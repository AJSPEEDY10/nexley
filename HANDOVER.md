# Nexley — session handover

**Session:** 2026-09-02 → 09-03 · **Ended at:** v0.9.2, SW cache `nexley-v16`, commit `9f6a739`
**Repo:** `C:\Users\PC\Nexley` · deploy = `git push origin main` (GitHub Pages, live in ~30–60s)
**Live:** landing `https://ajspeedy10.github.io/nexley/` · app `https://ajspeedy10.github.io/nexley/app.html`

> Kept out of the public repo? **No — this file is committed.** It contains no secrets.
> Private planning notes live in `GROWTH_AND_LAUNCH.md` and `ideas/`, both gitignored.

---

## 🔴 Do these first

1. **Apply `supabase/migrations/0004_bug_reports.sql`** to prod (and dev) via the Supabase
   SQL editor. Until it exists, crash reports and "Report a problem" submissions queue in
   the user's browser and retry forever — nothing is stored, nothing breaks.
   **Read the comment on the `bug_reports_insert_anon` policy before running it.** Keeping
   it is what allows crashes *before* sign-in to be reported (sign-in screen, OAuth
   redirect, intro — where new-user bugs live). The cost is an unauthenticated write path:
   nobody can read the table either way, but someone could fill it with junk. Recommendation
   is keep it, drop it if abused — deleting that one block is the whole change.

2. **Ask Alec what the Google error page actually said.** He hit one on 09-03. A regression
   was found and fixed (see below) that fits the symptom, but that is inference, not proof.
   If it said something specific — a Google `Error 400`, a Supabase message, a blank page —
   it either confirms the fix or points somewhere else.

3. **Alec has not eyeballed any of this on his iPad yet.** Particularly the ruled-paper
   alignment (a real bug was fixed there — see below) and the phone drawer.

---

## What was done

Eleven commits, all pushed and live. In order:

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

---

## What needs doing next

**Agreed build order, in order:**

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
- Testable hooks: `NexleyErrors._capture/report/diagnostics/pending/flush`,
  `NexleyAnalytics.sanitize/track/events`, `NexleyDB.all/get/put`, `NexleySync.run`.
- To test the sign-up path without making real accounts: copy `app.html`, `sed` the
  `auth.js` script tag to a stub that fakes `window.NexleyAuth` + a `from()` query builder
  over in-memory tables. That harness caught a bug where the seed logic read `state`
  instead of the store and **seeded a General/Welcome pair on top of a returning user's
  real notebook**. Delete the harness files before committing.

Deeper detail lives in Claude's memory: `project_nexley_deployment`,
`project_nexley_redesign`, `project_nexley_bug_reporting`, `project_nexley_ideas`.
