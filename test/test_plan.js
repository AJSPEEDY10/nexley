/* Extract the term planner from app.js and try to make it lie.

   Phase 7's claim is narrow and worth protecting: hours are attributed to the
   week a thing is DUE — a fact about a deadline — and a commitment with no
   estimate is COUNTED but never silently treated as zero. A planner that
   invents numbers is worse than no planner, because it gets believed. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');

function grab(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) { console.error('FAIL: could not extract ' + startMarker); process.exit(1); }
  return src.slice(a, b);
}

// storage is a browser thing; the planner only reads a number out of it
let store = {};
global.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); }
};

eval(grab('var MONTHS = [', '  function renderPlan()'));

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  — ' + detail : '')); }
}

const DAY = 24 * 3600 * 1000;
// a Wednesday, so week boundaries are not accidentally aligned
const NOW = new Date(2026, 8, 9, 14, 0, 0).getTime();   // Wed 9 Sep 2026
const at = (y, m, d) => new Date(y, m, d, 12, 0, 0).getTime();
const task = (due, hours, extra) => Object.assign({ id: 'c', title: 'T', due, hours, done: false }, extra || {});

console.log('\n1. Weeks start on Monday, in local time');
/* Local, not UTC. A Sunday-night deadline in Sydney must not fall into the
   following week because the timestamp crossed midnight in London. */
const wed = weekStartOf(NOW);
ok('a Wednesday maps back to Monday', new Date(wed).getDay() === 1);
ok('and to midnight', new Date(wed).getHours() === 0);
ok('a Monday maps to itself', weekStartOf(wed) === wed);
ok('Sunday 23:59 still belongs to the week that started six days earlier',
   weekStartOf(wed + 6 * DAY + 23 * 3600 * 1000) === wed);
ok('the next Monday starts a new week', weekStartOf(wed + 7 * DAY) === wed + 7 * DAY);

console.log('\n2. Hours land in the week the thing is DUE');
let w = planWeeks([task(at(2026, 8, 11), 4)], NOW, 4);   // Fri 11 Sep
ok('four weeks returned', w.length === 4);
ok('this week holds it', w[0].count === 1 && w[0].hours === 4);
ok('later weeks are empty', w[1].count === 0 && w[1].hours === 0);

console.log('\n3. THE RULE — an unestimated task is counted, never treated as zero');
/* This is the whole trustworthiness of the feature. "9 hours" when two tasks
   have no estimate is a lie by omission, and it is the one that gets someone to
   Friday having planned around a number that was never real. */
w = planWeeks([
  task(at(2026, 8, 11), 9),
  task(at(2026, 8, 12), null),
  task(at(2026, 8, 12), undefined)
], NOW, 2);
ok('hours count only what was estimated', w[0].hours === 9, String(w[0].hours));
ok('the unestimated ones are counted separately', w[0].unestimated === 2);
ok('and they still appear in the week', w[0].count === 3);
ok('null did not become zero hours', w[0].hours !== 0);

console.log('\n4. Done tasks stop counting');
w = planWeeks([task(at(2026, 8, 11), 5, { done: true }), task(at(2026, 8, 11), 2)], NOW, 1);
ok('a finished task is out of the plan', w[0].count === 1 && w[0].hours === 2);

console.log('\n5. Over-committed is arithmetic, not judgement');
ok('under capacity is fine', isOverCommitted({ hours: 8 }, 10) === false);
ok('exactly at capacity is NOT over', isOverCommitted({ hours: 10 }, 10) === false);
ok('above capacity is over', isOverCommitted({ hours: 11 }, 10) === true);
/* Unestimated work cannot make a week over-committed on its own — the app does
   not know how big it is, and inventing a size to trigger a warning would be
   the same fabrication in the other direction. */
ok('unestimated work alone never triggers it',
   isOverCommitted({ hours: 0, unestimated: 5 }, 10) === false);

console.log('\n6. Ordering inside a week');
w = planWeeks([
  task(at(2026, 8, 11), 1, { title: 'later' }),
  task(at(2026, 8, 9), 1, { title: 'sooner' })
], NOW, 1);
ok('due soonest first', w[0].items[0].title === 'sooner');

console.log('\n7. Capacity');
store = {};
ok('a sensible default when nothing is set', capacity() === 10);
setCapacity(6);
ok('reads back what was set', capacity() === 6);
store['nexley-hours-per-week'] = 'not a number';
ok('garbage falls back to the default', capacity() === 10);
store['nexley-hours-per-week'] = '0';
ok('zero is not a capacity', capacity() === 10);
store['nexley-hours-per-week'] = '-4';
ok('negative is not a capacity', capacity() === 10);

console.log('\n8. Reading a date off a sheet');
/* parseTask hands over what the sheet SAID. These convert it, and return null
   rather than guessing when they cannot tell. */
ok('"12 September"', parseDueDate('12 September', NOW) === at(2026, 8, 12));
ok('"12th Sept"', parseDueDate('12th Sept', NOW) === at(2026, 8, 12));
ok('"12 Sep 2027" honours a stated year', parseDueDate('12 Sep 2027', NOW) === at(2027, 8, 12));
ok('"12/9" is day-first, as an Australian sheet means it',
   parseDueDate('12/9', NOW) === at(2026, 8, 12));
ok('"12-09-2026"', parseDueDate('12-09-2026', NOW) === at(2026, 8, 12));
ok('"1.10.26" two-digit year', parseDueDate('1.10.26', NOW) === at(2026, 9, 1));

console.log('\n9. The year a sheet never states');
/* A date already comfortably past means next year — otherwise every January a
   December task lands in the past and the plan is quietly wrong. */
ok('a date months back rolls to next year',
   parseDueDate('3 March', NOW) === at(2027, 2, 3), String(new Date(parseDueDate('3 March', NOW))));
ok('a date a couple of days ago stays this year — probably a late entry',
   parseDueDate('7 September', NOW) === at(2026, 8, 7));
ok('tomorrow stays this year', parseDueDate('10 September', NOW) === at(2026, 8, 10));

console.log('\n10. Dates it should refuse rather than guess');
ok('nothing at all', parseDueDate(null, NOW) === null);
ok('prose', parseDueDate('end of term', NOW) === null);
ok('a month that does not exist', parseDueDate('12 Smarch', NOW) === null);
ok('31 February', parseDueDate('31 February', NOW) === null);
ok('day 40', parseDueDate('40 May', NOW) === null);
ok('month 13', parseDueDate('12/13', NOW) === null);

console.log('\n11. Weighting off a sheet');
ok('"20%"', parseWeightPct('20%') === 20);
ok('"7.5%"', parseWeightPct('7.5%') === 7.5);
ok('nothing', parseWeightPct(null) === null);
ok('prose', parseWeightPct('a fifth of the course') === null);
ok('over 100 is refused rather than clamped', parseWeightPct('140%') === null);

console.log('\n12. Naming the task off a sheet');
eval(grab('  var HEADERISH =', '  function note(text)'));
/* A sheet opens with the school/year header far more often than with the task
   name, and "Year 11 Human Movement" as a deadline in your plan is useless. */
ok('skips the year-level header',
   taskTitle('Year 11 Human Movement\nDepth Study: Energy Systems\nDue: 12 October')
     === 'Depth Study: Energy Systems');
ok('skips a term header',
   taskTitle('Term 3 2026\nIn-class essay') === 'In-class essay');
ok('takes the first real line when there is no header',
   taskTitle('Research report\nDue Friday') === 'Research report');
ok('never returns nothing', taskTitle('') === 'Assessment task');
ok('ignores lines too short to be a title',
   taskTitle('HM\nEnergy systems report') === 'Energy systems report');

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
