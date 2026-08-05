# Summit Education — Phase 1

A local, single-user study notebook. **No App Store, no website, no server, no account
service.** Everything you write is stored in this browser profile on this computer.

Working name only — see `Brain-Obsidian\Ideas\Summit Education — Build Plan.md`.

---

**Target device: iPads and pen-capable computers.** The UI is built touch-first — 44px hit
targets, no hover-only controls, no pinch-zoom fighting the writing surface.

---

## Running it

Double-click **`Summit.bat`**. It starts a tiny local server and prints two addresses.
Close the black window to stop it.

### On this PC
Opens automatically. To get a real app window rather than a browser tab, click the
**install icon** in Chrome's address bar (or ⋮ → Cast, save and share → Install page as app).
Own window, own icon, Start-menu entry.

### On your iPad
The window prints a second address like `http://192.168.86.24:8770/index.html`.
Open that in **Safari**, then **Share → Add to Home Screen**.

Both devices must be on the same Wi-Fi, and `Summit.bat` has to be running on the PC.

#### Windows Firewall — one-time setup

Binding to the network makes Windows prompt. Two things need to be true before an iPad can
connect, and both need administrator rights:

1. **Your home Wi-Fi must be classified Private.** Windows often defaults it to Public, and
   inbound connections are blocked on Public.
2. **TCP 8770 must be allowed inbound on the Private profile.**

Run this once — it triggers a UAC prompt:

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command',
  'Set-NetConnectionProfile -Name "YOUR WIFI NAME" -NetworkCategory Private;
   New-NetFirewallRule -DisplayName "Summit Education (local dev)" -Direction Inbound
     -Action Allow -Protocol TCP -LocalPort 8770 -Profile Private;
   Read-Host "Done - press Enter"'
```

**Do not allow this on Public networks.** Leave any existing Public block rules for
`python.exe` exactly where they are — school and café Wi-Fi should never reach this.

🔓 **The server has no password.** Anyone on the same Wi-Fi who knows the address can read
and write your notes. On a home network that's your family; on a public one it would be
everybody. That's the whole reason for the Private-only rule above.

⚠️ **Notes do not sync between devices yet.** Each device keeps its own notebook.
That's Phase 2.5 — until then, Export on one and Import on the other.

⚠️ **On iPad there's no offline mode.** Service workers need HTTPS (localhost is the only
exception), so over Wi-Fi the worker won't register. The app works fine; it just needs the
PC running. This goes away when it's eventually served over HTTPS.

---

## What Phase 1 does

- **Create an account** — name and an optional passcode, stored locally
- **Subjects** — add, rename, recolour, delete
- **Notes** — write, format, file under a subject, autosave
- **Search** — across every note you've written (`Ctrl+K`)
- **Note font** — Standard / Serif / Handwritten (the seed of the handwriting idea)
- **Export / Import** — full JSON dump of everything, any time

Shortcuts: `Ctrl+S` save now · `Ctrl+K` search · `Ctrl+B/I/U` formatting

---

## Two honest warnings

**The passcode is not security.** It stops someone idly opening the app. It does *not*
encrypt anything — anyone with access to this PC can read the database directly through
the browser's dev tools. Real protection comes later, if this ever leaves your machine.

**Your data lives in one browser profile.** If you clear site data for `localhost:8770`,
or use a different browser, the notes are gone. **Use Export regularly** until cloud sync
exists. That button is there for exactly this reason.

---

## Layout

```
SummitEducation\
  Summit.bat      ← double-click this
  serve.py        ← local server, no-cache headers
  app\
    index.html    ← markup
    app.css       ← styling and theming (light + dark)
    app.js        ← all logic, IndexedDB storage
    sw.js         ← service worker (NETWORK-FIRST on purpose — see note below)
    manifest.webmanifest
    icon.svg  icon-maskable.svg
```

### Why the service worker is network-first

The Tovo PWA got stuck serving a cached `index.html` forever, so edits never appeared no
matter how many refreshes. This one always tries the network first and only falls back to
cache when the server isn't running. **Don't flip it to cache-first for speed** — only
change it deliberately when real offline support is wanted, and bump `CACHE` when you do.

---

## Editing it

Change any file in `app\`, then refresh. No build step, no reinstall, no toolchain.
If something ever looks stale: `Ctrl+Shift+R`.

---

## What's next

**Phase 2** — the syllabus tree, notes filed against dot points rather than just a subject,
tabs, importing notes, syllabus notes alongside personal ones.

Full roadmap and all locked decisions: `Brain-Obsidian\Ideas\Summit Education — Build Plan.md`
