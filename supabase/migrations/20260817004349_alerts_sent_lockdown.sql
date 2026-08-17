-- Corrección de seguridad post Día 7A: ningún cliente autenticado (anon key
-- + JWT normal) debe poder crear ni transicionar filas de alerts_sent por
-- su cuenta — ni insertando "pending" directo, ni con UPDATE, ni invocando
-- la función set_alert_status(). A partir de ahora, todas esas escrituras
-- las hace api/send-alert.ts con un cliente service role (server-only, ver
-- api/_lib/supabaseAdmin.ts), que bypassea RLS por diseño — por eso la
-- integridad de "quién es dueño de qué" pasa a garantizarse con foreign
-- keys compuestas, no con políticas (que un cliente con service role
-- ignora igual).

-- 1) Nadie puede invocar set_alert_status(): ya no hace falta (el cliente
--    admin no necesita una función security definer para saltarse RLS, lo
--    hace de por sí), así que se elimina en vez de solo revocar permisos.
revoke all on function public.set_alert_status(uuid, text, text) from public, anon, authenticated;
drop function if exists public.set_alert_status(uuid, text, text);

-- 2) Nadie puede insertar directo en alerts_sent con la sesión normal.
drop policy if exists "alerts_sent_insert_own_pending" on public.alerts_sent;

-- Sigue existiendo alerts_sent_select_own (lectura del propio estado, para
-- cuando el Día 7B quiera mostrarlo en la UI) — no se toca.

-- 3) Integridad de ownership a nivel de base, efectiva incluso para el
--    cliente service role (que ignora RLS pero no puede violar un FK):
--    alerts_sent.user_id tiene que coincidir con el dueño real de check_id
--    y con el dueño real de contact_id. Se implementa con FKs compuestas
--    contra claves únicas (id, user_id) en checks y family_contacts.
--
--    Ya se verificó antes de aplicar esta migración que las 6 filas
--    existentes en alerts_sent son consistentes (user_id coincide con el
--    dueño de check_id y de contact_id en el 100% de los casos), así que
--    agregar estos constraints no requiere tocar datos.

alter table public.checks
  add constraint checks_id_user_id_key unique (id, user_id);

alter table public.family_contacts
  add constraint family_contacts_id_user_id_key unique (id, user_id);

alter table public.alerts_sent
  add constraint alerts_sent_check_owner_fk
    foreign key (check_id, user_id) references public.checks (id, user_id) on delete cascade,
  add constraint alerts_sent_contact_owner_fk
    foreign key (contact_id, user_id) references public.family_contacts (id, user_id) on delete cascade;

-- unique(check_id, contact_id) ya existe desde la migración anterior y se
-- conserva sin cambios: sigue siendo la base de la idempotencia del primer
-- INSERT. Las transiciones de estado posteriores (pending->sent,
-- pending->failed, failed->pending) ahora se hacen con UPDATE ... WHERE
-- status = '<estado esperado>' desde api/send-alert.ts (compare-and-set),
-- no con esta función eliminada.
