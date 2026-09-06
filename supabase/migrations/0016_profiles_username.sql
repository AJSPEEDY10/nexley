-- ---------------------------------------------------------------------------
-- A username on the EXISTING profiles table, so one student can be addressed
-- by another.
--
-- The first draft of this migration created a new `public.profiles`, which
-- failed on dev with 42P07 — 0001_init already creates that table (id, name,
-- created_at, updated_at), a row is auto-created for every signup by
-- handle_new_user(), and its select/insert/update-own policies are already
-- there under exactly the policy names the new file wanted. Caught by running
-- it against dev before prod, which is the entire reason dev goes first.
--
-- So this ALTERs rather than creates. `name` stays what it already is — the
-- display name — and only the handle is new.
--
-- THE DIRECTORY IS NOT BROWSABLE, AND THAT IS THE POINT.
-- 0001's policy is select-own and this migration does not loosen it. Without a
-- policy returning other people's rows, `select * from profiles` returns
-- exactly your own row no matter who asks: a student cannot pull a list of
-- every Nexley user, and a scraped copy of that list cannot exist because the
-- query that would build it comes back empty.
--
-- Addressing someone therefore goes through find_user_by_username() below: an
-- EXACT match, one row, two columns. Guessing a handle one at a time is still
-- possible — true of every service with usernames — but enumerating the user
-- base in one query is not, and those are very different exposures.
--
-- WHAT A USERNAME IS NOT. Deliberately not the email address: a school email
-- is usually firstname.lastname.year, and handing that to another student is
-- handing them a real identity. A username is a handle the student picks.
-- ---------------------------------------------------------------------------

-- 3-20 chars, starts with a letter, lowercase/digits/underscore. Lowercased by
-- the client AND enforced here, so two students cannot take "Sam" and "sam"
-- and then wonder which of them a note went to.
alter table public.profiles
  add column if not exists username text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_username_format') then
    alter table public.profiles
      add constraint profiles_username_format
      check (username is null or username ~ '^[a-z][a-z0-9_]{2,19}$');
  end if;
end $$;

-- Unique, but nullable: every existing user already has a profile row (the
-- signup trigger makes one), and none of them have claimed a handle yet. A
-- unique index treats nulls as distinct, so "not chosen yet" is not a clash.
create unique index if not exists profiles_username_key
  on public.profiles (username);

-- ---------------------------------------------------------------------------
-- find_user_by_username: the ONLY way to resolve a handle to a user id.
--
-- security definer, so it reads past the select-own policy — which is exactly
-- why it gives back as little as it possibly can: one row, exact match, two
-- columns, and nothing at all to a caller who is not signed in. No prefix
-- search, no ILIKE, no ordering, no count. Each of those would rebuild the
-- browsable directory this table is shaped to prevent.
--
-- `set search_path` is not decoration on a definer function: without it a
-- caller can put their own schema ahead of public and have this run their
-- table instead of ours, with the definer's rights.
-- ---------------------------------------------------------------------------
create or replace function public.find_user_by_username(p_username text)
returns table (user_id uuid, username text, name text)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, p.username, p.name
  from public.profiles p
  where auth.uid() is not null
    and p.username is not null
    and p.username = lower(trim(p_username))
  limit 1;
$$;

revoke all on function public.find_user_by_username(text) from public;
grant execute on function public.find_user_by_username(text) to authenticated;

-- ---------------------------------------------------------------------------
-- claim_username: take a handle, or find out it is taken.
--
-- A definer function rather than a plain update for one reason: the client
-- cannot check availability first, because checking availability against a
-- select-own table is impossible by design. So the check and the claim have to
-- happen in the same place, where the caller can see neither the table nor who
-- holds the name they were refused.
--
-- Changing an existing handle is allowed — people outgrow a name they picked
-- at 15 — and every row that snapshots a username (note_shares, comp_entries)
-- keeps its own copy precisely so that a rename cannot orphan old records.
-- ---------------------------------------------------------------------------
create or replace function public.claim_username(p_username text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := lower(trim(p_username));
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if v_name !~ '^[a-z][a-z0-9_]{2,19}$' then
    raise exception 'a username is 3-20 characters, starts with a letter, and uses only letters, numbers and _';
  end if;
  if exists (select 1 from public.profiles
              where username = v_name and id <> auth.uid()) then
    raise exception 'that username is taken';
  end if;

  update public.profiles set username = v_name, updated_at = now()
   where id = auth.uid();

  if not found then
    -- Belt and braces: every signup gets a row from handle_new_user(), but an
    -- account created before that trigger existed would not have one.
    insert into public.profiles (id, username) values (auth.uid(), v_name);
  end if;

  return v_name;
end;
$$;

revoke all on function public.claim_username(text) from public;
grant execute on function public.claim_username(text) to authenticated;
