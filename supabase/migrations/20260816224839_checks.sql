-- Día 7A: persistencia de análisis (sección 7 de indicaciones.md), para
-- poder avisarle a un contacto familiar en riesgo medio/alto (Día 7B).
-- Preserva el contrato del clasificador (sección 8) sin cambios: esta tabla
-- solo guarda lo que ya circula por ese contrato, nunca la imagen original.

create table if not exists public.checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_type text not null check (source_type in ('text', 'image_ocr', 'audio_transcript')),
  raw_text text not null check (char_length(btrim(raw_text)) > 0 and char_length(raw_text) <= 6000),
  risk_level text not null check (risk_level in ('bajo', 'medio', 'alto')),
  signals jsonb not null default '[]'::jsonb check (jsonb_typeof(signals) = 'array'),
  explanation text not null check (char_length(btrim(explanation)) > 0),
  recommended_action text not null check (char_length(btrim(recommended_action)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists checks_user_id_idx on public.checks (user_id);

alter table public.checks enable row level security;

-- Cada usuario ve y crea únicamente sus propios análisis. Sin política de
-- update/delete: en esta etapa los análisis persistidos son de solo lectura
-- una vez creados (no hay edición ni historial visible todavía — Día 7B+).
create policy "checks_select_own"
  on public.checks
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "checks_insert_own"
  on public.checks
  for insert
  to authenticated
  with check (auth.uid() = user_id);
