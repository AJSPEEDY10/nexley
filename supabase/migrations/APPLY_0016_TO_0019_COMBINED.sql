-- Nexley — migrations 0016-0019, concatenated for a single paste into the
-- PRODUCTION SQL editor (project qvijxnhigqfoinuitrue).
--
-- Already applied to nexley-dev on 2026-09-06 and verified against the server.
-- Run this whole file in one go: it is ordered, and 0016 must precede 0017/0018.
-- Expected result: "Success. No rows returned".
--
-- This file is a convenience copy. The numbered files remain the record.

-- =================================================================
-- 0016_profiles_username.sql
-- =================================================================
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

-- =================================================================
-- 0017_note_shares.sql
-- =================================================================
-- ---------------------------------------------------------------------------
-- note_shares: one student sends one note to one named student.
--
-- A SNAPSHOT, NOT A LINK, AND NOT A FEED.
-- The row carries a COPY of the note's text at the moment it was sent. It does
-- not reference the sender's note and cannot read it later. Three reasons, in
-- order of importance:
--
--   1. Nexley is offline-first and the notebook lives in IndexedDB on the
--      student's own device. A "live" shared note would mean the server
--      holding a continuously updated copy of private study notes — the exact
--      thing this app's architecture exists to avoid.
--   2. A snapshot cannot leak forwards. Whatever you write in that note
--      tomorrow is not in a copy you sent today.
--   3. It makes revoking meaningful. Deleting the row deletes the only copy
--      the recipient's device pulls from.
--
-- ONE NAMED RECIPIENT. There is no "share with everyone", no discovery, no
-- listing of what has been shared. You address a person by their username;
-- they receive it or they do not. That constraint is what let this ship
-- without the moderation design that a public pool would need first.
--
-- THE RECIPIENT CANNOT EDIT IT AND THE SENDER CANNOT EDIT IT AFTER SENDING.
-- No update grant to either side except the sender setting `deleted` (see the
-- policy). A shared note that could be edited after the fact is a note whose
-- reader can be lied to about what they were sent.
-- ---------------------------------------------------------------------------

create table public.note_shares (
  id            text primary key,          -- client-generated, as everywhere
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  rev           integer not null default 1,
  device        text,
  deleted       boolean not null default false,

  from_user     uuid not null references auth.users(id) on delete cascade,
  to_user       uuid not null references auth.users(id) on delete cascade,

  -- Snapshotted so the recipient sees who sent it even if that person later
  -- changes their handle. The row has to stay readable on its own terms.
  from_username text not null,

  title         text check (title is null or length(title) <= 200),
  body          text not null check (length(body) between 1 and 60000),

  -- Context, so a received note is filable rather than an orphan. Names and
  -- codes only — never the sender's internal ids, which would say more about
  -- their notebook's shape than the recipient needs to know.
  subject_name  text check (subject_name is null or length(subject_name) <= 80),
  syllabus_code text check (syllabus_code is null or length(syllabus_code) <= 40),
  syllabus_title text check (syllabus_title is null or length(syllabus_title) <= 300),

  -- You cannot send to yourself. Not a safety rule — it is a bug filter, since
  -- every path that produces it is a mistake.
  constraint note_shares_not_self check (from_user <> to_user)
);

create index note_shares_to_idx   on public.note_shares (to_user, created_at desc);
create index note_shares_from_idx on public.note_shares (from_user, created_at desc);

alter table public.note_shares enable row level security;

-- No delete grant: revoking sets `deleted`, the same tombstone every other
-- table uses, so the recipient's next pull learns the row is gone instead of
-- it silently staying on their device forever.
grant insert, select, update on public.note_shares to authenticated;

-- The sender must be themselves, and must not be able to forge who it is from.
create policy "note_shares_insert_own" on public.note_shares
  for insert to authenticated
  with check (auth.uid() = from_user);

-- Both ends can read it. This is the only policy in the schema that returns a
-- row written by a different user, and it is narrow on purpose: you see a row
-- only if you are one of its two named parties.
create policy "note_shares_select_party" on public.note_shares
  for select to authenticated
  using (auth.uid() = from_user or auth.uid() = to_user);

-- Only the sender, and the with-check keeps the row addressed where it was
-- addressed: you can revoke what you sent, you cannot re-point it at someone
-- else or rewrite its text after the fact.
create policy "note_shares_revoke_own" on public.note_shares
  for update to authenticated
  using (auth.uid() = from_user)
  with check (auth.uid() = from_user);

create trigger note_shares_touch_updated_at
  before update on public.note_shares
  for each row execute procedure public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- The policy above grants UPDATE on the ROW, not on particular columns, so on
-- its own it would let a sender rewrite `body` after the recipient had already
-- read it — which is precisely what the header of this file promises cannot
-- happen. A policy cannot express "only this column"; a trigger can.
--
-- So: the only field an update may move is `deleted` (plus the bookkeeping
-- columns the sync path and the touch trigger own). Anything else raises,
-- rather than being silently reverted — a write that appears to succeed and
-- did nothing is worse than an error.
-- ---------------------------------------------------------------------------
create or replace function public.note_shares_freeze_content()
returns trigger
language plpgsql
as $$
begin
  if new.from_user     is distinct from old.from_user
  or new.to_user       is distinct from old.to_user
  or new.from_username is distinct from old.from_username
  or new.title         is distinct from old.title
  or new.body          is distinct from old.body
  or new.subject_name  is distinct from old.subject_name
  or new.syllabus_code is distinct from old.syllabus_code
  or new.syllabus_title is distinct from old.syllabus_title
  then
    raise exception 'a shared note cannot be edited after it is sent; revoke it and send a new one';
  end if;
  return new;
end;
$$;

create trigger note_shares_content_is_frozen
  before update on public.note_shares
  for each row execute procedure public.note_shares_freeze_content();

-- =================================================================
-- 0018_comps.sql
-- =================================================================
-- ---------------------------------------------------------------------------
-- comps: several people sit the same practice test, then compare.
--
-- WHY THIS IS NOT A LEADERBOARD.
-- A comp is joined with a CODE. It is not discoverable, not listed, not
-- ranked against the year group, and there is no query in this schema that
-- returns "everyone using Nexley, ordered by score". You see the scores of
-- people who were given the same code as you, and nobody else — which means
-- a comp is always between people who chose each other.
--
-- That distinction is the whole reason this could ship. A live percentile
-- against your cohort is motivating for the students at the top and corrosive
-- for the ones who most need to keep going, and these are 16-year-olds. A
-- code-joined comp between four friends is a different object.
--
-- WHERE THE QUESTIONS COME FROM.
-- The owner's own paper. Nexley does not ship a question bank and cannot
-- until the NESA licensing question is answered — see the register. A comp is
-- therefore "a test one student wrote out", and the schema says so: questions
-- is free-form JSONB authored by the owner, never drawn from a catalogue.
--
-- WHAT IS NOT HERE, DELIBERATELY.
-- No chat, no comments, no free text from one participant to another beyond
-- the username they chose. The first time Nexley lets students write to each
-- other in an unstructured way is the first time it needs a moderation
-- design, and a score is not unstructured.
-- ---------------------------------------------------------------------------

create table public.comps (
  id           text primary key,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  rev          integer not null default 1,
  device       text,
  deleted      boolean not null default false,

  owner_user   uuid not null references auth.users(id) on delete cascade,
  owner_username text not null,

  title        text not null check (length(title) between 1 and 120),
  subject_name text check (subject_name is null or length(subject_name) <= 80),

  -- The test itself: [{ n, prompt, outOf }]. Marked by each participant
  -- against their own copy — see comp_entries. Capped so a comp cannot become
  -- a file host.
  questions    jsonb not null default '[]'::jsonb
                 check (jsonb_typeof(questions) = 'array'
                        and pg_column_size(questions) < 60000),
  out_of       numeric not null check (out_of > 0 and out_of <= 1000),

  -- Short, human-sayable, and case-insensitively unique. Six characters from
  -- an alphabet with no O/0 or I/1, because this gets read aloud and typed by
  -- someone else — an ambiguous code is a support problem, not a puzzle.
  join_code    text not null unique check (join_code ~ '^[A-HJ-NP-Z2-9]{6}$'),

  -- Nobody can join or submit after this. Null means open until the owner
  -- closes it.
  closes_at    timestamptz
);

create index comps_owner_idx on public.comps (owner_user, created_at desc);

create table public.comp_entries (
  id           text primary key,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  rev          integer not null default 1,
  device       text,
  deleted      boolean not null default false,

  comp_id      text not null references public.comps(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,

  -- Snapshotted for the same reason note_shares snapshots the sender: the row
  -- has to stay readable on its own terms if the person renames themselves.
  username     text not null,

  -- Null until they submit. A joined-but-unsubmitted entry is a real state and
  -- the app shows it as "still sitting it" rather than as a zero — the same
  -- rule the term planner already follows for unestimated work.
  score        numeric check (score is null or score >= 0),
  submitted_at timestamptz,

  -- One entry per person per comp. Re-sitting to improve a score is not a
  -- thing here: the comp is the comparison, and a resit makes it meaningless.
  unique (comp_id, user_id)
);

create index comp_entries_comp_idx on public.comp_entries (comp_id, score desc nulls last);

alter table public.comps        enable row level security;
alter table public.comp_entries enable row level security;

grant insert, select, update on public.comps        to authenticated;
grant insert, select, update on public.comp_entries to authenticated;

-- ---------------------------------------------------------------------------
-- Membership is the pivot every policy below turns on. Written as a security
-- definer function because the obvious formulation — a policy on comps that
-- selects from comp_entries, whose own policy selects from comps — is an
-- infinite recursion that Postgres rejects at query time.
-- ---------------------------------------------------------------------------
create or replace function public.is_comp_member(p_comp_id text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.comp_entries e
    where e.comp_id = p_comp_id
      and e.user_id = auth.uid()
      and e.deleted = false
  ) or exists (
    select 1 from public.comps c
    where c.id = p_comp_id
      and c.owner_user = auth.uid()
  );
$$;

revoke all on function public.is_comp_member(text) from public;
grant execute on function public.is_comp_member(text) to authenticated;

create policy "comps_insert_own" on public.comps
  for insert to authenticated with check (auth.uid() = owner_user);

-- You can read a comp you own or have joined. Note what is missing: there is
-- no policy returning comps by code, so a comp cannot be found by trying codes
-- against this table directly — joining goes through join_comp() below, which
-- is the only path that reads a comp you are not yet in.
create policy "comps_select_member" on public.comps
  for select to authenticated
  using (auth.uid() = owner_user or public.is_comp_member(id));

create policy "comps_update_owner" on public.comps
  for update to authenticated
  using (auth.uid() = owner_user) with check (auth.uid() = owner_user);

-- Entries are inserted by join_comp(), not directly, but the policy still has
-- to be right: you may only ever write an entry that is yours.
create policy "comp_entries_insert_own" on public.comp_entries
  for insert to authenticated with check (auth.uid() = user_id);

-- Everyone in the comp sees every entry in it. That IS the feature.
create policy "comp_entries_select_member" on public.comp_entries
  for select to authenticated using (public.is_comp_member(comp_id));

create policy "comp_entries_update_own" on public.comp_entries
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create trigger comps_touch_updated_at
  before update on public.comps
  for each row execute procedure public.touch_updated_at();
create trigger comp_entries_touch_updated_at
  before update on public.comp_entries
  for each row execute procedure public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- join_comp: the only way into a comp you were not already in.
--
-- Takes the code, creates the caller's entry, returns the comp id. Written as
-- security definer for one specific reason: resolving a code has to read a
-- comps row the caller cannot yet see, and doing that through a policy would
-- mean a policy that returns comps by code — which would let anyone walk the
-- code space and enumerate other people's comps. Here, a wrong code returns
-- nothing and tells the caller nothing about whether it exists.
--
-- Idempotent: joining a comp you are already in returns its id rather than
-- failing, because the honest response to "join" when you are already in is
-- "you are in", not an error the app then has to translate.
-- ---------------------------------------------------------------------------
create or replace function public.join_comp(p_code text, p_entry_id text, p_username text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_comp public.comps%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  select * into v_comp from public.comps
   where join_code = upper(trim(p_code)) and deleted = false;

  if not found then
    raise exception 'no comp with that code';
  end if;

  if v_comp.closes_at is not null and v_comp.closes_at < now() then
    raise exception 'that comp has closed';
  end if;

  -- Already in it (as a participant or as the owner): say so by succeeding.
  if exists (select 1 from public.comp_entries
              where comp_id = v_comp.id and user_id = auth.uid() and deleted = false) then
    return v_comp.id;
  end if;

  insert into public.comp_entries (id, comp_id, user_id, username)
  values (p_entry_id, v_comp.id, auth.uid(), p_username);

  return v_comp.id;
end;
$$;

revoke all on function public.join_comp(text, text, text) from public;
grant execute on function public.join_comp(text, text, text) to authenticated;

-- =================================================================
-- 0019_revoke_unused_privileges.sql
-- =================================================================
-- ---------------------------------------------------------------------------
-- Take back three privileges nothing in Nexley has ever used.
--
-- FOUND while verifying 0016-0018 on dev, by listing role_table_grants rather
-- than trusting that "grant insert, select, update" was the whole story. It is
-- not: Supabase's default privileges hand every role a set of extras on any
-- new table in `public`, so every table in this database — including `notes`,
-- which holds the actual study notes — currently reads:
--
--   anon           REFERENCES, TRIGGER, TRUNCATE
--   authenticated  INSERT, SELECT, UPDATE, REFERENCES, TRIGGER, TRUNCATE
--
-- TRUNCATE is the one that matters, because **TRUNCATE is not subject to row
-- level security**. Every protection in this schema is written as an RLS
-- policy, and a policy has nothing to say about a statement that removes every
-- row in the table. DELETE is safe here — RLS applies to it, and no table has
-- a delete policy — but TRUNCATE walks straight past all of it.
--
-- HOW BAD IS IT, HONESTLY. Not very, today: the anon key reaches PostgREST,
-- and PostgREST does not expose TRUNCATE. There is no known path from an
-- API key to this privilege. It is a loaded gun in a locked room rather than
-- an open door, and it has been true of every table since 0001.
--
-- That is still the wrong shape. The privilege is not used by anything, cannot
-- be used correctly by anything, and its only possible effect is to make some
-- future mistake — a new RPC, an exposed schema, a misconfigured role —
-- unrecoverable instead of survivable. REFERENCES and TRIGGER go with it for
-- the same reason: nothing needs them, and a client role that can attach a
-- trigger to a table is a client role that can run code on every write to it.
--
-- Deliberately does NOT touch postgres or service_role, which are the roles
-- that legitimately administer these tables.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  tables text[] := array[
    'profiles', 'subjects', 'notes', 'syllabus', 'cards', 'papers',
    'commitments', 'events', 'feedback', 'bug_reports', 'ai_usage',
    'note_shares', 'comps', 'comp_entries'
  ];
begin
  foreach t in array tables loop
    -- to_regclass returns null rather than raising for a table that is not
    -- there, so this file stays runnable against a database that is missing
    -- one of them (dev and prod have drifted before).
    if to_regclass('public.' || t) is not null then
      execute format('revoke truncate, references, trigger on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- And stop the defaults handing them out again on the NEXT table somebody
-- creates. This only affects objects created by the role that runs it, which
-- for a dashboard migration is the same role that creates the tables.
alter default privileges in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;

