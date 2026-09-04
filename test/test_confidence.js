/* Extract confidenceOf() / confidenceWhy() from app.js and check the properties
   that matter more than the exact numbers.

   This reading is what coverage, Tasks and (later) revision targeting all consult,
   so its failure modes are the dangerous kind: quietly wrong rather than broken.
   These tests pin the three claims its header comment makes — absence is not
   weakness, preparing work is not knowing it, and a stale reading must decay. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
const a=src.indexOf('function confidenceOf('), b=src.indexOf('  /* ============================================================\n     12h');
if(a<0||b<0){console.error('extract failed');process.exit(1);}
let NOTES=[],CARDS=[];
const state={cards:[]};
function notesOfNode(id){return NOTES.filter(n=>n.syllabusId===id);}
eval(src.slice(a,b));
let pass=0,fail=0;
const ok=(l,c,d)=>{c?(pass++,console.log('  PASS  '+l)):(fail++,console.log('  FAIL  '+l+(d?'\n        '+d:'')));};
const set=(notes,cards)=>{NOTES=notes;state.cards=cards;};
const card=(o)=>Object.assign({syllabusId:'p',ease:2.5,reps:0,lapses:0,due:Date.now()+9e8},o);
const note=()=>({syllabusId:'p',kind:'personal'});

console.log('\n1. Absence is not weakness');
set([],[]);
let c=confidenceOf('p');
ok('nothing at all -> untouched, score null', c.band==='untouched'&&c.score===null, JSON.stringify(c));

console.log('\n2. Preparing work is not knowing it');
set([note()],[card({reps:0}),card({reps:0})]);
c=confidenceOf('p');
ok('a deck of brand-new cards is not "solid"', c.band!=='solid', 'band '+c.band+' score '+c.score);

console.log('\n3. A well-reviewed point reads solid');
set([note()],[card({reps:6,ease:2.7}),card({reps:5,ease:2.6})]);
c=confidenceOf('p');
ok('high reps + high ease -> solid', c.band==='solid', 'band '+c.band+' score '+c.score.toFixed(2));

console.log('\n4. Repeated failure reads shaky');
set([note()],[card({reps:1,ease:1.3,lapses:4}),card({reps:1,ease:1.4,lapses:3})]);
c=confidenceOf('p');
ok('floored ease + many lapses -> shaky', c.band==='shaky', 'band '+c.band+' score '+c.score.toFixed(2));

console.log('\n5. Going stale lowers the reading');
set([note()],[card({reps:6,ease:2.7}),card({reps:6,ease:2.7})]);
const fresh=confidenceOf('p').score;
set([note()],[card({reps:6,ease:2.7,due:Date.now()-1000}),card({reps:6,ease:2.7,due:Date.now()-1000})]);
const stale=confidenceOf('p').score;
ok('all-overdue scores lower than all-fresh', stale<fresh, fresh.toFixed(2)+' -> '+stale.toFixed(2));

console.log('\n6. Every reading can name its evidence');
set([note()],[card({reps:3,due:Date.now()-1000})]);
c=confidenceOf('p');
ok('why-string mentions notes, cards and due', /note/.test(confidenceWhy(c))&&/card/.test(confidenceWhy(c))&&/due/.test(confidenceWhy(c)), confidenceWhy(c));
set([],[]);
ok('untouched explains itself', /No notes and no cards/.test(confidenceWhy(confidenceOf('p'))));

console.log('\n7. Score stays in range under abuse');
set([note()],[card({reps:99,ease:9,lapses:0})]);
ok('absurd inputs stay <= 1', confidenceOf('p').score<=1, ''+confidenceOf('p').score);
set([note()],[card({reps:1,ease:0,lapses:99})]);
ok('absurd inputs stay >= 0', confidenceOf('p').score>=0, ''+confidenceOf('p').score);

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
