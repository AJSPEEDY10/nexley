/* The version number lives in four places, and this file is the reason they agree.

   Nexley ships several times a day, and the version is not decoration: it is
   stamped into every snapshot, crash report, feedback item and export. When a
   report comes back saying something is broken, the version is what says which
   code produced it. That only works if the number moves when the code does.

   It did not. On 2026-09-08 the audit that produced this file found:
     - two releases (delete-account + the whole Phase 8 native surface, then the
       legal/AI-disclosure pass) had shipped with APP_VERSION untouched at 0.33.0,
       so two days of reports named code that was not running;
     - package.json said 0.19.1 — fourteen versions behind, because nothing ever
       read it and so nothing ever noticed;
     - sw.js's CACHE had not been bumped for either release, and its precache list
       was missing two scripts app.html loads on every launch.

   Every one of those is invisible until someone goes looking, which is the
   definition of a thing that belongs in a test rather than in a checklist. The
   same reasoning as test_events.js: a claim that lives only in a comment is a
   claim nobody is keeping.

   THE RULE: bump APP_VERSION, package.json and sw.js's CACHE together, and write
   what changed in CHANGELOG.md. This fails if you miss one. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\nversion consistency\n');

// ---------------------------------------------------------------------------
// the four sources
// ---------------------------------------------------------------------------
const appJs = read('app', 'app.js');
const swJs = read('app', 'sw.js');
const changelog = read('CHANGELOG.md');
const pkg = JSON.parse(read('package.json'));

const appVersion = (appJs.match(/APP_VERSION\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'/) || [])[1];
const cache = (swJs.match(/CACHE\s*=\s*'nexley-v([0-9]+)'/) || [])[1];

ok('app.js declares an APP_VERSION', !!appVersion, 'no APP_VERSION = \'x.y.z\' found');
ok('sw.js declares a numbered CACHE', !!cache, 'no CACHE = \'nexley-vN\' found');

ok('package.json matches app.js',
  pkg.version === appVersion,
  'package.json ' + pkg.version + ' vs app.js ' + appVersion);

ok('CHANGELOG.md has an entry for the current version',
  new RegExp('^## v' + String(appVersion).replace(/\./g, '\\.') + ' ', 'm').test(changelog),
  'no "## v' + appVersion + '" heading — write down what shipped');

// The newest entry in the file must BE the current version. A changelog whose top
// entry is older than the running code is worse than no changelog: it reads as
// current and is not.
const firstHeading = (changelog.match(/^## v([0-9]+\.[0-9]+\.[0-9]+) /m) || [])[1];
ok('CHANGELOG.md leads with the current version',
  firstHeading === appVersion,
  'newest entry is v' + firstHeading + ', app is v' + appVersion);

// ---------------------------------------------------------------------------
// the service worker actually caches what the app loads
// ---------------------------------------------------------------------------
/* app.html's <script src> list and sw.js's SHELL are two hand-maintained lists of
   the same thing, which is how notifications.js and widget.js went missing. Local
   scripts only — the CDN entry is precached by full URL. */
const appHtml = read('app', 'app.html');
const scripts = [...appHtml.matchAll(/<script src="([^"]+)"/g)]
  .map(m => m[1])
  .filter(s => !/^https?:/.test(s));
const missing = scripts.filter(s => !swJs.includes("'./" + s + "'"));
ok('every local script app.html loads is in the service worker SHELL',
  missing.length === 0,
  missing.join(', ') + ' would 404 on a cold offline launch');

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
