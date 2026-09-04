-- ---------------------------------------------------------------------------
-- events: first-party product analytics.
--
-- WHY THIS TABLE EXISTS INSTEAD OF POSTHOG.
-- PostHog Cloud is hosted in the US or the EU only. Adding it means a second
-- overseas processor holding behavioural data about minors: another recipient
-- to name in the privacy policy, another transfer to justify under APP 8 of the
-- Privacy Act, and a third-party script on a page full of private study notes.
-- Sending the same events to the backend that already holds the notes adds no
-- new recipient. We give up PostHog's dashboards and write SQL instead, which at
-- this stage is a good trade.
--
-- Region confirmed 2026-09-04: ap-northeast-1 (Tokyo). Already disclosed
-- correctly in legal.html.
--
-- WHAT MAKES IT SAFE.
-- The shape is the guarantee, not a promise to be careful:
--
--   1. No content column. There is nowhere for a note, a title, a subject name
--      or a search query to sit. Only an event name, a timestamp, and a tiny
--      properties object.
--   2. `props` is capped at 200 characters by a CHECK. Even a client bug cannot
--      push a paragraph of someone's notes through it.
--   3. `name` is constrained to a fixed list. Adding an event means editing this
--      constraint AND the client allowlist — two deliberate acts with visible
--      diffs, not something a call site can do on its own.
--   4. WRITE-ONLY from the client. Insert is granted; select is not. Nobody can
--      read this table through the API, including the person who wrote the rows.
--      Read it in the dashboard, which uses the service role.
--
-- WHY ROWS CARRY user_id.
-- Retention — "did this person come back in week two" — needs a stable
-- identifier, and there is no way around that. Using the real user id rather
-- than a separate pseudonymous one is the more honest option here: it is
-- first-party usage of their own account, disclosed in the privacy policy, and
-- it avoids needing an anon-insert policy that would let anyone on the internet
-- fill the table with junk.
--
-- RETENTION. There is no automatic expiry. These rows are small, but they are
-- still behavioural data about minors and should not be kept forever. Run this
-- periodically, or add a pg_cron job:
--     delete from public.events where created_at < now() - interval '180 days';
-- ---------------------------------------------------------------------------

create table public.events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),

  name        text not null,
  props       jsonb not null default '{}'::jsonb,

  app_version text,

  -- the allowlist, mirrored from app/analytics.js. Both must agree.
  constraint events_name_known check (name in (
    'app_opened', 'intro_finished', 'account_created', 'signed_in',
    'subject_created', 'note_created', 'note_deleted', 'syllabus_imported',
    'search_used', 'mode_switched', 'export_all', 'snapshot_restored',
    'capture_made', 'capture_filed', 'card_made', 'review_started', 'card_graded'
  )),

  -- a hard ceiling on anything that is not an event name. Counts and short
  -- enums fit comfortably; prose does not.
  constraint events_props_small check (length(props::text) <= 200),
  constraint events_version_small check (app_version is null or length(app_version) <= 20)
);

create index events_user_created_idx on public.events (user_id, created_at desc);
create index events_name_created_idx on public.events (name, created_at desc);

alter table public.events enable row level security;

-- INSERT only, deliberately. No select grant means the table cannot be read
-- through the API by anyone — this is the same shape as bug_reports, and for the
-- same reason. Nothing is granted to `anon`: analytics from signed-out visitors
-- is not worth an open insert endpoint.
grant insert on public.events to authenticated;

create policy "events_insert_own" on public.events
  for insert to authenticated with check (auth.uid() = user_id);
