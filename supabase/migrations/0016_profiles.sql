-- ---------------------------------------------------------------------------
-- profiles: a username, so one student can be addressed by another.
--
-- This is the first table in Nexley that exists to let users FIND each other,
-- and everything about its shape is set by that. The users are school-age.
--
-- THE DIRECTORY IS NOT BROWSABLE, AND THAT IS THE POINT.
-- There is no select policy that returns rows you do not own. Without one,
-- `select * from profiles` returns exactly your own row and nothing else, no
-- matter who asks. A student cannot pull a list of every Nexley user, and a
-- scraped copy of that list cannot exist because the query that would build it
-- returns nothing.
--
-- Addressing someone therefore goes through find_user_by_username() below: an
-- EXACT match, one row, id and username only. Guessing a username one at a
-- time is still possible — that is true of every service with usernames — but
-- enumerating the whole user base in one query is not, and those are very
-- different exposures.
--
-- WHAT A USERNAME IS NOT. It is not the display name, it is not searchable by
-- prefix, and it is deliberately not the email address: a school email is
-- usually firstname.lastname.year and handing that to another student is
-- handing them a real identity. A username is a handle the student chooses.
-- ---------------------------------------------------------------------------

create table public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  rev          integer not null default 1,
  device       text,
  deleted      boolean not null default false,

  -- 3-20 chars, lowercase letters/digits/underscore, must start with a letter.
  -- Stored already-lowercased by the client AND enforced here, so two students
  -- cannot take "Sam" and "sam" and then wonder which one a note went to.
  username     text not null unique
                 check (username ~ '^[a-z][a-z0-9_]{2,19}$'),

  -- Shown next to the username when someone receives a note or joins a comp,
  -- so the recipient can tell a stranger from a person they know. Optional,
  -- and deliberately not unique — real people share first names.
  display_name text check (display_name is null or length(display_name) between 1 and 40)
);

alter table public.profiles enable row level security;

-- RLS decides which rows; this grants the privilege to touch the table at all.
-- Without it every write fails 42501 regardless of policy. See 0005 and the
-- traps section of HANDOVER — this is the fourth table to need it.
grant insert, select, update on public.profiles to authenticated;

create policy "profiles_insert_own" on public.profiles
  for insert to authenticated with check (auth.uid() = user_id);

-- Own row only. There is intentionally no policy that returns anyone else's:
-- see the header. Lookup by exact username goes through the function below.
create policy "profiles_select_own" on public.profiles
  for select to authenticated using (auth.uid() = user_id);

create policy "profiles_update_own" on public.profiles
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute procedure public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- find_user_by_username: the ONLY way to resolve a handle to a user id.
--
-- security definer, so it can read past the select-own policy above — which is
-- exactly why it is written to give back as little as possible: one row, exact
-- match, two columns, and nothing at all for a caller who is not signed in.
-- No prefix search, no ILIKE, no ordering, no count. Those would each turn
-- this into the browsable directory the table is shaped to prevent.
--
-- `set search_path` is not decoration on a security definer function: without
-- it a caller can put their own schema ahead of public and have this function
-- run their table instead of ours, with the definer's rights.
-- ---------------------------------------------------------------------------
create or replace function public.find_user_by_username(p_username text)
returns table (user_id uuid, username text, display_name text)
language sql
security definer
set search_path = public
stable
as $$
  select p.user_id, p.username, p.display_name
  from public.profiles p
  where auth.uid() is not null
    and p.deleted = false
    and p.username = lower(trim(p_username))
  limit 1;
$$;

revoke all on function public.find_user_by_username(text) from public;
grant execute on function public.find_user_by_username(text) to authenticated;
