/* Avatars: stable identity, and legible in both themes.

   An avatar has exactly one job — let you tell people apart at a glance — and two
   ways to fail it silently.

   THE FIRST IS DRIFT. If the tone came from anything but the username (an index in
   a list, a row id, the user's chosen accent), the same person would look different
   on two screens, or change colour when someone re-accents the app. Then the mark
   means nothing and you are back to reading the text. So the tone is a pure hash of
   the username and this file pins that down.

   THE SECOND IS CONTRAST, and it is the one that actually happened. The first cut
   reused --margin-rule and --muted, tinting their backgrounds with color-mix.
   Measured in a real browser that gave 2.37:1 and 3.66:1 — below even the 3.0 floor
   for incidental UI, let alone the 4.5 that a letter this small needs. It looked
   fine to a sighted reader on a good monitor, which is exactly why it needed
   measuring rather than eyeballing. The tones are now explicit light/dark pairs and
   every one of the eight is checked here, so a future palette edit fails the build
   instead of quietly dimming somebody's initial.

   Both checks read the REAL source — the hash is extracted out of app.js and run,
   the colours are parsed out of app.css — so this cannot drift from what ships. */
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..', 'app');
const js = fs.readFileSync(path.join(appDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(appDir, 'app.css'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\navatars\n');

// ---------------------------------------------------------------------------
// 1 · The real hash, lifted out of app.js and executed
// ---------------------------------------------------------------------------
const toneSrc = js.match(/function avatarTone\s*\([\s\S]*?\n  \}/);
ok('avatarTone() is present in app.js', !!toneSrc);

const tonesSrc = js.match(/var AVATAR_TONES\s*=\s*(\d+)/);
ok('AVATAR_TONES is declared', !!tonesSrc);
const TONES = tonesSrc ? +tonesSrc[1] : 0;

let avatarTone = null;
if (toneSrc && tonesSrc) {
  avatarTone = new Function('var AVATAR_TONES = ' + TONES + ';' + toneSrc[0] + '; return avatarTone;')();
}

if (avatarTone) {
  ok('the same username always gives the same tone',
    avatarTone('samuel') === avatarTone('samuel') && avatarTone('a') === avatarTone('a'));

  ok('every tone is a valid index',
    ['alec', 'sam', 'x', '', 'a-very-long-username-indeed', '123']
      .every(u => Number.isInteger(avatarTone(u)) && avatarTone(u) >= 0 && avatarTone(u) < TONES));

  ok('different usernames do not all collapse to one tone',
    new Set(['alec','samuel','priya','tom','wei','jess','noah','mia'].map(avatarTone)).size > 1);

  // A hash that clusters is as bad as no hash: a class of 30 all in one colour.
  const counts = new Array(TONES).fill(0);
  for (let i = 0; i < 600; i++) counts[avatarTone('student' + i)]++;
  const min = Math.min(...counts), max = Math.max(...counts);
  ok('the spread across ' + TONES + ' tones is even enough to be useful',
    min > 600 / TONES * 0.5, 'counts: ' + counts.join(', '));
  ok('no tone is left unused', min > 0, 'counts: ' + counts.join(', '));
}

// ---------------------------------------------------------------------------
// 2 · Contrast, computed from the tokens app.css actually ships
// ---------------------------------------------------------------------------
function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * srgb((n >> 16) & 255) + 0.7152 * srgb((n >> 8) & 255) + 0.0722 * srgb(n & 255);
}
function ratio(a, b) {
  const x = lum(a), y = lum(b), hi = Math.max(x, y), lo = Math.min(x, y);
  return (hi + 0.05) / (lo + 0.05);
}

/* Same trap as the light block below: there is more than one
   :root[data-theme="dark"] block in this file and the first is the main palette,
   which declares no --av tokens at all. Match on content, not on position. */
const darkBlock = [...css.matchAll(/:root\[data-theme="dark"\]\s*\{[^}]*\}/g)]
  .map(m => m[0]).find(b => /--av0\s*:/.test(b));
ok('a dark-theme avatar token block exists', !!darkBlock);

function tokensIn(scope) {
  const out = {};
  for (const m of scope.matchAll(/--(av\d(?:-bg)?)\s*:\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}
/* The light pair is in a bare :root block, but NOT the first one in the file —
   the avatar tokens are declared next to the rules that use them, far below the
   main palette. Slicing at the first dark media query (which is near the top)
   cuts them off entirely and every lookup comes back empty, which is a test that
   passes by finding nothing. So find the :root block that actually declares --av0. */
const lightBlock = [...css.matchAll(/:root\s*\{[^}]*\}/g)]
  .map(m => m[0]).find(b => /--av0\s*:/.test(b));
ok('a light-theme avatar token block exists', !!lightBlock);
const themes = { light: tokensIn(lightBlock || ''), dark: tokensIn(darkBlock || '') };

const THRESHOLD = 4.5;
for (const [name, tok] of Object.entries(themes)) {
  for (let i = 0; i < TONES; i++) {
    const fg = tok['av' + i], bg = tok['av' + i + '-bg'];
    if (!fg || !bg) { ok(name + ': tone av' + i + ' has both a colour and a background', false, 'missing token'); continue; }
    const r = ratio(fg, bg);
    ok(name + ': av' + i + ' reaches ' + THRESHOLD + ':1 (' + r.toFixed(2) + ')', r >= THRESHOLD,
      fg + ' on ' + bg);
  }
}

// ---------------------------------------------------------------------------
// 3 · The tone must not ride on anything the user can change
// ---------------------------------------------------------------------------
const avatarRules = [...css.matchAll(/\.avatar\.av-\d\{[^}]*\}/g)].map(m => m[0]).join(' ');
ok('there are per-tone avatar rules to check', avatarRules.length > 0);
ok('no avatar tone is built on --structure (users can re-accent it)',
  !/--structure/.test(avatarRules),
  'an avatar that changes hue with the accent is not an identity mark');
for (const verdict of ['--good', '--warn', '--bad', '--danger']) {
  ok('no avatar tone spends the verdict colour ' + verdict,
    !new RegExp(verdict + '\\b').test(avatarRules));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
