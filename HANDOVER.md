# Nexley - session handover

**Session:** 2026-09-02 to 09-05 · **Ended at:** v0.19.1, SW cache `nexley-v30`
**Backend:** migrations 0005-0015 applied to prod **and** dev.
**Edge function:** `ai` deployed to prod and **WORKING** — Groq key is in. **Sync verified working.**
**Repo:** `C:\Users\PC\Nexley` · deploy = `git push origin main`
**Live:** landing `https://ajspeedy10.github.io/nexley/` · app `.../nexley/app.html`
**Tests:** `node test/test_parser.js`, `test_matcher.js`, `test_confidence.js`,
`test_feedback.js`, `test_marks.js`, `test_plan.js`, `test_events.js`,
`test_marking.js` - all green (230 assertions).
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

**Phase 8 - native wrap.** Capacitor, cloud build (no Mac needed), TestFlight, private
invites. Deliberately late: store review blocks daily iteration, so the PWA stays the
development vehicle until the product is worth freezing. Handwriting capture lands here -
target every device, not M-series iPads only.

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
- **RULE 2 IS STILL TOO ABSOLUTE and should be refined.** It currently says
  outside knowledge may never withhold a mark. But a criterion reading "correctly
  states the duration" cannot be judged WITHOUT knowing what is correct. The real
  distinction is: using knowledge to judge whether what was written is correct is
  legitimate; ADDING a requirement the criterion never stated is not. Reword
  before this reaches any UI.
- **NEXT: the adversarial case set.** Criteria deliberately silent on a detail;
  half-right answers; correct-but-differently-worded; factually wrong on
  something the criteria do not cover; ambiguous criteria. Run as one batch and
  judge the invention rate across all of them — one case at a time burns quota
  and proves little. This is the same method that caught the matcher's stopword
  bug.
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

### Design directions - decision still open
Five full prototypes built 09-03. Alec's call was "combine the best of everything,
professional, easy to navigate, not vibecoded". The token system in `app.css` is the
foundation for that; individual screens have not been restyled yet.

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
11. **Never let a client silently discard a failed write.** `errors.js` used to treat `42501`
   as an expected refusal and drop the batch, which made a misconfigured backend
   indistinguishable from a working one — the queue drained, the UI said "sent", nothing
   was stored. Discard only on a confirmed write.

---

12. **Two Supabase editor tabs can point at the same saved query.** Emptying one and saving
    it silently overwrites what the other just saved. Check the URL, not the tab title.

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
  to **both** prod and dev. The Chrome extension can load SQL into the editor
  (`window.monaco.editor.getModels()[0].setValue(sql)`) but is blocked from executing it;
  ComputerControl clicks Run. **Verify against the server afterwards, never the dashboard.**
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
