/* Cross-subject links (app.js 12l).

   The feature's whole value is restraint: it must find the one real connection
   between two courses and stay silent about the dozens of accidental word
   overlaps sitting next to it. So most of the assertions here are that it says
   NOTHING — a version of this that linked everything to everything would pass
   a "does it find the link" test and be useless in the app. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');

function grab(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) { console.error('FAIL: could not extract ' + startMarker); process.exit(1); }
  return src.slice(a, b);
}

// crossLinksFrom leans on tokenise/stem from the matcher section
eval(grab('var WORD = /', '  /* ============================================================\n     12f'));
eval(grab('var CROSS_MAX_DF_RATIO', '  /* Every dot point in the notebook'));

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : '')); }
}

/* Two real-shaped NSW syllabus slices. Biology and PDHPE genuinely share
   respiration and energy systems; they also share a lot of scaffolding
   ("describe", "students", "including") that must not link anything. */
const DOCS = [
  { id: 'b1', subjectId: 'bio', text: 'BIO-12-01 Cellular respiration including aerobic and anaerobic pathways Module 5 Metabolism' },
  { id: 'b2', subjectId: 'bio', text: 'BIO-12-02 Photosynthesis and the light dependent reactions Module 5 Metabolism' },
  { id: 'b3', subjectId: 'bio', text: 'BIO-12-03 Describe the structure of the cell membrane Module 4 Cells' },
  { id: 'b4', subjectId: 'bio', text: 'BIO-12-04 Students investigate homeostasis and feedback Module 6 Regulation' },
  { id: 'p1', subjectId: 'pdhpe', text: 'PDH-11-01 Energy systems and anaerobic respiration during exercise Module Body in motion' },
  { id: 'p2', subjectId: 'pdhpe', text: 'PDH-11-02 Describe the components of physical fitness Module Body in motion' },
  { id: 'p3', subjectId: 'pdhpe', text: 'PDH-11-03 Students investigate the structure of a training program Module Training' },
  { id: 'm1', subjectId: 'maths', text: 'MA-E1 Exponential growth and decay modelling Topic Exponential functions' },
  { id: 'm2', subjectId: 'maths', text: 'MA-S2 Describe data using measures of central tendency Topic Statistics' },
  { id: 'm3', subjectId: 'maths', text: 'MA-C1 Rates of change and the derivative Topic Calculus' }
];

function ids(rs) { return rs.map(r => r.id); }

/* --- the link it exists to find ------------------------------------- */
let r = crossLinksFrom(DOCS, 'b1');
ok('bio respiration links out of its own subject', r.length > 0, JSON.stringify(r));
ok('bio respiration links to the PDHPE energy-systems point',
  ids(r).indexOf('p1') === 0, JSON.stringify(ids(r)));
ok('the link names its evidence',
  r[0].shared.indexOf('respiration') >= 0 || r[0].shared.indexOf('anaerobic') >= 0,
  JSON.stringify(r[0] && r[0].shared));
ok('the link is symmetric', ids(crossLinksFrom(DOCS, 'p1')).indexOf('b1') === 0);

/* --- and the silence it exists to keep ------------------------------ */
ok('"Describe the structure of the cell membrane" links to nothing',
  crossLinksFrom(DOCS, 'b3').length === 0, JSON.stringify(crossLinksFrom(DOCS, 'b3')));
ok('shared command verbs alone do not link ("Describe…" x3)',
  crossLinksFrom(DOCS, 'm2').every(x => x.id !== 'p2' && x.id !== 'b3'),
  JSON.stringify(crossLinksFrom(DOCS, 'm2')));
ok('shared "students investigate" alone does not link',
  crossLinksFrom(DOCS, 'b4').every(x => x.id !== 'p3'),
  JSON.stringify(crossLinksFrom(DOCS, 'b4')));
ok('exponential growth finds nothing here rather than reaching',
  crossLinksFrom(DOCS, 'm1').length === 0, JSON.stringify(crossLinksFrom(DOCS, 'm1')));

/* Add the Maths↔Bio connection the feature is pitched on and it should appear
   — the silence above must be "no evidence", not "cannot see maths at all". */
const WITH_DECAY = DOCS.concat([
  { id: 'b5', subjectId: 'bio', text: 'BIO-11-05 Exponential population growth in bacterial cultures Module 3 Ecosystems' }
]);
ok('exponential growth links Maths to Biology once the point exists',
  ids(crossLinksFrom(WITH_DECAY, 'm1')).indexOf('b5') === 0,
  JSON.stringify(crossLinksFrom(WITH_DECAY, 'm1')));

/* --- never links inside a subject ----------------------------------- */
ok('two bio points sharing "Module 5 Metabolism" never link to each other',
  crossLinksFrom(DOCS, 'b2').every(x => x.subjectId !== 'bio'),
  JSON.stringify(crossLinksFrom(DOCS, 'b2')));
ok('a one-subject notebook produces nothing at all',
  crossLinksFrom(DOCS.filter(d => d.subjectId === 'bio'), 'b1').length === 0);

/* --- degenerate input ------------------------------------------------ */
ok('empty corpus', crossLinksFrom([], 'b1').length === 0);
ok('null corpus', crossLinksFrom(null, 'b1').length === 0);
ok('unknown id', crossLinksFrom(DOCS, 'nope').length === 0);
ok('single document', crossLinksFrom([DOCS[0]], 'b1').length === 0);
ok('missing subjectId is dropped rather than matched',
  crossLinksFrom(DOCS.concat([{ id: 'x', text: 'cellular respiration anaerobic' }]), 'b1')
    .every(x => x.id !== 'x'));
ok('a document with no text links to nothing',
  crossLinksFrom(DOCS.concat([{ id: 'blank', subjectId: 'art', text: '' }]), 'blank').length === 0);

/* --- the gates are real, not decoration ----------------------------- */
ok('raising the score floor silences a real link',
  crossLinksFrom(DOCS, 'b1', { minScore: 999 }).length === 0);
ok('dropping the df ceiling to zero silences everything',
  crossLinksFrom(DOCS, 'b1', { maxDfRatio: 0 }).length === 0);
ok('a shared term is never rejected for being shared (df floor of 2)',
  crossLinksFrom(DOCS, 'b1', { maxDfRatio: 0.0001 }).length > 0);
ok('limit is honoured', crossLinksFrom(WITH_DECAY, 'b1', { limit: 1 }).length <= 1);
ok('scores come back in descending order',
  crossLinksFrom(WITH_DECAY, 'b1', { minScore: 0.1, limit: 9 })
    .every((x, i, a) => i === 0 || a[i - 1].score >= x.score));

/* --- stability ------------------------------------------------------- */
const a1 = JSON.stringify(crossLinksFrom(DOCS, 'b1'));
const a2 = JSON.stringify(crossLinksFrom(DOCS.slice().reverse(), 'b1'));
ok('result does not depend on corpus order', a1 === a2, a1 + '\n        ' + a2);

const tie = [
  { id: 'z2', subjectId: 'a', text: 'photosynthesis chloroplast' },
  { id: 'z1', subjectId: 'b', text: 'photosynthesis chloroplast' },
  { id: 'z3', subjectId: 'c', text: 'photosynthesis chloroplast' },
  { id: 'z4', subjectId: 'a', text: 'unrelated vocabulary entirely' }
];
ok('exact ties break by id, not by input order',
  JSON.stringify(ids(crossLinksFrom(tie, 'z2', { limit: 9 })))
    === JSON.stringify(ids(crossLinksFrom(tie.slice().reverse(), 'z2', { limit: 9 }))),
  JSON.stringify(ids(crossLinksFrom(tie, 'z2', { limit: 9 }))));

/* --- repetition is not evidence -------------------------------------- */
ok('saying a shared word ten times does not strengthen the link',
  crossLinksFrom([
    { id: 'r1', subjectId: 'a', text: 'osmosis' },
    { id: 'r2', subjectId: 'b', text: 'osmosis osmosis osmosis osmosis osmosis' },
    { id: 'r3', subjectId: 'b', text: 'osmosis' },
    { id: 'r4', subjectId: 'c', text: 'nothing shared at all here' }
  ], 'r1', { limit: 9 }).map(x => x.score)
    .every((s, i, a) => Math.abs(s - a[0]) < 1e-9));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
