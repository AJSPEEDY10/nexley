# Nexley — design system

**Written 2026-09-09 by reading `app/app.css`, not by deciding anything new.** Everything here
already ships; this file exists because the system was legible only to whoever was reading the
stylesheet at the time. If the two ever disagree, `app.css` is right and this is stale — fix it.

The shape follows the `styles.refero.design` pattern named in `GROWTH_AND_LAUNCH.md` §12: one
line of art direction, named colours each with **one job**, one typeface with a named
substitute, a fixed type scale. The reason to have it in this form is blunt — you cannot prompt
a feeling. "Make it more premium" is an adjective. A table with a role per colour is a rule, and
rules are the only thing a model or a new contributor can actually follow.

---

## Art direction

> Editorial and calm. Feint-ruled paper, a bookish serif, syllabus outcome codes as the
> structural device, one highlighter-yellow mark used sparingly. The rail is the quietest
> surface; the page you write on is the brightest.

Grounded in the real materials of study: syllabus documents, ruled paper, highlighters, revision
guides. Not a productivity app, not a dashboard, not a "study aesthetic" moodboard.

**What that rules out**, which is the more useful half: no gradients, no glassmorphism, no card
shadows used as decoration, no icon-per-row, no accent colour chosen because it looked modern.
Component libraries like `ui.watermelon.sh` and `motion-primitives.com` are the house style of
the vibecoded look and are rejected on purpose, not overlooked.

---

## Colour

Every value below is already in `:root`. Each has **one** job. The test of this system is that a
colour never has to be chosen — the role picks it.

### Ground and ink

| Token | Light | Role — the only thing it is for |
|---|---|---|
| `--paper` | `#EFEBE1` | The desk. The surface everything else sits on. |
| `--surface` | `#E7E2D6` | Recessed chrome — the rail. Deliberately dimmer than the page. |
| `--card` | `#FFFDF7` | The page you write on. Sheet, not white. The brightest thing. |
| `--ink` | `#1A1815` | Body text. Warm near-black, never `#000`. |
| `--ink-2` | `#443F37` | Secondary text that is still text. |
| `--muted` | `#6A6255` | Metadata, captions, eyebrows. **Darkened 09-08 off a measured WCAG failure** — the old value was 3.47:1 on `--surface`. Do not lighten it back by eye. |
| `--rule` | `#D5CEC0` | Hairlines. The ruled line. |
| `--rule-soft` | `#E6E1D6` | A rule that should be felt more than seen. |

### The two that carry meaning

| Token | Light | Role |
|---|---|---|
| `--structure` | `#21493B` | Eucalypt. Links, primary actions, active state. Reads as ink, not as a brand colour shouting. **User-configurable** via `data-accent`, so nothing that needs a stable identity may be built on it. |
| `--mark` | `#E7E24C` | The highlighter. **The one loud thing in the app.** Selection, coverage fill, the current note's spine. If a second loud colour appears, this one stops working. |

### Verdicts — reserved, and this is load-bearing

| Token | Light | Role |
|---|---|---|
| `--good` / `--good-soft` | `#2C6B4F` / `#DCE9E1` | A result that was actually earned. |
| `--warn` / `--warn-soft` | `#856011` / `#F1EAD5` | Attention. Adjusted 09-08: was 4.42:1 on its own ground, under AA by a hair. |
| `--bad` / `--bad-soft` | `#A03A22` / `#F3E0D9` | A real problem. |

**The rule that makes them mean anything: colour is reserved for verdicts.** Green means a mark
someone earned. It does not mean "on", "selected", or "nice". This is why avatars got four
non-verdict tones of their own rather than a rainbow — decorating names with the palette is
exactly how green stops meaning anything two panes away in Marks.

### Identity

`--av0`…`--av3` with their `-bg` pairs. Four tones, assigned by hashing a username, so a person
looks the same everywhere with nothing stored. Deliberately **not** built on `--structure`,
because that is user-configurable and an identity mark that changes hue is not an identity mark.
Every pair was measured; the worst is 6.1:1.

### Dark theme

Every token above has a dark counterpart. Two rules, both already enforced:
- Define the light value on bare `:root`, and **only** override in the dark blocks. A colour
  whose sole definition lives inside a media query has no light value at all.
- Both `@media (prefers-color-scheme:dark)` **and** `:root[data-theme="dark"]` need the value,
  or the manual toggle and the system setting disagree.

---

## Type

**Display and reading: Newsreader**, self-hosted and precached, with `Iowan Old Style` → Palatino
→ Book Antiqua → Georgia as the substitute stack. The serif is what makes this a notebook rather
than a spreadsheet; it is not negotiable.
**UI: Segoe UI Variable Text** → system-ui. **Code and metadata: `ui-monospace`.** Outcome codes
are set in mono on purpose — they are the structural device, and mono is what makes them read as
a reference rather than as prose.

Fixed scale, in `rem` so it honours the reader's own text size:

| Token | px @ default | Job |
|---|---|---|
| `--t-2xs` | 9 | mono micro-labels |
| `--t-xs` | 10 | eyebrows, chips |
| `--t-sm` | 11 | captions, metadata |
| `--t-base` | 13 | **UI text — the anchor** |
| `--t-md` | 15 | list titles, emphasis |
| `--t-lg` | 17 | reading |
| `--t-xl` | 19 | brand, dialog titles |
| `--t-2xl` | `clamp()` | section headings |
| `--t-3xl` | `clamp()` | the largest heading |

**No bare `px` font sizes.** About a third of phone users change their text size, some to 310%,
and Apple asks for 200%; a `px` size opts that element out silently. `test/test_type.js` fails
on any. The two `clamp()` steps scale headings *down* on narrow screens — measured at 36px
desktop → 27.8px on a 390px phone.

⚠️ `clamp()` and `calc()` need whitespace around `+` and `−`. Without it the declaration is
dropped silently and you inherit. The note title rendered at 14px for an entire redesign pass
because of this.

---

## Space and shape

Spacing is a modular scale, not a 4px grid: `--s-1`…`--s-9` = 2, 4, 6, 9, 12, 16, 22, 30, 42.

Radii are **three steps and a pill** — `--r-sm` 4 (chips, pips), `--r-md` 7 (buttons, fields,
rows), `--r-lg` 11 (cards, dialogs), `--r-pill` 999. Ten steps was nine too many.

Two findings from the 09-09 audit, both measured before acting:

- **Corner concentricity does not apply here.** The rule — inner radius = outer minus padding —
  was checked against every rounded element and its nearest rounded ancestor across the app and
  all 21 dialogs. 79 pairs differ from the concentric ideal and **none of them sit at a corner**.
  Where the two curves never meet, forcing the arithmetic is arbitrary rather than correct.
- **Consistency did apply.** "Fully round" was written three ways — `99px`, `50%`, and a
  `--r-pill` token that was going unused — and the public pages had eyeballed `10px`/`8px`
  values belonging to no scale. Now every radius is a token or an explicit `0`, enforced by
  `test/test_radius.js`.

---

## Touch

Apple's minimum is 44×44 and it is not a rounding suggestion — 32px is roughly a fingertip.
Everything interactive reaches 44 under `@media (pointer:coarse)`; the mouse layout stays
compact and is byte-identical.

⚠️ Those rules must stay **last in the file**. Written mid-file they lose to later base
declarations at equal specificity — the fix parses, changes nothing, and reviews as correct.
`test/test_touch.js` fails if anything is added after them.

---

## Waiting

Six failures, each with its fix, from `GROWTH_AND_LAUNCH.md` §12:

1. A spinner says nothing → **skeleton in the shape of the real content.**
2. A dead button gets pressed twice → **acknowledge within 100ms, then lock it.**
3. Late content pushes the button down → **reserve the space.**
4. A bar with no number is not progress → percent, step, or time left; and if you genuinely
   have none, say the honest thing instead of drawing a bar.
5. One slow request must not freeze the page → render the shell, fill regions after.
6. **Every spinner needs an ending** → time out, say what broke, offer the retry.

`skeleton()` and `ready()` in `app.js` are the pair. **Every path that paints into a
skeletonised pane must call `ready()`**, including the error paths — an `aria-busy` left set
tells a screen reader the pane is loading forever.

---

## What this file cannot do

It cannot tell you whether something is *good*. It can tell you whether a value was chosen from
the system or reached for, which is a different and much more checkable question — and it is the
one that was actually going wrong. The remaining design work is **reference and audit**, not
another repalette: two have already been done, and a third is not the answer.
