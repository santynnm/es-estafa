-- Día 5-6B: contactos familiares del usuario autenticado.
-- Se usarán en el Día 7 para avisarles por email ante un riesgo medio/alto
-- (sección 3 de indicaciones.md). Esta migración solo crea la tabla y sus
-- políticas de acceso; el envío de alertas no se implementa acá.

create table if not exists public.family_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  nombre text not null,
  email text not null,
  created_at timestamptz not null default now(),
  constraint family_contacts_nombre_not_blank check (char_length(btrim(nombre)) > 0 and char_length(nombre) <= 200),
  constraint family_contacts_email_not_blank check (char_length(btrim(email)) > 0 and char_length(email) <= 320),
  constraint family_contacts_email_format check (email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$')
);

-- Un mismo email no puede cargarse dos veces para el mismo usuario
-- (comparación case-insensitive), sin límite de cantidad de contactos.
create unique index if not exists family_contacts_user_email_unique_idx
  on public.family_contacts (user_id, lower(email));

create index if not exists family_contacts_user_id_idx
  on public.family_contacts (user_id);

alter table public.family_contacts enable row level security;

-- Cada usuario autenticado ve, crea y borra únicamente sus propios
-- contactos. No hay política de update (todavía no se implementa editar,
-- solo alta/listado/baja) ni ninguna política para el rol anon: sin
-- sesión, RLS deniega todo por defecto.

create policy "family_contacts_select_own"
  on public.family_contacts
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "family_contacts_insert_own"
  on public.family_contacts
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "family_contacts_delete_own"
  on public.family_contacts
  for delete
  to authenticated
  using (auth.uid() = user_id);
