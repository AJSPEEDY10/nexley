# Phase 8 — the native wrap

Capacitor wraps the existing PWA (`app/`) for the App Store and Play Store. **The web
app itself still has no build step** — `app/` is exactly what GitHub Pages serves today.
Capacitor only adds a packaging layer around it; nothing about how `app.js` is written
or deployed changes.

## What's done (no Apple/Google account needed for any of this)

- `package.json`, `capacitor.config.json` (`appId: com.nexley.app`, `webDir: app`).
- `android/` and `ios/` platform projects, scaffolded and synced.
- Two bugs a native wrap would otherwise have shipped with, both fixed:
  - **`app/config.js`** used `location.hostname === 'localhost'` to decide "am I in
    local dev, so point at the dev Supabase project." Capacitor's WebView serves local
    files from `https://localhost` on both iOS and Android — same hostname, wrong
    answer. Every native build would have silently pointed at dev. Fixed: `isLocal` is
    now also gated on `!window.Capacitor?.isNativePlatform()`.
  - **`app/index.html`** (the marketing page) already had a "bounce installed PWAs
    straight to app.html" redirect, but it only checked PWA display-mode. A native
    build's WebView loads `index.html` by default the same as any static host — there
    is no separate "start page" setting — so without this fix the native app would have
    opened on the marketing pitch instead of the app. Fixed: the same redirect now also
    fires when `window.Capacitor.isNativePlatform()` is true.
- `.github/workflows/android-debug-build.yml` — builds an unsigned debug APK on every
  push to main, no account or secret needed. **This is ready right now**: run it from
  the Actions tab (or wait for the next push to `app/`), download the APK artifact, and
  side-load it onto any Android device to see the native wrap working today.
- `.github/workflows/ios-certificates.yml` and `ios-testflight.yml`, plus
  `fastlane/Fastfile` / `Appfile` / `Matchfile` — ready to run, but need the secrets
  below before they'll do anything. Both run on GitHub's macOS runners; **nothing here
  ever needs a Mac.**

## What only you can do

Nothing below can be delegated — each one needs your Apple ID, your payment method, or
a decision about the app's identity that's expensive to change later.

1. **Enroll in the Apple Developer Program** — developer.apple.com/programs, $99/year,
   your Apple ID. Takes up to 48 hours to approve.
2. **Create the app in App Store Connect** (appstoreconnect.apple.com → My Apps → +) —
   bundle ID `com.nexley.app` (matches `capacitor.config.json`; changing it later means
   a new App Store listing from scratch, so flag now if you'd rather use something else,
   e.g. tied to a domain you actually own).
3. **Generate an App Store Connect API key** — Users and Access → Integrations →
   Generate API Key, role "App Manager". Download the `.p8` file — **it only downloads
   once** — and note the Key ID and Issuer ID.
4. **Create a private GitHub repo** to hold the encrypted signing certificate (fastlane
   `match` needs somewhere to put it — it must be a repo, but its contents are only ever
   an encrypted blob). Empty repo is fine, e.g. `nexley-certificates`.
5. **Add these secrets to the `nexley` repo** (Settings → Secrets and variables →
   Actions):

   | Secret | Value |
   |---|---|
   | `DEVELOPER_APP_IDENTIFIER` | `com.nexley.app` |
   | `DEVELOPER_APP_ID` | the app's Apple ID, from App Store Connect → App Information |
   | `FASTLANE_APPLE_ID` | your Apple ID email |
   | `APP_STORE_CONNECT_TEAM_ID` | from App Store Connect → Membership |
   | `DEVELOPER_PORTAL_TEAM_ID` | from developer.apple.com/account → Membership |
   | `APPLE_ISSUER_ID` | from the API key screen in step 3 |
   | `APPLE_KEY_ID` | from the API key screen in step 3 |
   | `APPLE_KEY_CONTENT` | the full contents of the `.p8` file from step 3 |
   | `CERTIFICATE_STORE_URL` | the git URL of the repo from step 4 |
   | `GIT_USERNAME` | your GitHub username |
   | `GIT_TOKEN` | a GitHub personal access token with `repo` scope on the certs repo |
   | `MATCH_PASSWORD` | any passphrase you choose — encrypts the cert in the certs repo |
   | `TEMP_KEYCHAIN_USER` | any string, e.g. `nexley-ci` |
   | `TEMP_KEYCHAIN_PASSWORD` | any string |

6. **Run `ios-certificates.yml` once** (Actions tab → "iOS - generate signing
   certificates" → Run workflow). This is the only signing setup step, and it runs on
   GitHub's macOS runner — still no Mac.
7. **Tag a release to ship a TestFlight build**: `git tag v0.20.0 && git push origin
   v0.20.0` triggers `ios-testflight.yml`, which builds and uploads. It uploads as an
   internal build only (`distribute_external: false`) — inviting testers is a separate
   step in App Store Connect → TestFlight, which is also where you add the private
   invites this phase was meant to support.

## Why this is deliberately still not started

Nothing above commits you to anything — the workflows sit idle until the secrets exist.
The original plan called Phase 8 deliberately late (store review blocks daily
iteration, so the PWA stays the dev vehicle until the product is worth freezing); doing
the scaffolding now doesn't change that trade-off, it just means step 6/7 are a `git
tag` away whenever you decide it's time.
