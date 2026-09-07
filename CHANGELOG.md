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

