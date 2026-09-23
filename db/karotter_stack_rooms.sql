-- Game-only storage in the existing Supabase project.
-- Run once in the SQL editor if public.karotter_stack_rooms does not exist.
create table if not exists public.karotter_stack_rooms (
  id text primary key,
  password_hash text,
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists karotter_stack_rooms_updated_at_idx
  on public.karotter_stack_rooms (updated_at);

alter table public.karotter_stack_rooms enable row level security;
revoke all on public.karotter_stack_rooms from anon, authenticated;
grant select, insert, update, delete on public.karotter_stack_rooms to service_role;
