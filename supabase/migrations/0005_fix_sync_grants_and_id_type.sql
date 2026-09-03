-- ---------------------------------------------------------------------------
-- SYNC HAS NEVER WORKED. This migration is what makes it work.
--
-- Found 2026-09-03 by asking the deployed app, signed in as a real user, to do
-- what sync does. Every single call came back:
--     42501  permission denied for table subjects / syllabus / notes / profiles
-- and `localStorage['lastPullAt:<uid>']` was null — meaning no full sync round
-- trip has ever completed on that account. Notes have only ever existed on the
-- device that typed them. The welcome note's promise that your work "syncs to
-- your account whenever you have a connection" has never been true.
--
-- TWO INDEPENDENT FAULTS, BOTH OF WHICH BLOCK SYNC ON THEIR OWN.
--
-- FAULT 1 — no table privileges (the 42501 above).
-- Exactly the fault migration 0004 hit on bug_reports: an RLS policy decides
-- WHICH ROWS a role may touch, but it does not grant the privilege to touch the
-- table at all. 0004's header reasoned that the 0001 tables "inherit Supabase's
-- defaults and never needed one". That was wrong — they were never granted
-- either, and because nothing in the app surfaces a sync failure (sync.js logs
-- a console warning and returns ok:false) nobody ever saw it.
--
-- FAULT 2 — the id columns are uuid, and the client does not generate uuids.
-- app.js `uid()` returns e.g. "mtfgzh94-ib5yby" (base36 timestamp + random). The
-- id columns are `uuid`, so every push would fail with
--     22P02  invalid input syntax for type uuid
-- the moment the privileges above were granted. Fixing only the grants would
-- swap one silent failure for another.
--
-- WHY text RATHER THAN CHANGING THE CLIENT TO EMIT UUIDs.
-- Changing the client means rewriting the id of every record already on every
-- device, and every reference to it (notes.subject_id, notes.syllabus_id,
-- syllabus.parent_id, cards.*). A device still running the old build would keep
-- pushing old-style ids into the middle of that. Widening the column touches no
-- user data at all and cannot lose a note, which is the standing rule for this
-- schema. The client's ids are time-ordered and collision-resistant; they are a
-- perfectly good key, they were simply never the type the server asked for.
--
-- SAFE TO RUN: these tables are empty precisely because sync never worked, so
-- the type change rewrites nothing. It is written to be correct either way.
-- Idempotent — running it twice is harmless.
-- ---------------------------------------------------------------------------

-- --- FAULT 2: widen the client-generated key columns -----------------------
-- The foreign keys have to come off first: you cannot change the type of a
-- column another column references while the constraint is in place.
alter table public.syllabus drop constraint if exists syllabus_subject_id_fkey;
alter table public.syllabus drop constraint if exists syllabus_parent_id_fkey;
alter table public.notes    drop constraint if exists notes_subject_id_fkey;
alter table public.notes    drop constraint if exists notes_syllabus_id_fkey;

alter table public.subjects alter column id          type text using id::text;
alter table public.syllabus alter column id          type text using id::text;
alter table public.syllabus alter column subject_id  type text using subject_id::text;
alter table public.syllabus alter column parent_id   type text using parent_id::text;
alter table public.notes    alter column id          type text using id::text;
alter table public.notes    alter column subject_id  type text using subject_id::text;
alter table public.notes    alter column syllabus_id type text using syllabus_id::text;

-- The uuid defaults are meaningless now and would produce a text id the client
-- has never heard of if a row were ever inserted without one. The client always
-- supplies the id; that is the whole point of an offline-first store.
alter table public.subjects alter column id drop default;
alter table public.syllabus alter column id drop default;
alter table public.notes    alter column id drop default;

alter table public.syllabus
  add constraint syllabus_subject_id_fkey foreign key (subject_id)
  references public.subjects(id) on delete cascade;
alter table public.syllabus
  add constraint syllabus_parent_id_fkey foreign key (parent_id)
  references public.syllabus(id) on delete cascade;
alter table public.notes
  add constraint notes_subject_id_fkey foreign key (subject_id)
  references public.subjects(id) on delete cascade;
alter table public.notes
  add constraint notes_syllabus_id_fkey foreign key (syllabus_id)
  references public.syllabus(id) on delete set null;

-- --- FAULT 1: the privileges the policies were always assuming --------------
-- No DELETE anywhere: deletes in this app are tombstones (deleted = true via an
-- UPDATE). Withholding the privilege makes that structural rather than a rule
-- the client is trusted to follow.
grant select, insert, update on public.subjects to authenticated;
grant select, insert, update on public.syllabus to authenticated;
grant select, insert, update on public.notes    to authenticated;
grant select, update          on public.profiles to authenticated;

-- Nothing is granted to `anon`. Signed-out visitors have no business reading or
-- writing any of this, and RLS alone would not have stopped them if the grant
-- existed — 0004's anon insert on bug_reports is a deliberate, argued exception,
-- not a pattern to copy here.
