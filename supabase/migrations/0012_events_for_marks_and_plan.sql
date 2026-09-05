-- ---------------------------------------------------------------------------
-- Widen the allowed event names for everything shipped in 0.14.0 - 0.18.0.
--
-- Four features landed with no measurement at all: the feedback board, marks,
-- the loss breakdown, and term planning. "How many people ever opened it" is
-- the number that says whether a feature works, and without it the answer to
-- "should we build more of this" is a guess.
--
-- ADDING AN EVENT IS STILL TWO DELIBERATE ACTS: this constraint, and ALLOWED in
-- app/analytics.js. The friction is the feature — it is what stops an event
-- being added casually, and what makes every event name visible in a diff. As
-- of this migration a test (test/test_events.js) fails if the two lists ever
-- disagree, which is the thing that was previously only a comment.
--
-- Still no content column and still a 200-character cap on props: these events
-- carry counts and short enums, never anything a student wrote.
-- ---------------------------------------------------------------------------

alter table public.events drop constraint events_name_known;

alter table public.events add constraint events_name_known check (name in (
  -- 0.1 - 0.13
  'app_opened', 'intro_finished', 'account_created', 'signed_in',
  'subject_created', 'note_created', 'note_deleted', 'syllabus_imported',
  'search_used', 'mode_switched', 'export_all', 'snapshot_restored',
  'capture_made', 'capture_filed', 'card_made', 'review_started', 'card_graded',

  -- 0.14.0 the feedback board
  'feedback_sent',

  -- 0.15.0 - 0.17.0 marks
  'paper_recorded', 'paper_questions_added', 'cards_pulled_forward',

  -- 0.18.0 term planning
  'commitment_saved', 'task_unpacked'
));
