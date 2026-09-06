/* The one part of comps that is pure: turning a typed-out paper into
   questions. Everything else in 12p is network and DOM.

   This matters more than it looks. The marks total is what everyone in the
   comp is scored against, and it is derived from text somebody typed in a
   hurry — so the failure mode is not "the parser is wrong", it is "four people
   sat a test that was silently out of 7 instead of 10". */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');

function grab(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) { console.error('FAIL: could not extract ' + startMarker); process.exit(1); }
  return src.slice(a, b);
}
eval(grab('var QLINE =', '  function openComps'));

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : '')); }
}
const eq = (label, got, want) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want),
     'got ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want));

/* --- the ordinary case --- */
eq('marks at the end of the line',
  parseQuestions('Describe semi-conservative replication  3\nName the unwinding enzyme  1'),
  [{ prompt: 'Describe semi-conservative replication', outOf: 3 },
   { prompt: 'Name the unwinding enzyme', outOf: 1 }]);

eq('a bare question is worth one mark',
  parseQuestions('What is a codon?'),
  [{ prompt: 'What is a codon?', outOf: 1 }]);

eq('blank lines are not questions',
  parseQuestions('First  2\n\n\nSecond  2'),
  [{ prompt: 'First', outOf: 2 }, { prompt: 'Second', outOf: 2 }]);

eq('leading and trailing space is trimmed',
  parseQuestions('   Describe osmosis   4   '),
  [{ prompt: 'Describe osmosis', outOf: 4 }]);

eq('half marks survive',
  parseQuestions('Define diffusion  1.5'),
  [{ prompt: 'Define diffusion', outOf: 1.5 }]);

eq('empty input is no questions', parseQuestions(''), []);
eq('null input is no questions', parseQuestions(null), []);
eq('whitespace only', parseQuestions('   \n  \n'), []);

/* --- the ones that would silently change what everyone is marked out of --- */
eq('a number INSIDE the question is not the marks',
  parseQuestions('Name the 3 energy systems  2'),
  [{ prompt: 'Name the 3 energy systems', outOf: 2 }]);

eq('a question that ends in a number and has no marks keeps its meaning',
  parseQuestions('Balance the equation for photosynthesis'),
  [{ prompt: 'Balance the equation for photosynthesis', outOf: 1 }]);

/* This one is a genuine ambiguity and the test exists to pin the choice made:
   "What is 2 + 2" reads as a question worth 2, because there is no way to tell
   it apart from "Describe X  2" without understanding the sentence. Writing
   the marks explicitly is the fix, and the running total in the dialog is what
   makes the mistake visible before anyone joins. */
eq('a trailing number is ALWAYS read as marks (documented ambiguity)',
  parseQuestions('What is 2 + 2'),
  [{ prompt: 'What is 2 +', outOf: 2 }]);

eq('single-digit and multi-digit both work',
  parseQuestions('A  1\nB  12'),
  [{ prompt: 'A', outOf: 1 }, { prompt: 'B', outOf: 12 }]);

/* --- the total, which is what everyone is scored against --- */
ok('total adds up', questionsTotal(parseQuestions('A  3\nB  2\nC  5')) === 10);
ok('total of bare questions is the count',
  questionsTotal(parseQuestions('A\nB\nC')) === 3);
ok('total of nothing is zero', questionsTotal([]) === 0);
ok('total copes with a missing outOf',
  questionsTotal([{ prompt: 'x' }, { prompt: 'y', outOf: 2 }]) === 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
