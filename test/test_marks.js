/* Extract the marks grouping from app.js and try to make it produce a number it
   should not.

   Phase 6 exists because an open-notes mark and an exam mark are not the same
   mark. Everything else about the feature is presentation; THIS is the claim, and
   a claim that isn't tested is a claim that quietly stops being true the first
   time someone "simplifies" the grouping into a single average. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');

function grab(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) { console.error('FAIL: could not extract ' + startMarker); process.exit(1); }
  return src.slice(a, b);
}

eval(grab('var CONDITIONS = [', '  var mkSubject = null;'));

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  — ' + detail : '')); }
}

const paper = (conditions, mark, outOf, sat = 1) =>
  ({ conditions, mark, outOf, sat, title: conditions + ' ' + mark });

console.log('\n1. Nothing recorded');
ok('no papers means no groups', groupByConditions([]).length === 0);

console.log('\n2. One condition');
let g = groupByConditions([paper('exam', 30, 50), paper('exam', 45, 60)]);
ok('one group', g.length === 1);
ok('marks summed, not percentage-averaged', g[0].mark === 75 && g[0].outOf === 110);
/* 30/50 = 60% and 45/60 = 75%. Averaging the percentages gives 67.5%. Summing
   gives 75/110 = 68.2%. The second is what happened; the first weights a 50-mark
   paper and a 60-mark paper as if they were equal evidence. */
ok('68.2%, not the 67.5% you get from averaging percentages', g[0].pct === 68.2, String(g[0].pct));

console.log('\n3. THE RULE — two conditions never combine');
const mixed = [
  paper('exam', 30, 100),        // 30%
  paper('open_notes', 95, 100)   // 95%
];
g = groupByConditions(mixed);
ok('two conditions produce two groups', g.length === 2);
ok('exam group is exam only', g.find(x => x.condition === 'exam').pct === 30);
ok('open-notes group is open-notes only', g.find(x => x.condition === 'open_notes').pct === 95);
/* The average of these is 62.5% — a number describing nothing that was ever sat,
   and one that hides a 30% exam behind a 95% open-book paper. If any group ever
   reports it, the feature has lost its reason to exist. */
ok('NO group reports the combined 62.5%', g.every(x => x.pct !== 62.5),
   JSON.stringify(g.map(x => x.pct)));
ok('no group counts papers from another condition',
   g.every(x => x.papers.every(p => p.conditions === x.condition)));
ok('every paper lands in exactly one group',
   g.reduce((n, x) => n + x.count, 0) === mixed.length);

console.log('\n4. Empty conditions are absent, not zero');
/* A condition you have never sat under must not appear at 0% — that reads as a
   fail rather than as no data, and 0% is the single most alarming thing the app
   could show a student who has simply never sat a take-home. */
g = groupByConditions([paper('practice', 10, 10)]);
ok('only the condition actually used appears', g.length === 1 && g[0].condition === 'practice');
ok('no 0% phantom groups', g.every(x => x.count > 0));

console.log('\n5. Group order is fixed, hardest first');
g = groupByConditions([paper('practice', 1, 1), paper('exam', 1, 1), paper('open_notes', 1, 1)]);
ok('exam first regardless of entry order', g[0].condition === 'exam');
ok('order follows CONDITIONS, not insertion',
   g.map(x => x.condition).join(',') === 'exam,open_notes,practice',
   g.map(x => x.condition).join(','));

console.log('\n6. Awkward numbers');
ok('a zero mark is a real mark, not missing',
   groupByConditions([paper('exam', 0, 50)])[0].pct === 0);
ok('full marks read as 100', groupByConditions([paper('exam', 20, 20)])[0].pct === 100);
ok('halves survive', groupByConditions([paper('exam', 7.5, 10)])[0].pct === 75);
ok('percentage is rounded to one place, not floated',
   groupByConditions([paper('exam', 1, 3)])[0].pct === 33.3,
   String(groupByConditions([paper('exam', 1, 3)])[0].pct));

console.log('\n7. Papers inside a group are newest first');
g = groupByConditions([paper('exam', 1, 1, 100), paper('exam', 2, 2, 300), paper('exam', 3, 3, 200)]);
ok('sorted by date descending',
   g[0].papers.map(p => p.sat).join(',') === '300,200,100',
   g[0].papers.map(p => p.sat).join(','));

console.log('\n8. An unknown condition still has a label');
/* A row could arrive from a future version of the app via sync. It must not
   render as a blank heading. */
const meta = conditionMeta('something_new');
ok('unknown condition falls back to its own id', meta.label === 'something_new');
ok('known condition keeps its label', conditionMeta('exam').label === 'Exam conditions');

console.log('\n9. No forecasting anywhere in this section');
/* Guarding a product decision, not an implementation detail: the vision brief
   corrected an earlier concept on exactly this, so it is worth a test that fails
   loudly if someone adds a predicted band later. */
const section = grab('12h · marks', '13 · export');
const forbidden = ['predictedBand', 'predictBand', 'estimatedBand', 'projectedMark', 'atar'];
forbidden.forEach(function (word) {
  ok('no "' + word + '" in the marks section',
     section.toLowerCase().indexOf(word.toLowerCase()) === -1);
});

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
