-- ---------------------------------------------------------------------------
-- commitments: an assessment that is actually coming, with what it will cost.
--
-- Tasks mode could already unpack an assessment notification into the syllabus
-- points it tests — but it never SAVED anything, so nothing downstream could
-- ever ask "what is coming, and can I actually fit it". That is the whole of
-- Phase 7, and this is the missing record.
--
-- `hours_estimate` IS NULLABLE ON PURPOSE.
-- The honest answer to "how long will this take" is often "no idea yet", and a
-- planner that demands a number gets a made-up one — which then adds up into a
-- confident weekly total built from guesses. Null means unestimated, the app
-- counts those separately, and says how many there are rather than assuming
-- zero. A week reading "9 hours, plus 2 tasks not estimated" is true; the same
-- week reading "9 hours" is not.
--
-- No status/progress column: this records what is due and what it costs, not
-- how you feel about it, and "60% done" on a task nobody updated is worse than
-- no information. `done` is a fact and is enough.
-- ---------------------------------------------------------------------------

create table public.commitments (
  id             text primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  subject_id     text references public.subjects(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  rev            integer not null default 1,
  device         text,
  deleted        boolean not null default false,

  title          text not null,
  due_at         timestamptz not null,
  weight_pct     numeric(5,2) check (weight_pct is null or (weight_pct >= 0 and weight_pct <= 100)),
  hours_estimate numeric(6,2) check (hours_estimate is null or (hours_estimate >= 0 and hours_estimate <= 500)),
  done           boolean not null default false,
  notes          text check (notes is null or length(notes) <= 4000)
);

create index commitments_user_idx    on public.commitments (user_id, due_at);
create index commitments_subject_idx on public.commitments (subject_id, due_at);

alter table public.commitments enable row level security;

-- RLS decides which rows; the privilege to touch the table is this grant.
grant select, insert, update on public.commitments to authenticated;

create policy "commitments_select_own" on public.commitments
  for select to authenticated using (auth.uid() = user_id);
create policy "commitments_insert_own" on public.commitments
  for insert to authenticated with check (auth.uid() = user_id);
create policy "commitments_update_own" on public.commitments
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- no delete grant: deletes are tombstones, like every other table here.

create trigger commitments_touch_updated_at
  before update on public.commitments
  for each row execute procedure public.touch_updated_at();
