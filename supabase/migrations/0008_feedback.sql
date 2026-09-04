-- ---------------------------------------------------------------------------
-- feedback: what a beta user thinks, and what happened to it.
--
-- WHY THIS IS NOT bug_reports (0004)
-- bug_reports is deliberately WRITE-ONLY and content-free: no select policy at
-- all, so note text can never be read back out of it even by the person who
-- filed it. That shape is the thing protecting private study notes from a
-- crash reporter, and it must not be loosened.
--
-- Feedback is the opposite requirement. The whole point is that the user sees
-- it again — its status, and any reply — otherwise sending it is a black hole
-- and nobody sends a second one. So it gets its own table with select-own.
--
-- THE CLIENT CAN NEVER CHANGE A STATUS.
-- Only INSERT and SELECT are granted. There is no UPDATE and no DELETE grant,
-- so `status` and `reply` are writable only from the dashboard (service role,
-- bypasses RLS). A user cannot mark their own idea "shipped", and a submitted
-- piece of feedback cannot be quietly edited after the fact.
-- That is also why sync.js pushes this table with a plain insert rather than
-- the usual upsert — an upsert would need UPDATE privilege at plan time.
--
-- Sync-shaped like every other record (id, updated_at, rev, device, deleted)
-- so it rides the existing push/pull path in sync.js.
-- ---------------------------------------------------------------------------

create table public.feedback (
  id           text primary key,          -- client-generated, same as 0005's ids
  user_id      uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  rev          integer not null default 1,
  device       text,
  deleted      boolean not null default false,

  kind         text not null check (kind in ('idea', 'problem', 'confusing', 'praise')),
  body         text not null check (length(body) between 1 and 4000),

  -- set by Alec in the dashboard, read by the app. 'new' is the only value the
  -- client ever sees on a row it just wrote.
  status       text not null default 'new'
                 check (status in ('new', 'noted', 'planned', 'building', 'shipped', 'declined')),
  reply        text check (reply is null or length(reply) <= 4000),

  app_version  text
);

create index feedback_user_idx    on public.feedback (user_id, created_at desc);
create index feedback_status_idx  on public.feedback (status, created_at desc);

alter table public.feedback enable row level security;

-- RLS policies decide WHICH ROWS a role may touch; they do not grant the
-- privilege to touch the table at all. That is this separate table-level grant,
-- and without it every write fails 42501 no matter how permissive the policy
-- is. See 0004 and HANDOVER trap 8 — this is the second table to need it.
grant insert, select on public.feedback to authenticated;

create policy "feedback_insert_own" on public.feedback
  for insert to authenticated with check (auth.uid() = user_id);

create policy "feedback_select_own" on public.feedback
  for select to authenticated using (auth.uid() = user_id);

-- Same trigger the other tables use. It matters here for the dashboard path:
-- setting a status without touching updated_at falls into the auto-touch branch,
-- which moves updated_at to now() and bumps rev — which is exactly what makes
-- the change pull down to the user's device on their next sync.
create trigger feedback_touch_updated_at
  before update on public.feedback
  for each row execute procedure public.touch_updated_at();
