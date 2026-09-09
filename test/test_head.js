/* The head of every public page.
 *
 * These are the mechanical items off the two SEO checklists in
 * GROWTH_AND_LAUNCH.md §11 (batch 3, `yatesvids` — "unique page titles, meta
 * descriptions, canonical tags, alt text"). They are the cheapest possible wins
 * and exactly the kind that rot silently, because nothing in the app breaks when
 * one goes missing.
 *
 * THE TRAP THIS ENCODES: on 2026-09-09 the landing page and the app carried the
 * IDENTICAL <title>, and legal.html — which is in the sitemap, and is the page an
 * assistant is asked to read when a student wants to know whether their notes
 * train an AI — had no description and no canonical at all.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const SITE = 'https://ajspeedy10.github.io/nexley/';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  — ' + extra : '')); }
}

const read = f => fs.readFileSync(path.join(APP, f), 'utf8');
const grab = (s, re) => { const m = s.exec ? null : null; const r = re.exec(s); return r ? r[1].trim() : null; };
const title = s => grab(s, /<title>([\s\S]*?)<\/title>/i);
const meta = (s, n) => grab(s, new RegExp('<meta\\s+name="' + n + '"\\s+content="([\\s\\S]*?)"', 'i'));
const canonical = s => grab(s, /<link\s+rel="canonical"\s+href="(.*?)"/i);

/* Every page a search engine or an assistant can land on. app.html is here too:
   it is reachable by link even though it is deliberately out of the sitemap. */
const PAGES = ['index.html', 'app.html', 'legal.html', 'compare.html', '404.html'];
const INDEXED = ['index.html', 'legal.html', 'compare.html'];

console.log('\n1. Titles are unique');
const titles = {};
PAGES.forEach(p => { titles[p] = title(read(p)); });
PAGES.forEach(p => ok(p + ' has a title', !!titles[p]));
const seen = {};
let dupe = null;
Object.keys(titles).forEach(p => {
  const t = (titles[p] || '').toLowerCase();
  if (seen[t]) dupe = seen[t] + ' and ' + p + ' both use "' + titles[p] + '"';
  seen[t] = p;
});
ok('no two pages share a title', !dupe, dupe);

console.log('\n2. Indexed pages carry a description and a canonical');
INDEXED.forEach(p => {
  const s = read(p);
  const d = meta(s, 'description');
  ok(p + ' has a meta description', !!d);
  ok(p + ' description is a sentence, not a stub', !!d && d.length >= 60 && d.length <= 320,
    d ? d.length + ' chars' : 'missing');
  const c = canonical(s);
  ok(p + ' has a canonical', !!c);
  ok(p + ' canonical is absolute and on the real origin', !!c && c.indexOf(SITE) === 0, c || 'missing');
});

console.log('\n3. Pages that must NOT be indexed say so');
[['app.html', 'a sign-in gate with nothing to show a crawler'],
 ['404.html', 'an error page']].forEach(function (pair) {
  const r = meta(read(pair[0]), 'robots');
  ok(pair[0] + ' is noindex (' + pair[1] + ')', !!r && /noindex/i.test(r), r || 'no robots meta');
});
ok('app.html is left out of the sitemap', read('sitemap.xml').indexOf('app.html</loc>') === -1);
ok('every indexed page IS in the sitemap',
  INDEXED.every(p => read('sitemap.xml').indexOf(p === 'index.html' ? SITE + '<' : p) !== -1));

console.log('\n4. Images and headings');
PAGES.forEach(p => {
  const s = read(p);
  const imgs = s.match(/<img\b[^>]*>/gi) || [];
  const noAlt = imgs.filter(i => !/\balt=/i.test(i));
  ok(p + ' — every <img> has alt text', noAlt.length === 0, noAlt.slice(0, 1).join(''));
  const h1s = (s.match(/<h1\b/gi) || []).length;
  ok(p + ' — exactly one <h1>', h1s === 1, 'found ' + h1s);
});

console.log('\n5. The placeholder tells the checklists name');
PAGES.forEach(p => {
  const t = (titles[p] || '').toLowerCase();
  ok(p + ' — title is not a framework placeholder',
    !/vite|react|app|document|untitled|index/.test(t.replace('nexley', '')), titles[p]);
});

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
