# Nexley - session handover

**Session:** 2026-09-02 to 09-06 · **Ended at:** v0.33.0, SW cache `nexley-v46`
— migrations 0016-0021 are applied to **prod and dev** and verified against
the server. Nothing is waiting for Alec to apply.

---

## Read this first — where things stand at the end of 09-06

**The app is no longer just a notebook.** In one run on 09-06 it gained
usernames, note sharing, comps, handwriting, photographs of pages, a Home, a
restructured sidebar and accent themes. If you are picking this up cold, open
the app before reading further: the shape of it changed more today than in the
fortnight before.

### What shipped on 09-06, in order
| v | What |
|---|---|
| 0.21 | Cross-subject links |
| 0.22 | AI feedback wired into the UI (adversarial set finished, rule 7 added) |
| 0.23 | Warm repalette + the margin rule |
| 0.24 | Usernames (`social.js`) |
| 0.25 | Send a note to one named person, and an inbox |
| 0.26 | Comps — write a test, share a code, compare |
| 0.27 | Handwriting, first cut (a canvas under the text) |
| 0.28 | Handwriting rebuilt as ONE SURFACE — the pencil writes on the note |
| 0.29 | Lasso, pixel + object erasers, line tool, floating palette |
| 0.30 | Highlighter and four colours |
| 0.31 | Photograph a page, cleaned up |
| 0.32 | **Restructure**: Home, real sidebar, accent themes |
| 0.33 | Empty states, and brass used through Marks |

### The three rules this session added, which must not be quietly undone
1. **A pencil draws, a finger scrolls.** The ink canvas is
   `pointer-events:none` and pen input is ROUTED to it by `routePenToInk()` in
   app.js 12q. That is what makes "just start writing" work with no mode. If
   you ever find yourself giving the canvas pointer events back, you have
   broken scrolling on the device this app is aimed at.
2. **An AI mark is never written into a paper.** 12m has no save button and no
   persistence, verified against the stored record. A comp score never reaches
   Marks either.
3. **A comp is joined by code and is never a leaderboard.** There is no query
   in the schema that returns everyone ordered by score. Keep it that way — see
   `GROWTH_AND_LAUNCH.md` §0 for why the public version is a different product.

### Still needing Alec
- **A second account.** Sharing and comps are verified against stubs that mimic
  the real policies, and the schema is live, but "you send, someone else
  receives" has never been run with two real accounts.
- **Apple Developer enrolment** ($99/yr, his Apple ID) — `PHASE8.md`.
- **Android** is unblocked and unstarted: Capacitor scaffolding and CI are in.

### Decided, so do not re-open
- **NESA licensing is deferred until scale and revenue** (Alec, 09-06).
  Everything question-bank-shaped waits behind it.
- The brand ambition is written down in `GROWTH_AND_LAUNCH.md` §0 and in
  memory `project_nexley_brand_vision.md`.

**The last three things off the tracker, 09-06 morning.**
- **Cross-subject links** (v0.21.0-0.21.1). The first thing in the app that
  looks across a subject boundary — the 12e matcher is handed a subjectId and
  never sees anything else. Open a filed note and, if its dot point shares
  genuinely specific vocabulary with a point in a *different* subject, one
  quiet line says so and takes you there. Three gates: the shared term must be
  rare across the whole notebook, must not be syllabus scaffolding
  ("describe", "students investigate"), and the survivors must add up. **Most
  of the 25 assertions in `test_crosslinks.js` check that it says nothing** —
  a version that linked everything would pass a "does it find the link" test
  and be worse than not shipping. Two faults the harness caught before it went
  out: the line said "two other subjects" when both links were in the same
  one, and following a link set the active point without scrolling to it
  (top=1585 in an 888px viewport).
- **The adversarial marking set is COMPLETE.** All five cases have now been
  run against the live model and judged by hand; the log at the top of
  `test/probe_marking.js` is the record and is worth reading before touching
  the prompt. `irrelevant_wrong_fact` is the cleanest result: a volunteered
  wrong claim the criterion did not cover cost nothing and still got named in
  WHAT TO FIX. `ambiguous_criterion` was a partial — the dangerous failure did
  not happen, but rule 4's UNCLEAR path never fired and the vagueness came out
  as advice for something the criteria never asked for. **Rule 7** now makes
  any beyond-the-criteria advice say so; verified against the live model, and
  the model responded by dropping such advice entirely rather than tagging it.
- **AI feedback is wired into the UI** (v0.22.0). A question inside a paper,
  once you have typed your answer in. **There is no save button and there is
  no persistence** — the result lives in a local variable and dies with the
  dialog. Verified by taking a 2/2 from the model on a question marked 1/2,
  saving the paper, and reading the record back: still 1/2, nothing AI-shaped
  stored. A reply that fails the arithmetic checks or quotes a criterion the
  student did not supply is refused outright, not shown with a warning.

**Live build-plan tracker: https://claude.ai/code/artifact/08ba57da-71d6-477f-8eb5-9ede9416af85**
— the whole idea archive cross-referenced against what's shipped, updated
each time something ships. Check this before re-deriving what's worth
building; it has the "not doing, on purpose" list with reasons too.

**Everything else off the tracker, 09-06.** Four more shipped in one run:
- **Streaks** (`a4319a2`). One quiet line in the rail, derived from the
  `updated` timestamps already on every record — never stored, so it cannot
  drift or need syncing. One day off does not break it; two in a row does, and
  that rule is in the tooltip rather than hidden. Silent below two days.
  `test_streak.js`, 14 assertions.
- **The note title** (`e25f688`). Was a hard `slice(0,140)`, so captures got
  titles cut mid-word, rendered at display size in a single-line input that
  scrolled sideways — you saw the middle of your own title. `titleFrom()` now
  cuts on a word boundary at 72; the field is an auto-growing textarea and
  Enter moves to the body. `test_title.js`, 13 assertions.
- **Share progress** (`0628bc2`). Rail → per subject: syllabus covered, cards
  waiting, what is due in a fortnight. **No marks and no note text**, stated in
  the dialog and visible in full before it goes. Text you copy, not a link — a
  link needs a table, a policy and a hand-applied migration, and stays
  findable afterwards. Also extracted `coverageOf()` so the summary and the
  coverage bar cannot drift apart.
- **The sign-in gate** (`ce79fc3`). Two centred lines were orphaning their last
  word ("…sync to your / account", "Privacy & / Terms"). `text-wrap:balance`,
  and the footer links are a flex row so no "·" ever leads a line. The intro
  was reviewed in both themes and needed nothing.

**The two density passes (`2723b18`, `88a6b86`).** Both turned up structural
faults rather than needing polish:
- **Marks.** `.fld input[type=number]{width:100%}` was beating `.q-num{width:64px}`
  on both specificity and order, so every mark box had been stretching to fill
  the row and pushing the remove button onto its own line — on touch too. See
  trap 13. The answer box is also collapsed behind "+ answer text" until asked
  for, grows to fit when open (a short scroller inside a scrolling dialog is a
  wheel trap), and `#pprDialog` gets its own 680px width. "1 marks" → "1 mark"
  in four places, now sharing `marksLabel()`.
- **Tasks.** Two sibling `.pane-body` elements were each `flex:1`, so an empty
  paste box and a static explainer permanently owned ~60% of the pane while the
  eight-week plan got a strip at the bottom with its own scrollbar — and
  scrolling moved only half the screen. One scroller now; three weeks of plan
  are visible on open. The explainer only shows while there are no saved tasks.

**Also shipped 09-05, both off that tracker:**
- **Past you** (`597f574`). Open a filed note and, if you wrote about the same
  dot point ≥21 days earlier, a quiet line says so; "Read it" opens the older
  note in a second tab so the two sit side by side. The threshold IS the
  feature — two notes from the same week are one piece of thinking split in
  two, and showing those as progress would be flattery. `pastYouFrom()` is
  pure; `test/test_pastyou.js` (13 assertions) pins every way it could show a
  distance that isn't there. Deliberately untracked: a new analytics event
  costs a hand-applied migration and this doesn't need a number.
- **Mistake replay** (`36a400e`). "From your mistakes" in Review: every content
  gap across every subject, worst first. Cards exist → bring forward; already
  queued → says so; **none yet → "Write a card"**, opening the card dialog
  already filed against that point. That last case is the whole point — the
  per-subject version in Marks says "no cards yet" and stops, so the one dot
  point you'd measurably lost marks on was the one you couldn't act on.
  Needed `'mistake'` added to `card_made`'s allowed `from` values in
  `analytics.js` (unlisted values are dropped *silently*, so without it those
  cards would record as having no origin at all) — no migration, event name
  unchanged.

**The marked script — SHIPPED 09-05 (commit `aa7c2a3`)**, Alec's "number 2"
pick. Each question in Record a paper can now carry the student's own typed
answer text; select a phrase in it, tag it earned/lost with a reason and a
note, see it as a coloured underline you can click to jump to the footnote.
This is the exact "marked script you can actually read" Phase 6 flagged and
parked as needing image capture — it didn't, it needed typed text and a
selection UI, both buildable with no AI and no migration (papers are already
JSONB). Two real bugs caught building it: the annotate button did nothing on
first click because focus-move clears text selection on `mousedown` before
`click` fires (needs `preventDefault()` on mousedown); and span matching is
by substring-with-first-match-wins, not a stored offset, because an offset
silently points at the wrong text the moment the response is edited — a span
that can't refind itself now stays absent rather than landing wrong. 4 new
test sections, `test_marks.js` is 70 assertions now (was 60).

**The redesign — STARTED 09-05, Alec: "professional notebook and Apple style
... use all notes we have for nexley, take a deep dive and action
everything."** This is the "individual screens have not been restyled yet"
work the design-directions section below has been waiting on. Scope note:
"action everything" is a multi-session initiative, not a single commit —
what shipped today is step one, chosen deliberately as the highest-leverage
single change:
- **Repaletted the base neutrals onto Apple's own system gray scale**
  (commit `fb98a4d`): `paper`/`surface`/`card`/`ink`/`ink-2`/`muted`/`rule`/
  `rule-soft`, both themes. Eucalypt (`--structure`), the highlighter
  (`--mark`) and the serif display/reading faces are UNCHANGED — those are
  the notebook identity Alec explicitly wants kept alongside "Apple style."
  Because every screen already resolves through these root tokens, this one
  change cascades to Notebook, Marks, Tasks, dialogs, the landing page and
  the report-a-problem sheet with zero per-screen edits. Verified in both
  themes via the auth-stub QA harness, then confirmed live on production
  (signed in as Alec, data intact, sync unaffected).
- **Deep-dive source material, so the next screen-level passes don't
  re-derive this**: read `ideas/INDEX.md` in full (9 onedrive brand mockups:
  Institute/Slate/Scholar/Cohort/Marks/Neon + 10-concepts + new-features-2 +
  landing; 18 claude-artifacts: the original 10 named concept studies,
  Naming Shortlist, 3 vision/build docs, Summit content-engine research) and
  read The Nexley Register and Marking Ledger artifacts in full. **Finding:**
  none of the archived mockups is a literal template for "professional
  notebook AND Apple-style formal brand" — they're gamified phone-app concept
  sketches (streaks, palm cards, XP) with a different information
  architecture to what's actually shipped, and the Register itself is dated
  to v0.10.0 (pre almost everything built since). Useful as reference for
  specific interaction ideas, not as a skin to apply wholesale.
- **The one idea worth building next, identified in this pass**: Marking
  Ledger's tap-a-phrase-in-your-answer → margin note showing which rubric
  criterion it earned or lost. This is the exact "marked script you can
  actually read" feature Phase 6 flagged as its own obvious next step and
  parked (see Phase 6 below) — except it needs phrase-level span data the
  current Marks feature doesn't collect yet (today's per-question record only
  has a single reason, not per-phrase tags). Real feature work, not a skin;
  scope it properly before starting.
- **NOT yet touched**: per-screen layout/component redesign (Notebook editor
  chrome, Tasks, the sign-in gate's copy/structure, Classwork). The token
  cascade covers color; density, spacing rhythm and layout on the newer
  screens (Marks, Tasks) still reads as "not yet restyled" the way the
  original note put it. Continue there next.

**QA pass, 09-05 (Alec: "everything needs to be perfect, keep going"), two real
bugs found and fixed, both pushed:**
- **Marks — the per-question "got / of" row broke apart at the modal's own
  width** (not a narrow-viewport fluke — the modal is ~370px wide by design,
  so every user hit this every time they added a second question). Fixed by
  grouping mark+slash+outOf into one flex item and giving the number inputs
  enough padding to clear the native spinner. Commit `3764098`.
- **Tasks — the unpacker's "I don't know the due date" was silently becoming
  "today."** `parseDueDate` correctly returns null when the pasted text has no
  real calendar date ("Week 4, Term 3" isn't one), but `Date.now()` fallbacks
  one layer up (the save button, and again in the dialog prefill) turned that
  honest null into a confident wrong date by the time the student saw it —
  reproduced live, not theoretical. Fixed at both layers, plus
  `saveCommitment()` now refuses to save with no date rather than falling
  through to `dayToMs`'s own today-default (which is correctly left alone for
  its other caller, a paper's "sat" date). Commit `bc30c79`.
- Verified with the auth-stub QA harness this file's Testing section already
  describes (files deleted before committing, as that section says to).
- A straightforward "click through every mode" pass otherwise — nothing else
  found in Notebook, Classwork, Review, or the feedback board.
- **Also confirmed the one thing 09-04's note left unproven**: opened Feedback
  in the live signed-in app and the smoke-test row now shows a real reply
  ("Reply path verified end to end from the dashboard"). The reply round-trip
  works.
**Backend:** migrations 0005-0021 applied to prod **and** dev (0016-0021 on 09-06:
usernames, note sharing, comps, the privilege revoke, and `notes.ink`).
**Edge function:** `ai` deployed to prod and **WORKING** — Groq key is in. **Sync verified working.**
**Repo:** `C:\Users\PC\Nexley` · deploy = `git push origin main`
**Live:** landing `https://ajspeedy10.github.io/nexley/` · app `.../nexley/app.html`
**Tests:** thirteen files, all green (329 assertions) — `test_parser.js`,
`test_matcher.js`, `test_confidence.js`, `test_feedback.js`, `test_marks.js`,
`test_plan.js`, `test_events.js`, `test_marking.js`, `test_pastyou.js`,
`test_streak.js`, `test_title.js`, `test_crosslinks.js`, `test_comps.js`.
`for f in test/test_*.js; do node "$f"; done` runs the lot.
`test/probe_marking.js` is NOT one of them: it spends real Groq quota against
the live model and is judged by a human. Read its log before changing the
marking prompt.
Plus `node test/measure_matcher.js`, which is a MEASUREMENT, not a test: it prints
coverage/precision for auto-filing and never fails.

---

## Nothing is blocked on Alec

**Migration 0008 (`feedback`) was applied to dev and prod on 09-04, and v0.14.0 is
deployed.** Verified against the server (not the dashboard) in the live signed-in app:
select works, a report sent from the deployed UI is in the table as `status='new'`, and
`update` / `delete` / `upsert` are all refused `42501` - which is the live proof of why
sync pushes this table with a plain insert rather than an upsert.

One test row sits in prod `feedback` ("Smoke test of the feedback pipeline...") - delete
it, or reply to it to watch the reply land back in the app:
`update public.feedback set status='noted', reply='...' where id='...';`

Everything else that was waiting on him has been cleared or dropped:

- **Sync migrations - DONE 09-04.** 0005 (grants + text ids), 0006 (cards), 0007 (events),
  on prod and dev. Verified against the server: `sync.run()` returns `ok:true`, all tables
  read, a record with a client-generated id writes. **Notes left the device for the first
  time since the app was built.**
- **PostHog - dropped.** Replaced by first-party analytics in Nexley's own database. No key
  needed, no third party, no cross-border processor added.
- **Waitlist - scrapped** by Alec's call.
- **NESA - settled:** uploads only, private per student. An original question bank is a
  *later* idea, not started. No NESA email.
- **iPad - settled:** build for every device. Apple Smart Script was already rejected in
  August for being M-series-only; the cross-platform path was always the plan.
- **Entity / monetisation / Google error text - dropped or deferred** by Alec.
- **AI stance for now:** local matching only. AI marking and voice are NOT built, pending
  a proper costing conversation.

### Still worth knowing
- **Trademark: `NEXL` is registered in AU by NEXL Pty Ltd in classes 9 and 42** - exactly the
  classes Nexley would need. "Nexley" itself returns 0 results. Same classes, same country,
  two letters apart: a real deceptive-similarity risk, not a clear block. Not legal advice.
- **Supabase region is `ap-northeast-1` (Tokyo)**, confirmed in the dashboard. `legal.html`
  was right; the 2026-08-11 decision log's "Sydney" was wrong.
- One tombstoned probe row sits in prod `subjects` (`device = 'verify'`) from testing the
  write path. Invisible in the app. `delete from public.subjects where device = 'verify';`

---

## Shipped this session

| Version | What |
|---|---|
| 0.10.0 | Classwork + Review (SM-2), sync reports its state instead of failing silently |
| 0.11.0 | First-party analytics replacing PostHog, `legal.html` disclosure |
| 0.12.0 | **Tasks - the wedge.** Unpack an assessment notification into syllabus points |
| 0.13.0 | Confidence per dot point, auto-filing |
| 0.14.0 | **The feedback board**, and a landing page that matches the product |
| 0.15.0 | **Phase 6 part one - real marks**, recorded with their conditions |
| 0.16.0 | **Part two - where the marks went**, per question and per reason |
| 0.17.0 | **Part three - the loop closes**, gaps pull cards into Review |
| 0.18.0 | **Phase 7 - term planning.** Tasks finally saves what it unpacks |
| 0.18.1 | Measurement for all of the above, and 7 dead events fixed |
| 0.19.0 | Auto-filing measured; two real matcher bugs found and fixed |
| 0.19.1 | The AI proxy, live — plus the marking prompt and its checks |

Plus the design token system (97 font sizes / 61 gaps / 47 radii onto three scales).

**Bugs found and fixed along the way:** SM-2 showed `1d/1d/1d` on a new card, so three grade
buttons did nothing visibly different; `plain()` ran HTML blocks together in every excerpt;
the rail counted captures the notebook excluded; `legal.html` was styled against six CSS
variables that never existed; the code pattern read "TASK 3" as an outcome code; the Tasks
warning used a `.gap` class borrowed from a design artifact that isn't in `app.css`.

---

---

## The plan from here

Ordered. Each phase either unblocks or de-risks the next.

**Phase 5 - public site. DONE 09-04**, apart from applying migration 0008.
- *Feedback board.* Its own table, not `bug_reports`: that one is write-only on
  purpose (no select policy, so note text can never leak back out of a crash
  report) and feedback has to be readable or it is a hole that never answers.
  INSERT and SELECT are the only grants, so `status` and `reply` can only be
  written from the dashboard - a user cannot mark their own idea shipped. Sync
  pushes it with a plain `insert`, not an upsert, because Postgres needs UPDATE
  privilege to *plan* an `on conflict do update` even when nothing conflicts.
- *Landing page.* It was still selling Classwork and spaced review as "on the
  way" two versions after both shipped. Now describes what exists, with a
  built / being-built log. A predicted band is on neither list on purpose.
- Still open from this phase: nothing. The waitlist half was scrapped.

**Phase 6 - real marks. ALL THREE PARTS DONE 09-04/05 (v0.15.0 - v0.17.0).**
- *Part one.* A Marks mode and a `papers` store (migration 0009). A paper carries
  the conditions it was sat under (`conditions` is NOT NULL with no default - a paper
  whose conditions are unknown cannot honestly be compared to anything), and marks are
  grouped by those conditions and **never averaged across them**. A rule, not a setting:
  no code path produces a figure spanning two groups. Marks are summed per group and
  divided once rather than percentage-averaged, so a 9/10 quiz cannot outweigh a
  60/100 exam.
- *Part two.* Per-question detail and a reason per dropped mark (migration 0010, a
  JSONB column on papers - a question has no meaning apart from its paper and a table
  would double the sync surface and invent a merge-conflict class). Only LOST marks are
  grouped, and losses with no reason are reported as unexplained rather than dropped.
- *Part three.* A question can name the dot point it tested; gaps roll up per point,
  and the cards on that point can be pulled to the front of the review queue. Only
  "didn't know it" counts - running out of time is not a content gap. Cards are pulled
  forward (`due` = now, interval collapsed) but `ease` is deliberately untouched.
- *Not built, and the obvious next thing here:* a marked script you can actually read -
  the photo or text of the paper with the lost marks against it. That needs image
  capture, which is Phase 8 territory, which is why it stopped here.
- **No predicted band, ever** - `test_marks.js` fails if someone adds one.

**Phase 7 - term planning. DONE 09-05 (v0.18.0).** Tasks could unpack a notification and
then forgot it existed; it now saves commitments (migration 0011) and shows the next eight
weeks.
- Hours are attributed to the week a thing is **due** - a fact about a deadline, not a
  model of when you would do the work. The app cannot know when you would start, so it
  says the true thing instead: this much has to be finished by this week, and if that is
  more than a week holds it cannot all start in that week.
- `hours_estimate` is nullable on purpose. Unestimated work is COUNTED and reported
  ("9h due, 2 not estimated") but never treated as zero, and can never on its own trigger
  an over-commitment warning - inventing a size to justify a warning is the same
  fabrication pointing the other way.
- The framing is deliberate and is the phase's whole point: an over-committed week is
  arithmetic, not a judgement. "You are not behind - this week was over-committed the day
  these were set."
- The unpacker now offers to save what it read, opening the dialog PREFILLED rather than
  saving, because the title and date are inferred. `parseDueDate` takes the nearest future
  occurrence when no year is stated and returns null rather than guessing; `taskTitle`
  skips year/term headers.
- Weekly capacity is per-device in `localStorage` - a fact about your life this term, not
  study content, one number, re-entered in a tap.

**Phase 8 - native wrap. SCAFFOLDED 09-05 (4dede45), Alec's call to start it early** —
overriding "deliberately late" below, which still stands as the reasoning, just not as
the timing. See **`PHASE8.md`** for the full runbook.
- Capacitor wraps `app/` as-is — no build step added to the web app itself, just a
  packaging layer around it. `android/` and `ios/` platform projects are committed.
- Two bugs caught before either store would have shipped them: `config.js` detected
  local dev by `hostname === 'localhost'`, which is also what Capacitor's WebView uses
  for local files on both platforms — every native build would have silently pointed at
  the DEV Supabase project. And `index.html`'s existing "bounce an installed PWA to
  app.html" redirect only checked PWA display-mode, so a native build — same root cause,
  no separate "start page" setting — would have opened on the marketing pitch. Both now
  also gate on `window.Capacitor.isNativePlatform()`.
- **Android is ready to try TODAY, no account needed**:
  `.github/workflows/android-debug-build.yml` builds an unsigned debug APK on every push
  to main. Download the artifact, side-load it, done.
- **iOS needs Alec's own Apple Developer enrollment** ($99/yr, his Apple ID) before
  anything ships — that and five other one-time account steps are in `PHASE8.md`. Once
  the secrets exist, signing is a one-off `ios-certificates.yml` run and every release is
  `git tag v0.20.0 && git push origin v0.20.0`. Both run on GitHub's macOS runners —
  genuinely no Mac, ever, for Alec.
- Original reasoning, unchanged: store review blocks daily iteration, so the PWA should
  stay the primary dev vehicle. Starting the scaffolding now doesn't change that — the
  workflows sit idle until the Apple secrets exist.

*Original note, for context:* Deliberately late: store review blocks daily iteration, so
the PWA stays the development vehicle until the product is worth freezing. Handwriting
capture lands here - target every device, not M-series iPads only.

**The AI path — LIVE 09-05, and the prompt is the open work.**

*What is done and verified on production:*
- `supabase/functions/ai` — the model proxy. The API key lives there because a key
  shipped in a PWA is a public key. Returns 200 end to end with a real Groq key.
- **Model: `openai/gpt-oss-120b`.** `llama-3.3-70b-versatile` and
  `llama-3.1-8b-instant` are now Enterprise / "contact sales" on Groq and a normal
  account gets **404** — that was the first failure and it cost a round trip.
  Model IDs rotate: read console.groq.com/docs/models rather than guessing.
  ~$0.0006 a marking request.
- **Two ceilings, both in the database** (0013, 0015): `AI_DAILY_LIMIT` 10 per
  student, `AI_ACCOUNT_DAILY_LIMIT` 40 for everyone — because the free allowance
  is per ACCOUNT, so a per-user cap alone does not protect it. They return
  DIFFERENT errors on purpose; "you have used your ten" and "the shared allowance
  is gone" are different facts and the second is not the student's fault.
- Quota is taken BEFORE the provider call, so a timeout cannot be retried into a
  bill. Nothing a student wrote is ever logged — errors carry a code and a length.
- The function returns `provider_status` on failure: **401 = key, 404 = model,
  429 = rate limit.** Use it; diagnosing 502 from the logs is slow.
- `app/marking.js` — the prompt, in the CLIENT on purpose, so what the model is
  actually asked is visible in the app's own source. Plus `parseMarking`, which
  checks arithmetic the model cannot argue with, and `unsupportedCriteria`, which
  catches the marker judging against a criterion nobody supplied.

*The open work, and read this before touching it:*
- The first realistic marking test FAILED HONESTLY: it failed a student against
  "the expected 30s-2min range", a standard nowhere in the criteria, and gave 0/2
  where they had plainly got half right. After hardening, the same input went
  **2/6 -> 4/6**, with partial credit on both criteria and `unsupportedCriteria`
  returning clean.
- **Rule 2 — DONE 09-05.** Reworded in `app/marking.js`: outside knowledge may be
  used to JUDGE whether what the student wrote is correct, never to ADD a
  requirement the criterion didn't state — "correctly states the duration" can
  be judged against what duration actually is; "must fall in the 30s-2min
  range" is still forbidden if the criterion never named a range.
  `test/test_marking.js` updated to check the new wording; 31/31 pass.
- **The adversarial case set — test/probe_marking.js, 3 of 5 run 09-05.** Can't
  be a Node script: the proxy needs a real signed-in Supabase JWT and
  Claude-in-Chrome correctly refuses to hand a session token out of the page,
  so it's a script you paste into the console of the live signed-in app — see
  the file's header for how, and its PROBE LOG for what came back:
  - `silent_detail` (2/2) and `half_right` (1/2, correct partial credit) both
    came back clean — no invented threshold, no unsupported criterion. This is
    the exact shape of case Rule 2 was reworded for, and it held.
  - `different_wording` (1/2) looked like a marker miss at first but wasn't:
    the test case itself claimed a wrong fact (heat as the ATP-PC system's
    *only* by-product), and the model correctly used outside knowledge to
    mark that wrong rather than accept it as an honest paraphrase — legitimate
    under the reworded rule. Worth noting: an adversarial case set can itself
    be wrong: I initially misread the model's mark as the marker's mistake
    until re-checking the case's chemistry.
  - **`irrelevant_wrong_fact` and `ambiguous_criterion` did NOT run** — hit
    the 10/day per-student ceiling (already partly spent earlier the same
    session). **Re-run after reset (UTC midnight = 10am AEST)** and update the
    PROBE LOG before treating the prompt as validated — 3/5 is not the full
    set the handover called for.
  - No version bump, no UI change, no commit yet from this pass — flagging so
    the next session doesn't lose the two unrun cases.
- **Standing rule: an AI mark must NEVER be written into a paper record.** A real
  mark is one a teacher gave, and that is what makes the conditions grouping in
  Marks mean anything. The first bad mark was 2/6; had it landed in an
  exam-conditions average it would have silently corrupted the one honest number
  in the app.
- Groq's console shows Developer-Plan per-token pricing, which does not square
  with the "genuinely free tier" an earlier search reported. Cost is trivial
  either way and both ceilings cap it, but **do not tell Alec it is free** without
  re-checking. A spend limit in the Groq console is cheap insurance.

**Phase 9 - the gated ones. TWO OF FOUR ARE NOW DECIDED (09-05, Alec).**
- *AI marking* — decided and in progress, see above. Feedback AND marks, never a band,
  always against criteria the student pasted.
- *Sharing* — **deliberate one-off to a specific person. Not open, not browsable, no
  feed.** That collapses the old "Commons needs a safety design" blocker: with no
  discovery surface there is nothing to moderate, and it reduces to permission scoping.
  A shared question bank is a separate, later idea.
- *Still gated:* the question bank's content source, and whether a prac entry needs its
  own structure (method / results / conclusion) rather than a differently-tagged note.

### Design directions - IN PROGRESS 09-05, see "The redesign" near the top
Five full prototypes built 09-03, plus a much larger archive at `ideas/` (9 onedrive
brand mockups, 10 original concept studies, vision docs). Alec's call, restated 09-05:
"professional notebook and Apple style... proper brand or company." None of the
archived mockups turned out to be a literal template — see the deep-dive note above.
Step one (the base-neutral repalette) is done; per-screen layout/density work continues.

| Direction | Link |
|---|---|
| Marking Ledger | https://claude.ai/code/artifact/0b60cb0e-21e9-4aaa-8fd5-4095b6364f04 |
| Dark Regions | https://claude.ai/code/artifact/f58e7806-a38c-4d0b-aada-ee3c9de17dd0 |
| Ten Weeks Out | https://claude.ai/code/artifact/c90b2a37-d391-4c8a-90d6-2a56e514c703 |
| Season Four | https://claude.ai/code/artifact/a00c8fb0-0f3a-4a45-adee-ab6b20b9cebd |
| One Block | https://claude.ai/code/artifact/280486ef-8b6a-45d1-a5c8-5ea6b4d491b5 |
| **The Nexley Register** - every idea ever + the full plan | https://claude.ai/code/artifact/3885dc36-ed28-454f-bd37-519677bad4fd |

---

## Architecture, in one page

- **Offline-first.** IndexedDB is the source of truth for the UI, always. Sync pushes and
  pulls in the background and never blocks a read or a save.
- **Code and data are separate.** A deploy replaces files in the SW cache; it never touches
  IndexedDB. A deploy cannot delete a note.
- **Deletes are tombstones.** Nothing is hard-deleted, so a deletion syncs instead of the
  record resurrecting. No table grants DELETE - structural, not a rule the client is trusted
  to follow.
- **Every record is sync-shaped:** stable id, `updated`, `rev`, `device`, `deleted`.
- **Modes:** Notebook / Classwork / Review / Tasks. A capture is a note with
  `kind:'capture'`, so Classwork needed no migration; filing one flips the kind and sets a
  syllabus point, keeping the id and the original date.
- **Everything local.** Matcher, confidence and auto-filing are plain TF-IDF over the
  syllabus the user already pasted. No model, no network, works with no signal.

### Files
`app/app.js` is the app - one file, numbered sections, no build step. `sync.js`, `auth.js`,
`errors.js`, `analytics.js`, `config.js` are separate concerns. `app.css` holds the token
system: **every measurement resolves to a scale token.** If a value you need is not on a
scale, take the nearest step rather than inventing one.

### Tests
```
node test/test_parser.js       # syllabus paste parsing        13 tests
node test/test_matcher.js      # TF-IDF matcher + task parser  22 tests
node test/test_confidence.js   # confidence bands               9 tests
```
Tests extract functions from `app.js` by string-slicing and `eval`, so **renaming a function
or changing a section header can break extraction.** Run them after any refactor.

### Testing responsive layout
`resize_window` resizes the OS window but does NOT change the viewport here, so
media queries never fire and you will "verify" a phone layout at desktop width
without noticing. Put the app in an **iframe** instead — media queries evaluate
against the iframe's own viewport:

```html
<iframe src="app-qa.html" width="390" height="840"></iframe>
<iframe src="app-qa.html" width="820" height="840"></iframe>
```

Same origin, so IndexedDB and the auth stub work, and you can drive it from the
parent with `document.querySelector('iframe').contentDocument`. Delete the rig
before committing. This is how the clipped-note-title bug was found: it only
appeared when there was not enough vertical room, i.e. only on a phone.

### Testing the app itself
There is no way past the sign-in gate offline. Copy `app.html`, point the `auth.js` script
tag at a stub that fakes `window.NexleyAuth`, serve it, drive it. **Delete the harness files
before committing.** Use a fresh port every time - see the traps.

---

## Traps — don't re-learn these

1. **`clamp()`/`calc()` need whitespace around `+` and `-`.** `clamp(1.55rem,1.25rem+1.4vw,2rem)`
   is a parse error, the declaration is dropped silently, and you inherit. The note title
   spent all of Pass 1 rendering at **14px** because of this.
2. **An element cannot respond to its own container query.** Put `container-type` on the
   parent and query a wrapper inside it.
3. **`app.css` pins `html,body{height:100%;overflow:hidden}`** for the app shell. Any normal
   document sharing that stylesheet **cannot scroll**. Release it per-page.
4. **The SW's offline navigate fallback serves the app for any *uncached* navigation**, so a
   new page silently becomes the app on a slow connection. **Precache every real page.**
5. **Whenever a page moves to the site root, check what Supabase's Site URL now points at.**
   That is what caused the 09-03 auth regression.
6. **Local testing:** the SW + Chrome HTTP cache will serve stale JS on `127.0.0.1` even
   after unregistering, so an edit silently doesn't take and a test "fails" against old
   code. **Use a fresh port** (new origin ⇒ no SW, no HTTP cache, empty IndexedDB). Verify
   with `String(window.NexleySync.run).indexOf('<new code>')` before trusting a result.
7. **Never write `throw new Error('Could not save ' + note.title)`** — that defeats the
   error scrubber, which relies on quoted-span redaction.
8. **`window.confirm` blocks the renderer**, which kills browser automation dead - the
   tab stops answering and has to be closed. Stub it (`window.confirm = () => true`) before
   driving any delete or restore path in a harness. The app should keep using it; this is a
   testing note, not a reason to change the app.
9. **RLS policies are not privileges.** A policy decides *which rows* a role may touch; it
   does not grant permission to touch the table at all. That is a separate table-level
   `GRANT`, and without it every write fails with `42501 permission denied for table …`
   no matter how permissive the policy is. The original tables inherit Supabase's defaults
   and never needed one, which is exactly why this is easy to miss on a new table. Postgres
   names the fix in its own error hint — read it.
10. **A new store has FIVE homes, not one.** Adding `papers` needed: the IndexedDB
   migration, `refresh()`, `snapshot()`, `restore()`, `exportAll()` and the import merge.
   Miss `snapshot()`/`restore()` and a restore silently wipes the new store - which is
   exactly the class of bug this app's architecture exists to prevent, and it was live in
   the working tree for about twenty minutes on 09-04 before a browser pass caught it.
   `grep -n "all('cards')" app/app.js` finds every place a new store belongs.
16. **A collapsed browser viewport makes every dashboard click a silent no-op, and you
    will read the PREVIOUS result and believe it.** The prod SQL editor tab dropped to
    639x125 mid-session (the extension reports the tab's viewport, not the window). Run
    clicks at the coordinates from an earlier screenshot then land outside the viewport and
    do nothing at all — no error — while the results panel still shows the last query's
    output. That is how migration 0021 was "applied and verified" on prod twice without
    ever running. **Before trusting any dashboard result, read `innerWidth`/`innerHeight`
    and locate the Run button by `getBoundingClientRect()` rather than by memory**, and
    make the verification query return something that could only come from THIS run.

11. **Never let a client silently discard a failed write.** `errors.js` used to treat `42501`
   as an expected refusal and drop the batch, which made a misconfigured backend
   indistinguishable from a working one — the queue drained, the UI said "sent", nothing
   was stored. Discard only on a confirmed write.

---

12. **Two Supabase editor tabs can point at the same saved query.** Emptying one and saving
    it silently overwrites what the other just saved. Check the URL, not the tab title.

13. **`.fld input[type=number]` beats almost every component rule in `app.css`.** It is
    specificity (0,2,1) and sits at ~line 955, so any later-in-the-cascade-but-less-specific
    rule for an input inside a dialog field loses to it *silently*. It had been stretching
    every mark box in the question rows to `width:100%` for as long as those rows have
    existed, and it beat the `@media (pointer:coarse)` sizing too, so iPads had it worst.
    Component rules for inputs inside `.fld` need to be scoped (`.fld .qrow input.q-num`),
    not just written later. If a width or padding you set "isn't applying", check this rule
    first — the browser's computed value will tell you in seconds what reading the file
    will not.

15. **Anything written back into IndexedDB from an old copy of itself must be
    re-stamped.** Restore wrote snapshot records back verbatim, which looked
    completely correct locally and could not survive sync: push is gated on
    `pushedRev < rev` and a snapshot's record has them equal, so it never went
    out; and pull is "newest `updated` wins" (sync.js ~248), so the tombstone
    still on the server — newer than the record being restored — came back down
    and deleted it again. The note reappeared, then vanished at the next sync,
    with nothing in the UI to explain it. Fixed 09-06 by `stamp()`ing every
    restored record and dropping `pushedRev`.

    **Import had the same fault and it was live.** An export contains raw
    records, so a note that was in sync on the exporting device arrives with
    `pushedRev === rev` (confirmed against production: rev 8, pushedRev 8) —
    written back verbatim it is already "sent" as far as push is concerned, so
    importing onto a second device showed the notes locally and never once put
    them on the account. Fixed 09-06 by dropping `pushedRev` on import.
    `updated` is deliberately left alone there, unlike restore: it is real
    information the merge uses to decide what is newer, and re-stamping would
    let an old export beat newer work.

    Any future feature that revives old records — undo, conflict repair, a
    second import path — has this waiting for it. Two questions to ask: will
    it push (`pushedRev < rev`), and will it survive the next pull
    (`updated` newer than the server's copy).

14. **Never write a repo file with Python's text-mode `open(p,'w')` on this machine.**
    Windows translates `\n` to `\r\n`, so a two-line edit silently rewrites every line
    ending in the file. The extraction tests (`test_matcher`, `test_confidence`,
    `test_feedback`) match markers containing `\n` and all three fail instantly with
    "could not extract" — which reads like you broke a function when you only changed a
    string. The tracked files are LF. Use `open(p,'wb')` and bytes, or the Edit tool.

---

## Useful facts

- **Deploy is `git push origin main`.** GitHub Pages, live in ~30-60s. **PAT `nexley-deploy`
  expires 2026-09-29** - pushes fail after that until renewed.
- Supabase: prod `qvijxnhigqfoinuitrue`, dev `yvlcpngoplecigblxnkb`. Local
  (`127.0.0.1`/`localhost`) automatically points at **dev** - see `config.js`.
  **Region: `ap-northeast-1` (Tokyo).** Both auto-pause after ~7 days idle on the free tier.
- **Edge functions CAN be written and deployed in the browser** — Functions > Deploy a
  new function > Via Editor. No CLI needed, contrary to what this file used to imply.
  "Verify JWT with legacy secret" should stay OFF for `ai`: it does its own JWT check
  in code, which is what Supabase itself recommends for that case.
- **No Supabase CLI.** Migrations are applied by hand in the dashboard SQL editor;
  `supabase/migrations/` is a record of what was run, not something that runs itself. Apply
  to **both** prod and dev. The Chrome extension loads SQL into the editor
  (`window.monaco.editor.getModels()[0].setValue(sql)`) **and can click Run itself** — the
  extension's `computer` click on the Run button works, so ComputerControl is NOT needed
  for this and the earlier claim here that it was has been corrected (09-06). Even easier:
  have the page `fetch()` the migration from its raw.githubusercontent URL after pushing,
  which avoids pasting 20KB of SQL through a tool call.
  **Verify against the server afterwards, never the dashboard**, and verify GRANTS by
  listing `role_table_grants` rather than trusting the `grant` line you wrote — Supabase's
  default privileges add extras you did not ask for (that is how 0019 was found).
  **Run dev first, always.** 0016's first draft died on dev with 42P07 because a
  `profiles` table has existed since 0001; on prod that would have been a live surprise.
- Testable hooks: `NexleySync.run/status`, `NexleyErrors._capture/report/diagnostics/pending`,
  `NexleyAnalytics.sanitize/track/events/flush/pending`, `NexleyDB.all/get/put`.
- **Adding an analytics event takes two edits** - the `ALLOWED` map in `analytics.js` and the
  CHECK constraint (now in migration 0012, which drops and replaces 0007's).
  `test/test_events.js` really does assert the two lists match now - for seven versions
  that claim was only a comment, and writing the test turned up SEVEN declared events that
  nothing had ever emitted. It also checks every declared event is actually fired
  somewhere, which is what caught them.
- **A second reply on the same feedback item is only visible because seen-state is keyed
  by id AND rev.** The dashboard bumping `rev` on every update (0003's auto-touch branch)
  is what makes that work, so do not "simplify" the key to just the id.
