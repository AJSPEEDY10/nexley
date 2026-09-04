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
 *   papers:    id, subjectId->subject_id, title, sat->sat_at, conditions,
 *              mark, outOf->out_of, weight->weight_pct, reflection, questions,
 *              created->created_at, updated->updated_at, rev, device, deleted
 *   feedback:  id, kind, body, status, reply, appVersion->app_version,
 *              created->created_at, updated->updated_at, rev, device, deleted
 *              (push is INSERT-only — see syncFeedback)
 *   cards:     id, subjectId->subject_id, syllabusId->syllabus_id, noteId->note_id,
 *              front, back, ease, interval->interval_days, reps, lapses,
 *              due->due_at, lastReviewed->last_reviewed_at,
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

  /* Sync state is REPORTED, not swallowed.
     This module used to answer a total failure with console.warn and ok:false, and
     nothing upstream looked at either. That is how sync managed to be completely
     broken in production from the first deploy to 2026-09-03 without one visible
     symptom: every push and pull was returning 42501 permission denied, the app
     said nothing, and the welcome note went on promising that notes reach your
     account. An offline-first app is allowed to be behind. It is not allowed to be
     silently wrong about whether your work exists anywhere but this device. */
  var status = { state: 'idle', at: 0, error: null, lastOkAt: 0, fails: 0 };
  function setStatus(next) {
    status.state = next.state;
    status.at = Date.now();
    status.error = next.error || null;
    if (next.state === 'ok') { status.lastOkAt = status.at; status.fails = 0; }
    if (next.state === 'error') status.fails++;
    try {
      window.dispatchEvent(new CustomEvent('nexley-sync-state', { detail: describe() }));
    } catch (e) {}
  }
  function describe() {
    return {
      state: status.state, at: status.at, lastOkAt: status.lastOkAt,
      fails: status.fails, error: status.error
    };
  }

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

  function toRemoteCard(c, userId) {
    return {
      id: c.id, user_id: userId, subject_id: c.subjectId || null,
      syllabus_id: c.syllabusId || null, note_id: c.noteId || null,
      front: c.front || '', back: c.back || '',
      ease: c.ease || 2.5, interval_days: c.interval || 0,
      reps: c.reps || 0, lapses: c.lapses || 0,
      due_at: new Date(c.due || Date.now()).toISOString(),
      last_reviewed_at: c.lastReviewed ? new Date(c.lastReviewed).toISOString() : null,
      created_at: new Date(c.created).toISOString(), updated_at: new Date(c.updated).toISOString(),
      rev: c.rev || 1, device: c.device || null, deleted: !!c.deleted
    };
  }

  function toRemotePaper(p, userId) {
    return {
      id: p.id, user_id: userId, subject_id: p.subjectId || null,
      title: p.title || '', sat_at: new Date(p.sat).toISOString(),
      conditions: p.conditions, mark: p.mark, out_of: p.outOf,
      weight_pct: (p.weight === null || p.weight === undefined) ? null : p.weight,
      reflection: p.reflection || null,
      questions: p.questions || [],
      created_at: new Date(p.created).toISOString(), updated_at: new Date(p.updated).toISOString(),
      rev: p.rev || 1, device: p.device || null, deleted: !!p.deleted
    };
  }

  function toRemoteFeedback(f, userId) {
    return {
      id: f.id, user_id: userId, kind: f.kind, body: f.body || '',
      app_version: f.appVersion || null,
      created_at: new Date(f.created).toISOString(), updated_at: new Date(f.updated).toISOString(),
      rev: f.rev || 1, device: f.device || null, deleted: !!f.deleted
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

  function fromRemoteCard(r) {
    return {
      id: r.id, subjectId: r.subject_id, syllabusId: r.syllabus_id, noteId: r.note_id,
      front: r.front, back: r.back,
      ease: r.ease, interval: r.interval_days, reps: r.reps, lapses: r.lapses,
      due: Date.parse(r.due_at),
      lastReviewed: r.last_reviewed_at ? Date.parse(r.last_reviewed_at) : null,
      created: Date.parse(r.created_at), updated: Date.parse(r.updated_at),
      rev: r.rev, device: r.device, deleted: r.deleted || null
    };
  }

  /* Numerics come back from PostgREST as strings, so mark/out_of are parsed here
     rather than at every call site. A mark that failed to parse would render as
     NaN% and quietly corrupt an average, so it is worth doing once, centrally. */
  function fromRemotePaper(r) {
    return {
      id: r.id, subjectId: r.subject_id, title: r.title,
      sat: Date.parse(r.sat_at), conditions: r.conditions,
      mark: parseFloat(r.mark), outOf: parseFloat(r.out_of),
      weight: (r.weight_pct === null || r.weight_pct === undefined) ? null : parseFloat(r.weight_pct),
      // a paper written by 0.15.0 has no questions key at all
      reflection: r.reflection || null,
      questions: r.questions || [],
      created: Date.parse(r.created_at), updated: Date.parse(r.updated_at),
      rev: r.rev, device: r.device, deleted: r.deleted || null
    };
  }

  /* status and reply are NOT sent — they are the server's to set, and the table
     grants the client no UPDATE at all (see migration 0008). What comes back down
     is therefore always Alec's answer, never an echo of something the device
     decided for itself. */
  function fromRemoteFeedback(r) {
    return {
      id: r.id, kind: r.kind, body: r.body, status: r.status, reply: r.reply || null,
      appVersion: r.app_version,
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

  /* `cards` landed in app 0.10.0 but its table arrives in a separate hand-applied
     migration (0005). Until that migration is run, PostgREST answers every cards
     request with PGRST205 / 42P01 "relation does not exist" — and because push and
     pull are chained, an unhandled rejection there would take subjects, syllabus and
     notes down with it. So cards are isolated: a missing table is noted once and
     skipped for the session, and crucially the local records keep their existing
     pushedRev, so nothing is marked as sent. The moment the table exists they push
     normally on the next sync. Any OTHER error is left to propagate — a real failure
     must not look like a missing table (see HANDOVER trap 9). */
  var cardsTableMissing = false;
  function isMissingTable(err) {
    var code = err && err.code;
    var msg = String((err && err.message) || '');
    return code === 'PGRST205' || code === '42P01' ||
           /does not exist|schema cache/i.test(msg);
  }
  function syncCards(userId, since, count) {
    if (cardsTableMissing) return Promise.resolve();
    return pushTable('cards', toRemoteCard, 'cards', userId)
      .then(function () { return pullTable('cards', fromRemoteCard, 'cards', userId, since).then(count); })
      .catch(function (err) {
        if (!isMissingTable(err)) throw err;
        cardsTableMissing = true;
        console.warn('[sync] cards table not present yet — skipping until migration 0005 is applied');
      });
  }

  /* Feedback pushes with a plain INSERT, not the usual upsert.
     Migration 0008 grants the client INSERT and SELECT only, deliberately: with no
     UPDATE grant, nobody can rewrite a piece of feedback after sending it or mark
     their own idea "shipped". Postgres requires UPDATE privilege to PLAN an
     `insert ... on conflict do update`, so an upsert here would fail on every row
     even when nothing conflicts. Hence the split: insert what has never been sent,
     and let the pull bring the status and reply back down.

     A row is "never sent" when it has no pushedRev. There is no re-push path,
     because there is nothing local that can legitimately change. */
  var papersTableMissing = false;
  function syncPapers(userId, since, count) {
    if (papersTableMissing) return Promise.resolve();
    return pushTable('papers', toRemotePaper, 'papers', userId)
      .then(function () { return pullTable('papers', fromRemotePaper, 'papers', userId, since).then(count); })
      .catch(function (err) {
        if (!isMissingTable(err)) throw err;
        papersTableMissing = true;
        console.warn('[sync] papers table not present yet — skipping until migration 0009 is applied');
      });
  }

  var feedbackTableMissing = false;
  function pushFeedback(userId) {
    return window.NexleyDB.all('feedback').then(function (recs) {
      var fresh = recs.filter(function (r) { return !r.pushedRev; });
      if (!fresh.length) return;
      var rows = fresh.map(function (r) { return toRemoteFeedback(r, userId); });
      return client().from('feedback').insert(rows).then(function (res) {
        if (res.error) throw res.error;
        return Promise.all(fresh.map(function (r) {
          r.pushedRev = r.rev;
          return window.NexleyDB.put('feedback', r);
        }));
      });
    });
  }

  function syncFeedback(userId, since, count) {
    if (feedbackTableMissing) return Promise.resolve();
    return pushFeedback(userId)
      .then(function () { return pullTable('feedback', fromRemoteFeedback, 'feedback', userId, since).then(count); })
      .catch(function (err) {
        // same isolation as cards: a table that hasn't been migrated yet must not
        // take notes and subjects down with it. Any OTHER error still propagates.
        if (!isMissingTable(err)) throw err;
        feedbackTableMissing = true;
        console.warn('[sync] feedback table not present yet — skipping until migration 0008 is applied');
      });
  }

  /* Resolves with {ok, pulled}. `ok` says a full round trip actually completed —
     app.js needs that to tell "brand new account, seed it" apart from "returning
     user whose pull hasn't landed yet", which is the difference between a welcome
     note and a duplicate of somebody's real notebook. `pulled` is the number of
     records written from remote, so the UI knows whether it's worth repainting. */
  function runSync() {
    if (syncing) { pending = true; return Promise.resolve({ ok: false, pulled: 0 }); }
    if (!navigator.onLine) {
      setStatus({ state: 'offline' });
      return Promise.resolve({ ok: false, pulled: 0 });
    }
    syncing = true;
    var pulled = 0;
    var ok = false;
    return window.NexleyAuth.getSession().then(function (session) {
      if (!session) { setStatus({ state: 'signedout' }); return; }
      var userId = session.user.id;
      var since = localStorage.getItem(pullKey(userId));
      var count = function (n) { pulled += (n || 0); };
      return pushTable('subjects', toRemoteSubject, 'subjects', userId)
        .then(function () { return pushTable('syllabus', toRemoteSyllabus, 'syllabus', userId); })
        .then(function () { return pushTable('notes', toRemoteNote, 'notes', userId); })
        .then(function () { return pullTable('subjects', fromRemoteSubject, 'subjects', userId, since).then(count); })
        .then(function () { return pullTable('syllabus', fromRemoteSyllabus, 'syllabus', userId, since).then(count); })
        .then(function () { return pullTable('notes', fromRemoteNote, 'notes', userId, since).then(count); })
        .then(function () { return syncCards(userId, since, count); })
        .then(function () { return syncPapers(userId, since, count); })
        .then(function () { return syncFeedback(userId, since, count); })
        .then(function () {
          localStorage.setItem(pullKey(userId), new Date().toISOString());
          ok = true;
          setStatus({ state: 'ok' });
        });
    }).catch(function (err) {
      console.warn('[sync] failed, will retry next trigger', err);
      // The message is shown to the user, so it must name the fault without
      // quoting anything they wrote. Postgres error codes are safe; note text
      // never reaches here (only ids and timestamps travel in these queries).
      setStatus({
        state: 'error',
        error: {
          code: (err && err.code) || null,
          message: (err && err.message) || 'Sync failed',
          hint: (err && err.hint) || null
        }
      });
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

  window.NexleySync = { run: runSync, status: describe };

  window.addEventListener('online', runSync);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') runSync();
  });
  window.addEventListener('pagehide', runSync);
  setInterval(runSync, 5 * 60 * 1000);
})();
