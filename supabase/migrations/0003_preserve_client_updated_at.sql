-- Fix: touch_updated_at() was destroying the very field sync conflict-resolution runs on.
--
-- THE BUG
-- sync.js resolves conflicts with "newest `updated` wins" (pullTable: if local.updated
-- >= incoming.updated, keep local). That rule only works if updated_at reflects when the
-- EDIT happened. The original trigger fired `before update` and unconditionally did
--     new.updated_at = now();
--     new.rev = old.rev + 1;
-- so every client-supplied updated_at and rev was thrown away and replaced with the time
-- the row happened to reach the server.
--
-- That silently turns "newest edit wins" into "last device to reach Wi-Fi wins":
--   1. iPad edits note N at 10:00, offline.
--   2. Laptop edits note N at 12:00, syncs -> server updated_at stamped 12:30.
--   3. iPad reconnects at 13:00, pushes its 10:00 content -> server stamps 13:00.
--   4. Laptop pulls, sees 13:00 > its local 12:00, and accepts the STALE 10:00 content.
-- The 12:00 edit is gone. On an offline-first app whose stated hard requirement is an
-- iPad with unreliable Wi-Fi, this is the exact scenario that loses work.
--
-- It also corrupts the pushedRev bookkeeping: the device pulls back its own just-pushed
-- row (server updated_at is newer than the local edit time), overwriting the local rev
-- with the server's, so local `updated` decays into "time of last sync" rather than
-- "time of last edit".
--
-- THE FIX
-- The client is authoritative for edit time and rev. The server only stamps them when
-- the writer did not supply them, and refuses writes that are provably stale.

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  -- Stale write: the server already holds a newer edit. Drop this update entirely
  -- (returning null from a before-update trigger skips the row). The pushing client
  -- will receive the newer row on its next pull, which is the correct resolution.
  if new.updated_at < old.updated_at then
    return null;
  end if;

  -- Writer did not move the timestamp itself (server-side or non-sync update):
  -- fall back to the old auto-touch behaviour.
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at = now();
    new.rev = old.rev + 1;
    return new;
  end if;

  -- Client supplied a genuinely newer updated_at: honour it, and keep rev monotonic
  -- so it never travels backwards regardless of what the client sent.
  new.rev = greatest(coalesce(new.rev, 1), old.rev + 1);
  return new;
end;
$$;
