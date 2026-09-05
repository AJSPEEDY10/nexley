/* Extract titleFrom() from app.js.

   A capture's title is the first line of whatever got typed in a lesson, which
   is a sentence rather than a heading. This used to be a hard slice(0, 140), so
   a long first line produced a title cut mid-word — "…including joint types and
   musc" — which the editor then set at display size across four lines. The cut
   is the whole function; these are the ways a cut goes wrong. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');

const a = src.indexOf('  var TITLE_MAX = 72;');
const b = src.indexOf('  /* A capture is a note with kind');
const end = b > a ? b : src.indexOf('\n\n', src.indexOf('function titleFrom'));
if (a < 0 || end < 0) { console.error('FAIL: could not extract titleFrom'); process.exit(1); }
eval(src.slice(a, end));

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  — ' + detail : '')); }
}

console.log('\n1. Short lines are left alone');
ok('a real heading passes through', titleFrom('Energy systems') === 'Energy systems');
ok('no ellipsis is added', titleFrom('Mitosis').indexOf('…') === -1);
ok('empty stays empty', titleFrom('') === '');
ok('missing input is safe', titleFrom(null) === '');

console.log('\n2. Whitespace is normalised, not preserved');
ok('runs of space collapse', titleFrom('  Energy    systems  ') === 'Energy systems');
ok('a tab is just a space', titleFrom('Energy\tsystems') === 'Energy systems');

console.log('\n3. THE ONE THAT MATTERS — long lines cut at a word boundary');
const LONG = 'Today we covered the skeletal and muscular systems - how bones and '
           + 'muscles work together to produce movement, including joint types.';
const cut = titleFrom(LONG);
ok('it is shortened', cut.length < LONG.length, String(cut.length));
ok('it ends with an ellipsis', /…$/.test(cut), cut);
/* The actual bug: the old version ended mid-word. Strip the ellipsis and the
   last thing left must be a whole word from the original. */
const lastWord = cut.replace(/…$/, '').split(' ').pop();
ok('the last word is a whole word', LONG.split(/\s+/).indexOf(lastWord) > -1, lastWord);
ok('no dangling punctuation before the ellipsis', !/[\s,;:.–—-]…$/.test(cut), cut);

console.log('\n4. A long line with no spaces still gets cut');
/* A word-boundary rule that only works when there is a boundary is not a rule.
   A pasted URL or an unbroken string must still come back short. */
const NOSPACE = 'x'.repeat(300);
const hard = titleFrom(NOSPACE);
ok('it is still shortened', hard.length < 90, String(hard.length));
ok('and still marked as truncated', /…$/.test(hard));

console.log('\n5. The result is always one line');
ok('a newline never survives', titleFrom('First line\nSecond line').indexOf('\n') === -1);

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
