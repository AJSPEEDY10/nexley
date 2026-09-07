-- ---------------------------------------------------------------------------
-- papers.photo_url: a photo of the actual marked script, next to the marks
-- typed in about it.
--
-- This is the "obvious next thing" HANDOVER.md named when Marks (0009-0010)
-- shipped without it: "a marked script you can actually read — the photo or
-- text of the paper with the lost marks against it. That needs image
-- capture, which is Phase 8 territory." The capture pipeline already
-- existed (app/photo.js, built for note photos) and needed no changes at
-- all — this migration is the only thing that was actually missing.
--
-- SAME STORAGE SHAPE AS NOTE PHOTOS, FOR THE SAME REASON (see photo.js's own
-- header): a data URI in a text column rides every path papers already has —
-- sync, export, import, snapshot restore — with no new service, no storage
-- bucket, no second permission model to get right. The cost is column size,
-- so it is capped, same pattern as comps.questions in 0018.
--
-- ONE PHOTO, NOT MANY. A paper can have several pages, and this does not
-- solve that — it solves "the one page with the most marks lost on it is
-- worth having next to the numbers," which is the case that actually
-- motivated the request. Multiple photos per paper is a real next step if
-- one turns out not to be enough in practice, not a thing to speculatively
-- build now.
-- ---------------------------------------------------------------------------

alter table public.papers
  add column if not exists photo_url text
    check (photo_url is null or length(photo_url) <= 1000000);
