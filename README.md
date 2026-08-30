# Nexley

*(formerly "Summit Education" — everything says Nexley now: app, repo, site, Supabase
org/projects, local scripts, and the on-device store (`nexley`, migrated from the old
`summit-edu` on first open). Git history keeps the old commit messages, as history does.)*

A syllabus-aligned study notebook for tablets and pen-capable computers. Offline-first —
your notes are saved on-device first and always readable/writable without a connection —
and sync to your own account via Supabase whenever you're online.

---

**Target device: iPads and pen-capable computers.** The UI is built touch-first — 44px hit
targets, no hover-only controls, no pinch-zoom fighting the writing surface.

---

## Running it locally

Double-click **`Nexley.bat`**. It starts a tiny local server and prints two addresses.
Close the black window to stop it. Opening `app/index.html` directly (`file://`) instead of
through the server breaks it — service workers and some scripts are blocked under `file://`.

### On this PC
Opens automatically at `http://127.0.0.1:8770`. To get a real app window rather than a
browser tab, click the **install icon** in Chrome's address bar. Own window, own icon,
Start-menu entry.

### On your iPad
The window prints a second address like `http://192.168.86.24:8770/index.html`.
Open that in **Safari**, then **Share → Add to Home Screen**.

Both devices must be on the same Wi-Fi, and `Nexley.bat` has to be running on the PC —
this local-network route is really only useful for testing; once deployed to a real HTTPS
host, offline mode works everywhere without any of this.

---

## Accounts and data

Real accounts — email/password or Google sign-in via Supabase Auth. Local testing
(`127.0.0.1`/`localhost`) always talks to a separate **dev** Supabase project so nothing
you do while developing ever touches real user data; anywhere else talks to **production**.
See `app/config.js`.

- **Row-level security on every table**, scoped to your own account (`auth.uid()`) —
  enforced by the database itself, not just app code.
- **Offline-first**: IndexedDB on-device is the source of truth for the UI. `app/sync.js`
  pushes/pulls to Supabase in the background (on login, reconnect, tab-visible, and every
  5 min) using newest-`updated`-wins conflict resolution.
- **Deletes are tombstones**, never hard deletes — a sync can propagate a deletion instead
  of resurrecting it.
- Schema and RLS policies live in `supabase/migrations/` — every change is a migration,
  never a manual dashboard edit.

Privacy policy, terms of use, AI-use disclosure, and accessibility statement: `app/legal.html`
(linked from the sign-in screen).

---

## What's built

- **Real accounts** — email/password + Google, synced across devices
- **Subjects** — add, rename, recolour, delete
- **Syllabus tree** — topic → dot-point hierarchy; paste-to-import a syllabus structure
- **Notes** — write, format, file against a specific syllabus dot point or as personal notes,
  autosave
- **Search** — across every note you've written (`Ctrl+K`)
- **Note font** — Standard / Serif / Handwritten
- **Export / Import** — full JSON dump of everything, any time
- **Snapshots** — automatic rolling backups, plus one before every import/restore/update

Shortcuts: `Ctrl+S` save now · `Ctrl+K` search · `Ctrl+B/I/U` formatting

---

## Standing rules (do not quietly reverse these)

- **Never show a projected mark, band, or ATAR.** Only numbers for things that already
  happened — real past results, real trends against your own history.
- **The AI must never decline to help** (once AI features ship) — it says "I don't know"
  rather than invent, and must never lead toward a wrong answer.
- **No shortcuts** — this is being built to a real-launch, 10-100-users/day standard from
  day one, not a "clean up later" local prototype.

---

## Layout

```
Nexley\
  Nexley.bat        ← double-click this
  serve.py          ← local dev server, no-cache headers
  supabase\
    migrations\     ← every schema/RLS change, in order, never a manual dashboard edit
  app\
    index.html      ← markup
    app.css         ← styling and theming (light + dark)
    app.js          ← all app logic, IndexedDB storage
    config.js       ← Supabase project URL + publishable key (dev/prod picked by hostname)
    auth.js         ← Supabase Auth wrapper (email/password + Google)
    sync.js         ← IndexedDB <-> Supabase background sync
    sw.js           ← service worker (NETWORK-FIRST on purpose — see note below)
    legal.html      ← privacy policy, terms, AI-use disclosure, accessibility statement
    manifest.webmanifest
    icon.svg  icon-maskable.svg
```

### Why the service worker is network-first

The Tovo PWA once got stuck serving a cached `index.html` forever, so edits never appeared
no matter how many refreshes. This one always tries the network first and only falls back
to cache when offline. **Don't flip it to cache-first for speed** — bump `CACHE` in `sw.js`
on every release that changes any precached file.

---

## Editing it

Change any file in `app\`, then refresh. No build step, no reinstall, no toolchain.
If something ever looks stale: `Ctrl+Shift+R`, or click "Update now" if the app itself
offers it (it snapshots and flushes your work before updating — safe to click any time).

---

## Known gaps (tracked, not hidden)

- Not yet deployed anywhere public — still local-only at `127.0.0.1:8770`
- Dev Supabase project has no Google OAuth configured (email/password only there)
- No error monitoring, no CI, no automated tests beyond the syllabus parser suite
- Custom SMTP not yet configured — Supabase's default email service isn't meant for
  real signup volume
