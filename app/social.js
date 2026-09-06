/* Nexley — the only part of the app that talks to other people.
 *
 * EVERYTHING ELSE IN NEXLEY IS OFFLINE-FIRST. IndexedDB is the source of
 * truth, the network is an afterthought, and every feature works on a train.
 * This file is the exception, and it is worth being explicit about why rather
 * than letting it look like an oversight:
 *
 *   A note you shared is not yours any more, and a comp is a thing several
 *   people are inside at once. Neither has a meaningful local-first version.
 *   Caching an inbox would mean holding someone else's writing on this device
 *   after they revoked it, and caching a comp would mean showing scores that
 *   have since changed. So these read live, they fail honestly when there is
 *   no signal, and nothing here is written into the notebook's own stores.
 *
 * The one deliberate crossing: a note you RECEIVE and choose to keep becomes a
 * normal note in your notebook, at which point it is yours, offline, and has
 * nothing further to do with this file.
 *
 * WHAT THE SERVER WILL NOT LET THIS FILE DO, no matter what it asks:
 *   - list users (profiles is select-own; there is no query that returns a
 *     directory, which is why finding someone goes through an RPC)
 *   - read a share it is not a party to
 *   - read a comp it has not joined, or find one by trying codes
 *   - edit a shared note after sending it (a trigger refuses)
 * See supabase/migrations/0016-0018. The rules live there, in the database,
 * not here — this file is a caller, and a caller can always be replaced by
 * somebody's devtools console.
 */
(function () {
  'use strict';

  function client() { return window.NexleyAuth && window.NexleyAuth.client; }

  function offline() {
    return !navigator.onLine;
  }

  /* One shape for every failure so the UI never has to know whether a problem
     came from the network, PostgREST or a raise inside a function. `.message`
     is safe to show a student: the database's own messages here are written
     for exactly that ("that username is taken", "no comp with that code"). */
  function fail(e) {
    var msg = (e && (e.message || e.error_description || e.error)) || 'that did not work';
    return Promise.reject(new Error(String(msg)));
  }

  function need() {
    if (offline()) return Promise.reject(new Error('This needs the internet. The rest of Nexley does not.'));
    if (!client()) return Promise.reject(new Error('Not signed in.'));
    return null;
  }

  /* ---------- who you are ---------- */

  /* The row exists for everyone — 0001's signup trigger makes one — so a null
     username means "has not chosen yet", never "no profile". */
  function myProfile() {
    var no = need(); if (no) return no;
    return client().auth.getUser().then(function (u) {
      var id = u && u.data && u.data.user && u.data.user.id;
      if (!id) return null;
      return client().from('profiles').select('id, username, name').eq('id', id).maybeSingle()
        .then(function (r) {
          if (r.error) return fail(r.error);
          return r.data || null;
        });
    });
  }

  /* Availability cannot be checked separately: profiles is select-own, so a
     client asking "is `sam` free?" gets nothing back whether it is free or
     taken. The check and the claim therefore happen together, inside
     claim_username, and a refusal arrives as an error message. */
  function claimUsername(name) {
    var no = need(); if (no) return no;
    return client().rpc('claim_username', { p_username: String(name || '').toLowerCase().trim() })
      .then(function (r) { return r.error ? fail(r.error) : r.data; });
  }

  function findUser(username) {
    var no = need(); if (no) return no;
    return client().rpc('find_user_by_username', { p_username: String(username || '').toLowerCase().trim() })
      .then(function (r) {
        if (r.error) return fail(r.error);
        var rows = r.data || [];
        return rows.length ? rows[0] : null;
      });
  }

  /* ---------- sending a note ---------- */

  /* Takes the note's CONTENT, not the note. The caller flattens it first, so
     that what crosses the wire is visible at the call site and nobody can
     accidentally hand this function a whole record with ids, revisions and
     sync state attached. */
  function shareNote(to, content) {
    var no = need(); if (no) return no;
    return client().auth.getUser().then(function (u) {
      var me = u && u.data && u.data.user;
      if (!me) return fail(new Error('Not signed in.'));
      if (me.id === to.user_id) return fail(new Error('That is you.'));
      return client().from('note_shares').insert({
        id: content.id,
        from_user: me.id,
        to_user: to.user_id,
        from_username: content.fromUsername,
        title: content.title || null,
        body: content.body,
        subject_name: content.subjectName || null,
        syllabus_code: content.syllabusCode || null,
        syllabus_title: content.syllabusTitle || null,
        device: content.device || null
      }).then(function (r) { return r.error ? fail(r.error) : true; });
    });
  }

  /* Both directions come from the same table and the same policy — you see a
     row if you are one of its two parties — so "sent" and "received" is a
     client-side split of one query rather than two different permissions. */
  function shares() {
    var no = need(); if (no) return no;
    return client().auth.getUser().then(function (u) {
      var me = u && u.data && u.data.user;
      if (!me) return { received: [], sent: [] };
      return client().from('note_shares').select('*').eq('deleted', false)
        .order('created_at', { ascending: false })
        .then(function (r) {
          if (r.error) return fail(r.error);
          var rows = r.data || [];
          return {
            received: rows.filter(function (x) { return x.to_user === me.id; }),
            sent: rows.filter(function (x) { return x.from_user === me.id; })
          };
        });
    });
  }

  /* Tombstone, not delete — the recipient's next read has to learn it is gone
     rather than keep showing a row that no longer exists anywhere. */
  function revokeShare(id) {
    var no = need(); if (no) return no;
    return client().from('note_shares').update({ deleted: true }).eq('id', id)
      .then(function (r) { return r.error ? fail(r.error) : true; });
  }

  /* ---------- comps ---------- */

  /* No O/0 or I/1: this gets read aloud and typed by somebody else, and an
     ambiguous code is a support problem rather than a puzzle. Generated on the
     client and unique-checked by the database, which is the right way round —
     a collision is a failed insert to retry, not something to prevent by
     asking the server for a code it then has to remember it issued. */
  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function newCode() {
    var out = '';
    var bytes = new Uint8Array(6);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    for (var i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
  }

  function createComp(comp) {
    var no = need(); if (no) return no;
    return client().auth.getUser().then(function (u) {
      var me = u && u.data && u.data.user;
      if (!me) return fail(new Error('Not signed in.'));
      var row = {
        id: comp.id,
        owner_user: me.id,
        owner_username: comp.ownerUsername,
        title: comp.title,
        subject_name: comp.subjectName || null,
        questions: comp.questions || [],
        out_of: comp.outOf,
        join_code: comp.code || newCode(),
        closes_at: comp.closesAt || null,
        device: comp.device || null
      };
      return client().from('comps').insert(row)
        .then(function (r) { return r.error ? fail(r.error) : row; });
    });
  }

  /* The owner is a participant too. Without this a comp you made shows you no
     entry to submit against, which reads as the feature being broken. */
  function joinComp(code, entryId, username) {
    var no = need(); if (no) return no;
    return client().rpc('join_comp', {
      p_code: String(code || '').toUpperCase().trim(),
      p_entry_id: entryId,
      p_username: username
    }).then(function (r) { return r.error ? fail(r.error) : r.data; });
  }

  function myComps() {
    var no = need(); if (no) return no;
    return client().from('comps').select('*').eq('deleted', false)
      .order('created_at', { ascending: false })
      .then(function (r) { return r.error ? fail(r.error) : (r.data || []); });
  }

  /* One comp and everyone in it. Two queries rather than a join because the
     policies are different objects — a failure to read entries should not look
     like a failure to read the comp. */
  function compDetail(compId) {
    var no = need(); if (no) return no;
    return Promise.all([
      client().from('comps').select('*').eq('id', compId).maybeSingle(),
      client().from('comp_entries').select('*').eq('comp_id', compId).eq('deleted', false)
    ]).then(function (rs) {
      if (rs[0].error) return fail(rs[0].error);
      if (rs[1].error) return fail(rs[1].error);
      var entries = (rs[1].data || []).slice().sort(function (a, b) {
        /* Unsubmitted last, always. A null score is "still sitting it", and
           sorting it as a zero would put someone who has not started below
           someone who scored nothing — the same rule the term planner follows
           for unestimated work. */
        if (a.score === null && b.score === null) return a.username < b.username ? -1 : 1;
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        return b.score - a.score;
      });
      return { comp: rs[0].data || null, entries: entries };
    });
  }

  function submitScore(entryId, score) {
    var no = need(); if (no) return no;
    return client().from('comp_entries')
      .update({ score: score, submitted_at: new Date().toISOString() })
      .eq('id', entryId)
      .then(function (r) { return r.error ? fail(r.error) : true; });
  }

  window.NexleySocial = {
    myProfile: myProfile,
    claimUsername: claimUsername,
    findUser: findUser,
    shareNote: shareNote,
    shares: shares,
    revokeShare: revokeShare,
    createComp: createComp,
    joinComp: joinComp,
    myComps: myComps,
    compDetail: compDetail,
    submitScore: submitScore,
    newCode: newCode
  };
})();
