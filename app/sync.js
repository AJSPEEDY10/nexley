/* Nexley — sync layer.
 *
 * IndexedDB stays the source of truth for the UI at all times (offline-first,
 * hard requirement — the iPad has no reliable Wi-Fi). This module pushes local
 * changes up and pulls remote changes down in the background; it never blocks
 * a read or a save. Conflict rule: newest `updated` wins, same rule already used
 * by import/export merge — see app.js `mergeImport`.
 *
 * Local <-> remote field mapping:
 *   subjects:  id, name, code, colour->color, created->created_at, updated->updated_at,
 *              rev, device, deleted
 *   syllabus:  id, subjectId->subject_id, parentId->parent_id, title, code,
 *              order->sort_order, created->created_at, updated->updated_at, rev, device, deleted
 *   notes:     id, subjectId->subject_id, syllabusId->syllabus_id, kind, title, body, font,
 *              created->created_at, updated->updated_at, rev, device, deleted
 */
(function () {
  'use strict';

  // Per user: two accounts on one browser must not share a pull watermark, or the
  // second one starts from the first one's timestamp and silently misses every row
  // written before it.
  function pullKey(userId) { return 'lastPullAt:' + userId; }
  var syncing = false;
  var pending = false;

  function client() { return window.NexleyAuth.client; }

  function toRemoteSubject(s, userId) {
    return {
      id: s.id, user_id: userId, name: s.name, code: s.code || null, color: s.colour || null,
      created_at: new Date(s.created).toISOString(), updated_at: new Date(s.updated).toISOString(),
      rev: s.rev || 1, device: s.device || null, deleted: !!s.deleted
    };
  }
  function toRemoteSyllabus(n, userId) {
    return {
      id: n.id, user_id: userId, subject_id: n.subjectId, parent_id: n.parentId || null,
      title: n.title, code: n.code || null, sort_order: n.order || 0,
      created_at: new Date(n.created).toISOString(), updated_at: new Date(n.updated).toISOString(),
      rev: n.rev || 1, device: n.device || null, deleted: !!n.deleted
    };
  }
  function toRemoteNote(n, userId) {
    return {
      id: n.id, user_id: userId, subject_id: n.subjectId, syllabus_id: n.syllabusId || null,
      kind: n.kind || 'personal', title: n.title || '', body: n.body || '', font: n.font || 'standard',
      created_at: new Date(n.created).toISOString(), updated_at: new Date(n.updated).toISOString(),
      rev: n.rev || 1, device: n.device || null, deleted: !!n.deleted
    };
  }

  function fromRemoteSubject(r) {
    return {
      id: r.id, name: r.name, code: r.code, colour: r.color,
      created: Date.parse(r.created_at), updated: Date.parse(r.updated_at),
      rev: r.rev, device: r.device, deleted: r.deleted || null
    };
  }
  function fromRemoteSyllabus(r) {
    return {
      id: r.id, subjectId: r.subject_id, parentId: r.parent_id, title: r.title, code: r.code,
      order: r.sort_order, created: Date.parse(r.created_at), updated: Date.parse(r.updated_at),
      rev: r.rev, device: r.device, deleted: r.deleted || null
    };
  }
  function fromRemoteNote(r) {
    return {
      id: r.id, subjectId: r.subject_id, syllabusId: r.syllabus_id, kind: r.kind,
      title: r.title, body: r.body, font: r.font,
      created: Date.parse(r.created_at), updated: Date.parse(r.updated_at),
      rev: r.rev, device: r.device, deleted: r.deleted || null
    };
  }

  // records only get pushed once their local rev is newer than what we last pushed —
  // tracked per-record via a `pushedRev` shadow field so re-running sync is idempotent.
  function needsPush(rec) { return (rec.pushedRev || 0) < (rec.rev || 1); }

  function pushTable(store, mapFn, remoteTable, userId) {
    return window.NexleyDB.all(store).then(function (recs) {
      var dirty = recs.filter(needsPush);
      if (!dirty.length) return;
      var rows = dirty.map(function (r) { return mapFn(r, userId); });
      return client().from(remoteTable).upsert(rows).then(function (res) {
        if (res.error) throw res.error;
        return Promise.all(dirty.map(function (r) {
          r.pushedRev = r.rev;
          return window.NexleyDB.put(store, r);
        }));
      });
    });
  }

  function pullTable(store, mapFn, remoteTable, userId, since) {
    var q = client().from(remoteTable).select('*').eq('user_id', userId);
    if (since) q = q.gt('updated_at', since);
    return q.then(function (res) {
      if (res.error) throw res.error;
      return Promise.all((res.data || []).map(function (row) {
        var incoming = mapFn(row);
        return window.NexleyDB.get(store, incoming.id).then(function (local) {
          // newest `updated` wins; a local edit made while offline beats a stale pull
          if (local && local.updated >= incoming.updated) return 0;
          incoming.pushedRev = incoming.rev; // just pulled, so it's already in sync
          return window.NexleyDB.put(store, incoming).then(function () { return 1; });
        });
      })).then(function (writes) {
        return writes.reduce(function (a, b) { return a + b; }, 0);
      });
    });
  }

  /* Resolves with {ok, pulled}. `ok` says a full round trip actually completed —
     app.js needs that to tell "brand new account, seed it" apart from "returning
     user whose pull hasn't landed yet", which is the difference between a welcome
     note and a duplicate of somebody's real notebook. `pulled` is the number of
     records written from remote, so the UI knows whether it's worth repainting. */
  function runSync() {
    if (syncing) { pending = true; return Promise.resolve({ ok: false, pulled: 0 }); }
    if (!navigator.onLine) return Promise.resolve({ ok: false, pulled: 0 });
    syncing = true;
    var pulled = 0;
    var ok = false;
    return window.NexleyAuth.getSession().then(function (session) {
      if (!session) return;
      var userId = session.user.id;
      var since = localStorage.getItem(pullKey(userId));
      var count = function (n) { pulled += (n || 0); };
      return pushTable('subjects', toRemoteSubject, 'subjects', userId)
        .then(function () { return pushTable('syllabus', toRemoteSyllabus, 'syllabus', userId); })
        .then(function () { return pushTable('notes', toRemoteNote, 'notes', userId); })
        .then(function () { return pullTable('subjects', fromRemoteSubject, 'subjects', userId, since).then(count); })
        .then(function () { return pullTable('syllabus', fromRemoteSyllabus, 'syllabus', userId, since).then(count); })
        .then(function () { return pullTable('notes', fromRemoteNote, 'notes', userId, since).then(count); })
        .then(function () {
          localStorage.setItem(pullKey(userId), new Date().toISOString());
          ok = true;
        });
    }).catch(function (err) {
      console.warn('[sync] failed, will retry next trigger', err);
    }).then(function () {
      syncing = false;
      // a pull that changed nothing on screen is not worth a repaint
      if (pulled) {
        window.dispatchEvent(new CustomEvent('nexley-sync-pulled', { detail: { pulled: pulled } }));
      }
      if (pending) { pending = false; return runSync(); }
      return { ok: ok, pulled: pulled };
    });
  }

  window.NexleySync = { run: runSync };

  window.addEventListener('online', runSync);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') runSync();
  });
  window.addEventListener('pagehide', runSync);
  setInterval(runSync, 5 * 60 * 1000);
})();
