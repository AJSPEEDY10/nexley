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
