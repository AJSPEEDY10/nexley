/* Nexley ships no third-party code it did not commit.

   THE BUG THIS EXISTS TO PREVENT. Until 2026-09-08 app.html loaded supabase-js from
   jsDelivr on a floating major range (`@2`) with no integrity hash, and the service
   worker precached it. Three things made that worse than the usual CDN argument:

     - the version was decided by a CDN cache expiry, not by anyone here, so a new
       2.x release would execute in signed-in sessions with no commit and no diff;
     - the specific file requested, `dist/umd/supabase.min.js`, is NOT in the npm
       package at all — jsDelivr minifies it on demand, so the exact bytes being
       executed had no publisher-signed counterpart to check against;
     - it is the one script on a page holding the session token in localStorage and
       the whole notebook in IndexedDB, so anything running there reads both.

   None of that announces itself. The page works perfectly right up until it doesn't,
   and the §11 audit had this recorded as "third-party embeds — none currently".

   So the invariant is mechanical: every <script src> on every shipped page is
   same-origin, and the vendored file, the app.html tag and the service worker
   precache all name the SAME version. The last one matters because they are three
   copies of one fact, and a copy drifts — bump two of three and returning users keep
   being served the old file out of cache while the repo insists otherwise. */
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..', 'app');
const read = f => fs.readFileSync(path.join(appDir, f), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\nsupply chain\n');

// ---------------------------------------------------------------------------
// 1 · No page loads executable code from anywhere but Nexley's own origin
// ---------------------------------------------------------------------------
const pages = fs.readdirSync(appDir).filter(f => f.endsWith('.html'));
ok('there are pages to check', pages.length > 0, 'no .html found in app/');

for (const page of pages) {
  const html = read(page);
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
  const offOrigin = srcs.filter(s => /^(https?:)?\/\//i.test(s));
  ok(page + ': every <script src> is same-origin',
    offOrigin.length === 0,
    offOrigin.join(', '));
}

// A stylesheet can't read localStorage, but it can exfiltrate via selectors and it is
// still a third party watching every page load. Same rule, same reason.
for (const page of pages) {
  const html = read(page);
  const hrefs = [...html.matchAll(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi)]
    .map(tag => (tag[0].match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1])
    .filter(Boolean)
    .filter(h => /^(https?:)?\/\//i.test(h));
  ok(page + ': every stylesheet is same-origin', hrefs.length === 0, hrefs.join(', '));
}

// ---------------------------------------------------------------------------
// 2 · The three copies of the vendored version agree
// ---------------------------------------------------------------------------
const vendorDir = path.join(appDir, 'vendor');
const vendored = fs.existsSync(vendorDir)
  ? fs.readdirSync(vendorDir).filter(f => /^supabase-js-.*\.js$/.test(f))
  : [];

ok('exactly one vendored supabase-js is present',
  vendored.length === 1,
  vendored.length === 0 ? 'none found in app/vendor/' : 'found ' + vendored.join(', '));

if (vendored.length === 1) {
  const file = vendored[0];
  const version = (file.match(/^supabase-js-(.+)\.js$/) || [])[1];

  ok('the vendored filename pins an exact version, not a range',
    /^\d+\.\d+\.\d+$/.test(version),
    version);

  const appHtml = read('app.html');
  ok('app.html loads the vendored file by its exact name',
    appHtml.includes('vendor/' + file),
    'app.html does not reference vendor/' + file);

  const sw = read('sw.js');
  ok('the service worker precaches the same file',
    sw.includes('vendor/' + file),
    'sw.js does not precache vendor/' + file);

  // Any other version string left behind in either place means a half-finished bump.
  const stale = s => [...s.matchAll(/supabase-js-(\d+\.\d+\.\d+)\.js/g)]
    .map(m => m[1]).filter(v => v !== version);
  ok('no stale supabase-js version left in app.html', stale(appHtml).length === 0, stale(appHtml).join(', '));
  ok('no stale supabase-js version left in sw.js', stale(sw).length === 0, stale(sw).join(', '));

  ok('the vendored file is a real bundle, not a stub or an error page',
    fs.statSync(path.join(vendorDir, file)).size > 100000);

  ok('the vendored file actually defines the supabase UMD global',
    /createClient/.test(fs.readFileSync(path.join(vendorDir, file), 'utf8')));

  ok('vendor/README.md records this exact version',
    fs.existsSync(path.join(vendorDir, 'README.md')) &&
      fs.readFileSync(path.join(vendorDir, 'README.md'), 'utf8').includes(version),
    'app/vendor/README.md is missing or does not mention ' + version);
}

// ---------------------------------------------------------------------------
// 3 · The old CDN URL is gone everywhere, including the precache
// ---------------------------------------------------------------------------
for (const page of pages.concat(['sw.js'])) {
  ok(page + ': no jsdelivr/unpkg reference remains',
    !/cdn\.jsdelivr\.net|unpkg\.com/i.test(read(page)));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
