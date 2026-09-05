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
eval(grab('function findSpanRanges(response, spans) {', '  function syllabusPoints(subjectId) {'));

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

/* ---------------------------------------------------------------
   Phase 6 part two — where the marks went
   --------------------------------------------------------------- */
eval(grab('var LOSS_REASONS = [', '  function renderLossBreakdown'));

const q = (mark, outOf, reason) => ({ id: 'q', label: 'Q', mark, outOf, reason: reason || null });
const withQs = (qs) => ({ conditions: 'exam', mark: 0, outOf: 100, sat: 1, questions: qs });

console.log('\n10. Only LOST marks are grouped');
/* A question answered perfectly has no reason to explain. If full-mark questions
   counted, the biggest category would just be whatever you are best at — the
   exact opposite of what this is for. */
let r = lossByReason([withQs([q(5, 5, 'time'), q(0, 4, 'time')])]);
ok('a full-marks question contributes nothing', r.lost === 4, JSON.stringify(r));
ok('one row, four marks', r.rows.length === 1 && r.rows[0].lost === 4);
ok('the question count only counts questions that lost marks', r.rows[0].count === 1);

console.log('\n11. Ordered by damage, not by list order');
r = lossByReason([withQs([q(0, 2, 'careless'), q(0, 9, 'unknown'), q(0, 5, 'time')])]);
ok('biggest loss first', r.rows.map(x => x.reason).join(',') === 'unknown,time,careless',
   r.rows.map(x => x.reason).join(','));
ok('share is a percentage of everything dropped', r.rows[0].share === 56.3, String(r.rows[0].share));

console.log('\n12. Unexplained losses are reported, never hidden');
/* Silently dropping a lost mark with no reason would make the split add up to
   less than reality while still looking complete. */
r = lossByReason([withQs([q(0, 6, 'unknown'), q(0, 4, null)])]);
ok('total counts every lost mark', r.lost === 10);
ok('unexplained is reported separately', r.unexplained === 4);
ok('unexplained is NOT a reason row', r.rows.length === 1 && r.rows[0].reason === 'unknown');
ok('rows plus unexplained equal the total',
   r.rows.reduce((n, x) => n + x.lost, 0) + r.unexplained === r.lost);

console.log('\n13. A reason this version does not know is unexplained, not a blank row');
r = lossByReason([withQs([q(0, 3, 'invented_reason')])]);
ok('unknown reason falls through to unexplained', r.unexplained === 3 && r.rows.length === 0);

console.log('\n14. Across several papers');
r = lossByReason([
  withQs([q(1, 4, 'time')]),
  withQs([q(2, 6, 'time'), q(0, 5, 'unknown')])
]);
ok('the same reason accumulates across papers',
   r.rows.find(x => x.reason === 'time').lost === 7, JSON.stringify(r.rows));
ok('and counts its questions', r.rows.find(x => x.reason === 'time').count === 2);

console.log('\n15. Nothing recorded');
ok('no questions means no breakdown', lossByReason([withQs([])]).lost === 0);
ok('a paper with no questions key at all is safe',
   lossByReason([{ conditions: 'exam', mark: 1, outOf: 2, sat: 1 }]).lost === 0);

console.log('\n16. Coverage is measured, so a partial breakdown cannot read as complete');
let cov = breakdownCoverage({ mark: 60, outOf: 100, questions: [q(10, 20, 'time')] });
ok('counts the marks broken down', cov.marksCounted === 20);
ok('knows the paper total', cov.marksTotal === 100);
ok('not complete when most of the paper is unaccounted for', cov.complete === false);
cov = breakdownCoverage({ mark: 15, outOf: 20, questions: [q(10, 20, 'time')] });
ok('complete once the questions cover the paper', cov.complete === true);
ok('a paper with no questions is never complete',
   breakdownCoverage({ mark: 1, outOf: 2, questions: [] }).complete === false);

console.log('\n17. Every reason carries a fix — the split is only useful if it changes what you do');
LOSS_REASONS.forEach(function (x) {
  ok('"' + x.id + '" has a label and a fix', !!x.label && !!x.fix && x.fix.length > 10);
});

/* ---------------------------------------------------------------
   Phase 6 part three — mistakes feeding the review queue
   --------------------------------------------------------------- */
eval(grab('  function gapsByPoint(papers)', '  function renderLossBreakdown'));

const qp = (mark, outOf, reason, syllabusId) =>
  ({ id: 'q', label: 'Q', mark, outOf, reason: reason || null, syllabusId: syllabusId || null });

console.log('\n18. Only content gaps reach the review queue');
/* THE distinction the whole feature rests on. Running out of time is not a
   content gap; re-reviewing the card would be treating the wrong illness, and
   would also make the review queue useless by filling it with things you know. */
let gp = gapsByPoint([{ questions: [
  qp(0, 5, 'unknown', 'p1'),
  qp(0, 9, 'time',    'p1'),
  qp(0, 4, 'careless','p2')
] }]);
ok('only the "didn\'t know it" loss counts', gp.length === 1 && gp[0].syllabusId === 'p1');
ok('and only its marks, not the timed loss too', gp[0].lost === 5, String(gp[0].lost));

console.log('\n19. A gap with no dot point cannot be actioned, so it is not listed');
gp = gapsByPoint([{ questions: [qp(0, 6, 'unknown', null)] }]);
ok('unlinked gaps are left out', gp.length === 0);

console.log('\n20. Gaps accumulate per point, across papers, ranked by damage');
gp = gapsByPoint([
  { questions: [qp(1, 4, 'unknown', 'p1')] },
  { questions: [qp(0, 3, 'unknown', 'p1'), qp(0, 8, 'unknown', 'p2')] }
]);
ok('two points', gp.length === 2);
ok('worst point first', gp[0].syllabusId === 'p2' && gp[0].lost === 8);
ok('the other accumulates across both papers', gp[1].lost === 6, String(gp[1].lost));
ok('question counts follow', gp[1].count === 2);

console.log('\n21. A question answered in full is never a gap');
gp = gapsByPoint([{ questions: [qp(5, 5, 'unknown', 'p1')] }]);
ok('full marks means nothing was lost', gp.length === 0);

console.log('\n22. Nothing recorded');
ok('no questions, no gaps', gapsByPoint([{ questions: [] }]).length === 0);
ok('a paper with no questions key is safe', gapsByPoint([{}]).length === 0);

console.log('\n23. The marked script — matching a span back to the response text');
/* findSpanRanges matches by substring, not a stored offset, because an offset
   goes stale the moment the response text is edited. That trade-off has its
   own failure modes — this is where they get pinned down. */
const RESPONSE = 'A frameshift mutation shifts the reading frame. A substitution only changes one base.';

let sr = findSpanRanges(RESPONSE, [{ id: '1', text: 'shifts the reading frame', positive: false }]);
ok('a single span is found', sr.length === 1);
ok('at the right offset', sr[0].start === RESPONSE.indexOf('shifts the reading frame'));

sr = findSpanRanges(RESPONSE, [
  { id: '1', text: 'A frameshift mutation', positive: true },
  { id: '2', text: 'A substitution only changes one base', positive: false }
]);
ok('two non-overlapping spans both found', sr.length === 2);
ok('returned in reading order, not insertion order',
   sr[0].span.id === '1' && sr[1].span.id === '2');

console.log('\n24. Overlapping spans never double up — first found wins');
sr = findSpanRanges(RESPONSE, [
  { id: '1', text: 'shifts the reading frame', positive: false },
  { id: '2', text: 'the reading frame', positive: true }
]);
ok('only the first span claims the text', sr.length === 1, JSON.stringify(sr.map(x => x.span.id)));
ok('the first one in the array is the one kept', sr[0].span.id === '1');

console.log('\n25. Text edited out from under a span is dropped, not mis-highlighted');
sr = findSpanRanges('A completely different answer.', [
  { id: '1', text: 'shifts the reading frame', positive: false }
]);
ok('no match, no wrong highlight', sr.length === 0);

console.log('\n26. A repeated phrase can be annotated as two separate spans');
const REPEATED = 'It depends. It depends on the context.';
sr = findSpanRanges(REPEATED, [
  { id: '1', text: 'It depends', positive: false },
  { id: '2', text: 'It depends', positive: true }
]);
ok('both occurrences are found', sr.length === 2, JSON.stringify(sr));
ok('they do not land on the same offset', sr[0].start !== sr[1].start);

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
