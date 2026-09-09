/* Touch targets reach 44px on a touch device — and the rules that do it actually win.

   WHY THIS FILE EXISTS. Nexley is aimed at an iPad. Apple's minimum target is
   44x44, and that is not a rounding suggestion: 32px is roughly the width of a
   fingertip, so a 32px control makes every tap a small gamble. Measuring every
   visible control at phone width on 2026-09-09 found seven under the minimum —
   including all three rail icon buttons, which are the only way into the inbox,
   comps and settings, and `.edit` at 27x21, which the coarse block was already
   UNHIDING on touch: a live target that had never been given a size to be hit at.

   THREE BUGS WORTH REMEMBERING. All three were invisible in a diff, and all three
   were caught only by measuring afterwards.

   1 · ORDERING. The fix was first written into the coarse block at ~line 1500,
       while `.toolbtn{width:32px}` is declared at ~1690. Equal specificity, later
       wins — so the rule parsed fine, changed nothing, and reviewed as correct.
       The touch block must therefore be the LAST coarse block in the file.

   2 · A SELECTOR THAT MATCHED NOTHING. The nav fix was written `.rail-nav .mode`,
       but those buttons live in `.modes`. Valid CSS addressing an element that
       does not exist is the quietest possible failure. Every selector here is
       checked against the real markup — and against app.js too, because most of
       this app's DOM is built in JavaScript (`.snav` and `.nrow` appear zero times
       in the HTML).

       ⚠️ BE HONEST ABOUT WHAT THAT CATCHES. It catches a class name that exists
       NOWHERE. It does NOT catch `.rail-nav .mode`, because both of those classes
       are real — they just never appear in that relationship. Verifying a
       descendant selector needs a live DOM, and this app builds most of its DOM at
       runtime, so parsing app.html would not settle it either. That bug was found
       by measuring rendered sizes in a browser, and if these rules are ever
       changed, measuring is still the only thing that will confirm it.

   3 · This test's own first draft built its patterns with `new RegExp(...)` from
       strings, and the escapes did not survive into the file: '\\b' became a
       literal backspace character, so seven checks failed against code that was
       perfectly correct. Everything below uses plain string search where a string
       search will do.

   What this cannot do is assert rendered pixel sizes — that needs a browser where
   (pointer:coarse) actually matches, which a desktop iframe does not. What it can
   do is guarantee the rules exist, name real elements, and are placed to win. */
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..', 'app');
const css = fs.readFileSync(path.join(appDir, 'app.css'), 'utf8');
const html = fs.readFileSync(path.join(appDir, 'app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(appDir, 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\ntouch targets\n');

// Every @media (pointer:coarse) block, with where it sits in the file.
const MARKER = '@media (pointer:coarse)';
const blocks = [];
let from = 0;
for (;;) {
  const at = css.indexOf(MARKER, from);
  if (at === -1) break;
  let i = css.indexOf('{', at) + 1;
  const start = i;
  let depth = 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  blocks.push({ at, body: css.slice(start, i - 1), end: i });
  from = i;
}
ok('there are coarse-pointer blocks at all', blocks.length > 0, blocks.length + ' found');

const touch = blocks.find(b => b.body.includes('.toolbtn'));
ok('the touch-target block is present', !!touch);

// ---------------------------------------------------------------------------
// 1 · Ordering — the bug that made the first attempt silently inert
// ---------------------------------------------------------------------------
if (touch) {
  const later = blocks.filter(b => b.at > touch.at);
  ok('the touch-target block is the LAST coarse block in the file',
    later.length === 0, later.length + ' coarse block(s) come after it');

  const tail = css.slice(touch.end);
  for (const sel of ['.toolbtn{', '.acct{', '.nrow{']) {
    const i = tail.indexOf(sel);
    const near = i === -1 ? '' : tail.slice(i, i + 220);
    const redeclares = /[;{]\s*(?:width|height|min-height)\s*:/.test(near);
    ok('no later rule re-declares a size for ' + sel.slice(0, -1), !redeclares,
      redeclares ? 'a rule after the touch block would win' : '');
  }
}

// ---------------------------------------------------------------------------
// 2 · Every selector names something that actually exists
// ---------------------------------------------------------------------------
const knownClasses = new Set();
const knownIds = new Set();
for (const src of [html, appJs]) {
  for (const m of src.matchAll(/class(?:Name)?\s*[=:]\s*['"]([^'"]+)['"]/g)) {
    for (const c of m[1].split(/\s+/)) if (c) knownClasses.add(c.replace(/^\./, ''));
  }
  for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\(\s*['"]([^'"]+)['"]/g)) {
    knownClasses.add(m[1]);
  }
  for (const m of src.matchAll(/id\s*=\s*"([^"]+)"/g)) knownIds.add(m[1]);
  for (const m of src.matchAll(/\$\(\s*'([A-Za-z0-9_-]+)'\s*\)/g)) knownIds.add(m[1]);
}
ok('class names were collected from the markup and the JS',
  knownClasses.size > 20, knownClasses.size + ' found');

if (touch) {
  const selectors = touch.body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map(chunk => chunk.split('{')[0].trim())
    .filter(Boolean)
    .flatMap(s => s.split(','))
    .map(s => s.trim())
    .filter(Boolean);

  ok('the block declares some selectors', selectors.length > 0);

  for (const sel of selectors) {
    const parts = sel.split(/\s+/).filter(Boolean);
    const missing = parts.filter(p => {
      if (p.startsWith('#')) return !knownIds.has(p.slice(1));
      if (p.startsWith('.')) return !knownClasses.has(p.slice(1));
      return false;
    });
    ok('selector "' + sel + '" names real elements', missing.length === 0,
      'never appears in app.html or app.js: ' + missing.join(', '));
  }
}

// ---------------------------------------------------------------------------
// 3 · The controls that measured short are covered somewhere
// ---------------------------------------------------------------------------
const coarseAll = blocks.map(b => b.body).join('\n');
for (const sel of ['.toolbtn', '.acct', '.mode', '.edit', '.nrow', '.snav', '.btn']) {
  ok(sel + ' gets a touch size in a coarse block', coarseAll.includes(sel));
}

// 44 is the number. Lowering it should be a visible decision, not a quiet edit.
const under = [];
if (touch) {
  for (const m of touch.body.matchAll(/min-(?:width|height)\s*:\s*(\d+)px/g)) {
    if (+m[1] < 44) under.push(m[1] + 'px');
  }
}
ok('nothing in the touch block sets a minimum below 44px', under.length === 0, under.join(', '));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
