-- ---------------------------------------------------------------------------
-- ink: handwriting and diagrams on a note.
--
-- STROKES, NOT AN IMAGE. Each stroke is a list of points with pressure, so a
-- note's handwriting is a few kilobytes of numbers rather than a PNG. Three
-- reasons, and the third is the one that decided it:
--
--   1. It scales. A PNG drawn on a 10.9" iPad is a blurry mess on a desktop
--      and unreadable when the sidebar is open; strokes redraw at any size.
--   2. It is editable. Undo, erase-a-stroke and re-colour are all trivial on
--      a list of strokes and all impossible on a flattened bitmap.
--   3. It syncs through the existing pipeline unchanged. jsonb is just another
--      column on notes — no new table, no new policy, no new grant, and the
--      push/pull in sync.js needs one extra field rather than a new path.
--
-- SIZE CAP, AND WHY IT IS WHERE IT IS. 400KB of jsonb is roughly a thousand
-- dense strokes: far more than a page of handwriting, and far less than a
-- device could produce by accident if a pointermove loop ever misbehaved. A
-- note that hits this fails to save loudly rather than quietly filling a
-- database that every other user shares.
--
-- Null, not '[]', for a note with no ink — the whole point is that this costs
-- nothing on the overwhelming majority of notes, which are typed.
-- ---------------------------------------------------------------------------

alter table public.notes
  add column if not exists ink jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'notes_ink_shape') then
    alter table public.notes
      add constraint notes_ink_shape
      check (ink is null
             or (jsonb_typeof(ink) = 'array' and pg_column_size(ink) < 400000));
  end if;
end $$;
