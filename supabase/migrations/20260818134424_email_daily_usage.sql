-- Corrección 7A.2A: reserva atómica de cupos diarios de email, server-side.
-- Solo persistencia + operación transaccional — todavía NO está conectada a
-- api/send-alert.ts (eso es 7A.2B, después de auditar esta subetapa). No
-- guarda emails, nombres, raw_text ni ningún dato del mensaje: solo
-- contadores por usuario+día y un contador global+día, en UTC.
--
-- Límites del MVP: máximo 5 intentos por user_id por día UTC, máximo 250
-- intentos globales por día UTC (deja margen de 50 respecto del límite
-- gratuito de 300 emails/día de Brevo, para dejar lugar a reintentos
-- legítimos fuera del TTL de idempotencia — ver README, sección "Política
-- de reintentos y garantía de entrega").
--
-- "Intento" = cada llamada efectivamente hecha a
-- transactionalEmails.sendTransacEmail(), exista o no éxito, incluyendo un
-- resultado duplicate_parameter (el proveedor sí recibió la solicitud). No
-- son "intentos": fallos de validación, 401/404/422, alertas ya `sent` o
-- `pending`, ni una request que pierde el compare-and-set contra otra
-- simultánea — ninguno de esos casos llega a Brevo.

-- 1) Contador individual: una fila por (user_id, día UTC).
create table if not exists public.email_user_daily_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  usage_date date not null,
  attempt_count int not null default 0 check (attempt_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

-- 2) Contador global: una fila por día UTC. Sin referencia a ningún
--    usuario — es un total agregado, no identifica a nadie.
create table if not exists public.email_global_daily_usage (
  usage_date date primary key,
  attempt_count int not null default 0 check (attempt_count >= 0),
  updated_at timestamptz not null default now()
);

-- 3) Defensa en profundidad: RLS habilitado, CERO políticas para anon ni
--    authenticated (con RLS activo y sin políticas, ambos roles no pueden
--    leer ni escribir ni una fila). Además, revocamos privilegios directos
--    de PUBLIC/anon/authenticated explícitamente — no alcanza con RLS solo,
--    porque un GRANT directo sin política de RLS todavía deja al
--    descubierto metadata de error / algunos comandos; queremos que ni
--    siquiera exista el permiso subyacente.
alter table public.email_user_daily_usage enable row level security;
alter table public.email_global_daily_usage enable row level security;

revoke all on public.email_user_daily_usage from public, anon, authenticated;
revoke all on public.email_global_daily_usage from public, anon, authenticated;

-- Nadie necesita consultar ni el propio consumo ni, mucho menos, el global,
-- desde el cliente en esta subetapa (no hay UI todavía) — por eso no se
-- otorga ningún grant a authenticated. Si Día 7B necesita mostrarle a un
-- usuario su propio consumo, se agregará explícitamente en otra migración,
-- nunca acceso al agregado global.

-- 4) Operación transaccional y atómica: reserva un intento para un usuario
--    dado, o lo rechaza, comprobando ambos límites antes de incrementar
--    cualquiera de los dos contadores.
--
--    Orden de locking consistente (siempre el mismo en todas las
--    invocaciones, para no poder generar un deadlock entre sí mismas):
--      1. fila de email_user_daily_usage (user_id, hoy UTC)
--      2. fila de email_global_daily_usage (hoy UTC) — solo si el límite
--         individual todavía no se superó.
--    Como ninguna invocación bloquea nunca la fila global antes que la de
--    usuario, dos llamadas concurrentes jamás pueden estar cada una
--    esperando el lock que tiene la otra.
--
--    La fecha del período se calcula siempre server-side, en UTC, a partir
--    de now() — no recibe ningún parámetro de fecha, así ningún caller
--    (ni siquiera service_role) puede elegir qué día se usa.
--
--    No usa SECURITY DEFINER: el único rol que va a poder ejecutar esta
--    función es service_role (ver GRANT más abajo), que ya bypassea RLS
--    por sí mismo — no hace falta escalar privilegios con SECURITY
--    DEFINER, así que se deja en SECURITY INVOKER (default) para minimizar
--    superficie de ataque. Igual se fija search_path explícito y se
--    califican todos los objetos con "public." por buena práctica /
--    defensa en profundidad, aunque el riesgo de search_path hijacking es
--    principalmente un problema de funciones SECURITY DEFINER.
create or replace function public.reserve_email_attempt(p_user_id uuid)
returns table (result text, user_count int, global_count int)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_user_count int;
  v_global_count int;
begin
  if p_user_id is null then
    raise exception 'user_id_required';
  end if;

  -- Asegura que exista la fila del usuario para hoy, y la bloquea.
  insert into public.email_user_daily_usage (user_id, usage_date, attempt_count)
  values (p_user_id, v_today, 0)
  on conflict (user_id, usage_date) do nothing;

  select attempt_count into v_user_count
    from public.email_user_daily_usage
    where user_id = p_user_id and usage_date = v_today
    for update;

  if v_user_count >= 5 then
    return query
      select 'user_limit'::text, v_user_count,
        coalesce((select attempt_count from public.email_global_daily_usage where usage_date = v_today), 0);
    return;
  end if;

  -- Solo si el límite individual no se superó: asegura y bloquea la fila
  -- global de hoy. Un rechazo por límite individual nunca llega hasta acá,
  -- así que nunca incrementa (ni siquiera toca) el contador global.
  insert into public.email_global_daily_usage (usage_date, attempt_count)
  values (v_today, 0)
  on conflict (usage_date) do nothing;

  select attempt_count into v_global_count
    from public.email_global_daily_usage
    where usage_date = v_today
    for update;

  if v_global_count >= 250 then
    return query select 'global_limit'::text, v_user_count, v_global_count;
    return;
  end if;

  -- Ambos límites verificados y respetados: se incrementan los dos
  -- contadores juntos, en la misma transacción implícita de esta función.
  update public.email_user_daily_usage
    set attempt_count = attempt_count + 1, updated_at = now()
    where user_id = p_user_id and usage_date = v_today
    returning attempt_count into v_user_count;

  update public.email_global_daily_usage
    set attempt_count = attempt_count + 1, updated_at = now()
    where usage_date = v_today
    returning attempt_count into v_global_count;

  return query select 'reserved'::text, v_user_count, v_global_count;
end;
$$;

revoke all on function public.reserve_email_attempt(uuid) from public, anon, authenticated;
grant execute on function public.reserve_email_attempt(uuid) to service_role;
