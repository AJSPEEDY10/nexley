-- Summit Education — initial cloud schema
-- Mirrors the existing local IndexedDB shape (subjects / syllabus / notes) so the
-- client-side sync layer can map 1:1 onto these tables. Every table carries the
-- same sync-shaped fields IndexedDB records already have: id, created_at,
-- updated_at, rev, device, deleted (soft delete / tombstone, never a hard DELETE
-- from the client).
--
-- RLS is enabled on every table from this first migration, not retrofitted later.
-- Every row is scoped to auth.uid() — no client-supplied user id is ever trusted.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles: one row per auth.users, holds app-specific account fields
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
-- no delete policy: profile rows are never client-deletable (cascades from auth.users)

-- auto-create a profile row the moment a user signs up
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name) values (new.id, new.raw_user_meta_data ->> 'name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------------
-- subjects
-- ---------------------------------------------------------------------------
create table public.subjects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  color       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  rev         integer not null default 1,
  device      text,
  deleted     boolean not null default false
);

create index subjects_user_id_idx on public.subjects (user_id);
create index subjects_updated_at_idx on public.subjects (updated_at);

alter table public.subjects enable row level security;

create policy "subjects_select_own" on public.subjects
  for select using (auth.uid() = user_id);
create policy "subjects_insert_own" on public.subjects
  for insert with check (auth.uid() = user_id);
create policy "subjects_update_own" on public.subjects
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- deletes are tombstones (deleted = true via update), never a hard DELETE

-- ---------------------------------------------------------------------------
-- syllabus: flat store, parent_id gives topic -> dot-point hierarchy
-- ---------------------------------------------------------------------------
create table public.syllabus (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  subject_id  uuid not null references public.subjects(id) on delete cascade,
  parent_id   uuid references public.syllabus(id) on delete cascade,
  title       text not null,
  code        text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  rev         integer not null default 1,
  device      text,
  deleted     boolean not null default false
);

create index syllabus_user_id_idx on public.syllabus (user_id);
create index syllabus_subject_id_idx on public.syllabus (subject_id);
create index syllabus_parent_id_idx on public.syllabus (parent_id);

alter table public.syllabus enable row level security;

create policy "syllabus_select_own" on public.syllabus
  for select using (auth.uid() = user_id);
create policy "syllabus_insert_own" on public.syllabus
  for insert with check (auth.uid() = user_id);
create policy "syllabus_update_own" on public.syllabus
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- notes
-- ---------------------------------------------------------------------------
create table public.notes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  subject_id   uuid not null references public.subjects(id) on delete cascade,
  syllabus_id  uuid references public.syllabus(id) on delete set null,
  kind         text not null default 'personal' check (kind in ('personal', 'syllabus')),
  title        text not null default '',
  body         text not null default '',
  font         text not null default 'standard',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  rev          integer not null default 1,
  device       text,
  deleted      boolean not null default false
);

create index notes_user_id_idx on public.notes (user_id);
create index notes_subject_id_idx on public.notes (subject_id);
create index notes_syllabus_id_idx on public.notes (syllabus_id);
create index notes_updated_at_idx on public.notes (updated_at);

alter table public.notes enable row level security;

create policy "notes_select_own" on public.notes
  for select using (auth.uid() = user_id);
create policy "notes_insert_own" on public.notes
  for insert with check (auth.uid() = user_id);
create policy "notes_update_own" on public.notes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- updated_at auto-touch (keeps last-write-wins / rev logic honest server-side too)
-- ---------------------------------------------------------------------------
create function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.rev = old.rev + 1;
  return new;
end;
$$;

create trigger subjects_touch before update on public.subjects
  for each row execute procedure public.touch_updated_at();
create trigger syllabus_touch before update on public.syllabus
  for each row execute procedure public.touch_updated_at();
create trigger notes_touch before update on public.notes
  for each row execute procedure public.touch_updated_at();
