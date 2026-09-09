/* Corner radii come from the scale, and the scale has one spelling per idea.

   THE COMPLAINT THIS ANSWERS. The batch-4 design notes say Nexley's radii are
   "hard-coded numbers with no relationship to each other, which is the single most
   checkable reason a UI reads as amateur", and pair it with Apple's corner
   concentricity rule — inner radius = outer radius minus the padding between them.

   BOTH HALVES WERE CHECKED IN A BROWSER BEFORE ANY OF THIS WAS WRITTEN, and the
   answer split.

   Concentricity turned out NOT to apply. Measuring every rounded element against
   its nearest rounded ancestor across the app and all 21 dialogs found 79 pairs
   whose radii differ from the concentric ideal — and ZERO of them sitting at a
   corner. Concentricity only means anything when the inner corner falls inside the
   outer curve; where the two never meet, forcing inner = outer − padding is not
   more correct, it is arbitrary in a different direction. So it was not done, and
   that is a measurement rather than a preference.

   The consistency half was real. "Fully round" was being written THREE ways —
   `99px`, `50%`, and a `--r-pill` token that existed and was going unused — and
   the public pages had eyeballed `10px` and `8px` values that belonged to no
   scale at all. Three spellings of one idea is how a scale stops being a scale.

   So this file guards the part that was actually broken: every radius is a token
   or an explicit 0. It cannot tell you whether a radius is tasteful. It can tell
   you nobody reached for a number. */
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..', 'app');
const css = fs.readFileSync(path.join(appDir, 'app.css'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\ncorner radii\n');

// ---------------------------------------------------------------------------
// 1 · The scale itself
// ---------------------------------------------------------------------------
const tokens = {};
for (const m of css.matchAll(/--r-([a-z]+)\s*:\s*([0-9]+)px/g)) tokens[m[1]] = +m[2];
ok('the radius scale is declared', Object.keys(tokens).length >= 3, Object.keys(tokens).join(', '));

for (const step of ['sm', 'md', 'lg', 'pill']) {
  ok('--r-' + step + ' exists', tokens[step] !== undefined);
}

/* Three steps was a deliberate decision ("Ten was nine too many"). A fourth
   appearing usually means someone wanted a value the scale did not offer, which
   is the moment to change the scale rather than bolt a step onto it. */
const steps = Object.entries(tokens).filter(([, v]) => v < 900).map(([, v]) => v).sort((a, b) => a - b);
ok('there are exactly three real steps plus a pill', steps.length === 3, steps.join(', '));

/* Each step should be clearly larger than the last — a scale whose steps are a
   pixel apart is not a scale, it is a list. */
let ascending = true;
for (let i = 1; i < steps.length; i++) if (steps[i] <= steps[i - 1] + 1) ascending = false;
ok('the steps are meaningfully far apart', ascending, steps.join(' → '));

// ---------------------------------------------------------------------------
// 2 · Nothing bypasses it
// ---------------------------------------------------------------------------
/* The token declarations themselves are the one place a raw px radius belongs. */
const declLine = /--r-[a-z]+\s*:\s*[0-9]+px/;
const offenders = [];
const files = ['app.css', 'index.html', 'legal.html', 'compare.html', '404.html'];
for (const f of files) {
  const src = fs.readFileSync(path.join(appDir, f), 'utf8');
  src.split('\n').forEach((line, i) => {
    if (declLine.test(line)) return;
    for (const m of line.matchAll(/border-radius\s*:\s*([^;}\n]+)/g)) {
      const v = m[1].trim();
      if (v === '0' || v.startsWith('var(--r-')) continue;
      offenders.push(f + ':' + (i + 1) + '  ' + v);
    }
  });
}
ok('every border-radius is a token or an explicit 0',
  offenders.length === 0, offenders.slice(0, 8).join(' | '));

/* The three spellings that actually happened, called out by name so the next
   person sees why the rule exists rather than just that it does. */
for (const [spelling, why] of [
  ['border-radius:50%', 'renders identically to the pill token on a square, and differently on anything else'],
  ['border-radius:99px', 'a near-miss of the 999px token — same intent, different number']
]) {
  const hit = files.some(f => fs.readFileSync(path.join(appDir, f), 'utf8').includes(spelling));
  ok('no "' + spelling + '" — ' + why, !hit);
}

// ---------------------------------------------------------------------------
// 3 · The pill token is used, not just declared
// ---------------------------------------------------------------------------
/* It went unused for a long time while two literals did its job, which is how the
   inconsistency built up in the first place. */
const pillUses = (css.match(/var\(--r-pill\)/g) || []).length;
ok('the pill token is actually used', pillUses > 5, pillUses + ' uses');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
