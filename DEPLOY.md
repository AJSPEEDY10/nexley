# Getting Nexley onto a device

**It is already live.** The setup instructions this file used to carry — pick a host, get an
HTTPS address, "tell me and I'll create the repo" — were all completed weeks ago, and the
"notes do not sync" warning stopped being true on 4 September. This is the current version.

| | |
|---|---|
| **Live site** | `https://ajspeedy10.github.io/nexley/` — the landing page |
| **The app itself** | `https://ajspeedy10.github.io/nexley/app.html` |
| **Deploy** | `git push origin main`. `.github/workflows/deploy.yml` publishes `app/` to GitHub Pages; live in ~30–60s |
| **Local dev** | `Nexley.bat` (runs `serve.py`). `127.0.0.1`/`localhost` automatically points at the **dev** Supabase project — see `app/config.js` |

⚠️ The deploy PAT `nexley-deploy` **expires 2026-09-29**. Pushes fail after that until it's
renewed.

---

## ⚠️ Edge functions are the one thing `git push` does NOT deploy

The app is GitHub Pages, so pushing **is** deploying. `supabase/functions/` is not: those are
deployed separately and otherwise sit on whatever build was last pushed to Supabase, silently,
with every test still green — because every test reads the repo and none of them ask the server.

**This has already cost two days.** On 08-09 both functions were fixed to stop answering
`Access-Control-Allow-Origin: *` to any origin on the internet, committed and pushed. Nothing
deployed them. On 10-09 production was still serving `*`.

So after changing anything under `supabase/functions/`:

```
node test/probe_deploy_drift.js          # PROD  — exit 1 means deploy it
node test/probe_deploy_drift.js --dev    # dev
```

It needs no credential (a CORS preflight is public and unauthenticated), so it is safe to run
any time, and it distinguishes **DRIFT** (old build deployed) from **ABSENT** (404 — never
deployed here; the `*` on that response is Cloudflare's, not ours).

**To deploy one:** Supabase dashboard → Edge Functions → the function → **Code** → paste
`supabase/functions/<name>/index.ts` → **Deploy updates**. No CLI needed. `npx supabase login`
once would also let `npx supabase functions deploy <name>` do it from here.

`test/test_edge_cors.js` is the other half — it proves the *source* fails closed, and runs in
the normal suite. Neither test replaces the other: one stops the code regressing, the other
stops the deploy being forgotten.

---

## Install it on an iPad or phone (PWA)

1. Open **`https://ajspeedy10.github.io/nexley/app.html`** in **Safari** (iOS) or Chrome
   (Android).
2. **Share → Add to Home Screen.**
3. Sign in once. From then on it opens like an app, full screen, and works with no network.

**Why Safari specifically on iOS:** the service worker is what makes offline work, and iOS only
registers one over HTTPS. That's also why the local `Nexley.bat` server can't be the install
source — `localhost` is the only plain-HTTP exception and the iPad isn't localhost.

**The home-screen icon points at `app.html`** (`start_url` in `manifest.webmanifest`), so it
opens the app, not the marketing page. An icon added before 3 September has the old
`start_url` baked in — `app/index.html` bounces those into the app automatically, but removing
and re-adding the icon is cleaner.

---

## Install it as a real Android app (APK)

`.github/workflows/android-debug-build.yml` builds an **unsigned debug APK** on every push that
touches `app/`, `android/`, `capacitor.config.json` or `package.json`. No Google account, no
keystore, no fee.

1. GitHub → **Actions** → *Android - debug build* → the newest run.
2. Download **`nexley-android-debug`** from **Artifacts** (kept 30 days).
3. On the phone: allow install from unknown sources, open the file.

That is a genuine native wrap (Capacitor) with the widget, local notifications and camera —
not a bookmark. **iOS/TestFlight is blocked** on an Apple Developer enrolment ($99/yr, Alec's
own Apple ID) plus six one-time account steps; every step is written out in `PHASE8.md`.

---

## What gets published, and what doesn't

**Published:** the contents of `app/` — HTML, CSS, JS, icons, fonts. That's the whole site;
there is no build step.

**Not published:** anything under `ideas/` (gitignored — that's where the research videos live),
Supabase keys beyond the publishable anon key (which is designed to be public; row-level
security is what protects data), and no notes of any kind. The repo is public and contains
nothing sensitive.

---

## After it's installed

- **It works with no network.** The service worker precaches the shell on first load. Network
  first when you're online, so edits show up immediately rather than being stuck behind a cache.
- **Updates land automatically** whenever the device next has a connection. Releasing bumps
  `CACHE` in `app/sw.js`, which is what tells an installed copy to take the new files — see the
  release ritual in `HANDOVER.md` and the history in `CHANGELOG.md`.
- **Notes sync.** Every device signed into the same account converges: written to IndexedDB
  locally first (so it works offline), pushed to Supabase when there's a connection. Export /
  Import still exist, but they're for backups and moving between accounts now, not for getting
  a note from the PC to the iPad.
- **Check the sidebar.** It says either *Storage protected* or *Export regularly*. The latter
  means the browser hasn't guaranteed local data — installing to the home screen usually fixes
  it, and a snapshot plus sync is the backstop either way.

---

## If something looks wrong after a deploy

1. **Check the version.** Settings shows `Nexley vX.Y.Z`; `CHANGELOG.md` says what that version
   was and which commit it is. `git checkout vX.Y.Z` gets you the exact code.
2. **Check it's actually the new build.** A hard reload (or closing and reopening the installed
   app) picks up a new service worker. If the version in Settings doesn't match `CHANGELOG.md`'s
   top entry, the device is still running the old cache.
3. **Check the deploy ran.** GitHub → Actions → *Deploy Nexley to GitHub Pages*.
