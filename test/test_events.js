/* The two lists that must never disagree.

   An analytics event lives in two places: ALLOWED in app/analytics.js, and the
   `events_name_known` CHECK constraint in the migrations. Add it to one and not
   the other and you get a silent failure in whichever direction you missed —
   either the client drops the event before sending, or the database rejects the
   insert and the batch never lands. Neither shows up in the UI.

   The HANDOVER has claimed for a while that "a test asserts the two lists
   match". Until now that was only a comment. This is the test. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const analytics = fs.readFileSync(path.join(root, 'app', 'analytics.js'), 'utf8');
const migDir = path.join(root, 'supabase', 'migrations');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  — ' + detail : '')); }
}

/* ---------- what the client will send ---------- */
const allowedBlock = analytics.slice(
  analytics.indexOf('var ALLOWED = {'),
  analytics.indexOf('};', analytics.indexOf('var ALLOWED = {'))
);
const clientEvents = (allowedBlock.match(/^\s{4}([a-z_]+):/gm) || [])
  .map(l => l.trim().replace(':', ''));

/* ---------- what the database will accept ----------
   The live constraint is the LAST one defined across the migrations, since a
   later migration drops and replaces it. Read them in order and keep the last. */
const migrations = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();
let dbEvents = null, definedIn = null;
migrations.forEach(function (file) {
  const sql = fs.readFileSync(path.join(migDir, file), 'utf8');
  const idx = sql.lastIndexOf('events_name_known');
  if (idx < 0) return;
  const open = sql.indexOf('(', sql.indexOf('name in', idx));
  const close = sql.indexOf(')', open);
  // strip line comments FIRST — the list is commented by version, and a comment
  // sitting between two commas otherwise swallows the name that follows it
  const names = sql.slice(open + 1, close)
    .split(String.fromCharCode(10))
    .map(l => l.replace(/--.*$/, ''))
    .join(' ')
    .split(',')
    .map(x => x.trim().replace(/^'|'$/g, '').trim())
    .filter(x => /^[a-z_]+$/.test(x));
  if (names.length) { dbEvents = names; definedIn = file; }
});

console.log('\n1. Both lists were actually found');
ok('ALLOWED parsed out of analytics.js', clientEvents.length > 5, String(clientEvents.length));
ok('the constraint parsed out of a migration', !!dbEvents && dbEvents.length > 5,
   dbEvents ? String(dbEvents.length) : 'none');
console.log('     (constraint last defined in ' + definedIn + ')');

console.log('\n2. THE RULE — the two lists agree');
/* An event the client sends that the database rejects fails the whole batch, so
   one missing name can lose every other event queued with it. */
const missingInDb = clientEvents.filter(e => dbEvents.indexOf(e) === -1);
ok('every client event is accepted by the database', missingInDb.length === 0,
   missingInDb.join(', '));
/* The other direction is harmless at runtime but means a name was added to the
   schema and then never wired up — dead surface that reads as coverage. */
const missingInClient = dbEvents.filter(e => clientEvents.indexOf(e) === -1);
ok('every database event is one the client can actually send', missingInClient.length === 0,
   missingInClient.join(', '));

console.log('\n3. Every declared event is actually fired somewhere');
/* An event nobody emits is worse than no event: it looks like measurement in a
   diff, and its absence in the data reads as "nobody used the feature". */
const appJs = fs.readFileSync(path.join(root, 'app', 'app.js'), 'utf8');
const errorsJs = fs.readFileSync(path.join(root, 'app', 'errors.js'), 'utf8');
const authJs = fs.readFileSync(path.join(root, 'app', 'auth.js'), 'utf8');
const src = appJs + errorsJs + authJs;
clientEvents.forEach(function (name) {
  ok('"' + name + '" is emitted', src.indexOf("'" + name + "'") > -1);
});

console.log('\n4. No event carries anything a student wrote');
/* Structural, not a promise: property values are counts or short enums only.
   A free string here would be the one way note content could escape. */
const propStrings = allowedBlock.match(/'[^']*'/g) || [];
const suspicious = propStrings.filter(s => s.length > 22 || /\s{2,}/.test(s));
ok('no long or prose-shaped enum values', suspicious.length === 0, suspicious.join(' '));
ok('no event declares a free-text property',
   !/:\s*'(text|string|free|note|body|title)'/.test(allowedBlock));

console.log('\n==============================================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
