/* Extract pastYouFrom() from app.js and try to make it flatter the student.

   The feature's whole claim is that it shows you the DISTANCE between two
   attempts at the same dot point. Every way this breaks is a way of showing a
   distance that isn't there: two notes from the same week dressed up as
   progress, a note from a different topic, or the note you are looking at
   right now offered back to you as your own past self.

   None of that would look broken on screen. It would look like a working
   feature saying something false, which is the only kind of bug this app
   treats as serious. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');

const a = src.indexOf('var PAST_YOU_DAYS =');
const b = src.indexOf('  function pastYou(note) {');
if (a < 0 || b < 0) { console.error('FAIL: could not extract pastYouFrom'); process.exit(1); }
eval(src.slice(a, b));

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  — ' + detail : '')); }
}

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 5);
const ago = (days) => NOW - days * DAY;

// the note currently open in the editor
const current = { id: 'now', syllabusId: 'p1', kind: 'personal', updated: NOW };
const older = (id, days, over) =>
  Object.assign({ id, syllabusId: 'p1', kind: 'personal', updated: ago(days) }, over);

console.log('\n1. The gap has to be real');
ok('a note from yesterday is not past you',
   pastYouFrom([older('a', 1)], current) === null);
ok('a note from last week is not past you',
   pastYouFrom([older('a', 7)], current) === null);
ok('20 days is still inside the window',
   pastYouFrom([older('a', 20)], current) === null);
/* 21 days is the line. It is arbitrary in the way every threshold is, but it
   is the point past which a school student has been taught other things in
   between — which is the only thing that makes the comparison mean anything. */
ok('22 days is past you', (pastYouFrom([older('a', 22)], current) || {}).id === 'a');

console.log('\n2. Only the same dot point');
ok('an old note on another point is not offered',
   pastYouFrom([older('a', 90, { syllabusId: 'p2' })], current) === null);
ok('an old unfiled note is not offered',
   pastYouFrom([older('a', 90, { syllabusId: null })], current) === null);
ok('an unfiled note has no past self at all',
   pastYouFrom([older('a', 90)], { id: 'now', syllabusId: null, updated: NOW }) === null);

console.log('\n3. Never itself');
/* The editor re-renders on every keystroke-triggered save, so the open note is
   always in the list it searches. Matching itself would show "you wrote about
   this 0 days ago" against the note you are looking at. */
ok('the open note is never its own past self',
   pastYouFrom([{ id: 'now', syllabusId: 'p1', kind: 'personal', updated: ago(90) }],
               current) === null);

console.log('\n4. Captures are not notes');
/* A capture is an unfiled scrap from a lesson. It is not a considered write-up
   of the dot point, so comparing against it would measure the wrong thing. */
ok('an old capture on the same point is skipped',
   pastYouFrom([older('a', 90, { kind: 'capture' })], current) === null);

console.log('\n5. The OLDEST qualifying note, not merely an older one');
/* Two reasons: the earliest attempt is the honest baseline, and "any older
   note" would show a different one every time the list re-sorted. */
let hit = pastYouFrom([older('recent', 30), older('first', 200), older('mid', 90)], current);
ok('the earliest one wins', hit && hit.id === 'first', hit && hit.id);

console.log('\n6. Nothing to compare against');
ok('an empty notebook is silent', pastYouFrom([], current) === null);
ok('a missing list is silent', pastYouFrom(null, current) === null);
ok('no note at all is silent', pastYouFrom([older('a', 90)], null) === null);

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
