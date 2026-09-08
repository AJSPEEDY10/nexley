/* Every form control has a name a screen reader can actually announce.

   THE BUG THIS EXISTS TO PREVENT. An audit of the real app DOM on 2026-09-08 found
   13 of 54 controls with no accessible name. Most of them "looked" labelled: they
   had a placeholder. A placeholder is not a label. It is not reliably exposed as
   an accessible name, and it disappears the moment the user types — so a person
   using a screen reader hears "edit text, blank" on a field, and a sighted person
   who tabs away and back has lost the only description of what they were filling
   in. Three file inputs and both settings toggles had nothing at all.

   Nothing about that is visible on screen, which is exactly why it survived a
   click-through QA pass and needs a mechanical check instead.

   The rest of the structure was already clean and this pins that down too: no
   positive tabindex (which hijacks tab order and is almost always a mistake), no
   button whose only content is an icon with no name, and no div-pretending-to-be-
   a-button that keyboard users cannot reach.

   Scope: this parses app.html, so it covers the whole shipped DOM including the
   21 dialogs, which a browser pass only reaches one at a time if it opens each. */
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..', 'app');
const html = fs.readFileSync(path.join(appDir, 'app.html'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\naccessibility\n');

const attr = (tag, name) => {
  const m = tag.match(new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"', 'i'));
  return m ? m[1] : null;
};

// Every <label for="x"> in the document, so association can be checked by id.
const labelledIds = new Set(
  [...html.matchAll(/<label\b[^>]*\bfor\s*=\s*"([^"]+)"/gi)].map(m => m[1])
);

/* A control wrapped in <label>…</label> is named by it. Matching that needs the
   nesting, so pull each label's inner HTML and note which control ids it holds. */
const wrapped = new Set();
for (const m of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)) {
  for (const c of m[1].matchAll(/<(?:input|select|textarea)\b[^>]*\bid\s*=\s*"([^"]+)"/gi)) {
    wrapped.add(c[1]);
  }
}

const controls = [...html.matchAll(/<(input|select|textarea)\b[^>]*>/gi)]
  .map(m => ({ tag: m[0], kind: m[1].toLowerCase() }))
  .filter(c => (attr(c.tag, 'type') || '').toLowerCase() !== 'hidden');

ok('found the form controls to check', controls.length > 20, controls.length + ' found');

const unnamed = [];
for (const c of controls) {
  const id = attr(c.tag, 'id');
  const named = attr(c.tag, 'aria-label') || attr(c.tag, 'aria-labelledby')
    || (id && (labelledIds.has(id) || wrapped.has(id)));
  if (!named) unnamed.push((id || '(no id)') + ' [' + (attr(c.tag, 'type') || c.kind) + ']');
}
ok('every form control has an accessible name',
  unnamed.length === 0, unnamed.join(', '));

/* A placeholder standing in for a label is the specific thing that went wrong, so
   call it out on its own rather than letting it hide inside the check above. */
const placeholderOnly = [];
for (const c of controls) {
  const id = attr(c.tag, 'id');
  if (!attr(c.tag, 'placeholder')) continue;
  const realName = attr(c.tag, 'aria-label') || attr(c.tag, 'aria-labelledby')
    || (id && (labelledIds.has(id) || wrapped.has(id)));
  if (!realName) placeholderOnly.push(id || '(no id)');
}
ok('no control relies on a placeholder as its only name',
  placeholderOnly.length === 0, placeholderOnly.join(', '));

// ---------------------------------------------------------------------------
// Structure that was already right, and must stay right
// ---------------------------------------------------------------------------
const positive = [...html.matchAll(/<[^>]*\btabindex\s*=\s*"(\d+)"[^>]*>/gi)]
  .filter(m => +m[1] > 0);
ok('no positive tabindex anywhere', positive.length === 0,
  positive.length + ' found — these hijack tab order');

const namelessButtons = [];
for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
  const open = '<button' + m[1] + '>';
  const text = m[2].replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
  if (!text && !attr(open, 'aria-label') && !attr(open, 'title')) {
    namelessButtons.push(attr(open, 'id') || attr(open, 'class') || '(anonymous)');
  }
}
ok('every button has a name, text or otherwise',
  namelessButtons.length === 0, namelessButtons.join(', '));

/* Decorative SVGs must be hidden from the accessibility tree, or a screen reader
   reads out a pile of unnamed graphics between every real control. */
const svgs = [...html.matchAll(/<svg\b[^>]*>/gi)].map(m => m[0]);
const bareSvg = svgs.filter(s =>
  !/aria-hidden\s*=\s*"true"/i.test(s) && !/\baria-label\s*=/i.test(s) && !/\brole\s*=/i.test(s));
ok('every inline SVG is either hidden from screen readers or named',
  bareSvg.length === 0, bareSvg.length + ' undecided');


/* Images. This was "not applicable — there are no <img> elements" until the landing
   page got a real product screenshot on 2026-09-09. An unlabelled image on a
   marketing page is the single most-cited accessibility complaint there is, and a
   decorative-looking alt ("screenshot", "app") is barely better than none: the point
   is to convey what the picture SHOWS to someone who cannot see it. */
const pages = fs.readdirSync(appDir).filter(f => f.endsWith('.html'));
let imgCount = 0;
for (const page of pages) {
  const src = fs.readFileSync(path.join(appDir, page), 'utf8');
  for (const m of src.matchAll(/<img\b[^>]*>/gi)) {
    imgCount++;
    const tag = m[0];
    const alt = attr(tag, 'alt');
    const file = (attr(tag, 'src') || '(no src)').split('/').pop();
    ok(page + ': <img ' + file + '> has alt text', alt !== null);
    ok(page + ': <img ' + file + '> alt is descriptive, not a label',
      alt !== null && alt.trim().length > 25,
      alt === null ? 'missing' : '"' + alt + '"');
    /* Without width/height the page reflows when the image lands, shoving the
       content someone is reading. */
    ok(page + ': <img ' + file + '> reserves its space',
      attr(tag, 'width') !== null && attr(tag, 'height') !== null);
  }
}
console.log('  (' + imgCount + ' image' + (imgCount === 1 ? '' : 's') + ' checked)');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
