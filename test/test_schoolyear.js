/* The school-year question: asked once, skippable, and never a gate.

   WHAT THIS REPLACED, AND WHY IT MATTERS THAT IT DID. v0.43.0 shipped a hard
   minimum age of 15: a birth month and year on the sign-up form, and a
   non-dismissible dialog for anyone the form had not seen. It was built on the
   OAIC's Children's Online Privacy Code, which does require verified parental
   consent for under-15s — and would require it again every twelve months.

   Two things were wrong with acting on that in September 2026. The Code is an
   EXPOSURE DRAFT, unregistered until 10 December 2026 and being pushed back on by
   the firms reading it, so it was a gate built against a rule that did not exist
   yet. And a floor at 15 excludes Years 7 to 10 — roughly half of school — which
   runs directly against what Nexley is for. Compliance work that quietly deletes
   half your intended users is not conservative, it is just a different risk taken
   without noticing.

   So the question stayed and the gate went. Nexley is a syllabus app: Year 11 and
   Year 12 are different courses, so the year is something the product wants
   regardless. It is setup that happens to carry a rough age signal, rather than an
   age check wearing a product costume — and a year level is far less personal than
   a date of birth, which is no longer collected at all.

   These tests exist to stop the gate creeping back in by accident, and to stop the
   question hardening into a toll on someone's own notebook. */
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..', 'app');
const js = fs.readFileSync(path.join(appDir, 'app.js'), 'utf8');
const auth = fs.readFileSync(path.join(appDir, 'auth.js'), 'utf8');
const html = fs.readFileSync(path.join(appDir, 'app.html'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\nschool year\n');

// ---------------------------------------------------------------------------
// 1 · No date of birth, and no age gate, anywhere
// ---------------------------------------------------------------------------
const all = js + auth + html;
for (const [needle, why] of [
  ['MIN_AGE', 'a minimum-age constant'],
  ['minimumAge', 'the age calculator'],
  ['oldEnough', 'the age predicate'],
  ['birth_year', 'a stored birth year'],
  ['fDobMonth', 'a birth-month field'],
  ['fDobYear', 'a birth-year field'],
]) {
  ok('no ' + why + ' remains', !new RegExp('\\b' + needle + '\\b').test(all));
}
ok('no date of birth is collected in any form',
  !/date.of.birth|dateOfBirth|\bdob\b/i.test(js + auth) ||
  /an earlier version/.test(js + auth),
  'only historical references in comments are allowed');

// ---------------------------------------------------------------------------
// 2 · The question covers every door, like the gate did
// ---------------------------------------------------------------------------
/* Google sign-in never touches the sign-up form, and accounts that predate the
   question have no answer. If this lived only on the form it would look complete
   and miss both — the one property of the old gate worth keeping. */
ok('the question is asked from enterApp(), not only on the sign-up form',
  /function enterApp[\s\S]{0,600}?school_year[\s\S]{0,120}?askYear\(/.test(js));

ok('the sign-up form asks for a year', /id="fSchoolYear"/.test(html));
ok('the dialog asks for a year', /id="ySchoolYear"/.test(html));
/* Deliberately tolerant of a wrapper. This asserted `setSchoolYear: setSchoolYear`
   exactly, and went red in v0.56.0 when the export became
   `setSchoolYear: bound(setSchoolYear, …)` — a timeout wrapper that changes
   nothing about what this test is for. The property that matters is that auth.js
   exports the call and that it writes school_year; how the export is spelled is
   not this file's business. */
ok('auth.js can record it for accounts the form never saw',
  /setSchoolYear:[^,\n]*setSchoolYear/.test(auth) && /school_year/.test(auth));

// ---------------------------------------------------------------------------
// 3 · It is a question, not a toll  — the invariant that matters most
// ---------------------------------------------------------------------------
ok('the dialog has a Skip button', /id="yearSkip"/.test(html));
ok('Skip is wired to something', /\$\('yearSkip'\)\.addEventListener\('click', skip\)/.test(js));
ok('Escape skips rather than trapping the user outside their notes',
  /dlg\.addEventListener\('cancel', onCancel\)/.test(js) && /function onCancel\(e\) \{ e\.preventDefault\(\); skip\(\); \}/.test(js));

/* A skip has to be RECORDED, not just tolerated. If skipping left the field empty
   the guard in enterApp would fire again on the next load and the "skippable"
   dialog would be a nag that reappears forever. */
ok('skipping is stored as a real answer so it is not asked again',
  /school_year = value \|\| 'skipped'/.test(js) && /setSchoolYear\('skipped'\)/.test(js));

/* Nobody is refused. If any of these words come back near this flow, the gate is
   creeping back in. */
ok('nothing in the flow turns a user away',
  !/is for students aged|cannot be created yet|You have been.*signed out/i.test(js));

/* A failed write must not strand someone outside their own notebook — the notes
   are local first, and a network hiccup on a setup question is not a reason to
   withhold them. */
ok('a failed save still lets the user into the app',
  /\.catch\(function \(\) \{[\s\S]{0,140}?resolve\(enterApp\(user\)\)/.test(js));

// ---------------------------------------------------------------------------
// 4 · The options are the ones a school actually has
// ---------------------------------------------------------------------------
const years = ['7', '8', '9', '10', '11', '12'];
for (const y of years) {
  ok('Year ' + y + ' is offered', new RegExp('<option value="' + y + '">Year ' + y + '</option>').test(html));
}
ok('"Finished school" is offered, so leaving school is not a dead end',
  /<option value="finished">/.test(html));
ok('Years 7-10 are included — the floor that excluded them is gone',
  years.slice(0, 4).every(y => new RegExp('value="' + y + '"').test(html)));

const listed = js.match(/var SCHOOL_YEARS\s*=\s*\[([^\]]*)\]/);
ok('app.js and the markup agree on the set of years', !!listed &&
  years.every(y => listed[1].includes("'" + y + "'")) && listed[1].includes("'finished'"));

// ---------------------------------------------------------------------------
// 5 · The answer has to DO something, or the question should not be asked
// ---------------------------------------------------------------------------
/* This is the integrity check on the whole feature. legal.html and the dialog both
   tell the student their year is used to read the syllabus against the right
   course. For a while it was not used for anything at all — collected, stored, and
   consumed nowhere — which made both of those statements false. A policy that
   describes a feature the app does not have is the exact failure this project has
   had before: legal.html called AI "a future feature" two days after AI marking
   shipped. If the year stops being used, the question has to go. */
ok('the year reaches state.account, where the rest of the app can see it',
  /schoolYear: meta\.school_year/.test(js));

ok('the syllabus dialog reads it', /function syllabusYear\(\)/.test(js) &&
  (js.match(/syllabusYear\(\)/g) || []).length >= 2);

ok('the syllabus heading names the year',
  /sylSubject'\)\.textContent = subj\.name \+ \(yr \?/.test(js));

/* The worked example is rewritten from the ORIGINAL each time, kept in
   data-placeholder. Substituting in place would compound: 11 -> 12 -> 9 would
   leave a Year 9 student looking at whatever the last two edits produced. */
ok('the placeholder is rewritten from a stored original, not edited in place',
  /data-placeholder/.test(js) && /ph\.replace\(\/-11-\/g/.test(js));

ok('"finished" and "skipped" do not rewrite the example',
  /y !== 'skipped' && y !== 'finished'/.test(js));

// ---------------------------------------------------------------------------
// 6 · Changeable, because students move up a year
// ---------------------------------------------------------------------------
ok('Settings has a school-year control', /id="setSchoolYear"/.test(html));
ok('it is a real label, not a placeholder',
  /<label class="setlabel" for="setSchoolYear">/.test(html));
ok('changing it saves', /\$\('setSchoolYear'\)\.addEventListener\('change'/.test(js));
/* A control showing a value that was never saved is worse than one that fails
   loudly, so a failed write puts the previous value back. */
ok('a failed save reverts the control instead of lying', /box\.value = previous/.test(js));


console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
