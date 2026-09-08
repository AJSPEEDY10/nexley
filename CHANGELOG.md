# Nexley — version history

Every released version, what it was, and the commit it lives at. Reconstructed from git on
2026-09-08 by reading `APP_VERSION` out of `app/app.js` at every commit that touched it — so
this is what actually shipped, not what anyone remembers shipping.

**To go back to a version**, each one is a git tag:

```
git checkout v0.31.0      # look at it
git diff v0.31.0 v0.32.0  # what changed between two releases
git log v0.30.0..v0.31.0  # the commits inside one release
```

**A version number lives in four places and they must agree** — `APP_VERSION` in `app/app.js`,
`version` in `package.json`, `CACHE` in `app/sw.js` (bumped so returning users are served the
new files), and an entry in this file. `test/test_version.js` fails if they drift, which is
what keeps this list honest rather than aspirational.

**Why it matters beyond tidiness:** the app stamps its version into every snapshot, crash
report, feedback item and export. When one of those shows something wrong, the version says
which code produced it — but only if the number moved when the code did.

Newest first.

## v0.39.0 — 2026-09-08
Empty screens now hand you the thing to press, and people have faces.
Three creators independently reported the same finding, one with numbers: a blank first
screen with no guidance got **3 of 100** users started; adding a single button took it to
**100 of 100**. Nexley had a good `emptyState()` component with an action slot and used it in
two places, both inside Marks. The screen a brand-new account actually lands on — no subjects,
no notes — got one grey sentence, *"Add a subject first, then start writing"*, naming a button
somewhere else on the page. Telling someone what to do is not the same as giving them the
thing to do it with. That screen, the no-notes screen, the empty Review deck and the empty
inbox now all end in a real button, and each one was clicked in a harness to prove it goes
somewhere: subject dialog, note editor, and for the inbox — which cannot fill itself, because
the next step is telling a person your handle — a button that copies your username. A search
that matches nothing deliberately keeps its plain sentence: a no-results state is working
correctly, and offering "add a subject" mid-search is a non-sequitur.
**Avatars.** Usernames appeared as bare text in comps and the inbox, so a leaderboard was a
column of identical `@` prefixes. Each person now has an initial in a tone derived from a hash
of their username — same person, same mark, everywhere, with nothing stored, nothing to sync
and no upload. There is deliberately still no photo upload: a picture of a school-age user is
data this app has no reason to hold.
Three decisions inside that are not obvious. **Four tones, not a rainbow** — this app reserves
colour for verdicts so that green means an earned result, and decorating names with the palette
is how green stops meaning anything two panes over in Marks. **Their own tokens, not reuses** —
`--structure` is user-configurable through the accent setting, and an identity mark that changes
hue when you re-accent the app is not an identity mark. **Measured, not eyeballed** — the first
cut tinted `--margin-rule` and `--muted` with `color-mix` and measured **2.37:1** and 3.66:1 in
a real browser, below even the 3.0 floor for incidental UI. The tones are now explicit light and
dark pairs and the worst of the eight is **6.1:1**.
`test/test_avatar.js` extracts the real hash out of `app.js`, runs it, and parses the real
colours out of `app.css`, so neither can drift from what ships. It caught two bugs while being
written. The hash used `*` instead of `Math.imul`, and since the FNV prime overflows 2^53
immediately, the low bits carrying all the entropy were silently dropped — 600 sequential
usernames landed **465 / 14 / 100 / 21** across four tones, most of a class in one colour.
`test_type.js` then caught a hardcoded `font-size:9px` on the inbox avatar, which would have
quietly opted that element out of the reader text-size scaling shipped one version earlier.

## v0.38.0 — 2026-09-08
The auth library is Nexley's own file now, not a CDN's. `app.html` had exactly one off-origin
script — `cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js` — and it was
the script that holds the session token in `localStorage` and reaches every note in IndexedDB.
Three things made that worse than the usual CDN argument. `@2` is a range, not a version, so
which build students ran was decided by a CDN cache expiry rather than by a commit: jsDelivr
was serving 2.115.0 while npm's `latest` was already 2.116.0, and a release could have started
executing in signed-in sessions with no diff and no test run. There was no `integrity` hash, so
the browser would execute whatever bytes came back. And the requested file **is not in the npm
package at all** — Supabase publishes `dist/umd/supabase.js`; jsDelivr minifies `.min.js` on
demand, so the exact artifact being executed had no publisher-signed counterpart to check
against. It was also precached by the service worker, which would have pinned a bad version
into every user's cache until `CACHE` moved.
Now vendored at `app/vendor/supabase-js-2.115.0.js`, served same-origin. 2.115.0 is exactly
what was live in production at the moment of the change, taken from the npm tarball whose
hash was verified against the registry's published integrity value before extracting — so this
is a supply-chain fix and nothing else, with no library upgrade riding along. Same-origin also
means it works offline and inside the Capacitor wrap, where fetching your auth library over the
network is both a cold-start failure and something App Review asks about.
`test/test_supplychain.js` fails the build if any off-origin `<script src>` or stylesheet
reappears on any page, or if the three copies of the version — the filename, the tag in
`app.html`, the service-worker precache entry — ever drift apart. Verified in a browser rather
than assumed: the app renders, `createClient` works, and a real request through the vendored
library reaches PostgREST and is correctly refused by RLS with `42501`.
Found by auditing the §11 line that said *"third-party embeds — none currently"*. It had been
wrong since it was written, which is exactly why nothing looked at it again; that line, and the
two cookie-policy questions it sat next to, are now settled with the code checked rather than
assumed. Nexley makes zero third-party requests and sets no cookies.

## v0.37.0 — 2026-09-08
Text now scales with the reader, and Android builds for the first time. Three `font-size`
declarations were locked to `px` — including `body`, which every element without a type token
inherits from, so the rem scale honoured the reader's text-size setting while unclassed text
quietly ignored it. About a third of phone users have changed that setting, some to 310%, and
Apple asks for 200%. `body` is now `.875rem` (identical at default) and the touch-input rules
are `max(1rem, 16px)` — keeping the 16px floor that stops iOS zooming a focused field, without
capping the size for someone who scaled up. The ruled-paper pitch is derived from that same
expression, so text and ruling cannot drift apart, which is a bug this app has already had
once. `test/test_type.js` fails on any bare-px font size.
Separately, and bigger: **the Android debug build had failed on every run it has ever had**,
while PHASE8.md and the handover both said the APK was ready to side-load. Two stacked faults —
the workflow pinned Node 20 and Capacitor 8 requires 22, and `android/gradlew` was committed
from Windows without its executable bit, so gradle died with exit 126. Both fixed; the run for
`77e8c17` is green and produced a real 4.1 MB `nexley-android-debug` artifact. The iOS
workflow, which cannot pass until the Apple enrolment exists, is now skipped rather than
failing on every tag — a permanently red Actions tab is what let the Android failure hide.

## v0.36.0 — 2026-09-08
The questions people actually ask, answered on the page. A ten-question FAQ on the landing
page — free?, who can read my notes?, does it predict a band?, does an AI mark my work?, can I
get my data out?, who makes it? — mirrored exactly as `FAQPage` structured data, which §11 of
the growth plan had listed as blocked on there being an FAQ to mark up. A new
`compare.html` answers the question a student actually types: how this differs from Notion,
OneNote, Google Docs, Quizlet and Anki, including the four cases where those are the better
answer and the four things Nexley deliberately does not do. Both are written to be quotable
out of context, because a student asks an assistant for a study app before they open Google.
Plus a sticky call-to-action on phones that appears only once the hero's own button has
scrolled away and hides again at the footer. `sitemap.xml`, `llms.txt` and the service
worker's precache list all know about the new page, and `test_version.js` now fails if a page
is ever added without being precached — offline, a missing page is silently served as a
*different* page, which is worse than an error.

## v0.35.0 — 2026-09-08
Press feedback and waiting states. Every interactive state in the app was a *hover* state, and
hover does not exist on the iPad this is built for — so pressing anything gave no response at
all until the action finished. Buttons now take weight on press (the surface a hover would give,
plus a 1px drop on the things shaped like buttons), rows take the surface only, disabled
controls stay still, and iOS's own blue tap-flash and 300ms double-tap delay are turned off.
The three panes that genuinely wait on the network — the inbox, the comps list, a comp itself —
show bars in the shape of what is coming instead of the word "Loading…", so the pane no longer
jumps when content lands; `aria-busy` carries the same information to a screen reader, and the
sweep animation is dropped for anyone who asked for reduced motion. `DEPLOY.md` also rewritten:
it still described a site that had not been published yet and warned that notes do not sync,
which stopped being true on 4 September.

## v0.34.0 — 2026-09-08
The version the two previous commits should have carried. `3e5ef7d` (in-app delete account,
Sign in with Apple, Android widget, local notifications, camera on Marks, the SEO/legal pass)
and `74ff628` (legal.html caught up with the shipped app, the AI-written disclosure on the
marking panel, Apple's button hidden until its provider exists) both shipped while
`APP_VERSION` stayed at 0.33.0 — so every crash report and snapshot from those two days
names code that is not what was running. This version closes that, and brings
`package.json` (stranded at 0.19.1, fourteen versions behind) and the service-worker cache
back in step. Also fixes what the drift hid: `notifications.js` and `widget.js` were loaded
by `app.html` but missing from the service worker's precache list, so a cold offline launch
was fetching two files that had never been cached.  
`3e5ef7d`, `74ff628`

## v0.33.0 — 2026-09-06
Empty states, and brass finally means something  
`4d08915`

## v0.32.0 — 2026-09-06
Restructure: a Home, a real sidebar, and accents  
`38689d2`

## v0.31.0 — 2026-09-06
Photograph a page, cleaned up until it is worth keeping  
`0e5c7e2`

## v0.30.0 — 2026-09-06
Highlighter and four colours  
`7a87022`

## v0.29.0 — 2026-09-06
The full pen toolkit: lasso, both erasers, line, floating palette  
`fff0f71`

## v0.28.0 — 2026-09-06
One surface: the pencil writes on the note, not in a box under it  
`eb33e2e`

## v0.27.0 — 2026-09-06
Handwriting verified, 0021 applied, and a trap that nearly fooled me  
`1d4967e`

## v0.26.0 — 2026-09-06
Comps: write a test, share a code, compare  
`ecd2d64`

## v0.25.0 — 2026-09-06
Send a note to one named person, and read what you were sent  
`2134797`

## v0.24.0 — 2026-09-06
Usernames: social.js, and the handle other people address you by  
`090a956`

## v0.23.0 — 2026-09-06
Warm the app back up, and draw the margin rule  
`dd46800`

## v0.22.0 — 2026-09-06
AI feedback wired into the UI  
`44431f7`

## v0.21.2 — 2026-09-06
Adversarial marking set complete — 5/5 run, and rule 7  
`a2009a9`

## v0.21.1 — 2026-09-06
Cross-subject link line: let the sentence keep its own line  
`ae824bf`

## v0.21.0 — 2026-09-06
Cross-subject link finder  
`fa6a35d`

## v0.20.0 — 2026-09-06
v0.20.0, and a landing page that is true again  
`ff440a3`

## v0.19.1 — 2026-09-05
The marking prompt, and the checks that catch it inventing a standard  
`ac9377a`

## v0.19.0 — 2026-09-05
Measure auto-filing before buying a model — and find two real bugs  
`0c40230`

## v0.18.1 — 2026-09-05
Measure what shipped today, and fix seven events that were never fired  
`47fed58`

## v0.18.0 — 2026-09-05
Phase 7: term planning — what is coming, and whether it fits  
`ed4eb5a`

## v0.17.0 — 2026-09-05
Phase 6, part three: the loop closes — mistakes reach the review queue  
`c00439b`

## v0.16.0 — 2026-09-05
Phase 6, part two: where the marks actually went  
`b3120e9`

## v0.15.0 — 2026-09-04
Phase 6, part one: real marks, recorded with the conditions they were sat under  
`49a2667`

## v0.14.0 — 2026-09-04
Close the feedback loop, and stop the landing page lying about what exists  
`f950217`

## v0.13.0 — 2026-09-04
Add confidence per syllabus point, and auto-filing  
`2026d22`

## v0.12.0 — 2026-09-04
Build Tasks — unpack an assessment notification into the syllabus  
`ed3ce0a`

## v0.11.0 — 2026-09-04
Replace PostHog with first-party analytics, and disclose it  
`5805c42`

## v0.10.0 — 2026-09-03
Build Classwork and Review, and stop sync failing silently  
`8df8853`

## v0.9.3 — 2026-09-03
Fix bug_reports being unwritable, and stop reports vanishing when it is  
`01fa9b2`

## v0.9.2 — 2026-09-03
Add an explicit Sign in link to the landing page  
`9f6a739`

## v0.9.1 — 2026-09-03
Fix auth redirects landing on the landing page with nothing to handle them  
`7019875`

## v0.9.0 — 2026-09-02
Add crash reporting and a Report a problem button  
`1e7332e`

## v0.8.0 — 2026-09-02
Make the landing page the front door; the app moves to /app.html  
`71ece61`

## v0.7.0 — 2026-09-02
Add analytics, built so it cannot leak note content — and left switched off  
`549073b`

## v0.6.1 — 2026-09-02
Add a landing page at about.html  
`7f158f4`

## v0.6.0 — 2026-09-02
Add the pre-signup intro: tell people what this is before asking for an email  
`8429989`

## v0.5.1 — 2026-09-02
Pass 2 finish: Newsreader display face, calmer subject palette, ruled-line fixes  
`d669e06`

## v0.5.0 — 2026-09-02
Redesign pass 2b: rail mode switch + the note margin  
`d148e5d`

## v0.4.1 — 2026-08-31
Rename local DB store summit-edu -> nexley (with one-time migration)  
`435af7b`

## v0.4.0 — 2026-08-30
Rename Summit -> Nexley across the app, scripts and docs  
`b8fb194`

## v0.3.1 — 2026-08-30
Fix update banner: no first-install flash, robust Update now, fresh sw.js  
`00d38b3`

## v0.3.0 — 2026-08-07
Phase 2: syllabus structure  
`9bacfff`

## v0.2.0 — 2026-08-06
Phase 1 + data-layer hardening  
`79f8b29`

