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

## v0.50.0 — 2026-09-09
Four waits that could never end, on the four paths that matter most.
v0.49.0 did the waiting pass for AI marking and named sync and cold boot as the surfaces still
owed one. They turned out to owe more than polish. The common fault is the same in all four:
**a network call that is up but not answering**. `navigator.onLine` reports true on school Wi-Fi
parked behind a sign-in page, so none of the offline handling fires and the request simply never
settles. Each of these was reproduced before it was fixed.
**Sync wedged permanently, and said it was fine.** A hung run left the module's `syncing` latch
stuck true for the life of the tab, so every later trigger — the five-minute timer, a tab focus,
an `online` event — returned instantly without doing anything. Sync was dead for the session
while the status line still read "Checking…", which was its *idle* text and therefore a claim
that something was happening when nothing was. A run now gives up at 60s (a dozen sequential
round trips, so a longer leash than marking's single request) with an error that names the
cause, and the latch is released exactly once even if the original request answers later. The
status line gained a real "Syncing…", emitted only after 1.2s — a healthy sync finishes in well
under a second and runs every five minutes, so announcing every one of them would just make the
rail blink at the student forever.
**Boot could stop dead before the app existed.** `getSession()` looks local but refreshes an
expired token over the network, and the whole boot chain waited on it — no app, no sign-in card,
no message, no end. It now gives up at 10s and shows the sign-in card with the reason, while
keeping the real request alive so a late answer lets the student straight in instead of making
them sign in again. A related wrong answer went with it: anything failing from the session check
onward was caught by the chain's outer handler and reported as **"Could not open local storage"**
— confidently wrong, since storage is how it got that far.
**A returning student was told they had no account, on every cold open.** The gate markup is
visible by default so that a JS failure still shows a sign-in — but that meant "Create your
account" sat on screen for the whole session check, to someone who was already signed in. A
pre-paint check for a stored session hides the card until boot has decided. Presence of the key
is all that is read, never its contents, and it is dropped the moment the gate is genuinely
wanted, so a stale key cannot hide the sign-in card forever.
**"Lock this device" did not always lock.** `signOut()` is a network call, and the caller had no
catch and no timeout: a failing connection meant the gate never appeared, a hanging one meant
the button did nothing at all — the student handing over an unlocked iPad. Supabase's own
`scope:'local'` is not the escape hatch it looks like; the vendored source still calls
`admin.signOut()` first and hangs identically. Five seconds for a clean revoke, then the session
is forgotten locally and the page reloads. That leaves the server-side token alive until it
expires, which is worse than a clean revoke and far better than not locking.
**And the sign-in buttons answered a tap with nothing.** Google and Apple sign-in ran a network
round trip *before* navigating away, with no disable and no label change, so the natural
response to a slow connection was to press again and start a second OAuth flow. The email form
has guarded exactly this since it was written. Three taps now produce one flow.
Two suites added, both of which fail against the previous release: `test_sync_timeout.js` (6 of
10 red before, 10 green after) and `test_auth_lock.js` (10 of 12 red before, 12 green after).
Also fixed while proving the boot path in a real browser: a synchronous throw inside
`refreshMe()` escaped the "its failure is swallowed" comment above its call site and replaced
the entire app with the storage error. The comment was true of rejections and not of throws.

## v0.49.0 — 2026-09-09
The design audit, and a spinner that can end.
From `GROWTH_AND_LAUNCH.md` §12, written after Alec's own read: *"nexley looks like ai slop
atm."* The diagnosis there was that Nexley is not missing a design system — `app.css` has a
deliberate one — it is missing **studied reference and an auditor**. Two repalettes have already
happened; a third is not the answer. So this is an audit.
**AI marking had four of the six classic loading failures in one screen**, and it is the worst
place in the app to have them: the student's daily quota is spent the moment the request leaves,
so a wait that ends in nothing costs one of ten. It now shows a skeleton in the shape of a real
marking response rather than a bare spinner, which also reserves the space so buttons do not
jump when the answer lands; says something honest at 8s and 20s rather than drawing a progress
bar it has no numbers for; and — the important one — **it can end.** The Edge Function gained a
30s provider timeout, but that does nothing if the request never arrives or the reply never
comes back, and the page would have waited forever. The client now gives up at 45s, deliberately
longer than the server's 30s so the server's more specific message wins when it can answer. The
timeout message names the wait, admits the request still counted — the student will watch the
counter move and deserves to know why — and says that retrying usually works.
A bug caught while building it: `renderAiResult()` cleared the panel's contents but not its
`aria-busy`, which would have told a screen reader the results pane was loading forever, on the
one screen whose entire point is knowing when the wait has ended.
**Corner radii — the audit said one thing and the measurement said another.** §12 flagged
Apple's concentricity rule (inner = outer − padding). Checked against every rounded element and
its nearest rounded ancestor across the app and all 21 dialogs: **79 pairs differ from the
concentric ideal and not one of them sits at a corner.** Concentricity only means something
where the two curves actually meet, so it was not applied — a measurement, not a preference.
What *was* real is the consistency half. "Fully round" was being written **three ways** —
`99px`, `50%`, and a `--r-pill` token that existed and was going unused — and the public pages
had eyeballed `10px`/`8px` values belonging to no scale at all. Three spellings of one idea is
how a scale stops being a scale. Every radius is now a token or an explicit `0`, and
`test/test_radius.js` fails on anything else.
**`DESIGN.md` is new**, written by reading `app.css` rather than deciding anything. §12's point
is that you cannot prompt a feeling: "make it more premium" is an adjective, a table with one
job per colour is a rule. It carries the art-direction line that already existed, every token
with its single role, the type scale, and the traps that have already cost real time — the
`clamp()` whitespace bug that rendered note titles at 14px for a whole pass, the touch rules
that must stay last in the file, and the `ready()` pairing that this release nearly got wrong.

## v0.48.0 — 2026-09-09
"Recoverable from Snapshots" was not true, and now it is.
Deleting a note said *"the most recent snapshot can bring it back."* Deleting a subject —
which takes every note under it and the whole syllabus with it — said the same. **No snapshot
was taken before either.** Automatic snapshots run every **20 hours**, so "the most recent
snapshot" could easily predate the thing being deleted, and anything written today was simply
gone.
This was not reasoned about, it was reproduced. In a harness: create a subject, write a note,
delete the subject, open Snapshots, restore the newest one — the note does not come back,
because that snapshot was taken before it existed. A UI telling a student their work is
recoverable and being wrong is worse than one that says nothing, and this is the screen someone
reads at exactly the moment they think they have lost a term of notes.
Both deletes now snapshot first. Re-ran the identical sequence afterwards: the note comes back.
A failed snapshot does not block the delete — a full disk is not a reason to refuse to remove
something someone asked to remove.
**Snapshot rotation now protects the newest daily copy.** Snapshotting before every delete means
a tidy-up session deleting eight notes would have rotated eight near-identical copies through
the whole seven-slot budget and pushed out the only record of what the notebook looked like
yesterday — which is the one you want when you notice days later.
`test/test_durability.js` is new and covers the thing that actually kills a notes app. HANDOVER
trap 10 records a new store being added and one of its *five* homes being missed, which silently
wipes it on restore; that was live for twenty minutes on 09-04. The test now asserts every
object store is handled by **all four** of snapshot, restore, export and the import merge, or is
on an exclusion list **with a stated reason** — no third option, because "I'll add it later" is
the state this prevents. It also pins the two non-obvious re-stamping rules: restore must
re-stamp and drop `pushedRev` or the server's newer tombstone pulls the restored record straight
back down and deletes it again, while import must drop `pushedRev` but *keep* `updated`, or an
old export overwrites newer work. Proven by re-introducing the trap: a new store wired into
snapshot but not restore fails with *"a restore would silently wipe it."*
Also, on the screen someone reads while deciding whether they have lost work: it said "1 notes ·
1 subjects" and labelled copies with machine tags like `before-syllabus-import`. Now it counts
properly and says "before a syllabus import".

## v0.47.0 — 2026-09-09
Seven touch targets were under Apple's minimum, including every way into the inbox, comps
and settings.
Nexley is aimed at an iPad, and Apple's 44×44 minimum is not a rounding suggestion — 32px is
roughly the width of a fingertip, so a 32px control makes every tap a small gamble. Measuring
every visible control at phone width found **seven** below it: the three rail icon buttons
(32×32 — and they are the *only* route into the inbox, comps and settings), the account button,
the six primary nav items at 36px, the sync-state row, and `.edit` at **27×21**. That last one
is the worst of them: the coarse block was already unhiding `.edit` on touch, which quietly made
it a live target without ever giving it a size to be hit at.
Only the touch layout changed. Verified on the same page with the coarse rules inactive: a
mouse user still gets 32×32 icons, 36-high nav and the 27×21 edit affordance, exactly as before.
The extra area is padding around the same painted mark, so nothing looks different — it is
reach, not weight.
**Three bugs happened while fixing this, and all three were invisible in a diff.**
The first attempt went into the coarse block at ~line 1500, while `.toolbtn{width:32px}` is
declared at ~1690 — equal specificity, later wins. The rule parsed, changed nothing, and read as
correct. The touch rules now sit at the very end of the file and `test/test_touch.js` fails if
anything is added after them.
The nav fix was written `.rail-nav .mode`, but those buttons live in `.modes`. Valid CSS
addressing an element that does not exist is the quietest possible failure.
And this test's own first draft built its patterns with `new RegExp` from strings whose escapes
did not survive into the file — `'\b'` became a literal backspace character, so seven checks
failed against code that was perfectly correct.
⚠️ The test is explicit about its own limits: it catches a class name that exists nowhere and it
catches the ordering trap, but it **cannot** catch `.rail-nav .mode`, because both classes are
real and only their relationship is wrong. That needs a live DOM, and this app builds most of
its DOM at runtime. Measuring in a browser is still the only thing that confirms these rules.
Also checked and clean, so it is recorded rather than re-derived later: no layout overflow and
no horizontal scroll at 320, 390, 768, 834, 1024 or 1180; headings scale *down* on mobile
(36px → 27.8px) rather than blowing up, which closes that item; and at **200% text size** —
what Apple asks for, body going 14px → 28px — there is still no overflow at either phone or
iPad width. The earlier viewport measurements that suggested otherwise were artifacts of
resizing a fixed app shell; an iframe gets its own viewport and is the only honest way to test
this locally.

## v0.46.0 — 2026-09-09
A real screenshot of the real app, on the landing page.
The audit list had "no real product demos" flagged as a genuine conversion problem — to a
visitor it reads as *there might be no product*. Every claim on that page was being made with
nothing to look at. There is now a screenshot directly under the hero, before the copy that
describes it, because seeing the thing makes the rest easier to believe.
It is genuinely the app, not a mockup: a demo account with Biology, a pasted three-module
syllabus, and three notes filed against the dot points they answer. The coverage bar reading
**3 / 9 written · 33%** is the app's own arithmetic, and the filled versus hollow pips are the
whole product thesis in one frame. The only things touched were two harness artifacts that
exist because the stub has no backend — a sync-failure warning and a storage read-out — neither
of which a real user would see.
**35 KB.** Served as WebP through `<picture>` with a quantised PNG fallback at 81 KB; the raw
capture was 217 KB. UI screenshots are mostly flat colour, so a 128-colour palette costs nothing
visible and roughly two-thirds of the bytes. Width and height are declared so the page does not
reflow under the reader when it lands, and it is lazy-loaded, precached, and captioned.
The app's own scrollbar came out in the capture as a black bar down the right edge, so it is
cropped — found by scanning columns from the right for the first dark one rather than guessing
at a number.
`test/test_a11y.js` grew an images section, which had been sitting at "not applicable, there are
no `<img>` elements" until today. It requires alt text, requires it to be **descriptive rather
than a label** ("screenshot" tells a blind reader nothing), and requires width and height. And
`test_version.js` earned its keep by catching the demo harness page left behind in `app/` before
it could be committed.

## v0.45.0 — 2026-09-08
The school year now does something, and you can change it.
v0.44.0 started asking what year you are in, and told you — in the dialog and in `legal.html` —
that it was used to read your syllabus against the right course. **It wasn't used for anything
at all.** Collected, stored, consumed nowhere; `schoolYearLabel()` was defined and never called.
That made both statements false, which is the exact failure this project has had before:
`legal.html` once described AI as "a future feature" two days after AI marking shipped.
So it does the job now. NSW syllabus codes carry the year in them — `HM-11-01` is a Year 11 code,
`HM-12-01` a Year 12 one — so the syllabus dialog heads itself **"Biology · Year 12"** and rewrites
its worked example into that student's own year. A Year 12 student pasting a syllabus is no longer
looking at a Year 11 example. The example is rebuilt from a stored original each time rather than
edited in place, so switching 11 → 12 → 9 doesn't compound into nonsense; that round trip is
tested.
**And it is changeable, which it very much was not.** It was asked once at sign-up and then frozen
for the life of the account — for a school app, where every student moves up a year annually, that
is a bug rather than an omission. Settings › School now shows it and saves on change. A failed
write puts the old value back rather than displaying a year that was never saved.
Copy tightened to match reality in both places: it said "the right syllabus comes up", which
implies Nexley fetches one. It doesn't — you paste it. It now says your year is used to show the
right codes and label the course, which is what the code actually does.
`test/test_schoolyear.js` grew a section whose whole job is to fail if the year stops being used,
because at that point the honest move is to delete the question rather than keep asking it.

## v0.44.0 — 2026-09-08
The minimum age is gone. It asks what year you are in instead.
v0.43.0 shipped a hard floor of 15 — birth month and year at sign-up, a dialog nobody could
dismiss. It lasted about an hour, because Alec asked the obvious question: *why on earth is there
a minimum age, and can't we just ask what year?*
Both halves of that were right. **The gate was built against a rule that does not exist yet** —
the Children's Online Privacy Code is an exposure draft, unregistered until 10 December 2026, and
the parts being relied on are exactly the parts being pushed back on. And **a floor at 15 excludes
Years 7 to 10**, which is roughly half of school and runs straight into what Nexley is actually
for. Compliance work that quietly deletes half the intended audience is not the cautious option;
it is a large product decision taken by accident under cover of a legal one.
**Asking the year is also just the better question.** Nexley is a syllabus app — Year 11 and
Year 12 are different courses — so it is something the product wants regardless. It is setup, not
screening. A year level barely identifies anyone next to a date of birth, and **no date of birth
is asked for or stored anywhere now.** "What year are you in?" reads as setup; "when were you
born?" reads as a border check.
Nobody is turned away and nothing is held hostage. The question is skippable, Escape skips it,
skipping is *recorded* so it never asks twice, and a failed save still lets you into your own
notes. It is asked from `enterApp()` — the one property of the old gate worth keeping — so Google
sign-in and accounts that predate it get asked once too, rather than the check sitting on a form
that half the sign-ins never touch.
`legal.html` now says there is no minimum age, and says plainly why: the obligation is real, it
is not law yet, and the honest plan is to build a proper parental-consent step when the Code is
registered rather than lock out Years 7–10 in the meantime. `test/test_schoolyear.js` replaces
`test_age.js` and asserts the gate stays gone — no age constant, no birth date, and Skip still
works. Full reasoning kept in `PRIVACY_IMPACT_ASSESSMENT.md`, including what the obligation
actually says, so deferring it is not the same as forgetting it. **Diarised for December 2026.**

## v0.43.1 — 2026-09-08
The age dialog had no padding and no name on it.
`dialog` is `padding:0` so its `<form>` can own the inset — and this one is built from a plain
`div`, so its contents sat hard against the border. It also opens over nothing (no gate behind
it, no app yet), which meant an unattributed box on an empty screen asking a teenager for their
birthday. It now carries the Nexley mark and uses the same spacing as every other dialog, so it
cannot tell you which markup it happens to be made of.

## v0.43.0 — 2026-09-08
There is a minimum age now, and it is enforced at every door.
Nexley being "for Year 11 students" was an intention with no control behind it — the app asked
nothing, so a twelve-year-old could sign up. The Children's Online Privacy Code (registered by
10 December 2026, and it covers educational tools) asks for reasonable steps to ascertain age,
and under-15s need **verified** parental consent, which Nexley cannot obtain and is not going to
build. So the honest answer is not to accept them: **the minimum age is 15.**
**Month and year, not a full date of birth.** The only question is "15 or older". A full DOB is
a strong identifier, and holding one to answer a yes/no question is collection past the purpose
— which is the exact standard this Code tightens. The month is used to decide and then thrown
away; **only the year is stored.** Asking for a day and then discarding it would also just be
dishonest about what is wanted.
**The check does not live on the sign-up form.** It lives in `enterApp()`, the single point that
both the email and the Google paths funnel through. Putting it on the form would have looked
complete while leaving OAuth wide open, and would have said nothing to accounts that already
existed. Both now get asked once, before the app will open; declining or pressing Escape signs
you out rather than leaving a half-signed-in session with no app behind it.
**The boundary errs young on purpose.** Age is computed from the *last* day of the birth month,
so someone whose fifteenth birthday falls later this month reads as fourteen and waits a few
weeks. Erring young delays a legitimate student; erring old admits a child permanently.
`test/test_age.js` pins that boundary from both sides against a fixed clock — a test that
depends on today's date passes until the morning it doesn't.
**Said honestly in `legal.html`, including the limits.** It is a declared age, the weakest form
of assurance, and it can be lied to. The policy says so, and says why there is no ID check:
verifying identity would mean collecting far more sensitive data from young people than a study
notebook could justify, which fails the same best-interests test from the other side. The old
"Children's privacy" section — which said the app may have under-13 users and that
age verification was a future step — was true when written and became false the moment this
shipped; it has been rewritten rather than left to rot.

## v0.42.0 — 2026-09-08
Muted text was failing WCAG AA across the entire light theme, and nobody could see it.
`--muted` was #7E7669: **4.41:1** on `--card`, **3.77** on `--paper`, **3.47** on `--surface`.
It carries every caption, eyebrow, timestamp and piece of metadata in the app, most of it set
at 9–13px, so the smallest text was the least legible. The dark theme was already clean, which
is exactly how this survived — anyone who checked was almost certainly looking at dark mode,
and a contrast failure is invisible to someone with good eyes on a good screen. The student
reading it is on a bus, on a cracked iPad, in the sun.
It is now #6A6255 — deliberately the *lightest* value that clears 4.5:1 against all three light
grounds (worst case 4.65 on `--surface`), so muted text stays recessive instead of being
over-darkened into a second body colour. `--warn` was also 4.42 on its own soft ground, under
by a hair, which is the worst kind of miss because it looks fine; now 4.75. **One token change
fixed five separate visible symptoms.**
`test/test_contrast.js` checks the palette itself rather than the live DOM, because a browser
sweep only sees the panes that happen to be open — the audit that found this reached 19
elements in an app with 21 dialogs. Checking token pairs covers every screen at once, including
ones nobody has opened yet, and it is what actually failed. Re-verified in a real browser
afterwards: zero failures in both themes.
⚠️ **A methodology warning is written into that test**, because this cost four rounds to
disprove. `.snav` and friends carry `transition:background .12s`, so reading `getComputedStyle`
straight after flipping the theme returns the colour *mid-animation* — which produced a very
convincing 1.05:1 "invisible text" reading that was pure artifact. Kill transitions first or
you will chase a bug that is not there.
Also: `delete-account`'s CORS now fails closed to Nexley's own origin like the AI function did
in v0.40.0 — an arbitrary origin had no business reaching the *account deletion* endpoint. And
three audit items closed by checking rather than assuming: **no stock or third-party images
anywhere** (icons are Alec's own, `og.png` is generated from this repo, Newsreader ships with
its OFL licence); **no invented testimonials** — there are none at all; and the landing page's
one forward-looking claim now reads "App Store **or Google Play**", since Android builds today
while iOS waits on enrolment.

## v0.41.0 — 2026-09-08
A share card that shows the product instead of the logo.
The Open Graph tag pointed at `icon-512.png` — a 512×512 square, which every platform
letterboxes or centre-crops into its 1200×630 card. A shared Nexley link previewed as a small
logo floating in grey, saying nothing. `app/og.png` replaces it and *shows the idea rather
than describing it*: three syllabus dot points, two written up and one not, beside the line
the site leads with. The pip being hollow on the third row is the entire product in one
detail.
Built by `tools/make_og_image.py`, which is checked in on purpose — a PNG dropped in `app/`
with no provenance is something nobody can change later without redoing it, and it goes stale
silently when the palette moves. It uses the **real Newsreader face**, decompressed from the
same woff2 the site serves, rather than a substituted lookalike, and every colour in it is
copied from `app.css`. The row panel measures its own longest label instead of assuming a
width — at a guessed 396px the first row ran underneath its own pip, which is exactly the
detail that makes a card look thrown together.
Cards upgraded from `summary` to `summary_large_image`, with explicit width, height and alt
text so a scraper that never fetches the file still lays the card out correctly. Precached in
the service worker like every other asset.
Also closed four audit items by measuring rather than assuming, and one by declining to act:
**no console errors** on either live page and **zero requests to any third-party origin**;
**no source maps** (there is no build step, so there was never anything to strip); the whole
offline app is **787 KB decoded**, roughly 200 KB over the wire. And **SkillSpector** — real,
NVIDIA's, Apache-2.0, 16.5k stars — is **not being installed**, because this machine has no
custom skills and exactly one marketplace, `anthropics/claude-plugins-official`, with every
plugin pinned to a commit SHA. Scanning Anthropic's own official plugins would be theatre.
The command is recorded for the day a skill arrives from anywhere else, which is the threat
model it is actually for.

## v0.40.0 — 2026-09-08
A switch for the usage data, names on every form control, and a timeout the code already
claimed to have.
**The law changed under this app.** The OAIC's Children's Online Privacy Code must be
registered by **10 December 2026**, and the OAIC says plainly it reaches educational tools,
not just social media. Nexley is a study app for Year 11 students, so it is in scope, and the
collection standard tightens from *reasonably necessary* to **strictly necessary**, judged
against the best interests of the child. Assessed properly in
`PRIVACY_IMPACT_ASSESSMENT.md` — the right of destruction is already met (in-app delete,
built for Apple in September, satisfies the harder rule by accident) and AI marking came out
proportionate and well-controlled. Analytics is the item that fails *strictly necessary* most
clearly, because it is necessary to **improve** the app rather than to **provide** it.
So: **Settings › Privacy now has a switch.** Turning it off stops the current session
immediately — anything queued is discarded rather than flushed on the way out, because a
switch that lets one last batch through is not a switch. Do Not Track and Global Privacy
Control are still honoured and now say so: when one is on, the control renders **off and
disabled** with a line naming which browser signal did it, rather than a live-looking toggle
that does nothing. `legal.html` says where the switch is instead of burying it, and now also
states that Nexley loads nothing from anyone else's server — true since v0.38.0.
The remaining gap is **age assurance**, and it is genuinely Alec's call rather than an
engineering one: the Code wants reasonable steps to ascertain age and verified parental
consent under 15, Nexley's audience is 16–17, and intent is not a control. Three options are
costed in the PIA.
**Accessibility.** An audit of the real DOM found **13 of 54 form controls with no accessible
name**. Most looked labelled because they had a placeholder — which is not a label: it is not
reliably exposed as an accessible name and it vanishes the moment you type, so a screen reader
announces "edit text, blank" and a sighted user who tabs away loses the only description of
the field. Three file inputs and both settings toggles had nothing at all. All 54 are named
now, and the two settings toggles became real `<label for>` elements, which also makes the
whole row a tap target instead of a 16px box. `test/test_a11y.js` parses the shipped DOM —
including all 21 dialogs, which a click-through pass only reaches one at a time — and also
pins the things that were already right: no positive tabindex, no nameless buttons, no
undecided decorative SVGs.
**AI proxy.** Neither provider fetch had a timeout, so a stalled connection held the function
open until the platform killed it, with the student's quota already spent and a spinner on
screen. The quota comment reasoned about exactly this case — "a provider timeout cannot be
retried into an unbounded bill" — while no timeout existed. Now 30s, surfaced as its own
`provider_timeout` / 504 rather than collapsing into a generic 502, with a message that says
it counted and is worth retrying. CORS also stopped defaulting to `*` when `ALLOWED_ORIGIN`
is unset: a missing secret should fail closed and loudly, not leave any page on the internet
able to spend this account's model quota through a visitor's session.
⚠️ **The edge function change is committed but NOT deployed** — that needs `supabase login`.

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

