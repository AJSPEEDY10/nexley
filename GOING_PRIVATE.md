# Making the repo private — without buying a domain, and without breaking the iPad

**Why it is public today:** GitHub Pages on a free account can only serve a **public** repo.
Private Pages needs a paid plan (~$4 USD/mo). That was never a decision about openness — it
was the price of the site being live at all.

**The free way out:** Cloudflare Pages deploys **private** GitHub repos on its free tier and
gives you an HTTPS address like `nexley.pages.dev`. That is a real origin: the iPad installs
the PWA from it exactly as it does now. **No domain purchase is required.** When `nexley.app`
is worth buying (~$14.20/yr, checked available 2026-09-07), it points at the same deployment
and `pages.dev` keeps working — so a device installed on `pages.dev` never has to migrate a
second time.

**Local-only is not an option, and it is worth knowing why.** iOS registers a service worker
only over HTTPS, and the iPad is not `localhost`. Serving from `serve.py` means no offline, no
home-screen install, and the PC has to be awake on the same network. It would not even remove
the cloud — sync goes to Supabase either way. Local hosting costs the iPad.

---

## What going private does and does not hide

**Hides:** the commit history, `supabase/migrations/` (the whole schema and every RLS policy),
`HANDOVER.md` / `PHASE8.md` (roadmap, unfinished work, known traps), the test suite, the
native wrap config, and one-click cloning.

**Does NOT hide the app.** Nexley is a PWA: every byte of `app/*.js` and `app/*.css` is
downloaded into the browser of anyone who opens the site, readable in devtools and saveable as
a folder. No repo setting changes that. Going private hides the workshop, not the product.

**Audited 2026-09-10 — no secret has ever been committed.** All 156 commits scanned: the only
key-shaped strings are the two `sb_publishable_*` anon keys, which are public by design and
shipped to every browser anyway. **Nothing needs rotating.** As of that date the repo had 0
forks, 0 stars, 0 watchers.

The sharpest reason to go private is not code theft — it is that a public repo tells anyone
exactly which guard is missing. Migration 0022 is committed and unapplied on prod.

---

## ⚠️ Do these two BEFORE anything else

1. **Sync the iPad.** A new origin means a new browser storage area, so a device's local
   IndexedDB does not come with it. Synced notes re-pull from Supabase on first sign-in;
   anything **unsynced** on that device is stranded with no way back. Open the app, let it
   sync, confirm the status line says so.
2. **Do not flip the repo to private until the new host is verified serving.** Pages stops
   the moment a free-account repo goes private. Stand up Cloudflare, prove it works, *then*
   flip. Out of order, the live site goes down.

---

## The move

**Only Alec can do step 1** — Claude cannot create accounts or enter passwords.

1. **Create a Cloudflare account** — free, no card needed for Pages.
2. Workers & Pages → Create → Pages → **Connect to Git** → authorise GitHub → pick `nexley`.
3. **Build settings: there is no build.** Framework preset *None*, build command **empty**,
   build output directory **`app`**. (`app/` is the whole site — see DEPLOY.md.)
4. Deploy. Note the assigned `*.pages.dev` address.

**Then, and these are the ones that break silently if skipped:**

5. **The 27 hardcoded origin references.** `git grep -n "ajspeedy10\.github\.io"` — 15 files.
   Most are canonical/`og:`/sitemap/robots and are cosmetic-but-wrong. Two are not:
   - `supabase/functions/ai/index.ts` and `.../delete-account/index.ts` hardcode
     `DEFAULT_ORIGIN = 'https://ajspeedy10.github.io'`. **The moment the pending CORS fix is
     deployed, both functions fail closed against the new origin** — AI marking and delete
     account stop working. Today they survive only because the stale deployed build still
     answers `*`, i.e. the vulnerable build is the only thing keeping them reachable. Deploy
     the fix and set the origin in the same pass. Simplest: set `ALLOWED_ORIGIN` in Edge
     Function secrets to the new origin, which needs no code change at all.
   - `test/test_head.js` and `test/test_edge_cors.js` assert the origin and will go red. That
     is the tests doing their job — update the constants with everything else.
6. **Supabase Auth redirect URLs** — Authentication → URL Configuration, on **both** the prod
   (`qvijxnhigqfoinuitrue`) and dev (`yvlcpngoplecigblxnkb`) projects. Sign-in silently fails
   to return to the app if this is missed.
7. **Verify on the new origin before flipping anything**: sign in, a note syncs, the service
   worker registers, and the app installs to an iPad home screen.
8. **Now** flip the GitHub repo to private (Settings → General → Danger Zone).
9. **On the iPad: remove the old home-screen icon and re-add from the new address.** The old
   icon points at the old origin and its cached service worker will keep serving the old site
   on that device indefinitely.
10. `brand/README.md` — the QR codes encode the old URL and are already marked "do not print
    yet". Regenerate them after the move, not before.

---

## Afterwards

`.github/workflows/deploy.yml` (GitHub Pages) becomes dead weight — Cloudflare deploys on push
by itself. The Android debug-build workflow is unaffected and keeps working on a private repo.
The deploy PAT `nexley-deploy` expiring 2026-09-29 stops mattering for the site, though it is
still what pushes.
