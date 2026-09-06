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
