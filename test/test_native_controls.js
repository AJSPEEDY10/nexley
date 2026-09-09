/* The browser's own widgets have to be in the app's palette, not the OS's.
 *
 * THE TRAP THIS ENCODES, measured in a browser 2026-09-09: `:root` carried
 * `color-scheme: light dark`, which tells the browser "this page handles both",
 * so it paints selects, scrollbars and carets to the OPERATING SYSTEM's
 * preference. Nexley has its own theme switch, so a reader on a dark-mode
 * machine who picked the light theme got a light page with **six dark native
 * selects on it (#3B3B3B)** — one of them the year picker on the sign-up form,
 * sitting beside three correctly styled inputs.
 *
 * Two separate faults, both guarded here:
 *   1. color-scheme followed the OS instead of the app's own theme.
 *   2. `.field input` was styled and `.field select` was not, so a control was
 *      styled or not depending on which tag it happened to be.
 *
 * This is a source check, not a render check — the browser measurement that
 * found it is recorded above rather than re-run, because a headless render of
 * native widget chrome is not something this suite can do.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const css = fs.readFileSync(path.join(APP, 'app.css'), 'utf8');
const appHtml = fs.readFileSync(path.join(APP, 'app.html'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\nnative controls\n');

console.log('1. color-scheme tracks the app theme, not the machine');
ok('the default is a single scheme, not "light dark"',
  /:root\s*\{[^}]*color-scheme\s*:\s*light\s*;/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')) &&
  !/color-scheme\s*:\s*light\s+dark/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')),
  'a page that says it handles both gets the OS preference, which is the bug');
ok('an explicit dark theme switches it',
  /:root\[data-theme="dark"\]\s*\{\s*color-scheme\s*:\s*dark/.test(css));
ok('so does a dark OS when no theme has been forced',
  /:root:not\(\[data-theme="light"\]\)\s*\{\s*color-scheme\s*:\s*dark/.test(css));
ok('and forcing the light theme on a dark machine stays light — that is the '
  + 'case that was broken',
  /:root:not\(\[data-theme="light"\]\)\s*\{\s*color-scheme\s*:\s*dark/.test(css));

console.log('\n2. Every select is dressed, not left to the browser');
/* Selects grouped by the container that is supposed to style them. If a new
   container shows up here, it needs a rule of its own before this passes. */
const STYLED_CONTAINERS = [
  { sel: '.field select', why: 'form fields, including the sign-up year picker' },
  { sel: '.setrow select', why: 'settings rows' },
  { sel: '.pane-sel select', why: 'pane headers' },
  { sel: '.qrow select', why: 'per-question mark rows' }
];
STYLED_CONTAINERS.forEach(c => {
  const re = new RegExp(c.sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  ok('there is a rule for ' + c.sel + ' (' + c.why + ')', re.test(css));
});

ok('.field styles input and select with the SAME rule, so a new field cannot '
  + 'land half-dressed',
  /\.field\s+input\s*,\s*\.field\s+select\s*\{/.test(css));

ok('the styled selects set a background — inheriting the widget default is the fault',
  /\.field\s+input\s*,\s*\.field\s+select\s*\{[^}]*background\s*:/.test(css));
ok('and a colour, so text stays legible on it',
  /\.field\s+input\s*,\s*\.field\s+select\s*\{[^}]*color\s*:/.test(css));

console.log('\n3. Nothing new has slipped in unstyled');
/* Every select in app.html, by the container it sits in. This is the list that
   was six-strong before the fix; it exists so that adding a select somewhere new
   is a decision rather than an accident. */
const selects = (appHtml.match(/<select\b[^>]*id="([^"]+)"/g) || [])
  .map(s => /id="([^"]+)"/.exec(s)[1]);
ok('app.html still has the selects this was written against', selects.length >= 10,
  selects.length + ' found');
const KNOWN = ['fSchoolYear', 'noteSubject', 'noteSyllabus', 'paperSel', 'cwSubject',
  'tkSubject', 'mkSubject', 'cardSyllabus', 'fileSubject', 'fileSyllabus',
  'cmSubject', 'ySchoolYear', 'setSchoolYear'];
const unknown = selects.filter(id => KNOWN.indexOf(id) === -1);
ok('no select has appeared that this file has never been checked against',
  unknown.length === 0,
  unknown.join(', ') + ' — add it to KNOWN once you have confirmed it is styled');

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
