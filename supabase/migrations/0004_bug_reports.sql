-- ---------------------------------------------------------------------------
-- bug_reports: crashes captured automatically, plus anything a user sends with
-- the "Report a problem" button.
--
-- The privacy shape is the point. This app's whole content is private study
-- notes, so a crash reporter is the most obvious way to leak them by accident:
-- error messages and stack traces routinely quote the data that broke. The
-- client (app/errors.js) scrubs and caps everything before it gets here, and
-- this table is deliberately shaped so there is nowhere for note content to sit
-- — no free-form JSON blob, only named columns with known meanings.
--
-- WRITE-ONLY FROM THE CLIENT. There is an insert policy and no select policy,
-- so nobody — not even the reporter — can read this table through the API.
-- Read it in the Supabase dashboard (SQL editor / table view), which uses the
-- service role and bypasses RLS.
-- ---------------------------------------------------------------------------

create table public.bug_reports (
  id           uuid primary key,
  user_id      uuid references auth.users on delete set null,   -- null = signed out
  created_at   timestamptz not null default now(),

  kind         text not null check (kind in ('crash', 'user')), -- automatic vs reported
  message      text not null,          -- scrubbed + capped client-side
  stack        text,                   -- scrubbed + capped client-side
  source       text,                   -- file:line:col, our own files only
  note         text,                   -- what the user typed, 'user' reports only

  -- context, all low-cardinality and content-free
  app_version  text,
  page         text,                   -- 'app' | 'landing' | 'legal'
  view         text,                   -- 'gate' | 'intro' | 'notebook' | 'editor' | ...
  online       boolean,
  standalone   boolean,
  viewport     text,                   -- e.g. '834x1112'
  user_agent   text,

  -- set by the client so repeats of the same fault collapse when you read it
  signature    text
);

create index bug_reports_created_at_idx on public.bug_reports (created_at desc);
create index bug_reports_signature_idx  on public.bug_reports (signature);

alter table public.bug_reports enable row level security;

-- RLS policies decide WHICH ROWS a role may touch. They do not grant the privilege to
-- touch the table at all — that is a separate, table-level GRANT, and without it every
-- insert fails with 42501 "permission denied for table bug_reports" no matter how
-- permissive the policy is. The other tables in this schema never needed an explicit
-- grant (they inherit Supabase's defaults), which is exactly why this was easy to miss.
--
-- INSERT only, on purpose. No SELECT is granted to anyone, which is what keeps this
-- table write-only from the client — see the header.
grant insert on public.bug_reports to authenticated;
grant insert on public.bug_reports to anon;

-- A signed-in user may file their own report.
create policy "bug_reports_insert_own" on public.bug_reports
  for insert to authenticated with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- OPTIONAL, AND A REAL TRADE-OFF — read before keeping it.
--
-- Without this, crashes that happen BEFORE sign-in are never reported: the
-- sign-in screen, the OAuth redirect, the intro. That is exactly where new-user
-- bugs live, and exactly the population that cannot tell you about them.
--
-- With it, anyone on the internet can insert rows into this table. There is no
-- select policy so they cannot read anything, and the client caps its own rate,
-- but a determined person could fill the table with junk. For a small app that
-- is an acceptable trade; if it is ever abused, drop this one policy and
-- pre-sign-in crashes simply stop arriving.
--
-- Delete this block if you would rather not take that trade.
-- ---------------------------------------------------------------------------
create policy "bug_reports_insert_anon" on public.bug_reports
  for insert to anon with check (user_id is null);
