-- ---------------------------------------------------------------------------
-- Per-question detail on a paper, and WHY each mark was lost.
--
-- WHY THIS IS A COLUMN AND NOT A TABLE
-- A question has no meaning apart from the paper it was on: it is never queried
-- across papers, never shared, and always read and written together with its
-- paper. Making it a table would double the sync surface (another push, another
-- pull, another missing-table branch) and introduce a conflict class that cannot
-- otherwise happen — two devices editing different questions of the same paper
-- and merging into a half-updated script. As one JSONB column the paper stays a
-- single record with a single `updated_at`, and the existing newest-wins rule
-- keeps working unchanged.
--
-- Shape of each element, all optional except id/label/mark/out_of:
--   { id, label, mark, out_of, reason, syllabus_id, note }
--
-- `reason` is the point of the whole feature. A mark lost to running out of
-- time and a mark lost to not knowing the content are the same number and
-- completely different problems, and only one of them is fixed by studying
-- harder. The app can only tell them apart if the student says which it was.
--
-- Not validated field-by-field here on purpose: a CHECK constraint over JSONB
-- would have to be rewritten every time a reason is added, and the client is
-- the only writer. The cap below is a size guard, not a schema.
-- ---------------------------------------------------------------------------

alter table public.papers
  add column if not exists questions jsonb not null default '[]'::jsonb;

alter table public.papers
  add constraint papers_questions_is_array
    check (jsonb_typeof(questions) = 'array');

-- ~200 questions of ordinary length. Stops a runaway client filling the row
-- without putting a schema in a constraint.
alter table public.papers
  add constraint papers_questions_bounded
    check (length(questions::text) <= 60000);
