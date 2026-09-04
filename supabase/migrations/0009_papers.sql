-- ---------------------------------------------------------------------------
-- papers: a real assessment, actually sat, recorded WITH the conditions it was
-- sat under.
--
-- THE CONDITIONS COLUMN IS THE WHOLE POINT.
-- An open-notes mark and an exam mark are not the same mark. Averaging them
-- produces a number that describes nothing that ever happened, and it flatters:
-- the open-book marks pull the average up and hide the exam-condition gap, which
-- is precisely the gap that matters. So `conditions` is NOT NULL with no default
-- - there is no way to record a paper without saying how it was sat, because a
-- paper whose conditions are unknown cannot be honestly compared to anything.
--
-- Deliberately NOT here: any predicted band, grade or ATAR estimate, and any
-- column that could become one. The app records what happened. It does not
-- forecast, and the vision brief corrected an earlier concept on exactly this.
--
-- Sync-shaped (id, updated_at, rev, device, deleted) like every other record.
-- Unlike `feedback`, this is the user's own data and they can edit and delete
-- it, so it takes the normal select/insert/update grants and the usual upsert
-- push path.
-- ---------------------------------------------------------------------------

create table public.papers (
  id            text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  subject_id    text references public.subjects(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  rev           integer not null default 1,
  device        text,
  deleted       boolean not null default false,

  title         text not null,
  sat_at        timestamptz not null,          -- when it was sat, not when it was typed in

  conditions    text not null
                  check (conditions in ('exam', 'class_test', 'open_notes',
                                        'take_home', 'practice')),

  -- Stored as awarded/total rather than a percentage, because the raw marks are
  -- what a student actually holds in their hand, and because a percentage throws
  -- away the size of the paper - 8/10 and 80/100 are not equally strong evidence.
  mark          numeric(7,2) not null check (mark >= 0),
  out_of        numeric(7,2) not null check (out_of > 0),
  weight_pct    numeric(5,2) check (weight_pct is null or (weight_pct >= 0 and weight_pct <= 100)),

  reflection    text check (reflection is null or length(reflection) <= 4000),

  constraint papers_mark_within_total check (mark <= out_of)
);

create index papers_user_idx    on public.papers (user_id, sat_at desc);
create index papers_subject_idx on public.papers (subject_id, sat_at desc);

alter table public.papers enable row level security;

-- RLS decides WHICH ROWS; the privilege to touch the table at all is this
-- separate grant. See 0004 / 0005 / 0008 - three tables have now needed it.
grant select, insert, update on public.papers to authenticated;

create policy "papers_select_own" on public.papers
  for select to authenticated using (auth.uid() = user_id);
create policy "papers_insert_own" on public.papers
  for insert to authenticated with check (auth.uid() = user_id);
create policy "papers_update_own" on public.papers
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- no delete policy and no delete grant: deletes are tombstones (deleted = true),
-- like every other table here.

create trigger papers_touch_updated_at
  before update on public.papers
  for each row execute procedure public.touch_updated_at();
