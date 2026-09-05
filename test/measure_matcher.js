/* MEASUREMENT, not a test. It prints numbers; it does not pass or fail.
   Run: node test/measure_matcher.js

   The question this answers, before anyone spends money on a language model:
   how good is the auto-filing that already exists and costs nothing?

   THE NUMBER THAT MATTERS IS NOT TOP-1 ACCURACY. suggestFiling can decline to
   answer — it stays quiet when the best score is under MIN_SUGGEST, and when the
   runner-up is within 80% of the leader ("a near-tie is not a suggestion, it is a
   coin toss"). So the honest pair of numbers is:

     COVERAGE  — how often it offers a suggestion at all
     PRECISION — when it does offer one, how often it is right

   A matcher that stays quiet half the time and is right 95% of the time it speaks
   is a good product. One that always answers and is right 70% of the time is a
   bad one, and they can share a top-1 score.

   HONEST LIMIT OF THIS MEASUREMENT: the fixtures below are written by me, not
   taken from Alec's real notebook. They are modelled on real NSW syllabus wording
   and on how a student actually writes notes — including cases built to fail —
   but they measure the matcher against my idea of a realistic note. Treat the
   failure modes at the bottom as the durable output and the headline percentage
   as indicative. Re-run against real notes when there are enough of them. */

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');

function grab(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) { console.error('could not extract ' + startMarker); process.exit(1); }
  return src.slice(a, b);
}

/* ---------- the syllabus the matcher indexes ---------- */
let SYLLABUS = [];
function nodeById(id) { return SYLLABUS.filter(n => n.id === id)[0] || null; }
function topicsOf(sid) { return SYLLABUS.filter(n => n.subjectId === sid && !n.parentId); }
function childrenOf(pid) { return SYLLABUS.filter(n => n.parentId === pid); }

eval(grab('var WORD = /', '  /* ============================================================\n     12f'));

// mirrors suggestFiling's gates exactly — see app.js 12g
const MIN_SUGGEST = 0.35;
function suggest(text, subjectId) {
  if (String(text).trim().length < 25) return { quiet: 'too short' };
  const hits = matchSyllabus(text, subjectId, 2);
  if (!hits.length || hits[0].score < MIN_SUGGEST) return { quiet: 'low score', hits };
  if ((hits[0].matched || []).length < 2 && !hits[0].byCode) return { quiet: 'one word only', hits };
  if (hits[1] && hits[1].score > hits[0].score * 0.8) return { quiet: 'near tie', hits };
  return { hit: hits[0], hits };
}

/* ---------- fixtures ----------
   Two subjects, modelled on NSW Stage 6 wording. Cases are labelled with the dot
   point a teacher would file them under, and deliberately include ones that
   should be hard or impossible. */

const BIO = 'bio';
const HM = 'hm';
SYLLABUS = [
  { id: 'b-t1', subjectId: BIO, parentId: null, title: 'Heredity', code: null },
  { id: 'b1', subjectId: BIO, parentId: 'b-t1', code: 'BIO-11-05', title: 'Reproduction in animals and plants, including internal and external fertilisation' },
  { id: 'b2', subjectId: BIO, parentId: 'b-t1', code: 'BIO-11-06', title: 'Cell replication: mitosis and meiosis, and the role of DNA replication' },
  { id: 'b3', subjectId: BIO, parentId: 'b-t1', code: 'BIO-11-07', title: 'Polypeptide synthesis: transcription and translation' },
  { id: 'b4', subjectId: BIO, parentId: 'b-t1', code: 'BIO-11-08', title: 'Inheritance patterns: autosomal, sex-linkage, co-dominance and multiple alleles' },
  { id: 'b-t2', subjectId: BIO, parentId: null, title: 'Genetic change', code: null },
  { id: 'b5', subjectId: BIO, parentId: 'b-t2', code: 'BIO-12-01', title: 'Mutation: point mutations, frameshift mutations and chromosomal mutations' },
  { id: 'b6', subjectId: BIO, parentId: 'b-t2', code: 'BIO-12-02', title: 'Biotechnology and its applications in agriculture and medicine' },
  { id: 'b7', subjectId: BIO, parentId: 'b-t2', code: 'BIO-12-03', title: 'Genetic technologies including CRISPR, gene therapy and recombinant DNA' },
  { id: 'b-t3', subjectId: BIO, parentId: null, title: 'Infectious disease', code: null },
  { id: 'b8', subjectId: BIO, parentId: 'b-t3', code: 'BIO-12-08', title: 'Causes of infectious disease and the work of Pasteur and Koch' },
  { id: 'b9', subjectId: BIO, parentId: 'b-t3', code: 'BIO-12-09', title: 'Responses to pathogens: innate and adaptive immune responses' },
  { id: 'b10', subjectId: BIO, parentId: 'b-t3', code: 'BIO-12-10', title: 'Epidemiology and the management of disease outbreaks in populations' },

  { id: 'h-t1', subjectId: HM, parentId: null, title: 'Body systems and energy', code: null },
  { id: 'h1', subjectId: HM, parentId: 'h-t1', code: 'HM-11-04', title: 'Skeletal and muscular systems, including joint types and muscle contraction' },
  { id: 'h2', subjectId: HM, parentId: 'h-t1', code: 'HM-11-05', title: 'Energy systems: ATP-PC, lactic acid and aerobic systems' },
  { id: 'h3', subjectId: HM, parentId: 'h-t1', code: 'HM-11-06', title: 'Biomechanics: force summation, levers and projectile motion' },
  { id: 'h-t2', subjectId: HM, parentId: null, title: 'Training and performance', code: null },
  { id: 'h4', subjectId: HM, parentId: 'h-t2', code: 'HM-12-01', title: 'Principles of training: progressive overload, specificity and reversibility' },
  { id: 'h5', subjectId: HM, parentId: 'h-t2', code: 'HM-12-02', title: 'Recovery strategies and the physiological effects of fatigue' },
  { id: 'h6', subjectId: HM, parentId: 'h-t2', code: 'HM-12-03', title: 'Nutrition and supplementation for athletic performance' }
];

const CASES = [
  // --- ordinary notes: the words are there ---
  [BIO, 'b5', 'Frameshift mutations happen when a base is inserted or deleted, so every codon after the change is read wrong. Point mutations only swap one base.', 'plain vocabulary overlap'],
  [BIO, 'b3', 'Transcription makes mRNA from the DNA template in the nucleus. Translation happens at the ribosome where tRNA brings amino acids to build the polypeptide.', 'plain vocabulary overlap'],
  [BIO, 'b9', 'The innate immune response is fast and non-specific. The adaptive response is slower but produces memory cells so the second exposure is quicker.', 'plain vocabulary overlap'],
  [HM, 'h2', 'The ATP-PC system gives about 10 seconds of maximal effort. The lactic acid system takes over after that, and the aerobic system dominates past two minutes.', 'plain vocabulary overlap'],
  [HM, 'h3', 'Force summation means using body parts in the right order. In a throw the bigger muscles go first, then the smaller ones, so the force adds up.', 'plain vocabulary overlap'],
  [HM, 'h4', 'Progressive overload means you have to keep increasing the demand or you stop adapting. Reversibility is losing it again when you stop training.', 'plain vocabulary overlap'],

  // --- a code written out: should be decisive, not a guess ---
  [BIO, 'b7', 'BIO-12-03 notes from today. CRISPR uses a guide RNA to cut at a specific site.', 'outcome code stated'],
  [HM, 'h1', 'HM-11-04 — hinge joints only move one way, ball and socket move in every direction.', 'outcome code stated'],

  // --- realistic messy notes: partial words, abbreviations ---
  [BIO, 'b2', 'Mitosis makes two identical cells, meiosis makes four gametes with half the chromosomes. Crossing over happens in prophase I.', 'note omits the dot point wording "cell replication"'],
  [HM, 'h5', 'Ice baths and active recovery. Fatigue builds up because of hydrogen ions, not lactic acid itself like everyone says.', 'note contradicts the syllabus wording it belongs to'],
  [BIO, 'b10', 'Epidemiology is studying disease across a population rather than one patient. Contact tracing and quarantine are how you manage an outbreak.', 'plain vocabulary overlap'],
  [BIO, 'b4', 'Sex linkage — the gene is on the X chromosome so males only need one copy to show the trait. Co-dominance is when both alleles show, like roan cattle.', 'plain vocabulary overlap'],

  // --- built to be hard: concept discussed without naming it ---
  [BIO, 'b3', 'The cell reads the code three letters at a time and lines up the matching building blocks in order until it has the whole chain.', 'concept described with none of its vocabulary — matcher SHOULD stay quiet'],
  [HM, 'h2', 'For the first ten seconds you are running on what is already stored in the muscle. After that it starts to burn.', 'concept described with none of its vocabulary — matcher SHOULD stay quiet'],

  // --- built to be ambiguous: genuinely spans two points ---
  [BIO, 'b6', 'Biotechnology in agriculture uses recombinant DNA to put a gene into a crop. Bt cotton is the example.', 'genuinely spans biotech and genetic technologies — a near-tie is the right answer'],

  // --- too short to judge ---
  [HM, 'h3', 'Levers.', 'too short — must stay quiet'],
  [BIO, 'b5', 'mutation', 'too short — must stay quiet'],

  // --- a note that belongs to no dot point at all ---
  [BIO, null, 'Remember to bring the prac book on Thursday and ask Mr Harding about the excursion form.', 'admin, belongs nowhere — must stay quiet'],
  [HM, null, 'Group members: me, Sam, Priya. We are meeting at lunch on Tuesday in the library to plan.', 'admin, belongs nowhere — must stay quiet']
];

/* ---------- run ---------- */
let offered = 0, correct = 0, quiet = 0;
let quietWhenItShould = 0, quietWhenItShouldNot = 0;
let wrongWhenOffered = [];
const quietReasons = {};

console.log('\n=====================================================');
console.log('  AUTO-FILING, MEASURED — no model, no network');
console.log('=====================================================\n');

CASES.forEach(function ([subject, expected, text, note]) {
  const r = suggest(text, subject);
  const shouldStayQuiet = expected === null || /stay quiet|near-tie/.test(note);

  if (r.quiet) {
    quiet++;
    quietReasons[r.quiet] = (quietReasons[r.quiet] || 0) + 1;
    if (shouldStayQuiet) quietWhenItShould++;
    else quietWhenItShouldNot++;
    console.log('  QUIET (' + r.quiet + ')  ' + text.slice(0, 58) + '…');
    console.log('          expected: ' + (expected || 'nothing') + '  — ' + note);
  } else {
    offered++;
    const got = r.hit.node.id;
    if (got === expected) {
      correct++;
      console.log('  RIGHT        ' + r.hit.node.code + '  ' + text.slice(0, 50) + '…');
    } else {
      wrongWhenOffered.push({ text, expected, got: r.hit.node.code, note });
      console.log('  WRONG        said ' + r.hit.node.code + ', wanted ' + (expected || 'nothing'));
      console.log('          ' + text.slice(0, 66) + '…');
      console.log('          ' + note);
    }
  }
});

const pct = (a, b) => b === 0 ? '—' : (Math.round((a / b) * 1000) / 10) + '%';

console.log('\n-----------------------------------------------------');
console.log('  ' + CASES.length + ' cases');
console.log('');
console.log('  COVERAGE   offered a suggestion on ' + offered + '/' + CASES.length
            + '  (' + pct(offered, CASES.length) + ')');
console.log('  PRECISION  right when it spoke     ' + correct + '/' + offered
            + '  (' + pct(correct, offered) + ')');
console.log('');
console.log('  stayed quiet ' + quiet + ' times:');
Object.keys(quietReasons).forEach(k => console.log('      ' + k + ': ' + quietReasons[k]));
console.log('      correctly quiet:   ' + quietWhenItShould);
console.log('      missed one it could have got: ' + quietWhenItShouldNot);
console.log('-----------------------------------------------------');

if (wrongWhenOffered.length) {
  console.log('\n  WRONG ANSWERS — the ones that matter, because a confident');
  console.log('  wrong suggestion is worse than no suggestion:\n');
  wrongWhenOffered.forEach(w => {
    console.log('   · said ' + w.got + ', wanted ' + (w.expected || 'nothing'));
    console.log('     ' + w.note);
  });
} else {
  console.log('\n  No wrong answers: it was right every time it spoke.');
}
console.log('');
