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
- **A third bug the wrap would have shipped with, and this one was a guaranteed crash.**
  `ios/App/App/Info.plist` had **no usage strings at all** — no
  `NSCameraUsageDescription`, no `NSPhotoLibraryUsageDescription` — while `app/app.html`
  has two `capture="environment"` file inputs (a photo attached to a note, and a photo of
  a marked paper). Inside a WKWebView those open the system camera and photo picker, and
  iOS does **not** show a permission prompt when the string is missing: it **terminates
  the app**. Every camera tap in the iOS build would have killed it, the first time a
  student tried to photograph a page. Both strings are in now, worded as reasons rather
  than requests because a reviewer reads them and Apple rejects vague ones. Found from
  the "justify every permission the native wrap requests" line on the App Store checklist
  in `GROWTH_AND_LAUNCH.md` §11 — not from testing, because none of this can be tested
  without a device.
  `test/test_native_permissions.js` now holds the invariant in the direction the drift
  actually goes: it reads what the *web* app does and asserts the *native* shells have
  kept up. It also fails if either shell starts asking for something Nexley does not use.
  🔲 **Still worth a look before submission, not changed here:**
  `UIRequiredDeviceCapabilities` is still Capacitor's scaffold default of `armv7`, which
  is 32-bit and wrong for an arm64-only modern iOS app. Left alone deliberately — it is a
  build-and-upload concern, and changing device capabilities blind, with no way to run a
  build, risks trading a cosmetic wrong for a real one.
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

## Google + Apple sign-in — the account setup, since neither can be done from code

`signInGoogle()` and `signInApple()` are both already written (`app/auth.js`) and the
buttons are in the sign-in gate (Apple above Google, per Apple's own prominence rule —
`app/app.html`). Neither will actually work until the OAuth app exists on the
provider's side and is wired into Supabase Auth. Nothing below can be delegated —
each step needs an account (Alec's Google account, Apple ID) or a decision the app
can't make for itself.

### Google — the shorter one, no paid enrollment needed
1. **console.cloud.google.com** → create a project (or use an existing one) →
   **APIs & Services → OAuth consent screen**. App name "Nexley", your email as
   support contact, External user type (anyone with a Google account, not just an
   org). Scopes: the defaults (email, profile) are enough — Nexley never asks for
   more than a name and an email.
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → type
   **Web application**.
3. **Authorized redirect URIs** — add both, since Nexley has a dev and a prod
   Supabase project (see `app/config.js`):
   - `https://qvijxnhigqfoinuitrue.supabase.co/auth/v1/callback` (prod)
   - `https://yvlcpngoplecigblxnkb.supabase.co/auth/v1/callback` (dev, optional —
     only needed if Google sign-in is worth testing locally before it matters live)
4. Copy the **Client ID** and **Client Secret** it generates.
5. **Supabase Dashboard → Authentication → Providers → Google** (on the **prod**
   project) → toggle it on → paste the Client ID and Client Secret → Save.
6. Test it: open the live site, click "Continue with Google". No app review, no
   waiting — this works the moment step 5 is saved.

### Apple — needs the Developer Program enrollment, same one blocking TestFlight
**Do this at the same time as the TestFlight enrollment in the section above** — it's
one $99/yr wait, not two. Everything below assumes that's done.

1. **developer.apple.com/account → Certificates, Identifiers & Profiles →
   Identifiers** → open the existing App ID (`com.nexley.app`) → enable the
   **Sign In with Apple** capability → Save.
2. **Identifiers → + → Services IDs** → create a new one, e.g.
   `com.nexley.app.signin` (a Services ID is a separate identifier from the App ID —
   this is the one Apple treats as the "web client" for Sign in with Apple).
3. Edit that Services ID → enable **Sign In with Apple** → **Configure** → add:
   - **Domain**: `qvijxnhigqfoinuitrue.supabase.co`
   - **Return URL**: `https://qvijxnhigqfoinuitrue.supabase.co/auth/v1/callback`
4. **Certificates, Identifiers & Profiles → Keys → +** → name it, enable
   **Sign In with Apple**, associate it with the `com.nexley.app` App ID → Continue
   → download the `.p8` file (**only downloads once** — same warning as the App
   Store Connect API key above) → note the **Key ID** shown on screen.
5. Note the **Team ID** (Membership page — same one already needed for the
   TestFlight secrets above).
6. **Supabase Dashboard → Authentication → Providers → Apple** (prod project) →
   toggle it on → fill in:
   - **Client ID(s)**: the Services ID from step 2 (`com.nexley.app.signin`)
   - **Secret Key (for OAuth)**: the full contents of the `.p8` file
   - **Key ID**: from step 4
   - **Team ID**: from step 5
   Save.
7. Test it: "Continue with Apple" on the live site. Apple sign-in also works inside
   the native wrap once Phase 8 ships — no separate mobile-specific config needed
   for this part.

## Home-screen widget — Android done, iOS genuinely blocked, not just untested

**What it shows:** "N things due this week" and the next one by name and date, read
from `app/widget.js`, which writes a small JSON summary (count + next task only — no
subject content, no marks) via `@capacitor/preferences` every time the term-planning
view renders. No new server calls; it's the same data the app already has.

### Android — built, needs a real-device test but has no known blocker
- `android/app/src/main/java/com/nexley/app/DueWidgetProvider.kt` — reads the same
  `CapacitorStorage` SharedPreferences file the JS plugin already writes to (verified
  against the plugin's own Android source, 09-07).
- `res/xml/due_widget_info.xml`, `res/layout/widget_due.xml`, and the manifest
  `<receiver>` entry are all in place.
- **Written without a device or emulator — "compiles" and "renders correctly on a
  real home screen" are different claims.** Build the debug APK (already automatic
  on every push) and actually add the widget before trusting it.

### iOS — a real architectural blocker, not just "unverified"
Two separate problems stack here, and the second one is not a testing gap, it's a
missing piece:
1. **A Widget Extension is a new Xcode target.** Adding one normally means either
   doing it in Xcode (needs a Mac, which breaks Phase 8's whole "no Mac, ever"
   promise) or scripting the `.pbxproj` file (technically possible — the `xcodeproj`
   Ruby gem is already a transitive dependency via fastlane/CocoaPods — but
   unverifiable from here: no Mac, no Xcode, no simulator, and a wrong `.pbxproj`
   edit risks breaking the iOS project that already builds today).
2. **Checked 09-07: `@capacitor/preferences`'s iOS side writes to
   `UserDefaults.standard`, not an App Group suite** (see
   `node_modules/@capacitor/preferences/ios/Sources/PreferencesPlugin/Preferences.swift`).
   A widget extension runs in its own sandbox, separate from the main app — it
   cannot read the main app's `UserDefaults.standard` at all, App Group or not, this
   is not a permissions toggle. Making the data actually reach a widget needs an App
   Group capability enabled on BOTH targets plus a small native bridge change, since
   this plugin version has no App Group option to turn on.

**No Swift was written for this.** Writing a widget view that reads a value it can
architecturally never receive would look finished while being silently broken, which
is worse than leaving it undocumented. If/when this is worth doing: it needs someone
with Xcode access for the one-time target + App Group setup (a single sitting, not
ongoing), after which the JS side (`widget.js`) needs a few added lines to also write
to the shared suite. Flagging this now so a future session doesn't rediscover the
same blocker from zero.

## Why this is deliberately still not started

Nothing above commits you to anything — the workflows sit idle until the secrets exist.
The original plan called Phase 8 deliberately late (store review blocks daily
iteration, so the PWA stays the dev vehicle until the product is worth freezing); doing
the scaffolding now doesn't change that trade-off, it just means step 6/7 are a `git
tag` away whenever you decide it's time.
