-- Día 7A: registro de alertas por email a contactos familiares (sección 7).
-- No envía nada por sí sola — solo modela el estado del envío; el envío
-- real lo hace api/send-alert.ts vía Resend, usando la sesión del usuario
-- (nunca una service role key).

create table if not exists public.alerts_sent (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  check_id uuid not null references public.checks (id) on delete cascade,
  contact_id uuid not null references public.family_contacts (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  -- Como máximo una alerta por combinación análisis+contacto: evita envíos
  -- duplicados por doble clic o requests simultáneas. Un envío fallido se
  -- reintenta reutilizando esta misma fila (vía set_alert_status), no
  -- insertando una nueva.
  unique (check_id, contact_id)
);

create index if not exists alerts_sent_user_id_idx on public.alerts_sent (user_id);

alter table public.alerts_sent enable row level security;

-- Los usuarios pueden ver y crear (en estado "pending") sus propias
-- alertas, pero NO pueden actualizarlas directamente: no hay política de
-- update para el rol "authenticated". La única forma de pasar a "sent" o
-- "failed" es la función set_alert_status() de abajo, que corre con
-- privilegios elevados (security definer) pero igual exige que
-- auth.uid() sea dueño de la fila — así un cliente no puede marcar
-- arbitrariamente una alerta como enviada sin pasar por esa función, que
-- es lo único que llama api/send-alert.ts después de una confirmación
-- real de Resend.
create policy "alerts_sent_select_own"
  on public.alerts_sent
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "alerts_sent_insert_own_pending"
  on public.alerts_sent
  for insert
  to authenticated
  with check (auth.uid() = user_id and status = 'pending');

-- Transiciona el estado de una alerta propia. p_status solo puede ser
-- "pending" (para reintentar una que quedó en "failed"), "sent" o
-- "failed". Devuelve la fila actualizada, o null si no existe / no es del
-- usuario autenticado.
create or replace function public.set_alert_status(
  p_alert_id uuid,
  p_status text,
  p_error_message text default null
)
returns public.alerts_sent
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.alerts_sent;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if p_status not in ('pending', 'sent', 'failed') then
    raise exception 'invalid_status';
  end if;

  update public.alerts_sent
    set status = p_status,
        error_message = case when p_status = 'failed' then p_error_message else null end,
        sent_at = case when p_status = 'sent' then now() else sent_at end
    where id = p_alert_id and user_id = v_uid
    returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.set_alert_status(uuid, text, text) from public;
grant execute on function public.set_alert_status(uuid, text, text) to authenticated;
