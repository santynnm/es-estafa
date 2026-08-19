-- Plantilla SQL para el schema aislado de scripts/eval-email-quota.mts
-- (corrección 7A.2A.1). NO se aplica nunca directamente: el script
-- reemplaza el placeholder __SCHEMA__ por un nombre generado y validado
-- en tiempo de ejecución (regex ^quota_eval_[0-9a-f]{16}$) antes de
-- mandar este SQL a la Management API de Supabase. El schema completo se
-- elimina al final de la corrida (bloque finally), sea que las pruebas
-- hayan pasado o fallado.
--
-- Reproduce fielmente la lógica de reserve_email_attempt de
-- supabase/migrations/20260818134424_email_daily_usage.sql (límites 5 y
-- 250, orden de locking usuario->global, incremento conjunto o ninguno,
-- resultados reserved|user_limit|global_limit), con dos diferencias
-- deliberadas y documentadas, solo para poder aislar las pruebas:
--   1. Las tablas de este schema NO tienen foreign key contra auth.users
--      -- así las pruebas pueden usar UUIDs ficticios sin crear usuarios
--      reales.
--   2. La función acepta un p_date explícito en vez de calcular
--      (now() at time zone 'utc')::date -- necesario para poder probar
--      distintos "días" sin depender del reloj real ni tocar el día UTC
--      real. Esta función NUNCA se expone en public ni se otorga a
--      ningún rol de cliente: vive únicamente dentro de este schema
--      efímero, con permisos otorgados solo a service_role igual que la
--      real, y se destruye junto con el resto del schema al terminar.

create schema __SCHEMA__;

create table __SCHEMA__.email_user_daily_usage (
  user_id uuid not null,
  usage_date date not null,
  attempt_count int not null default 0 check (attempt_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

create table __SCHEMA__.email_global_daily_usage (
  usage_date date primary key,
  attempt_count int not null default 0 check (attempt_count >= 0),
  updated_at timestamptz not null default now()
);

create or replace function __SCHEMA__.reserve_email_attempt(p_user_id uuid, p_date date)
returns table (result text, user_count int, global_count int)
language plpgsql
set search_path = __SCHEMA__, pg_temp
as $$
declare
  v_today date := p_date;
  v_user_count int;
  v_global_count int;
begin
  if p_user_id is null then
    raise exception 'user_id_required';
  end if;

  insert into __SCHEMA__.email_user_daily_usage (user_id, usage_date, attempt_count)
  values (p_user_id, v_today, 0)
  on conflict (user_id, usage_date) do nothing;

  select attempt_count into v_user_count
    from __SCHEMA__.email_user_daily_usage
    where user_id = p_user_id and usage_date = v_today
    for update;

  if v_user_count >= 5 then
    return query
      select 'user_limit'::text, v_user_count,
        coalesce((select attempt_count from __SCHEMA__.email_global_daily_usage where usage_date = v_today), 0);
    return;
  end if;

  insert into __SCHEMA__.email_global_daily_usage (usage_date, attempt_count)
  values (v_today, 0)
  on conflict (usage_date) do nothing;

  select attempt_count into v_global_count
    from __SCHEMA__.email_global_daily_usage
    where usage_date = v_today
    for update;

  if v_global_count >= 250 then
    return query select 'global_limit'::text, v_user_count, v_global_count;
    return;
  end if;

  update __SCHEMA__.email_user_daily_usage
    set attempt_count = attempt_count + 1, updated_at = now()
    where user_id = p_user_id and usage_date = v_today
    returning attempt_count into v_user_count;

  update __SCHEMA__.email_global_daily_usage
    set attempt_count = attempt_count + 1, updated_at = now()
    where usage_date = v_today
    returning attempt_count into v_global_count;

  return query select 'reserved'::text, v_user_count, v_global_count;
end;
$$;

revoke all on function __SCHEMA__.reserve_email_attempt(uuid, date) from public, anon, authenticated;
grant execute on function __SCHEMA__.reserve_email_attempt(uuid, date) to service_role;
