/* Extract parseSyllabus() from app.js and exercise it against realistic paste formats. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');

const start = src.indexOf('function parseSyllabus(');
const marker = '\n  function openSyllabusDialog';
const end = src.indexOf(marker, start);
if (start < 0 || end < 0) { console.error('FAIL: could not extract parseSyllabus'); process.exit(1); }
const fn = src.slice(start, end);
eval(fn);

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
}
const shape = r => r.map(t => ({ c: t.code, t: t.title, p: t.points.map(p => [p.code, p.title]) }));

console.log('\n1. NSW-style with codes, 2-space indent');
check('structure', shape(parseSyllabus(
`Module 1: Health for individuals and communities
  HM-11-01 Meanings of health
  HM-11-02 Determinants of health
Module 2: Body systems and movement
  HM-11-05 Energy systems`)),
[{ c: 'Module 1', t: 'Health for individuals and communities', p: [['HM-11-01','Meanings of health'],['HM-11-02','Determinants of health']] },
 { c: 'Module 2', t: 'Body systems and movement', p: [['HM-11-05','Energy systems']] }]);

console.log('\n2. tab indent + bullets');
check('structure', shape(parseSyllabus(
`Financial Management
\t- Role of financial management
\t* Influences on financial management`)),
[{ c: '', t: 'Financial Management', p: [['','Role of financial management'],['','Influences on financial management']] }]);

console.log('\n3. numeric decimal codes');
check('structure', shape(parseSyllabus(
`1 Kinematics
    1.1 Motion in a straight line
    1.2 Motion on a plane`)),
[{ c: '1', t: 'Kinematics', p: [['1.1','Motion in a straight line'],['1.2','Motion on a plane']] }]);

console.log('\n4. no code at all');
check('structure', shape(parseSyllabus(
`Belonging
  Prescribed text
  Related material`)),
[{ c: '', t: 'Belonging', p: [['','Prescribed text'],['','Related material']] }]);

console.log('\n5. orphan indented line (no topic above it)');
check('synthesises a topic', shape(parseSyllabus(`  HM-11-01 Meanings of health`)),
[{ c: '', t: 'Topic', p: [['HM-11-01','Meanings of health']] }]);

console.log('\n6. blank lines and trailing whitespace tolerated');
// "Module 1" with no separator+title is the whole topic name — must NOT be split
check('structure', shape(parseSyllabus(
`\nModule 1   \n\n   HM-11-01 Meanings of health   \n\n`)),
[{ c: '', t: 'Module 1', p: [['HM-11-01','Meanings of health']] }]);

console.log('\n7. plain word first token must NOT be eaten as a code');
check('title intact', shape(parseSyllabus(
`Business Studies
  Operations processes`)),
[{ c: '', t: 'Business Studies', p: [['','Operations processes']] }]);

console.log('\n8. empty input');
check('empty', parseSyllabus(''), []);
check('whitespace only', parseSyllabus('   \n\n  \t '), []);

console.log('\n9. long false-positive code is rejected (>20 chars)');
const r9 = parseSyllabus(`Topic\n  Supercalifragilistic99expialidocious thing`);
check('kept as title', [r9[0].points[0].code, r9[0].points[0].title.slice(0, 11)], ['', 'Supercalifr']);

console.log('\n10. real-world formats that must round-trip');
check('Business Studies HSC', shape(parseSyllabus(
`Topic 1 - Operations
  Role of operations management
  Operations processes
Topic 2 - Marketing
  Role of marketing`)),
[{ c: 'Topic 1', t: 'Operations', p: [['','Role of operations management'],['','Operations processes']] },
 { c: 'Topic 2', t: 'Marketing', p: [['','Role of marketing']] }]);

check('4-digit year is NOT eaten as a code', shape(parseSyllabus(`Depth study\n  1914 as a turning point`))[0].p,
[['','1914 as a turning point']]);

check('short numeric code still works', shape(parseSyllabus(`Kinematics\n  3 Projectile motion`))[0].p,
[['3','Projectile motion']]);

console.log('\n' + '='.repeat(46));
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
