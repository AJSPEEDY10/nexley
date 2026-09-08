/* Type has to scale with the reader, and nothing in the app tells you when it stops.

   Roughly a third of iPhone users have changed their default text size, some as
   far as 310%, and Apple's own guidance is to stay usable at 200%. A web app gets
   this free — but only while its sizes are relative. One `font-size: 13px` added
   later silently opts that element out of the reader's setting forever, and it
   looks perfect on the machine of whoever added it.

   `body` was exactly that: it declared 14px, so the --t-* rem scale honoured the
   setting while every unclassed line of text inherited a fixed size and ignored it.

   THE ONE ALLOWED EXCEPTION is a px FLOOR inside max(): iOS zooms the page when a
   focused input is under 16px, so `max(1rem, 16px)` is correct — it keeps the floor
   without capping the size for a reader who scaled up. A bare px value is not. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app', 'app.css'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\ntype scaling\n');

// Strip comments first: the explanations above these rules mention "16px" on purpose.
const live = css.replace(/\/\*[\s\S]*?\*\//g, '');

const pxSizes = [...live.matchAll(/font-size:\s*([^;}]+)/g)]
  .map(m => m[1].trim())
  .filter(v => /\d+px/.test(v))
  .filter(v => !/max\(/.test(v));

ok('no font-size is locked to px',
  pxSizes.length === 0,
  pxSizes.join(', ') + ' — use rem, or max(1rem, 16px) if it needs the iOS input floor');

ok('body sets its size in rem, so unclassed text scales too',
  /body\s*\{[^}]*font-size:\s*[\d.]+rem/.test(live.replace(/\s*\n\s*/g, ' ')),
  'body must not carry a px font-size — everything without a token inherits it');

/* The ruled-paper pitch and the text sitting on it come from the same --line, and
   they went out of step once already (line-height 1.9 against a 1.75 ruling). So
   wherever the coarse-pointer block resizes the editor, --line has to be derived
   from the same expression, not from a number someone kept in their head. */
/* Brace-count to the end of the @media block. A lazy regex stops at the first "}"
   it meets, which is the end of the first rule INSIDE the block — it looked like a
   match and was three lines of an eighty-line block. */
function blocksFrom(src, re) {
  const out = [];
  let m;
  const rx = new RegExp(re.source, 'g');
  while ((m = rx.exec(src))) {
    const open = src.indexOf('{', m.index);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { out.push(src.slice(open + 1, i)); break; }
    }
  }
  return out;
}
/* There are five separate coarse-pointer blocks in this file, and the editor's
   rules are in one of them. Take the one that actually sets --line rather than
   the first one that matches the header — the first attempt at this test found a
   different block, reported 0 characters, and was measuring nothing. */
const coarse = blocksFrom(live, /@media\s*\(pointer:\s*coarse\)/)
  .find(b => b.includes('--line')) || '';
ok('found the coarse-pointer block that sizes the editor', coarse.length > 100,
  'no touch block sets --line');

// Walk the block as selector { body } pairs rather than guessing at one shape —
// .ed-body's font-size is set in a grouped selector and its --line is not.
const rules = [...coarse.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(m => ({ sel: m[1].trim(), body: m[2] }))
  .filter(r => /\.ed-body(\s|,|$|\{)/.test(r.sel + '{'));

const norm = s => s.replace(/\s+/g, ' ').trim();
const edFont = rules.map(r => (r.body.match(/font-size:\s*([^;}]+)/) || [])[1]).filter(Boolean)[0];
const edLine = rules.map(r => (r.body.match(/--line:\s*([^;}]+)/) || [])[1]).filter(Boolean)[0];

ok('the editor sets both its text size and its ruled pitch on touch',
  !!edFont && !!edLine,
  'font-size=' + edFont + ' --line=' + edLine);
ok('the ruled pitch is derived from the same size as the text it rules',
  !!(edFont && edLine && norm(edLine).includes(norm(edFont))),
  'font ' + norm(edFont || '(none)') + ' does not appear in --line ' + norm(edLine || '(none)'));

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
