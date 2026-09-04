# Nexley - session handover

**Session:** 2026-09-02 to 09-04 · **Ended at:** v0.13.0, SW cache `nexley-v22`
**Backend:** migrations 0005-0007 applied to prod **and** dev. **Sync verified working.**
**Repo:** `C:\Users\PC\Nexley` · deploy = `git push origin main`
**Live:** landing `https://ajspeedy10.github.io/nexley/` · app `.../nexley/app.html`
**Tests:** `node test/test_parser.js`, `test_matcher.js`, `test_confidence.js` - all green

---

## Nothing is blocked on Alec

Everything that was waiting on him has been cleared or dropped:

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

Plus the design token system (97 font sizes / 61 gaps / 47 radii onto three scales).

**Bugs found and fixed along the way:** SM-2 showed `1d/1d/1d` on a new card, so three grade
buttons did nothing visibly different; `plain()` ran HTML blocks together in every excerpt;
the rail counted captures the notebook excluded; `legal.html` was styled against six CSS
variables that never existed; the code pattern read "TASK 3" as an outcome code; the Tasks
warning used a `.gap` class borrowed from a design artifact that isn't in `app.css`.

---

---

## What was done

Fourteen commits, all pushed and live. In order:

| Commit | What |
|---|---|
| `d148e5d` | Redesign pass 2b — rail mode switch, note marginalia |
| `d669e06` | Pass 2 finish — Newsreader display face, subject palette, ruled-line fixes |
| `17a61b5` | Sign-up / first-run path — five bugs |
| `8429989` | Pre-signup intro |
| `9079aaa` | Link-preview + description metadata |
| `7f158f4` | Landing page |
| `549073b` | Analytics — built, left OFF |
| `71ece61` | Landing page becomes the front door; app moves to `/app.html` |
| `1e7332e` | Crash reporting + Report a problem |
| `7019875` | Fix auth redirects landing on the landing page |
| `9f6a739` | Explicit Sign in link on the landing page |
| `71bd3d0` | This handover file |
| `01fa9b2` | Migration 0004 applied — fix the missing GRANTs, and stop reports vanishing |
| `4f1a604` | Handover updated after the migration went in |

### Design (Pass 2 is finished)
- **Rail mode switch** — Notebook / Classwork / Review. The last two are honest "not built
  yet" stubs so the nav holds their shape and isn't restructured twice. Not persisted.
- **Marginalia** — at ≥880px editor width the note apparatus becomes a real left margin
  against a margin rule. Driven by a **container query on `.editor`** with a `.ed-page`
  wrapper inside it.
- **Newsreader** self-hosted (`app/fonts/`, SIL OFL), precached and served cache-first.
  Display voice only — the writing surface stays on Iowan/Palatino deliberately.
- **Subject palette** retuned mid-tone; old defaults remapped by index on load.

### Onboarding & auth
- Pre-signup **intro** (3 panels, once per device, `nexley-intro-seen`).
- **Five sign-up bugs fixed:** `enterApp` ran twice per email sign-up; Google sign-ups were
  never seeded (empty app on first run); a sync pull never repainted (second device looked
  like your notes were gone); "check your email to confirm" was set then immediately hidden;
  `lastPullAt` was one shared key across accounts.
- **Landing page is now the site root; the app is at `/app.html`.** Installed home-screen
  icons still have the old `start_url`, so the landing page detects installed mode and
  replaces itself with the app before paint. In-app "What is Nexley?" passes `?from=app` to
  opt out of that bounce.

### Reporting
- `app/errors.js` — automatic capture (`onerror`, `unhandledrejection`) + a **Report a
  problem** button in the rail *and on the sign-in screen*. Scrubbed so note content can't
  leak. Dedupes, caps at 8/session, queues offline.
- `app/analytics.js` — PostHog, **OFF**. No key ⇒ nothing loads.

---

## Traps this session hit — don't re-learn these

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
8. **RLS policies are not privileges.** A policy decides *which rows* a role may touch; it
   does not grant permission to touch the table at all. That is a separate table-level
   `GRANT`, and without it every write fails with `42501 permission denied for table …`
   no matter how permissive the policy is. The original tables inherit Supabase's defaults
   and never needed one, which is exactly why this is easy to miss on a new table. Postgres
   names the fix in its own error hint — read it.
9. **Never let a client silently discard a failed write.** `errors.js` used to treat `42501`
   as an expected refusal and drop the batch, which made a misconfigured backend
   indistinguishable from a working one — the queue drained, the UI said "sent", nothing
   was stored. Discard only on a confirmed write.

---

## What needs doing next

**⚠️ The build order below is on hold.** On 09-03 Alec asked for five full redesign
directions to choose from before anything else ships. They are built and published:

| Direction | What it argues | Link |
|---|---|---|
| Marking Ledger | The app as an evidenced record; outcomes with receipts, marks with reasons | https://claude.ai/code/artifact/0b60cb0e-21e9-4aaa-8fd5-4095b6364f04 |
| Dark Regions | The knowledge map *is* the interface; gaps found from absence | https://claude.ai/code/artifact/f58e7806-a38c-4d0b-aada-ee3c9de17dd0 |
| Ten Weeks Out | The term as a workload problem; collisions caught weeks early | https://claude.ai/code/artifact/c90b2a37-d391-4c8a-90d6-2a56e514c703 |
| Season Four | The syllabus as the skill tree it already is; live, competitive | https://claude.ai/code/artifact/a00c8fb0-0f3a-4a45-adee-ab6b20b9cebd |
| One Block | Strip everything; protect one block of attention at a time | https://claude.ai/code/artifact/280486ef-8b6a-45d1-a5c8-5ea6b4d491b5 |

Commit `8df8853` (Classwork + Review + sync reporting, v0.10.0) is **committed locally
and deliberately not pushed** — a redesign may restructure it. Nothing is deployed from
it. `git push` when the direction is settled, or rebuild on top of whichever wins.

**Agreed build order, once a direction is picked:**

1. **Classwork mode** — quick-capture for what happens in class, graduating into notebook
   notes once filed against the syllabus. The rail stub is already there waiting.
2. **SM-2 spaced repetition ("Review")** — a due-today queue built from the user's own
   coverage. Stub also already in the rail.
3. **AI auto-filing** — the app detects what you're writing and suggests where to file it,
   with manual override. ⚠️ **Needs a privacy/consent answer before it is built**: it means
   sending student note text to an external model, and it is the one item with a running
   cost. Nexley's `legal.html` currently promises notes are not used to train any AI model.

**Smaller / open:**
- **PostHog**: needs Alec to create a project and supply the key. **`legal.html` must change
  in the same commit** — the paragraph to paste is in the header of `app/analytics.js`.
- Snapshot / dialog polish (last design item).
- `og:` URLs are pinned to the Pages address — update if Nexley gets its own domain.
- **Nexley has not been trademark-checked.**
- Deferred by Alec, do not start without him asking: **textbook-photo OCR import**, and the
  **branding decision** (is "classwork" the same feature as "notebook"? one app vs several?).
- `MEMORY.md` is near its read limit and wants compacting.

---

## Useful facts

- **Deploy PAT `nexley-deploy` expires 2026-09-29.** After that pushes fail until renewed.
- Supabase: prod `qvijxnhigqfoinuitrue`, dev `yvlcpngoplecigblxnkb`. Local
  (`127.0.0.1`/`localhost`) automatically points at **dev** — see `config.js`.
- Both Supabase projects auto-pause after ~7 days idle on the free tier.
- **There is no Supabase CLI and no linked config.** Migrations are applied by hand in the
  dashboard SQL editor, and `supabase/migrations/` is a record of what was run, not
  something that runs itself. Apply to **both** prod and dev. Alec is already logged into
  the dashboard in Chrome, so this is doable with browser automation: paste into the editor
  (Monaco — `window.monaco.editor.getModels()[0].setValue(sql)` beats typing it), Run, then
  **verify against the server** rather than trusting the client.
- Testable hooks: `NexleyErrors._capture/report/diagnostics/pending/flush`,
  `NexleyAnalytics.sanitize/track/events`, `NexleyDB.all/get/put`, `NexleySync.run`.
- To test the sign-up path without making real accounts: copy `app.html`, `sed` the
  `auth.js` script tag to a stub that fakes `window.NexleyAuth` + a `from()` query builder
  over in-memory tables. That harness caught a bug where the seed logic read `state`
  instead of the store and **seeded a General/Welcome pair on top of a returning user's
  real notebook**. Delete the harness files before committing.

Deeper detail lives in Claude's memory: `project_nexley_deployment`,
`project_nexley_redesign`, `project_nexley_bug_reporting`, `project_nexley_ideas`.
