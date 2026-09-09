/* Nothing a student wrote can be silently dropped by backup, restore, export or import.

   THIS IS THE WORST FAILURE MODE THIS APP HAS. Every other bug is an annoyance;
   losing a term of notes is the thing that ends the product. And the way it
   happens is not dramatic — it is a new store being added and one of its homes
   being missed, which loses data only later, only for people who actually use the
   restore, and with no error at any point.

   HANDOVER trap 10 records it happening: "A new store has FIVE homes, not one.
   Adding `papers` needed the IndexedDB migration, refresh(), snapshot(),
   restore(), exportAll() and the import merge. Miss snapshot()/restore() and a
   restore silently wipes the new store." That was live in the working tree for
   about twenty minutes on 2026-09-04 before a browser pass caught it. A browser
   pass catches it only if someone thinks to look; this does not need anyone to
   think of it.

   THE RULE. Every object store is either handled by ALL FOUR of snapshot,
   restore, exportAll and the import merge, or it is on the exclusion list below
   with a stated reason. There is deliberately no third option, because "I'll
   remember to add it later" is exactly the state this file exists to make
   impossible. */
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..', 'app');
const js = fs.readFileSync(path.join(appDir, 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\ndurability\n');

/* Stores that are deliberately NOT user work. Each needs a reason, because an
   undocumented exclusion is indistinguishable from a forgotten one. */
const EXCLUDED = {
  meta: 'settings and the sync cursor. Restoring a stale cursor would make the app ' +
        'think it had already pulled changes it has not, which loses MORE than it saves.',
  feedback: 'posts to the feedback board and their replies. The server is authoritative ' +
            'for these and they are support correspondence, not the student\'s own work; ' +
            'they come back on the next sync.'
};

/* `backups` is not excluded content — it is the MEDIUM. snapshot() writes into it
   and restore() reads out of it, so of course both name it; that is the mechanism
   working, not a store being backed up. What would be wrong is exporting or
   importing it: a student's export should carry their notes, not a nested pile of
   old copies of them. So it gets its own rule rather than a blanket one. */
const MEDIUM = 'backups';

// ---------------------------------------------------------------------------
// 1 · Every store the database actually creates
// ---------------------------------------------------------------------------
const stores = [...js.matchAll(/createObjectStore\(\s*'([a-zA-Z0-9_]+)'/g)].map(m => m[1]);
const unique = [...new Set(stores)];
ok('found the object stores', unique.length >= 8, unique.join(', '));

// ---------------------------------------------------------------------------
// 2 · The four functions that must know about each of them
// ---------------------------------------------------------------------------
function bodyOf(name, startPat) {
  const at = js.indexOf(startPat);
  if (at === -1) return null;
  let i = js.indexOf('{', at) + 1, depth = 1;
  const start = i;
  while (i < js.length && depth > 0) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}') depth--;
    i++;
  }
  return js.slice(start, i - 1);
}

const HOMES = {
  'snapshot()': bodyOf('snapshot', 'function snapshot('),
  'restore()': bodyOf('restore', 'function restore('),
  'exportAll()': bodyOf('exportAll', 'function exportAll('),
  'the import merge': bodyOf('importFile', 'function importFile(')
};
for (const [name, body] of Object.entries(HOMES)) {
  ok(name + ' was located in app.js', !!body && body.length > 50);
}

// ---------------------------------------------------------------------------
// 3 · The rule itself
// ---------------------------------------------------------------------------
for (const store of unique) {
  if (store === MEDIUM) {
    ok('"' + store + '" is the storage medium — used by snapshot and restore',
      HOMES['snapshot()'].includes("'" + store + "'") &&
      HOMES['restore()'].includes("'" + store + "'"));
    ok('"' + store + '" is NOT exported or imported — an export carries notes, not old copies of them',
      !HOMES['exportAll()'].includes("'" + store + "'") &&
      !HOMES['the import merge'].includes("'" + store + "'"));
    continue;
  }
  if (EXCLUDED[store]) {
    /* Assert the exclusion is real: an excluded store must NOT be quietly half
       handled, because half is the worst of both — it looks covered and is not. */
    const partial = Object.entries(HOMES)
      .filter(([, body]) => body && body.includes("'" + store + "'"))
      .map(([name]) => name);
    ok('"' + store + '" is excluded on purpose and stays fully out',
      partial.length === 0,
      'appears in ' + partial.join(', ') + ' — either handle it everywhere or nowhere');
    continue;
  }
  const missing = Object.entries(HOMES)
    .filter(([, body]) => !body || !body.includes("'" + store + "'"))
    .map(([name]) => name);
  ok('"' + store + '" survives backup, restore, export and import',
    missing.length === 0,
    'NOT handled in: ' + missing.join(', ') + ' — a restore would silently wipe it');
}

// ---------------------------------------------------------------------------
// 4 · The two re-stamping rules, which are subtler than they look
// ---------------------------------------------------------------------------
/* Both were real bugs. Restore wrote records back verbatim, so push (gated on
   pushedRev < rev) never sent them and the server's newer tombstone pulled straight
   back down and deleted them again — the safety net quietly undoing itself. */
ok('restore() re-stamps, so a restored record can actually reach the server',
  HOMES['restore()'] && /stamp\(copy\)/.test(HOMES['restore()']));
ok('restore() drops pushedRev', HOMES['restore()'] && /delete copy\.pushedRev/.test(HOMES['restore()']));

/* Import must drop pushedRev for the same reason, but must NOT re-stamp `updated`:
   that field is what decides which copy is newer, and re-stamping would let an old
   export overwrite newer work on the device. */
ok('the import merge drops pushedRev too',
  HOMES['the import merge'] && /pushedRev/.test(HOMES['the import merge']));
ok('the import merge keeps `updated` so newest-wins still works',
  HOMES['the import merge'] && /updated/.test(HOMES['the import merge']));

/* A restore overwrites everything. Taking a snapshot first is the only thing
   standing between a mistaken restore and the work it replaces. */
ok('restore() snapshots BEFORE it overwrites anything',
  HOMES['restore()'] && /snapshot\('before-restore'\)/.test(HOMES['restore()']));
ok('the import merge snapshots first as well',
  HOMES['the import merge'] && /snapshot\('before-import'\)/.test(HOMES['the import merge']));

/* An import that replaced rather than merged would roll back newer work. */
ok('import merges rather than replaces',
  HOMES['the import merge'] && />=\s*\(rec\.updated/.test(HOMES['the import merge']));

// ---------------------------------------------------------------------------
// 5 · A destructive delete must snapshot FIRST
// ---------------------------------------------------------------------------
/* The confirm dialogs promise the work "can be brought back". That promise was
   FALSE: automatic snapshots run every 20 hours, so the newest one could easily
   predate whatever is being deleted. Proven in a harness — a note was written, its
   subject deleted, and the newest snapshot could not restore it, because it had
   been taken before the note existed. A UI that tells someone their work is
   recoverable and is wrong about it is worse than one that says nothing.

   These check that the snapshot happens before the delete, not that the wording is
   nice. Remove the call and the promise silently becomes a lie again. */
function fnBody(startPat) {
  const at = js.indexOf(startPat);
  if (at === -1) return '';
  let i = js.indexOf('{', at) + 1, depth = 1;
  const start = i;
  while (i < js.length && depth > 0) {
    if (js[i] === '{') depth++;
    else if (js[i] === '}') depth--;
    i++;
  }
  return js.slice(start, i - 1);
}

for (const [fn, pat] of [['deleteNote', 'function deleteNote('],
                         ['deleteSubject', 'function deleteSubject(']]) {
  const body = fnBody(pat);
  const iSnap = body.indexOf("snapshot('before-delete')");
  const iDel = body.indexOf('softDelete(');
  ok(fn + '() takes a snapshot before deleting', iSnap !== -1);
  ok(fn + '() snapshots BEFORE the first softDelete, not after',
    iSnap !== -1 && iDel !== -1 && iSnap < iDel);
  /* A failed snapshot must not trap someone with data they asked to remove — a
     full disk is not a reason to refuse a delete. */
  ok(fn + '() still deletes if the snapshot itself fails',
    body.includes("snapshot('before-delete').catch"));
}

/* A burst of deletes now creates a burst of snapshots. Unprotected, those would
   rotate through the whole budget and push out the only copy of what the notebook
   looked like yesterday — which is the one someone wants when they notice days
   later. */
ok('the newest daily snapshot is protected from rotation',
  fnBody('function snapshot(').includes("b.reason === 'auto'"));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
