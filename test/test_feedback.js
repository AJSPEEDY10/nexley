/* Extract the feedback board's seen/unread logic from app.js and exercise it.

   This is the only part of the feedback feature with state that can rot silently.
   Everything else either renders (visible the moment you look) or writes to the
   server (loud when it fails). The unread dot is different: if it is wrong nobody
   finds out, they just never learn that someone replied to them — which defeats
   the entire reason the table has a select policy at all.

   The specific thing being pinned down: seen-state is keyed by id AND rev, not by
   id alone, so a SECOND reply on a thread you already read counts as unread again. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');

function grab(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) { console.error('FAIL: could not extract ' + startMarker); process.exit(1); }
  return src.slice(a, b);
}

// the app runs in a browser; give the extracted code the two globals it touches
let store = {};
global.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};

eval(grab('var FB_KINDS = [', '  /* ============================================================\n     12c ·'));

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  — ' + detail : '')); }
}

function reset() { store = {}; }

console.log('\n1. Nothing to read');
reset();
ok('no rows means nothing unread', fbUnread([]) === 0);
ok('a row with no reply is not unread',
   fbUnread([{ id: 'a', rev: 1, reply: null }]) === 0);

console.log('\n2. A reply arrives');
reset();
const replied = [{ id: 'a', rev: 3, reply: 'Building this now.' }];
ok('an unseen reply counts', fbUnread(replied) === 1);
fbMarkSeen(replied);
ok('reading it clears the count', fbUnread(replied) === 0);

console.log('\n3. A SECOND reply on the same item');
/* The bug this exists to prevent: keying seen-state on the id alone. Alec replies,
   you read it, he replies again a week later — with an id-only key that second
   reply is invisible forever. The server bumps rev on every dashboard update
   (migration 0003's auto-touch branch), so rev is what makes it visible. */
const again = [{ id: 'a', rev: 4, reply: 'Shipped it.' }];
ok('a newer rev on a read item is unread again', fbUnread(again) === 1);
fbMarkSeen(again);
ok('reading the new one clears it too', fbUnread(again) === 0);

console.log('\n4. Several items at once');
reset();
const many = [
  { id: 'a', rev: 1, reply: 'Yes.' },
  { id: 'b', rev: 1, reply: null },
  { id: 'c', rev: 2, reply: 'Not planned, sorry.' }
];
ok('only replied items count', fbUnread(many) === 2);
fbMarkSeen(many);
ok('all cleared together', fbUnread(many) === 0);
ok('marking does not invent an entry for a reply-less row',
   JSON.parse(store['nexley-feedback-seen']).b === undefined);

console.log('\n5. Storage that refuses to work');
/* Private windows and "block site data" make localStorage throw on access rather
   than return null. The dot going missing is acceptable; the app crashing on a
   sync pull because of it is not — every path here is wrapped. */
const good = global.localStorage;
global.localStorage = {
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); }
};
let threw = false;
try { fbUnread([{ id: 'a', rev: 1, reply: 'hi' }]); fbMarkSeen([{ id: 'a', rev: 1, reply: 'hi' }]); }
catch (e) { threw = true; }
ok('blocked storage does not throw', !threw);
global.localStorage = good;

console.log('\n6. Corrupt stored value');
reset();
store['nexley-feedback-seen'] = 'not json {{{';
let threw2 = false;
try { fbUnread([{ id: 'a', rev: 1, reply: 'hi' }]); } catch (e) { threw2 = true; }
ok('garbage in storage is ignored, not fatal', !threw2);

console.log('\n7. The status map covers every status the database allows');
/* migration 0008 constrains status to exactly these six. A status the app has no
   label for would render as an empty pill, so the two lists have to agree — the
   same two-lists-must-match trap analytics.js already has. */
const inDb = ['new', 'noted', 'planned', 'building', 'shipped', 'declined'];
inDb.forEach(function (st) {
  ok('label exists for "' + st + '"', !!(FB_STATUS[st] && FB_STATUS[st].label));
});
ok('no label without a database status',
   Object.keys(FB_STATUS).every(k => inDb.indexOf(k) > -1),
   Object.keys(FB_STATUS).join(','));

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
