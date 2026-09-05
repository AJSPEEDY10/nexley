/* Extract streakFrom() from app.js and check the rule it exists to enforce.

   A streak is a motivation mechanic, which means every bug in it is a bug in
   how the app makes someone feel. The two that matter:

     - counting a day you did nothing, which makes the number a lie; and
     - resetting to zero the first time someone has a sick day, which turns a
       nudge into a punishment.

   The second is the reason this file exists. Nexley's tone everywhere else is
   "you are not behind — this week was over-committed the day these were set",
   and a streak that snaps on one missed day contradicts that in the one place
   the student looks every time they open the app. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');

const a = src.indexOf('  function streakFrom(days, today) {');
const b = src.indexOf('  function activeDayNumbers() {');
if (a < 0 || b < 0) { console.error('FAIL: could not extract streakFrom'); process.exit(1); }
eval(src.slice(a, b));

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  — ' + detail : '')); }
}

const T = 20000;                       // "today", as a day number
const run = (offsets) => streakFrom(offsets.map(o => T - o), T);

console.log('\n1. Counting consecutive days');
ok('nothing at all is zero', streakFrom([], T) === 0);
ok('today alone is 1', run([0]) === 1);
ok('today and yesterday is 2', run([0, 1]) === 2);
ok('four in a row is 4', run([0, 1, 2, 3]) === 4);

console.log('\n2. Not having worked TODAY yet does not end it');
/* The app is open at 9am before you have done anything. Yesterday's streak is
   still alive — it just has not been extended. Reporting 0 here would be the
   app telling you that you had lost something you had not lost. */
ok('yesterday and the day before, nothing today, is 2', run([1, 2]) === 2);
ok('and it still counts back properly', run([1, 2, 3, 4]) === 4);

console.log('\n3. THE RULE — one day off does not break it');
/* today, [gap], then three more. The gap day is not counted, but it does not
   end the run either. */
ok('a single missed day is survived', run([0, 2, 3, 4]) === 4, String(run([0, 2, 3, 4])));
ok('the missed day itself is not counted', run([0, 2]) === 2, String(run([0, 2])));

console.log('\n4. Two missed days in a row does end it');
ok('a two-day gap stops the count', run([0, 3, 4, 5]) === 1, String(run([0, 3, 4, 5])));
/* Nothing today and nothing yesterday means the run is already over — there is
   no live streak to report, however good last week was. */
ok('nothing today or yesterday is zero', run([2, 3, 4, 5]) === 0, String(run([2, 3, 4, 5])));

console.log('\n5. Messy input is still counted once');
ok('duplicate days do not inflate it', streakFrom([T, T, T, T - 1], T) === 2,
   String(streakFrom([T, T, T, T - 1], T)));
ok('order does not matter', streakFrom([T - 2, T, T - 1], T) === 3);
ok('a missing list is zero', streakFrom(null, T) === 0);

console.log('\n6. It terminates on a long history');
/* The walk is bounded — a notebook with two years of daily activity must not
   spin, and must not report more days than it walked. */
const long = [];
for (let i = 0; i < 500; i++) long.push(T - i);
const big = streakFrom(long, T);
ok('a 500-day run is bounded, not infinite', big > 300 && big <= 401, String(big));

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
