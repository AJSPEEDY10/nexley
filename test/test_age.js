/* The minimum-age check, and specifically its boundary.

   WHY THERE IS A GATE AT ALL. The OAIC's Children's Online Privacy Code is
   registered by 10 December 2026 and covers educational tools, not only social
   media. It asks services to take reasonable steps to ascertain age, and under-15s
   require verified parental consent — which Nexley cannot obtain and is not going
   to build, so the honest answer is not to accept them. Nexley's audience being
   Year 11 used to be an intention with no control behind it: the app asked
   nothing, so a 12-year-old could sign up. See PRIVACY_IMPACT_ASSESSMENT.md.

   WHY MONTH AND YEAR RATHER THAN A FULL DATE OF BIRTH. The only question is "15 or
   older". A full DOB is a strong identifier and holding one to answer a yes/no
   question collects past the purpose — the exact standard the Code tightens. Only
   the YEAR is stored, even though the month is asked, because the month is needed
   to decide and not afterwards.

   WHY THIS FILE IS MOSTLY BOUNDARY CASES. Every age check ever written is wrong by
   one somewhere, and it is wrong silently: a fifteenth birthday that reads as
   fourteen turns a legitimate student away, and the reverse admits a child the
   whole control exists to keep out. Both failures are invisible unless the exact
   day is tested, so the day is tested — with a FIXED clock, because a test that
   depends on today's date passes until the morning it doesn't. */
const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\nage gate\n');

// Lift the real functions out of app.js rather than reimplementing them here —
// a copy would drift and then this file would be testing itself.
const minSrc = js.match(/function minimumAge\s*\([\s\S]*?\n  \}/);
const oldSrc = js.match(/function oldEnough\s*\([\s\S]*?\n  \}/);
const minAgeSrc = js.match(/var MIN_AGE\s*=\s*(\d+)/);

ok('minimumAge() is present in app.js', !!minSrc);
ok('oldEnough() is present in app.js', !!oldSrc);
ok('MIN_AGE is declared', !!minAgeSrc);

const MIN_AGE = minAgeSrc ? +minAgeSrc[1] : 0;
ok('the minimum age is 15, matching the Code\'s parental-consent threshold', MIN_AGE === 15,
  'found ' + MIN_AGE);

let minimumAge = null, oldEnough = null;
if (minSrc && oldSrc && minAgeSrc) {
  const mod = new Function(
    'var MIN_AGE = ' + MIN_AGE + ';' + minSrc[0] + ';' + oldSrc[0] +
    '; return { minimumAge: minimumAge, oldEnough: oldEnough };')();
  minimumAge = mod.minimumAge;
  oldEnough = mod.oldEnough;
}

if (minimumAge) {
  // A fixed "today" so this file means the same thing in five years.
  const TODAY = new Date(2026, 8, 8);   // 8 September 2026

  // ---- the boundary, from both sides -------------------------------------
  /* Someone born in September 2011 turns 15 some time this month. The check uses
     the LAST day of the birth month, i.e. assumes they are as young as they could
     be — so on 8 September they are treated as 14 and refused. That is the
     deliberate direction to be wrong in: erring young keeps a child out for a few
     weeks, erring old lets one in permanently. */
  ok('born the same month as today reads as one year younger (conservative)',
    minimumAge(2011, 9, TODAY) === 14, 'got ' + minimumAge(2011, 9, TODAY));
  ok('…and is therefore refused', oldEnough(2011, 9, TODAY) === false);

  ok('born the month BEFORE, fifteen years ago, is 15 and accepted',
    minimumAge(2011, 8, TODAY) === 15 && oldEnough(2011, 8, TODAY) === true,
    'got ' + minimumAge(2011, 8, TODAY));

  ok('born the month AFTER, fifteen years ago, is 14 and refused',
    minimumAge(2011, 10, TODAY) === 14 && oldEnough(2011, 10, TODAY) === false,
    'got ' + minimumAge(2011, 10, TODAY));

  // ---- the population this is actually for --------------------------------
  ok('a Year 11 student (born 2009) is accepted',
    oldEnough(2009, 5, TODAY) === true);
  ok('a Year 12 student (born 2008) is accepted',
    oldEnough(2008, 11, TODAY) === true);
  ok('a Year 7 student (born 2014) is refused',
    oldEnough(2014, 3, TODAY) === false);
  ok('an adult (born 1985) is accepted',
    oldEnough(1985, 1, TODAY) === true);

  // ---- December/January, where off-by-one bugs live -----------------------
  ok('born December, fifteen years ago, is refused in September',
    oldEnough(2011, 12, TODAY) === false, 'got ' + minimumAge(2011, 12, TODAY));
  ok('born January, fifteen years ago, is accepted in September',
    oldEnough(2011, 1, TODAY) === true, 'got ' + minimumAge(2011, 1, TODAY));
  ok('a January birthday is handled on New Year\'s Day itself',
    oldEnough(2011, 1, new Date(2027, 0, 1)) === true);

  // ---- refusing to guess ---------------------------------------------------
  /* null means "not answered", which the caller must treat differently from
     "answered and too young" — one is a prompt to fill the field in, the other
     is a refusal. Collapsing them would either nag a rejected user forever or
     let an empty form through. */
  for (const [y, m, why] of [
    ['', '', 'both blank'], [2010, '', 'no month'], ['', 6, 'no year'],
    [2010, 0, 'month 0'], [2010, 13, 'month 13'], ['abc', 'def', 'nonsense'],
  ]) {
    ok('no answer given (' + why + ') is null, not a refusal',
      minimumAge(y, m, TODAY) === null && oldEnough(y, m, TODAY) === null);
  }
}

// ---------------------------------------------------------------------------
// The gate has to cover every door, not just the sign-up form
// ---------------------------------------------------------------------------
/* Google sign-in never touches the sign-up form, and every account made before
   this existed has no answer recorded. If the check lived only on the form it
   would look complete and leave the OAuth door open — so it lives in enterApp(),
   which both paths funnel through. */
ok('the check runs in enterApp(), not only on the sign-up form',
  /function enterApp[\s\S]{0,600}?birth_year[\s\S]{0,120}?askAge\(/.test(js),
  'enterApp must refuse to open the app without a recorded birth_year');

ok('a full date of birth is never collected — no day field exists',
  !/fDobDay|birth_day|dobDay/.test(js));

ok('only the year is persisted, never the month',
  /setBirthYear\(Number\(y\)\)/.test(js) && !/birth_month/.test(js));

const auth = fs.readFileSync(path.join(__dirname, '..', 'app', 'auth.js'), 'utf8');
ok('auth.js stores birth_year and nothing more granular',
  /birth_year/.test(auth) && !/birth_month|birth_date|dob\b/.test(auth));
ok('setBirthYear is exposed for the accounts the form cannot reach',
  /setBirthYear:\s*setBirthYear/.test(auth));

// The dialog must not be escapable into a half-signed-in state.
ok('the age dialog cannot be dismissed with Esc into the app',
  /dlg\.addEventListener\('cancel'/.test(js));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
