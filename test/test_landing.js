/* The landing page's two invariants, both of which fail silently.

   1. THE FAQ AND ITS STRUCTURED DATA MUST MATCH. The FAQPage JSON-LD in the head
      is a second copy of the questions written in the body. A copy is a thing that
      drifts: edit an answer on the page, forget the head, and now the page tells a
      reader one thing and tells Google and every AI assistant another. Search
      engines have a word for markup that does not match the visible page and it is
      not a compliment — and more simply, one of the two is then a lie.

   2. THE STICKY CALL-TO-ACTION MUST APPEAR IN THE MIDDLE AND NOWHERE ELSE. It is a
      duplicate of the hero button, so showing it while the hero button is on screen
      is worse than not having it, and showing it over the footer covers the links
      it sits on top of. That logic lives in an inline IIFE driven by
      IntersectionObserver, which cannot be exercised in a browser tab that is not
      being rendered — a background tab delivers no intersections at all, which is
      exactly how this went "verified" the first time when nothing had been proven.
      So the observer is stubbed here and the three states are asserted directly. */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\nlanding page\n');

// ---------------------------------------------------------------------------
// 1 · FAQ ↔ FAQPage parity
// ---------------------------------------------------------------------------
const pageQuestions = [...html.matchAll(/<summary>([^<]+)<\/summary>/g)].map(m => m[1].trim());
const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .map(b => { try { return JSON.parse(b[1]); } catch (e) { return { _bad: e.message }; } });

ok('every JSON-LD block parses',
  ldBlocks.every(b => !b._bad),
  (ldBlocks.find(b => b._bad) || {})._bad);

const faqLd = ldBlocks.find(b => b['@type'] === 'FAQPage');
ok('the page declares FAQPage structured data', !!faqLd);

if (faqLd) {
  ok('one schema entry per question on the page',
    faqLd.mainEntity.length === pageQuestions.length,
    faqLd.mainEntity.length + ' in schema vs ' + pageQuestions.length + ' on the page');

  ok('no schema answer is a stub',
    faqLd.mainEntity.every(q => q.acceptedAnswer && (q.acceptedAnswer.text || '').length > 60),
    'an answer under 60 characters is a placeholder, not an answer');

  /* QUESTION WORDING IS DELIBERATELY ALLOWED TO DIFFER. The page asks "Is it free?"
     because the page is around it; the schema asks "Is Nexley free?" because it will
     be read with no context at all. An earlier version of this test compared the
     question text and failed on exactly that — the check was wrong, not the page.

     What must not drift is the ANSWERS, and they are positional: the schema array is
     written in the same order as the sections. So each schema answer is compared with
     the page answer at the same index, and most of what it says has to actually appear
     there. That catches the real mistake — editing an answer in one place only. */
  const pageAnswers = [...html.matchAll(/<summary>[^<]+<\/summary>\s*<p>([\s\S]*?)<\/p>/g)]
    .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').toLowerCase());
  ok('every question on the page has an answer under it',
    pageAnswers.length === pageQuestions.length,
    pageAnswers.length + ' answers for ' + pageQuestions.length + ' questions');

  const contentWords = s => s.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 4);
  const drifted = faqLd.mainEntity.map((q, i) => {
    const mine = contentWords(q.acceptedAnswer.text);
    const theirs = pageAnswers[i] || '';
    const shared = mine.filter(w => theirs.includes(w)).length;
    return { name: q.name, overlap: mine.length ? shared / mine.length : 0 };
  }).filter(r => r.overlap < 0.6);
  ok('each schema answer still matches the answer printed on the page',
    drifted.length === 0,
    drifted.map(d => d.name + ' (' + Math.round(d.overlap * 100) + '% shared)').join(' / '));
}

// ---------------------------------------------------------------------------
// 2 · the sticky CTA's three states
// ---------------------------------------------------------------------------
const iife = (html.match(/\(function \(\) \{\s*var bar = document\.getElementById\('stickyCta'\)[\s\S]*?\}\)\(\);/) || [])[0];
ok('the sticky-CTA script is present in the page', !!iife);

if (iife) {
  const bar = { hidden: true };
  const hero = { name: 'hero' };
  const foot = { name: 'foot' };
  let cb = null;
  const observed = [];

  const sandbox = {
    document: {
      getElementById: id => (id === 'stickyCta' ? bar : null),
      querySelector: sel => (sel === '.hero .cta' ? hero : sel === '.foot' ? foot : null)
    },
    window: { IntersectionObserver: true },
    IntersectionObserver: function (fn) {
      cb = fn;
      this.observe = t => observed.push(t);
    }
  };
  // 'in' against a plain object works the same as against window here
  new Function('document', 'window', 'IntersectionObserver', iife)(
    sandbox.document, sandbox.window, sandbox.IntersectionObserver);

  ok('it observes both the hero button and the footer',
    observed.length === 2 && observed.includes(hero) && observed.includes(foot));

  const scroll = (heroVisible, footVisible) =>
    cb([{ target: hero, isIntersecting: heroVisible }, { target: foot, isIntersecting: footVisible }]);

  scroll(true, false);
  ok('hidden at the top, where the hero button is already on screen', bar.hidden === true);

  scroll(false, false);
  ok('SHOWN in the middle, where there is no other way in', bar.hidden === false);

  scroll(false, true);
  ok('hidden again at the footer, so it never covers those links', bar.hidden === true);

  scroll(true, true);
  ok('hidden on a screen tall enough to show both at once', bar.hidden === true);
}

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
