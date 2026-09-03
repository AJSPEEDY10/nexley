-- ---------------------------------------------------------------------------
-- cards: spaced-repetition review cards (app 0.10.0, "Review" mode).
--
-- Same sync shape as subjects / syllabus / notes — id, created_at, updated_at,
-- rev, device, deleted — so sync.js maps onto it with the same push/pull pair
-- and the same "newest updated_at wins" conflict rule.
--
-- SCHEDULING STATE LIVES HERE, and that is the reason this is a table rather
-- than a field on notes. The whole value of spaced repetition is the history:
-- ease, interval and lapse count are what make the schedule yours. If they only
-- existed on one device, reviewing on the iPad and then on the laptop would
-- silently double every card's workload and reset its ease.
--
-- Column names are spelled out (interval_days, due_at) rather than mirroring the
-- client's field names, because `interval` is a reserved word in Postgres and
-- `due` reads as a boolean.
--
-- ids are `text`, not `uuid`, matching the rest of the schema after 0005 — the
-- client generates its own ids and they are not uuids. Run 0005 before this.
-- ---------------------------------------------------------------------------

create table public.cards (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,

  subject_id    text references public.subjects(id) on delete set null,
  syllabus_id   text references public.syllabus(id) on delete set null,
  note_id       text references public.notes(id)    on delete set null,

  front         text not null,
  back          text not null,

  -- SM-2 state
  ease             real        not null default 2.5,
  interval_days    integer     not null default 0,
  reps             integer     not null default 0,
  lapses           integer     not null default 0,
  due_at           timestamptz not null default now(),
  last_reviewed_at timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  rev           integer not null default 1,
  device        text,
  deleted       boolean not null default false
);

create index cards_user_id_idx    on public.cards (user_id);
create index cards_updated_at_idx on public.cards (updated_at);
-- the query the app actually runs every time Review opens
create index cards_due_idx        on public.cards (user_id, due_at) where deleted = false;

alter table public.cards enable row level security;

-- RLS decides WHICH ROWS a role may touch; it does not grant the privilege to
-- touch the table at all. 0004 shipped without this and every insert failed with
-- 42501; 0005 then found that the 0001 tables had never been granted either and
-- sync had therefore never run at all. Assume nothing is granted by default.
grant select, insert, update on public.cards to authenticated;

create policy "cards_select_own" on public.cards
  for select using (auth.uid() = user_id);
create policy "cards_insert_own" on public.cards
  for insert with check (auth.uid() = user_id);
create policy "cards_update_own" on public.cards
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- no delete policy: deletes are tombstones (deleted = true via update), like every
-- other table here. Nothing the client does can hard-delete a row.

-- The client is authoritative for edit time and rev — see 0003 for why this
-- matters and what it fixes. A new table needs the trigger attached explicitly.
create trigger cards_touch_updated_at
  before update on public.cards
  for each row execute procedure public.touch_updated_at();
