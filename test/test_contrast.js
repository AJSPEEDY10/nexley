/* Text colours clear WCAG AA against the grounds they are actually painted on.

   THE BUG THIS EXISTS TO PREVENT. Until 2026-09-08 `--muted` was #7E7669, which
   measured 4.41:1 on --card, 3.77 on --paper and 3.47 on --surface. Every caption,
   eyebrow, timestamp and bit of metadata in the app failed AA in the LIGHT theme,
   and most of them are set at 9-13px where legibility matters most. The dark theme
   was already clean, which is exactly how it survived: whoever looked at it was
   almost certainly looking at dark mode, and the failure is invisible to anyone
   with good eyesight on a good screen anyway.

   That is the whole argument for checking this by arithmetic rather than by eye.
   A designer's judgement of "readable enough" is made in ideal conditions; the
   student reading it is on a bus, on a cracked iPad, in the sun.

   WHY IT CHECKS TOKEN PAIRS AND NOT THE LIVE DOM. A browser sweep only sees the
   panes that happen to be rendered — the audit that found this reached 19 elements
   out of an app with 21 dialogs. Checking the palette itself covers every screen
   at once, including ones nobody has opened yet, and it is what actually failed:
   one token, five visible symptoms.

   A NOTE ON MEASURING THIS IN A BROWSER, since the next person will try: .snav and
   friends carry `transition:background .12s`, so getComputedStyle straight after
   flipping the theme returns the colour mid-animation. That produced a convincing
   1.05:1 "invisible text" reading that was pure artifact. Kill transitions first
   (`*{transition:none!important}`) or you will chase a bug that is not there. */
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.css'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\ncontrast\n');

function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * srgb((n >> 16) & 255) + 0.7152 * srgb((n >> 8) & 255) + 0.0722 * srgb(n & 255);
}
function ratio(a, b) {
  const x = lum(a), y = lum(b), hi = Math.max(x, y), lo = Math.min(x, y);
  return (hi + 0.05) / (lo + 0.05);
}

/* Pull a token out of a specific block rather than the first match in the file —
   the same names are declared once per theme. */
function tokensFrom(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) {
    if (!(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

const lightBlock = css.slice(0, css.indexOf('@media (prefers-color-scheme:dark)'));
const darkMatch = css.match(/:root\[data-theme="dark"\]\s*\{[\s\S]*?\}/);
ok('found the light palette', /--muted\s*:/.test(lightBlock));
ok('found the dark palette', !!darkMatch && /--muted\s*:/.test(darkMatch[0]));

const themes = {
  light: tokensFrom(lightBlock),
  dark: tokensFrom(darkMatch ? darkMatch[0] : '')
};

/* The three grounds any text in this app can land on. --surface is the darkest of
   the light three (the rail), and it is the one that actually failed. */
const GROUNDS = ['card', 'paper', 'surface'];

/* Foreground tokens used for real text, with the minimum each must reach.
   4.5 is AA for normal text; --ink-2 and --muted carry body copy and captions at
   9-15px so they get the full 4.5 rather than the large-text exemption. */
const FOREGROUNDS = [
  ['ink', 4.5],
  ['ink-2', 4.5],
  ['muted', 4.5],
  ['structure', 4.5],   // links and primary actions
  ['brass', 3.0],       // used on its own soft ground for chips, not body copy
];

for (const [theme, tok] of Object.entries(themes)) {
  for (const [fg, need] of FOREGROUNDS) {
    if (!tok[fg]) { ok(theme + ': --' + fg + ' is defined', false, 'token missing'); continue; }
    let worst = Infinity, worstOn = '';
    for (const g of GROUNDS) {
      if (!tok[g]) continue;
      const r = ratio(tok[fg], tok[g]);
      if (r < worst) { worst = r; worstOn = g; }
    }
    ok(theme + ': --' + fg + ' clears ' + need + ':1 on every ground (worst ' +
       worst.toFixed(2) + ' on --' + worstOn + ')', worst >= need);
  }
}

/* The verdict colours are read as status, so they have to be legible on their own
   soft backgrounds — that pairing is the only place they are used for text. */
for (const [theme, tok] of Object.entries(themes)) {
  for (const name of ['good', 'warn', 'bad']) {
    const fg = tok[name], bg = tok[name + '-soft'];
    if (!fg || !bg) { ok(theme + ': --' + name + ' has a soft pair', false); continue; }
    const r = ratio(fg, bg);
    ok(theme + ': --' + name + ' on --' + name + '-soft clears 4.5:1 (' + r.toFixed(2) + ')',
       r >= 4.5);
  }
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
