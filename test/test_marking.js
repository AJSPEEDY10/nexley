/* The offline half of marking: prompt construction, and reading the answer back.

   None of this calls a model. What it pins down is the part that must be true
   before a model is involved at all — that the app can CHECK what came back
   rather than trusting it. A marker that returns 7/6, or judges against a
   criterion nobody supplied, has failed, and the student must see that it failed
   instead of a confident wrong number.

   The live quality question — does it invent standards — is not answerable here.
   That is test/probe_marking.js, which spends real quota and is judged by a
   human. */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'marking.js'), 'utf8');
global.window = {};
eval(src);
const M = global.window.NexleyMarking;

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  — ' + detail : '')); }
}

const CRITERIA = [
  '- 2 marks: correctly identifies the fuel source of BOTH systems',
  '- 2 marks: correctly states the duration each system predominates',
  '- 2 marks: correctly identifies the by-products of BOTH systems'
].join('\n');

console.log('\n1. The prompt says the things that stop the known failure');
const p = M.buildPrompt({ question: 'Explain the difference.', outOf: 6,
                          criteria: CRITERIA, response: 'Some answer.' });
ok('criteria are named as the only standard', /ONLY standard/i.test(p.system));
ok('outside knowledge may explain but not withhold',
   /never to take one away/i.test(p.system));
ok('partial credit is explicitly allowed', /PARTIAL credit/i.test(p.system));
ok('UNCLEAR is an available answer', /UNCLEAR/.test(p.system));
ok('bands and grades are forbidden', /band, grade, ATAR/i.test(p.system));
ok('the criterion must be quoted word for word', /quoted word for word/i.test(p.system));
ok('the criteria reach the model', p.user.indexOf('fuel source of BOTH systems') > -1);
ok('the response reaches the model', p.user.indexOf('Some answer.') > -1);
ok('the mark total is stated', p.user.indexOf('(6 marks)') > -1);

console.log('\n2. A well-formed answer parses');
const good = [
  'MARK: 4/6',
  '- "correctly identifies the fuel source of BOTH systems" — 2/2 — both named',
  '- "correctly states the duration each system predominates" — 1/2 — only one given',
  '- "correctly identifies the by-products of BOTH systems" — 1/2 — lactic acid only',
  'WHAT TO FIX:',
  '- Give the duration of the second system',
  '- Name the by-product of the first'
].join('\n');
let r = M.parseMarking(good, 6);
ok('no problems', r.ok, r.problems.join(','));
ok('mark read', r.mark === 4 && r.outOf === 6);
ok('all three criteria read', r.criteria.length === 3);
ok('partial credit survives parsing', r.criteria[1].awarded === 1 && r.criteria[1].available === 2);
ok('fixes read', r.fixes.length === 2);
ok('criteria all traceable to what was supplied',
   M.unsupportedCriteria(r, CRITERIA).length === 0);

console.log('\n3. UNCLEAR is understood, not treated as zero');
/* A criterion the model could not settle must be distinguishable from one it
   settled at zero. Collapsing them would turn "I do not know" into "you failed",
   which is the same lie the marks feature is built to avoid. */
r = M.parseMarking([
  'MARK: 2/6',
  '- "correctly identifies the fuel source of BOTH systems" — 2/2 — both named',
  '- "correctly states the duration each system predominates" — UNCLEAR — criteria do not say what counts',
  'WHAT TO FIX:', '- Ask your teacher what duration is expected'
].join('\n'), 6);
ok('unclear flagged', r.criteria[1].unclear === true);
ok('and is not zero', r.criteria[1].awarded === null);

console.log('\n4. Arithmetic the model cannot argue with');
ok('a mark above the total is caught',
   M.parseMarking('MARK: 7/6\n- "x" — 7/6 — y', 6).problems.indexOf('mark_above_total') > -1);
ok('a criterion scored above its own value is caught',
   M.parseMarking('MARK: 3/6\n- "correctly identifies the fuel source of BOTH systems" — 3/2 — x', 6)
     .problems.indexOf('criterion_above_available') > -1);
ok('a total that is not the paper total is caught',
   M.parseMarking('MARK: 4/10\n- "x" — 4/10 — y', 6).problems.indexOf('wrong_total') > -1);
ok('a missing MARK line is caught',
   M.parseMarking('- "x" — 1/2 — y').problems.indexOf('no_mark_line') > -1);
ok('prose with no criteria lines is caught',
   M.parseMarking('MARK: 4/6\nThe student did quite well overall.', 6)
     .problems.indexOf('no_criteria_lines') > -1);
ok('empty is caught', M.parseMarking('', 6).problems.indexOf('empty') > -1);

console.log('\n5. THE ONE THAT MATTERS — a criterion nobody supplied');
/* The exact 2026-09-05 failure, caught mechanically. If the marker judges
   against something that is not in the student's criteria, the words will not be
   findable in what was supplied, and the app can refuse to show the result. */
r = M.parseMarking([
  'MARK: 2/6',
  '- "correctly identifies the fuel source of BOTH systems" — 2/2 — both named',
  '- "response falls within the expected thirty second to two minute range" — 0/2 — too vague'
].join('\n'), 6);
const bad = M.unsupportedCriteria(r, CRITERIA);
ok('the invented criterion is flagged', bad.length === 1, JSON.stringify(bad));
ok('and the real one is not', bad[0].indexOf('thirty second') > -1);

console.log('\n6. Wording differences are not treated as invention');
/* The check must catch invented standards without punishing a model that quotes
   with different punctuation or capitalisation — otherwise it fires constantly
   and gets switched off, which is worse than not having it. */
r = M.parseMarking([
  'MARK: 2/2',
  '- "Correctly identifies the fuel source of both systems." — 2/2 — fine'
].join('\n'), 2);
ok('punctuation and case do not trip it', M.unsupportedCriteria(r, CRITERIA).length === 0,
   JSON.stringify(M.unsupportedCriteria(r, CRITERIA)));

console.log('\n7. No band, grade or prediction anywhere in the rules');
['band', 'grade', 'atar', 'predict'].forEach(function (w) {
  ok('"' + w + '" appears only as something forbidden',
     new RegExp('never state or imply[^.]*' + w, 'i').test(M.RULES) ||
     M.RULES.toLowerCase().split(w).length - 1 <= 1);
});

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
