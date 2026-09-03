# Nexley — session handover

**Session:** 2026-09-02 → 09-03 · **Ended at:** v0.9.3, SW cache `nexley-v17`, commit `4f1a604`
**Backend:** migration 0004 applied to prod **and** dev; reporting verified working live.
**Repo:** `C:\Users\PC\Nexley` · deploy = `git push origin main` (GitHub Pages, live in ~30–60s)
**Live:** landing `https://ajspeedy10.github.io/nexley/` · app `https://ajspeedy10.github.io/nexley/app.html`

> Kept out of the public repo? **No — this file is committed.** It contains no secrets.
> Private planning notes live in `GROWTH_AND_LAUNCH.md` and `ideas/`, both gitignored.

---

## 🔴 Do these first

1. **SYNC HAS NEVER WORKED. Apply migration 0005.** Found 2026-09-03 by asking the
   deployed app, signed in as Alec, to do what sync does. Every table answered
   `42501 permission denied` (subjects, syllabus, notes, profiles) and
   `localStorage['lastPullAt:<uid>']` was **null** — no full round trip has ever
   completed on that account. Notes have only ever existed on the device that typed
   them, and the welcome note's promise that work "syncs to your account" has never
   been true. Two independent faults, either fatal on its own:
   - **No table GRANTs.** Exactly trap 8 again, on the *original* tables. 0004's
     header reasoned they "inherit Supabase's defaults" — that was wrong.
   - **`id` columns are `uuid`; `uid()` does not emit uuids** (`mtfgzh94-ib5yby`).
     Fixing only the grants swaps 42501 for `22P02 invalid input syntax for type uuid`.
   `supabase/migrations/0005_fix_sync_grants_and_id_type.sql` fixes both and is safe to
   run — the tables are empty *because* sync never worked, so the type change rewrites
   nothing. Apply to **prod and dev**, then verify with the app, not the client.
   ⚠️ I could not apply it: browser automation to the Supabase dashboard is blocked in
   this environment. It needs you.

2. **Then apply 0006 (cards).** Review mode's table. Until it exists the client skips
   card sync deliberately and keeps the records unpushed — nothing is lost, and notes
   sync is not taken down with it.

3. **Ask Alec what the Google error page actually said.** Still open from 09-02.

4. **Alec has not eyeballed any of this on an iPad.**

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
