# Nexley — Growth & Launch Notes

Working notes on how Nexley gets from "built and deployed" to "has users." Captured from
Alec's notes-to-self 2026-08-30 and expanded with research. Nothing here is a committed
decision — open questions are marked. Companion to the product backlog in memory
`project_nexley_ideas.md`.

Current state for reference: Nexley is a **PWA** (offline-first, IndexedDB + Supabase sync,
real accounts, RLS), deployed at `ajspeedy10.github.io/nexley` via GitHub Pages. It is not a
native app and is not on any app store.

---

## 1. Reality check that shapes everything below

Nexley today is a website you "Add to Home Screen," not an `.ipa`/`.apk`. That single fact
decides a lot:

- **Firebase App Distribution and TestFlight distribute native binaries.** They do nothing
  for a PWA. They only become relevant if Nexley gets wrapped in a native shell
  (Capacitor, or PWABuilder to emit store packages).
- A PWA "beta" is just: a URL + "Add to Home Screen" + an invite list. No store, no review,
  updates ship instantly. That is a real advantage for moving fast right now.
- The trade-offs of staying PWA-only: no App Store / Play Store discovery or credibility,
  iOS web-push only works from a home-screen-installed PWA (iOS 16.4+), and iOS can evict
  storage from PWAs that go unused for weeks (offline-first design mitigates this but does
  not eliminate it).

**Recommendation:** run the first beta as PWA + private invites. Add a native wrapper +
store betas only when there's a concrete reason (reliable push, store discovery, "it's a
real app" credibility with schools/parents).

---

## 2. MVP vs Alpha vs Beta — what the words mean

These are loose industry terms; the useful part is what each one *promises testers* and
*what you're trying to learn*.

**Prototype / PoC** — throwaway. Proves a concept or a risky technical assumption. Not for
users.

**MVP (Minimum Viable Product)** — the smallest version with enough real value that early
users will actually use it, so you can learn whether the core idea works. Goal: validate
the concept for minimum time/cost. *Nexley's MVP is essentially already built* — syllabus
notebook + search + sync + accounts is a usable core.

**Alpha** — first feature-complete build, still unstable. Internal / trusted testers only
(you + a few close friends). Expect bugs; the point is to shake them out.

**Beta** — feature set is **frozen** and stable ("release candidate"). Handed to a larger,
still-selective *external* group under real conditions. The point is polish, edge-case
bugs, and structured feedback before a public launch. Don't add features mid-beta.

**GA / public launch** — open to anyone.

Rough order: Prototype → MVP → Alpha → Beta → GA. For Nexley the honest current status is
"MVP built, entering private alpha." Beta = when you'd be comfortable a stranger's kid
relying on it for a term's notes.

---

## 3. Beta distribution & testing

### Firebase App Distribution
- One dashboard for **both** Android and iOS pre-release builds. Uploads via console, CLI,
  CI, or API. Builds reach testers in minutes; testers use the "Firebase App Tester" app;
  organise testers into groups by role.
- **Free** — part of Firebase's free tier, no per-tester charge.
- iOS caveats: testers need a Google account, must install a device provisioning profile,
  and every tester device UDID must be registered in your Apple Developer account (ad-hoc
  cap: 100 devices per device-type per year). It does **not** remove the need for the paid
  Apple Developer Program ($99/yr).
- Upside vs TestFlight: no Apple Beta App Review, so faster iteration.

### TestFlight
- **Apple platforms only.** Up to 10,000 external testers via a public link (no UDID
  wrangling). Internal testers (up to 100 App Store Connect users) get builds instantly;
  external builds go through Beta App Review (~24h for the first build, usually quick
  after). Builds expire after 90 days. Free, but needs the Apple Developer Program
  ($99/yr).

### Alternatives
TestApp.io, Appcircle, Diawi, Bitrise. (Microsoft App Center is winding down — don't start
there.) For Android alone, Google Play Console's internal testing track is simplest.

### What this means for Nexley
- **Now:** stay PWA. "Beta" = share the URL with an invite list; gate with a simple
  allow-list or invite code if you want it private.
- **If/when wrapped native:** Firebase App Distribution earns its place as the *one* place
  to push both iOS and Android beta builds. Pair it with TestFlight for iOS if you want the
  public-link + 10k-tester path.
- **Decision needed:** PWA-only beta, or wrap with Capacitor now? (See §9.)

---

## 4. Waitlist landing page

### Why
Start demand generation and ad testing *before* the product is public: build a launch-day
list, and learn which messaging and which channels convert while it's cheap to experiment.

### What converts (2026 best practice)
Five things, consistently:
1. **Outcome-driven headline** — the specific result, not "the future of studying." e.g.
   "Keep every class note filed against your actual syllabus."
2. **One CTA above the fold, one field** (email). Every extra field measurably drops
   conversion — ask year level / school later, or as an optional second step.
3. **Tangible social proof near the form** — live signup count, one crisp screenshot of the
   notebook, or "built by a Year 11 student for Year 11–12" (authentic > fake logos).
4. **Referral incentive on the confirmation screen** — "jump the queue / get early access
   for every friend who joins."
5. **Zero distraction** — no nav bar, no footer maze, mobile-first (most traffic is a phone
   from a social post).

### Benchmarks
Average visitor→signup ≈ 15%. Good ≥ 25%. Warm/targeted traffic can hit 25–85%.

### Referral — use with care
Referral loops turn linear growth into viral growth, but sloppy incentives attract
low-intent signups that inflate the number and then never activate. Keep the reward tied to
product value (early access, a founder walkthrough) not swag. Tools that automate this:
GetWaitlist, Waitlister, LaunchList, Viral Loops (all have free tiers).

### Build options
- **(a) Dedicated tool** (GetWaitlist / Waitlister / LaunchList): fastest, includes
  referral + email + basic analytics out of the box. Downside: their branding, their data,
  less control — and you're handing minors' emails to a third party.
- **(b) Self-built** on the existing GitHub Pages site: a static page matching Nexley's
  look, email written to a Supabase `waitlist` table (you already run Supabase and RLS),
  referral via a `?ref=` code. More work, but you own the data (matters for school-age
  users) and it's on-brand.
- **Recommendation:** (b). One static page + a `waitlist` table + PostHog on the page from
  day one so ad spend is measurable. Add referral only if/when you decide it's worth the
  vanity-signup risk.

### Page contents
Headline (specific outcome) · one notebook screenshot · 3 bullets of what it does · "who
it's for" (start narrow: NSW HSC, Year 11–12) · email field · confirmation page with "what
happens next," a rough timeframe, and the referral link.

### Legal
Even a waitlist collecting emails from minors needs a short privacy note and minimal
collection (email only). Reuse/point at `app/legal.html`.

---

## 5. Onboarding before sign-in (the psychological hook)

### The principle
Deliver value *before* asking for an account. Duolingo puts the product first and account
creation last/optional — their delayed signup alone drove a ~20% DAU lift, and their
onboarding converts ~9% vs a ~2% industry average.

### Why it works
Sunk-cost / endowment effect: every pre-signup screen gets the user to *invest* something
(pick subjects, paste a syllabus, set a study style, write one note, do one quiz). By the
time you ask them to register, leaving means abandoning something they built — so they
sign up to keep it.

### Concrete Nexley pre-signup flow (aim 6–9 screens, not 38)
1. Warm intro (1–2 screens): what Nexley is, one promise.
2. "What are you studying?" → state/board + year (e.g. NSW, Year 11). Personalises
   everything after.
3. Pick 1–3 subjects.
4. "How do you like to study?" — a few preference questions (cram vs steady, notes vs
   quizzing, handwriting vs typing, want reminders?). These set real defaults (note font,
   quiz emphasis, reminder cadence) so the answers visibly matter.
5. Paste or pick a syllabus for one subject (existing feature) — the big investment moment.
6. Write your first note **or** take a 3-question quiz on a dot point — the "aha."
7. **Then:** "Create a free account to save this across your devices" — everything they did
   migrates into the new account.

### Implementation notes
- Store pre-signup state in IndexedDB (the app already uses it) and migrate on signup. The
  offline-first sync plumbing already exists for this.
- Always show a "skip" / "I already have an account" path.
- Keep the flow under ~9 screens. Duolingo's real flow is 38 screens but they earned that
  with years of A/B testing — don't copy the length, copy the sequence.
- **Blocker:** the already-flagged "double-signup bug + onboarding empty-state" issue must
  be fixed first — losing a new user's first note at the signup boundary is fatal to
  everything this flow is trying to do.
- Anonymous analytics during the pre-signup phase need a privacy note and must stay
  event-only (no content, no PII) — see §6.

---

## 6. Analytics — PostHog

### What it is
Product analytics (funnels, retention, user paths) + session replay + feature flags + A/B
tests + surveys, in one open-source tool with a large free tier. Good fit for "analytics
for the entire app."

### Free tier (self-serve, no card)
Per month, every month: **1M events**, 5K session replays, 1M feature-flag requests, 100K
error-tracking events. PostHog states ~97% of companies never exceed the free tier. Limits
have been stable over time.

### Cost beyond free
Usage-based with volume step-downs. Events are ~$0.00005 each after the first 1M (cheaper
at higher volume). **"Person profiles"** — tracking tied to identified users — cost *extra*
on top of the event rate (~$0.0002 per identified event in the first paid band, stepping
down). Practical takeaway: keep most events anonymous and only `identify()` signed-in
users, and you stay on/near free far longer.

### Self-host?
The open-source version can be self-hosted (Docker/K8s), but PostHog has de-emphasised it
and only recommends it above roughly 1M events/day or for hard data-residency needs. For
Nexley: use **PostHog Cloud**, EU region (fine for an AU/education audience, better privacy
posture).

### Per-user tracking
`identify()` links events to a person after signup; before signup, anonymous distinct IDs.
Set `person_profiles: 'identified_only'` so anonymous visitors don't create billable,
PII-bearing profiles.

### Privacy — this matters, users are school-age
- A persistent distinct ID is personal data under GDPR and the Australian Privacy Act.
  Under-13s need parental consent; a minor's rights override "legitimate interest"
  arguments.
- Recommended setup: `person_profiles: 'identified_only'`; **mask all inputs** in session
  replay (`maskAllInputs: true`) or don't enable replay at all at first; disable autocapture
  of text; never put note content in event properties; EU cloud; add an analytics
  disclosure to `app/legal.html`; offer a genuine consent choice (not pre-ticked). Consider
  memory-only / cookieless persistence for the pre-signup phase.
- Track **events** ("quiz completed", "note saved", "syllabus imported"), never content.

### What to instrument (first pass)
- **Activation funnel:** landing → onboarding step N → first note/quiz → signup → second
  synced device.
- **Aha-metric candidates:** wrote ≥1 note in first session · imported a syllabus ·
  completed ≥1 quiz.
- **Retention:** return on D1/D7/D30, cohorted by signup week (see §8).
- **Engagement:** notes/week, quizzes/week, subjects added, sync success rate.
- **Drop-off funnels:** which onboarding screen loses people.
- **Waitlist page:** traffic source → signup → later in-app activation (close the loop on
  ad spend).

### Lighter alternatives (if PostHog feels heavy)
Plausible or Umami for privacy-first *site* analytics (page-level only, cheap/free to
self-host); Amplitude or Mixpanel free tiers for product analytics. PostHog covers both, so
one tool is probably enough.

---

## 7. Getting recommended by AI assistants (GEO)

**Generative Engine Optimization** = being cited/recommended in answers from ChatGPT,
Claude, Gemini, Perplexity, and Google AI Overviews. An estimated 12–18% of informational
queries now run through these tools (Q1 2026), and users act on the recommendation directly
— they sign up for the tool that got named.

You can't pay for it. You earn it like organic SEO, plus a few new levers:

1. **Have real, crawlable content.** A public marketing site (not just an app behind
   login): what Nexley is, who it's for, how it compares to Notion / OneNote / Goodnotes /
   Quizlet, an FAQ. Models extract from text — front-load the answer in the first sentence
   of each section.
2. **Extractable structure:** descriptive H2/H3s, Q&A blocks, short declarative sentences,
   a comparison section, schema.org markup (`SoftwareApplication`, `FAQPage`).
3. **Third-party citations.** AI answers lean on sources they trust. Get into "best study
   apps for HSC" roundups, education subreddits and student forums, a Product Hunt launch,
   a few blog posts / school newsletters, directory listings (AlternativeTo, education-tool
   lists). Each credible mention raises the odds of being cited.
4. **Consistent naming** everywhere: "Nexley — a syllabus-aligned study notebook for Year
   11–12." Repetition across sources is how models learn the association.
5. **Let the crawlers in:** don't block GPTBot / ClaudeBot / PerplexityBot / Google-Extended
   in `robots.txt`. For a product you *want* recommended, allow them (deliberate choice —
   the alternative protects content but forfeits GEO).
6. **Canonical facts** (Wikidata / Wikipedia) once Nexley is notable enough to qualify.
7. **Track it manually:** every few weeks, ask each assistant "best study apps for the NSW
   HSC" and see whether/how Nexley shows up. Paid trackers (Profound, LLMrefs, Peec) exist
   but manual checks are fine at this stage.

**Reality:** this is a slow, compounding channel and mostly downstream of having public
content + real third-party mentions. Not a week-1 growth lever. Set the foundations now
(public site, structured content, allow crawlers) and it accrues over months.

---

## 8. Week-one retention

**Definition:** of the users who first used Nexley in a given week, what % come back.
Common cuts: D1 (came back the next day), D7 (came back on day 7), or "week-1" = any use in
days 1–7. Always cohort by signup week.

**Benchmarks (2026):** cross-industry ≈ 25–26% D1, 11–13% D7, 5–7% D30. **Education is one
of the worst categories:** D1 ≈ 14–15%, D30 ≈ 2–3%. Learning happens in exam-driven bursts,
so episodic usage is normal.

**Implication for Nexley:** expect low raw retention vs consumer apps. Judge against
*education* benchmarks and against your own trend line, not against Duolingo. Exam timing
will dominate the signal — if possible, segment by "weeks to nearest exam."

**Levers that move early retention:**
- Fast time-to-value (the §5 pre-signup flow).
- A reason to come back *this week*: a spaced-repetition quiz due, a streak, "your syllabus
  is 40% noted."
- Reliable sync — one lost note kills retention.
- Re-engagement: email or push when a quiz is due (push needs an installed PWA or a native
  wrapper).

**Measure in PostHog:** the Retention view, cohorted by first-seen week. Define "retained"
as a *value* action (opened **and** wrote/quizzed), not just "app opened."

---

## 9. Open decisions for Alec

1. **PWA-only beta, or wrap with Capacitor now?** Decides whether Firebase App Distribution
   / TestFlight matter yet. (Recommendation: PWA-only for first beta.)
2. **Waitlist: dedicated tool (GetWaitlist etc.) or self-built on Supabase?**
   (Recommendation: self-built — you own the minors' data and it's on-brand.)
3. **How much analytics to turn on given school-age users** — session replay on or off at
   launch? What consent model? (Recommendation: replay off initially, `identified_only`,
   inputs masked, legal.html updated.)
4. **Waitlist positioning / target** — lead with NSW HSC Year 11–12? This is tied to the
   still-open branding decision (one app vs umbrella; "classwork" vs "notebook").
5. **Referral on the waitlist — yes or no?** (Weigh viral growth vs vanity signups.)

---

## 10. Suggested sequence

1. Fix the known onboarding bugs (double-signup, empty state) — prerequisite for §5.
2. Stand up a public marketing + waitlist page on the existing GitHub Pages site; PostHog
   on it; Supabase `waitlist` table. (Also lays the GEO foundation.)
3. Add PostHog to the app: `identified_only`, inputs masked, `legal.html` updated, consent
   choice.
4. Build the pre-signup onboarding flow (local state → migrate on signup).
5. Define activation + retention events; watch cohorts by signup week.
6. Only then decide on a native wrapper + TestFlight / Firebase for a store beta.
7. GEO foundations (structured public content, allow AI crawlers, chase 3–5 credible
   third-party mentions) — ongoing, in the background.

---

## Sources

- [GeeksforGeeks — MVP vs Beta Release](https://www.geeksforgeeks.org/difference-between-minimum-viable-product-mvp-and-beta-release/)
- [Feedough — MVP vs Beta](https://www.feedough.com/mvp-vs-beta-difference/)
- [CCS Technologies — Alpha, Beta, and Production Releases](https://ccs-technologies.com/beyond-the-minimum-viable-product-understanding-alpha-beta-and-production-releases-for-successful-product-launches/)
- [Firebase App Distribution — product page](https://firebase.google.com/products/app-distribution)
- [Firebase App Distribution — docs](https://firebase.google.com/docs/app-distribution)
- [Brightec — Firebase App Distribution vs TestFlight](https://www.brightec.co.uk/blog/firebase-app-distribution-vs-testflight)
- [TestApp.io — Firebase App Distribution alternatives 2026](https://blog.testapp.io/firebase-app-distribution-alternatives/)
- [Appcircle — iOS App Distribution: TestFlight, Ad Hoc, Enterprise](https://appcircle.io/guides/ios/ios-app-distribution)
- [LaunchList — waitlist landing page examples that convert (2026)](https://getlaunchlist.com/blog/waitlist-landing-page-examples-that-convert)
- [Unicorn Platform — waitlist page strategy 2026](https://unicornplatform.com/blog/waitlist-page-strategy-in-2026/)
- [Waitlister — waitlist landing page optimization guide](https://waitlister.me/growth-hub/guides/waitlist-landing-page-optimization-guide)
- [Appcues — Duolingo user onboarding](https://goodux.appcues.com/blog/duolingo-user-onboarding)
- [Relaunch — Duolingo onboarding teardown (9% conversion)](https://relaunch.ai/blog/duolingo-onboarding-teardown-7-b-tests-behind-their-9-conver.html)
- [Tasu.ai — Duolingo onboarding: 38 screens](https://tasu.ai/library/duolingo)
- [PostHog pricing 2026 breakdown (Flexprice)](https://flexprice.io/blog/posthog-pricing-guide)
- [PostHog free tier 2026 (userorbit)](https://userorbit.com/blog/posthog-pricing-guide)
- [PostHog & GDPR compliance — docs](https://posthog.com/docs/privacy/gdpr-compliance)
- [PostHog — cookieless tracking tutorial](https://posthog.com/tutorials/cookieless-tracking)
- [Enrich Labs — GEO complete 2026 guide](https://www.enrichlabs.ai/blog/generative-engine-optimization-geo-complete-guide-2026)
- [AI Magicx — getting cited in ChatGPT, Claude, Perplexity 2026](https://www.aimagicx.com/blog/generative-engine-optimization-chatgpt-perplexity-2026)
- [Panto — mobile app retention statistics 2026](https://www.getpanto.ai/blog/mobile-app-retention-statistics)
- [UXCam — mobile app retention benchmarks by industry 2026](https://uxcam.com/blog/mobile-app-retention-benchmarks/)
- [Appcues — app retention benchmarks 2026](https://www.appcues.com/blog/app-retention-is-hard-heres-how-to-improve-it)
