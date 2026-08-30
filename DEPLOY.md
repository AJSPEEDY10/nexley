# Getting Nexley onto the iPad

The app is already offline-capable. The only thing missing is a one-time HTTPS address for
Safari to install it from.

**Why HTTPS and not the local server:** iOS refuses to register a service worker over plain
`http://`, and without the service worker there is no offline mode. `localhost` is the only
exception, and the iPad isn't localhost.

**What gets published:** the app itself — HTML, CSS, JS, icons. **No notes.** There is no
server and no database behind it; every note lives in IndexedDB on whichever device wrote it.
Anyone with the URL would see an empty notebook.

---

## Option A — Netlify Drop (fastest, ~2 minutes)

Best if you just want it on the iPad today.

1. Go to **app.netlify.com/drop**
2. Drag the **`app`** folder onto the page
3. It gives you an address like `https://something-random.netlify.app`
4. Sign in (GitHub or email) so the site doesn't expire
5. On the iPad: open that address in **Safari** → **Share** → **Add to Home Screen**

Done. It now works with no network at all.

**To update:** re-drag the `app` folder. Fine occasionally, tedious daily.

---

## Option B — GitHub Pages (better for daily updates)

Best long-term, since after setup each update is one command.

One-time:

```powershell
winget install --id GitHub.cli -e
gh auth login          # opens a browser, sign in to GitHub
```

Then tell me and I'll do the rest — create the repo, push `app/`, enable Pages, and hand you
the URL. After that, updating is a single push whenever you want.

The repo will be **public** unless you say otherwise. That means the app's source is visible.
There is nothing sensitive in it — no notes, no keys, no personal data — but it's your call,
and a private repo with Pages is also possible.

---

## After it's installed

- **It works with no network.** The service worker precaches everything on first load.
- **Updates land whenever the iPad next has a connection**, automatically.
- **Notes do not sync.** The iPad's notebook and the PC's notebook are separate. Until sync
  exists, move them with **Export** on one device and **Import** on the other — the export
  file goes to Files, and AirDrop moves it across.
- **Check the sidebar.** It shows either *Storage protected* or *Export regularly*. If it says
  the latter, the browser hasn't guaranteed your data — installing to the home screen usually
  fixes it, and exporting is the backstop either way.

---

## What stays local

The `Nexley.bat` local server still works exactly as before for building and testing on the
PC. Nothing about publishing changes that, and the firewall / LAN setup is no longer needed
unless you want the iPad talking to the PC directly.
