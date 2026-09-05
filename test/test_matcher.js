/* Extract the syllabus matcher and the task parser from app.js and exercise them
   against realistic syllabus data and a realistic assessment notification.

   These two functions carry the claim that auto-filing and the assessment
   unpacker need no language model and nothing leaving the device. That claim is
   only worth making if the matching is actually good, so this file tries to
   break it rather than confirm it. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');

function grab(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) { console.error('FAIL: could not extract ' + startMarker); process.exit(1); }
  return src.slice(a, b);
}

// the matcher reads nodeById / topicsOf / childrenOf from app state; stub them
let SYLLABUS = [];
function nodeById(id) { return SYLLABUS.filter(n => n.id === id)[0] || null; }
function topicsOf(sid) { return SYLLABUS.filter(n => n.subjectId === sid && !n.parentId); }
function childrenOf(pid) { return SYLLABUS.filter(n => n.parentId === pid); }

eval(grab('var WORD = /', '  /* ============================================================\n     12f'));
eval(grab('var DUE_RE =', '  /* ============================================================\n     13 ·'));

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : '')); }
}

/* A realistic slice of two NSW syllabuses, deliberately including points that
   share vocabulary so the matcher has to discriminate rather than keyword-hit. */
SYLLABUS = [
  { id: 'm5', subjectId: 'bio', parentId: null, code: 'Module 5', title: 'Heredity' },
  { id: 'p1', subjectId: 'bio', parentId: 'm5', code: 'BIO-12-01', title: 'Reproduction in plants and animals' },
  { id: 'p2', subjectId: 'bio', parentId: 'm5', code: 'BIO-12-02', title: 'Cell replication and DNA structure' },
  { id: 'm6', subjectId: 'bio', parentId: null, code: 'Module 6', title: 'Genetic change' },
  { id: 'p3', subjectId: 'bio', parentId: 'm6', code: 'BIO-12-06', title: 'Mutation and genetic variation' },
  { id: 'p4', subjectId: 'bio', parentId: 'm6', code: 'BIO-12-07', title: 'Biotechnology and its applications' },
  { id: 'm7', subjectId: 'bio', parentId: null, code: 'Module 7', title: 'Infectious disease' },
  { id: 'p5', subjectId: 'bio', parentId: 'm7', code: 'BIO-12-08', title: 'Causes and transmission of infectious disease' },
  { id: 'b1', subjectId: 'bus', parentId: null, code: 'Topic 3', title: 'Operations' },
  { id: 'b2', subjectId: 'bus', parentId: 'b1', code: 'BUS-11-03', title: 'Role of operations in business performance' },
  { id: 'b3', subjectId: 'bus', parentId: 'b1', code: 'BUS-11-06', title: 'Influences on operations management' }
];

console.log('\n1. Matching a note to the right dot point');
const r1 = matchSyllabus('A frameshift mutation shifts the reading frame so every subsequent codon is altered.', 'bio');
ok('frameshift note -> Mutation and genetic variation', r1.length && r1[0].node.id === 'p3',
   'got: ' + (r1[0] ? r1[0].node.title : 'nothing'));

const r2 = matchSyllabus('Biotechnological applications in agriculture and medicine.', 'bio');
ok('biotech note -> Biotechnology', r2.length && r2[0].node.id === 'p4',
   'got: ' + (r2[0] ? r2[0].node.title : 'nothing'));

// stemming: a note says "mutations", the syllabus says "Mutation"
const r2b = matchSyllabus('Mutations arise during replication and cause variations.', 'bio');
ok('plurals match singulars (stemming)', r2b.length && r2b[0].node.id === 'p3',
   'got: ' + (r2b[0] ? r2b[0].node.title : 'nothing'));

const r3 = matchSyllabus('How pathogens spread between hosts, and modes of transmission.', 'bio');
ok('pathogens note -> Infectious disease', r3.length && r3[0].node.id === 'p5',
   'got: ' + (r3[0] ? r3[0].node.title : 'nothing'));

console.log('\n2. Syllabus verbs must not decide the answer');
// "describe/analyse" style words appear across points, so IDF should zero them
const r4 = matchSyllabus('Describe and analyse and outline and explain and identify.', 'bio');
ok('a note of pure command verbs matches nothing', r4.length === 0,
   'got ' + r4.length + ' matches, top: ' + (r4[0] ? r4[0].node.title : '-'));

console.log('\n3. An outcome code is decisive, not a guess');
const r5 = matchSyllabus('This task assesses BUS-11-06 primarily.', 'bus');
ok('code match wins outright', r5.length && r5[0].node.id === 'b3' && r5[0].byCode === true,
   'got: ' + JSON.stringify(r5[0] && { t: r5[0].node.title, byCode: r5[0].byCode }));
ok('code match beats a text match on the sibling',
   r5[0].node.id === 'b3' && (!r5[1] || r5[1].score < r5[0].score));

const r6 = matchSyllabus('assesses BIO 12 06 with spaces', 'bio');
ok('code recognised with spaces instead of hyphens', r6.length && r6[0].node.id === 'p3',
   'got: ' + (r6[0] ? r6[0].node.title : 'nothing'));

console.log('\n4. Honest failure');
ok('empty text matches nothing', matchSyllabus('', 'bio').length === 0);
ok('unrelated text matches nothing', matchSyllabus('the quick brown fox jumped', 'bio').length === 0,
   'got: ' + JSON.stringify(matchSyllabus('the quick brown fox jumped','bio').map(r=>r.node.title)));
ok('a subject with no syllabus returns nothing', matchSyllabus('mutation', 'nosuch').length === 0);

console.log('\n4b. KNOWN LIMITATION — this matches vocabulary, not meaning');
/* "CRISPR" and "restriction enzymes" belong to "Biotechnology" only semantically:
   they share no words with it. No lexical matcher can bridge that, and the honest
   move is to assert the limit exists rather than quietly hope nobody notices. If
   this test ever starts behaving differently, the matcher's character has changed
   and the claim in its header comment needs revisiting. */
const lim = matchSyllabus('Restriction enzymes and CRISPR are used for gene editing.', 'bio');
ok('semantically related but lexically unrelated text does NOT reach Biotechnology',
   lim.length === 0 || lim[0].node.id !== 'p4',
   'top matches were: ' + JSON.stringify(lim.slice(0, 2).map(r => r.node.title)));

console.log('\n5. Parent topic context is inherited');
// "Applications" alone is vague; the parent supplies "Genetic change"
const r7 = matchSyllabus('genetic change', 'bio');
ok('parent topic words reach the child point', r7.length > 0 &&
   r7.some(r => r.node.id === 'p3' || r.node.id === 'p4'));

console.log('\n6. Unpacking a real assessment notification');
const task = parseTask(`BUSINESS STUDIES - ASSESSMENT TASK 3
Due: Friday 12 September, 3:15pm
Weighting: 25% of the course
Format: Business report, 1200 words
Outcomes assessed: BUS-11-03, BUS-11-06`);
ok('due date',  task.due === '12 September', 'got ' + JSON.stringify(task.due));
ok('weighting', task.weight === '25%',       'got ' + JSON.stringify(task.weight));
ok('word count',task.words === '1200',       'got ' + JSON.stringify(task.words));
ok('format',    task.format === 'report',    'got ' + JSON.stringify(task.format));
ok('both outcome codes', task.codes.length === 2 && /BUS.11.03/.test(task.codes[0]),
   'got ' + JSON.stringify(task.codes));

const task2 = parseTask('Depth Study due 3/11 worth 30%. 2000 words.');
ok('numeric date form',  task2.due === '3/11',   'got ' + JSON.stringify(task2.due));
ok('weight after "worth"', task2.weight === '30%', 'got ' + JSON.stringify(task2.weight));
ok('depth study format',  task2.format === 'depth study', 'got ' + JSON.stringify(task2.format));

const empty = parseTask('just some text with nothing in it');
ok('nothing found reports null, never a guess',
   empty.due === null && empty.weight === null && empty.format === null && empty.codes.length === 0,
   'got ' + JSON.stringify(empty));
console.log('\nRegressions found by measurement (test/measure_matcher.js)');
/* Two defects the measurement harness turned up on 2026-09-05. Both were the
   same shape: the matcher SPEAKING when the honest answer is silence, which is
   the expensive direction — a wrong suggestion costs trust, a missing one costs
   a tap. Pinned here so they cannot come back. */

// 1 · function words used to score. IDF alone does not remove them at this
//     corpus size: "the" in 3 of 10 dot points scores log(10/3) = 1.2.
const adminNote = 'Group members: me, Sam, Priya. We are meeting at lunch on Tuesday in the library to plan.';
ok('a note about nothing academic matches nothing',
   matchSyllabus(adminNote, 'bio', 3).length === 0,
   JSON.stringify(matchSyllabus(adminNote, 'bio', 3).map(h => h.node.code)));
ok('"the" is not a term at all', tokenise('the the the').length === 0);
ok('real words still survive tokenising',
   tokenise('the mitochondria and the ribosome').join(',') === 'mitochondria,ribosome',
   tokenise('the mitochondria and the ribosome').join(','));

// 2 · a single shared word is a coincidence, not evidence
const oneWord = matchSyllabus('The cell reads the code three letters at a time and lines up the matching blocks.', 'bio', 2);
ok('a one-word overlap still ranks (the unpacker shows candidates)',
   oneWord.length > 0 && oneWord[0].matched.length === 1,
   oneWord.length ? oneWord[0].matched.join(',') : 'none');
/* suggestFiling is what must stay silent on it — it requires two distinct terms.
   Kept as a rule about the DATA rather than re-testing the gate, so this still
   means something if the gate moves. */
ok('and that single term is not enough to file on',
   oneWord[0].matched.length < 2);



console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
