/* Nexley (formerly Summit Education)
 *
 * Design rules for this file — the reason it looks the way it does:
 *
 *   1. CODE AND DATA ARE SEPARATE. Updating the app replaces the files in the service
 *      worker cache. It never touches IndexedDB. A deploy cannot delete a note.
 *   2. SCHEMA CHANGES ARE MIGRATIONS, NEVER WIPES. Every version bump adds; nothing is
 *      dropped or rewritten destructively. See migrate().
 *   3. DELETES ARE TOMBSTONES. Records are flagged deleted, not removed, so a future
 *      sync can propagate a deletion instead of resurrecting it.
 *   4. EVERY RECORD IS SYNC-SHAPED FROM DAY ONE — stable id, updated, rev, device.
 *   5. BACKUPS ARE AUTOMATIC. A bad update or a mis-tap is recoverable.
 *   6. A NOTE BELONGS TO A SYLLABUS POINT, not to a pile. Everything later — questions by
 *      topic, revision targeting, mastery — reads from that link, so it exists from here on.
 */

(function () {
  'use strict';

  var APP_VERSION = '0.19.1';
  // errors.js loads before this and stamps crash reports with it
  window.NEXLEY_APP_VERSION = APP_VERSION;
  var DB_NAME = 'nexley';
  var OLD_DB_NAME = 'summit-edu';   // pre-0.4.1 name; contents adopted once on first open
  var DB_VER = 7;
  var BACKUP_KEEP = 7;
  var BACKUP_EVERY = 20 * 60 * 60 * 1000;
  var MAX_TABS = 8;

  var db = null;

  /* ============================================================
     1 · storage
     ============================================================ */
  function migrate(d, txn, from) {
    if (from < 1) {
      d.createObjectStore('meta', { keyPath: 'key' });
      d.createObjectStore('subjects', { keyPath: 'id' });
      var n = d.createObjectStore('notes', { keyPath: 'id' });
      n.createIndex('subjectId', 'subjectId', { unique: false });
      n.createIndex('updated', 'updated', { unique: false });
    }

    if (from < 2) {
      if (!d.objectStoreNames.contains('backups')) d.createObjectStore('backups', { keyPath: 'id' });
      ['notes', 'subjects'].forEach(function (name) {
        if (!d.objectStoreNames.contains(name)) return;
        txn.objectStore(name).openCursor().onsuccess = function (e) {
          var cur = e.target.result;
          if (!cur) return;
          var v = cur.value;
          if (v.deleted === undefined) v.deleted = null;
          if (v.rev === undefined) v.rev = 1;
          if (v.device === undefined) v.device = 'legacy';
          if (v.updated === undefined) v.updated = v.created || Date.now();
          cur.update(v);
          cur.continue();
        };
      });
    }

    if (from < 3) {
      // syllabus: one flat store, parentId gives the hierarchy (topic -> dot point)
      if (!d.objectStoreNames.contains('syllabus')) {
        var s = d.createObjectStore('syllabus', { keyPath: 'id' });
        s.createIndex('subjectId', 'subjectId', { unique: false });
      }
      // existing notes become unfiled personal notes — nothing is lost, nothing is guessed
      if (d.objectStoreNames.contains('notes')) {
        txn.objectStore('notes').openCursor().onsuccess = function (e) {
          var cur = e.target.result;
          if (!cur) return;
          var v = cur.value;
          if (v.syllabusId === undefined) v.syllabusId = null;
          if (v.kind === undefined) v.kind = 'personal';
          cur.update(v);
          cur.continue();
        };
      }
    }

    if (from < 4) {
      // review cards. Sync-shaped like everything else so they ride the same
      // push/pull path the moment the remote table exists (see sync.js).
      if (!d.objectStoreNames.contains('cards')) {
        var c = d.createObjectStore('cards', { keyPath: 'id' });
        c.createIndex('subjectId', 'subjectId', { unique: false });
        c.createIndex('due', 'due', { unique: false });
      }
    }

    if (from < 5) {
      /* Feedback the user has sent, and what came back. Held locally for the same
         reason everything else is: it has to be readable on a train with no signal,
         and something written offline must not be lost waiting for Wi-Fi. */
      if (!d.objectStoreNames.contains('feedback')) {
        d.createObjectStore('feedback', { keyPath: 'id' });
      }
    }

    if (from < 6) {
      // real marks, each carrying the conditions it was sat under
      if (!d.objectStoreNames.contains('papers')) {
        var pp = d.createObjectStore('papers', { keyPath: 'id' });
        pp.createIndex('subjectId', 'subjectId', { unique: false });
        pp.createIndex('sat', 'sat', { unique: false });
      }
    }

    if (from < 7) {
      // what is actually coming, and what it will cost
      if (!d.objectStoreNames.contains('commitments')) {
        var cm = d.createObjectStore('commitments', { keyPath: 'id' });
        cm.createIndex('subjectId', 'subjectId', { unique: false });
        cm.createIndex('due', 'due', { unique: false });
      }
    }
  }

  function open() {
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) { migrate(e.target.result, e.target.transaction, e.oldVersion); };
      req.onsuccess = function () {
        db = req.result;
        adoptOldDb(db).then(function () { res(db); }, function () { res(db); });
      };
      req.onerror = function () { rej(req.error); };
      req.onblocked = function () {
        rej(new Error('Another tab has an older version of Nexley open. Close it and reload.'));
      };
    });
  }

  /* One-time: the local store was renamed 'summit-edu' -> 'nexley' in 0.4.1.
     Copy any records out of the old database on first open so nothing that was
     only ever saved offline is lost. Runs once (guarded by a meta flag); the
     server copy is authoritative once sync runs anyway. */
  function adoptOldDb(newDb) {
    return new Promise(function (done) {
      var STORES = ['meta', 'subjects', 'syllabus', 'notes', 'backups'];
      var check = newDb.transaction('meta', 'readonly').objectStore('meta').get('migratedFrom');
      check.onerror = function () { done(); };
      check.onsuccess = function () {
        if (check.result) return done();                     // already adopted
        var oldReq = indexedDB.open(OLD_DB_NAME);
        oldReq.onerror = function () { mark(); };
        oldReq.onsuccess = function () {
          var oldDb = oldReq.result;
          var have = STORES.filter(function (s) { return oldDb.objectStoreNames.contains(s); });
          if (!have.length) { oldDb.close(); return mark(); }
          var rtx = oldDb.transaction(have, 'readonly');
          var payload = {};
          var pending = have.length;
          have.forEach(function (s) {
            var g = rtx.objectStore(s).getAll();
            g.onsuccess = function () { payload[s] = g.result || []; if (!--pending) writeBack(); };
            g.onerror = function () { payload[s] = []; if (!--pending) writeBack(); };
          });
          function writeBack() {
            oldDb.close();
            var names = Object.keys(payload).filter(function (s) {
              return payload[s].length && newDb.objectStoreNames.contains(s);
            });
            if (!names.length) return mark();
            var wtx = newDb.transaction(names, 'readwrite');
            names.forEach(function (s) {
              payload[s].forEach(function (rec) { try { wtx.objectStore(s).put(rec); } catch (e) {} });
            });
            wtx.oncomplete = mark;
            wtx.onerror = mark;
          }
        };
      };
      function mark() {
        try {
          newDb.transaction('meta', 'readwrite').objectStore('meta')
            .put({ key: 'migratedFrom', value: OLD_DB_NAME, at: Date.now() });
        } catch (e) {}
        done();
      }
    });
  }

  function tx(store, mode) { return db.transaction(store, mode).objectStore(store); }

  function put(store, val) {
    return new Promise(function (res, rej) {
      var r = tx(store, 'readwrite').put(val);
      r.onsuccess = function () { res(val); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function hardDelete(store, key) {
    return new Promise(function (res, rej) {
      var r = tx(store, 'readwrite').delete(key);
      r.onsuccess = function () { res(); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function get(store, key) {
    return new Promise(function (res, rej) {
      var r = tx(store, 'readonly').get(key);
      r.onsuccess = function () { res(r.result || null); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function all(store) {
    return new Promise(function (res, rej) {
      var r = tx(store, 'readonly').getAll();
      r.onsuccess = function () { res(r.result || []); };
      r.onerror = function () { rej(r.error); };
    });
  }

  function stamp(rec) {
    rec.updated = Date.now();
    rec.rev = (rec.rev || 0) + 1;
    rec.device = state.deviceId;
    if (rec.deleted === undefined) rec.deleted = null;
    if (!rec.created) rec.created = rec.updated;
    return rec;
  }
  function softDelete(store, rec) {
    rec.deleted = Date.now();
    return put(store, stamp(rec));
  }
  var live = function (arr) { return arr.filter(function (r) { return !r.deleted; }); };

  /* Analytics is off unless a key is configured (see analytics.js). Wrapped so call
     sites never have to care whether it loaded, and so nothing here can throw into
     a save path. Only the event names in analytics.js ALLOWED are accepted, and note
     content can't travel through it — read that file before adding a call. */
  function track(name, props) {
    try { if (window.NexleyAnalytics) window.NexleyAnalytics.track(name, props); }
    catch (e) {}
  }

  /* ============================================================
     2 · backups
     ============================================================ */
  function snapshot(reason) {
    return Promise.all([all('subjects'), all('notes'), all('syllabus'), all('cards'),
                        all('papers'), all('commitments')]).then(function (r) {
      return put('backups', {
        id: uid(), at: Date.now(), reason: reason || 'auto', appVersion: APP_VERSION,
        subjects: r[0], notes: r[1], syllabus: r[2], cards: r[3], papers: r[4],
        commitments: r[5]
      });
    }).then(function () {
      return all('backups');
    }).then(function (list) {
      list.sort(function (a, b) { return b.at - a.at; });
      return Promise.all(list.slice(BACKUP_KEEP).map(function (b) { return hardDelete('backups', b.id); }));
    });
  }

  function maybeAutoBackup() {
    return all('backups').then(function (list) {
      var newest = list.reduce(function (m, b) { return Math.max(m, b.at); }, 0);
      if (Date.now() - newest < BACKUP_EVERY) return;
      return snapshot('auto');
    }).catch(function () {});
  }

  function restore(backupId) {
    return get('backups', backupId).then(function (b) {
      if (!b) return;
      return snapshot('before-restore').then(function () {
        var jobs = (b.subjects || []).map(function (s) { return put('subjects', s); })
          .concat((b.notes || []).map(function (n) { return put('notes', n); }))
          .concat((b.syllabus || []).map(function (s) { return put('syllabus', s); }))
          // snapshots taken before 0.10.0 have no cards key, and before 0.15.0 no
          // papers key — leave those stores alone rather than emptying them
          .concat((b.cards || []).map(function (c) { return put('cards', c); }))
          .concat((b.papers || []).map(function (pp) { return put('papers', pp); }))
          .concat((b.commitments || []).map(function (cm) { return put('commitments', cm); }));
        return Promise.all(jobs);
      }).then(function () {
        state.activeNote = null;
        state.tabs = [];
        return refresh();
      }).then(function () {
        track('snapshot_restored');
        toast('Restored the snapshot from ' + when(b.at) + '.');
      });
    });
  }

  /* ============================================================
     3 · helpers
     ============================================================ */
  var $ = function (id) { return document.getElementById(id); };
  var uid = function () {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  };

  /* textContent runs blocks straight together — a note of "<h3>Why?</h3><p>Because…</p>"
     came out as "Why?Because…" in every excerpt, search snippet and card suggestion.
     Blocks get a space between them before the text is flattened. */
  var BLOCKS = /^(P|DIV|H1|H2|H3|H4|H5|H6|LI|UL|OL|BR|TR|BLOCKQUOTE|PRE|SECTION)$/;
  function plain(html) {
    var d = document.createElement('div');
    d.innerHTML = html || '';
    var walk = d.querySelectorAll('*');
    for (var i = 0; i < walk.length; i++) {
      if (BLOCKS.test(walk[i].tagName)) walk[i].appendChild(document.createTextNode(' '));
    }
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function when(ts) {
    if (!ts) return '';
    var d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    var yr = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString(undefined,
      yr ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3000);
  }

  /* Subject colours. These are mid-tone on purpose: a subject shows up as a 7px dot,
     and the old palette was dark enough to vanish against the near-black rail in dark
     mode. Everything here reads on both the blue-grey paper and the warm near-black.
     Muted and earthy rather than bright, so eight subjects on screen stay calm and the
     highlighter yellow is still the only loud thing in the app. */
  var COLOURS = ['#4E8C6E', '#5B87A8', '#C07A5E', '#C09A48',
                 '#9C6E92', '#4F9095', '#6E76B0', '#86A05A'];

  /* the pre-0.5.1 palette, by index. Subjects still carrying one of these get moved to
     the matching new colour on load — cosmetic, exact-match only, and idempotent since
     no new colour appears in this list. */
  var OLD_COLOURS = ['#1E4D3E', '#2E6F8E', '#8A5A2B', '#7A3B5C',
                     '#4A6B2F', '#A8721B', '#3F4C8A', '#A8391F'];

  /* ============================================================
     4 · state
     ============================================================ */
  var state = {
    account: null, deviceId: null,
    subjects: [], notes: [], syllabus: [], cards: [], papers: [], commitments: [],
    activeSubject: null, activeNode: null, activeNote: null,
    tabs: [], collapsed: {},
    query: '', dirty: false,
    editingSubject: null, editingNode: null, pendingParent: null,
    pendingColour: COLOURS[0]
  };

  /* ============================================================
     5 · gate
     ============================================================ */
  /* The intro runs once per device, ahead of the sign-in card. Deliberately keyed off
     localStorage and not the account: it answers "what is this", which you need BEFORE
     you have an account, and a returning user must never see it again. If storage is
     unavailable (private window, blocked site data) we simply skip it rather than
     showing it on every visit. */
  var INTRO_KEY = 'nexley-intro-seen';
  function introSeen() {
    try { return localStorage.getItem(INTRO_KEY) === '1'; } catch (e) { return true; }
  }
  function markIntroSeen() {
    try { localStorage.setItem(INTRO_KEY, '1'); } catch (e) {}
  }

  var introPanel = 0;
  function showIntro() {
    var panels = document.querySelectorAll('.ipanel');
    var dots = $('introDots');
    dots.textContent = '';
    for (var i = 0; i < panels.length; i++) dots.appendChild(document.createElement('i'));
    $('gate').hidden = true;
    $('app').hidden = true;
    $('intro').hidden = false;
    introPanel = 0;
    paintIntro();
  }
  function paintIntro() {
    var panels = document.querySelectorAll('.ipanel');
    var dots = $('introDots').children;
    for (var i = 0; i < panels.length; i++) {
      panels[i].classList.toggle('on', i === introPanel);
      if (dots[i]) dots[i].classList.toggle('on', i === introPanel);
    }
    var last = introPanel === panels.length - 1;
    $('introNext').textContent = last ? 'Get started' : 'Next';
    $('introSkip').textContent = last ? '' : 'Skip';
    $('introSkip').hidden = last;
  }
  function endIntro(how) {
    track('intro_finished', { how: how === 'skipped' ? 'skipped' : 'completed' });
    markIntroSeen();
    document.documentElement.classList.remove('pre-intro');
    $('intro').hidden = true;
    showGate('create');
  }

  function showGate(mode) {
    enteredUser = null;
    // a first-time visitor gets the explanation before the sign-up form
    // a sign-in that just failed outranks the first-run pitch — showing the carousel
    // here would bury the reason it failed behind three taps
    if (mode === 'create' && !introSeen() && !authUrlError() && $('intro')) return showIntro();
    // whenever the gate is genuinely being shown, drop the pre-paint guard — otherwise
    // signing out on a device that skipped the intro leaves the card display:none
    document.documentElement.classList.remove('pre-intro');
    $('intro').hidden = true;
    $('gate').hidden = false;
    $('app').hidden = true;
    var creating = mode === 'create';
    $('nameField').hidden = !creating;
    $('gateSub').textContent = creating
      ? 'Create your account. Your notes sync to it and work offline in between.'
      : 'Welcome back.';
    $('gateBtn').textContent = creating ? 'Create account' : 'Sign in';
    $('gateSwitch').textContent = creating ? 'Already have an account? Sign in' : 'New here? Create an account';
    $('gateErr').hidden = true;
    $('fName').value = '';
    $('fEmail').value = '';
    $('fPass').value = '';
    setTimeout(function () { (creating ? $('fName') : $('fEmail')).focus(); }, 60);
    $('gateForm').dataset.mode = creating ? 'create' : 'unlock';
    showAuthUrlError();
  }

  /* A failed OAuth round trip comes back as ?error=/#error_description=. Read-only, so
     it can also be used to decide whether to show the intro. */
  function authUrlError() {
    try {
      var q = new URLSearchParams(location.search);
      var h = new URLSearchParams(location.hash.replace(/^#/, ''));
      var msg = h.get('error_description') || q.get('error_description') ||
                h.get('error') || q.get('error');
      return msg ? decodeURIComponent(String(msg).replace(/\+/g, ' ')) : null;
    } catch (e) { return null; }
  }

  /* Without this a failed sign-in just rendered a blank form, so a real failure looked
     like nothing happened. Say what went wrong, then strip it from the URL so a reload
     doesn't replay a stale error. */
  function showAuthUrlError() {
    var msg = authUrlError();
    if (!msg) return;
    gateError(msg);
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }
  function gateError(msg) {
    var el = $('gateErr');
    el.textContent = msg;
    el.hidden = false;
    gateBusy = false;
    $('gateBtn').disabled = false;
    // put the label back — otherwise a wrong password leaves it reading "Signing in…"
    $('gateBtn').textContent = $('gateForm').dataset.mode === 'create' ? 'Create account' : 'Sign in';
  }

  /* Signing up fires BOTH the signUp promise and a SIGNED_IN event, and Google's
     redirect fires the event on its own. All of them land here, so entering has to
     be idempotent — otherwise a single sign-up ran the whole load twice, racing its
     own seed. Reset in showGate on the way out. */
  var enteredUser = null;

  function enterApp(user) {
    if (enteredUser === user.id) return Promise.resolve();
    enteredUser = user.id;
    state.account = { id: user.id, name: (user.user_metadata && user.user_metadata.name) || '', email: user.email };
    $('gate').hidden = true; $('app').hidden = false;
    return refresh()
      .then(function () { return window.NexleySync.run(); })
      .then(function (res) { return maybeSeed(res); })
      .then(function (seeded) {
        track('app_opened');
        renderFeedbackBadge();
        if (!seeded) return;
        // push the welcome note up now rather than waiting for the 5-minute tick,
        // so it's already there when they open the app on a second device
        return refresh().then(function () { window.NexleySync.run(); });
      });
  }

  /* Seeding belongs here, not in the sign-up handler: a Google sign-up never goes
     through that handler, so new Google accounts used to land in a completely empty
     app. The test is "signed in, a full sync round trip completed, and there is still
     nothing here" — waiting for the sync is what stops a returning user on a new
     device getting a duplicate General/Welcome pair on top of their real notebook. */
  function maybeSeed(sync) {
    if (!sync || !sync.ok) return false;
    // read the store, NOT state: the sync we just awaited wrote the pulled records
    // straight into IndexedDB, and state is only rebuilt by refresh(). Checking state
    // here sees the pre-pull emptiness and seeds a General/Welcome pair on top of a
    // returning user's real notebook.
    return Promise.all([all('subjects'), all('notes')]).then(function (r) {
      if (live(r[0]).length || live(r[1]).length) return false;
      return seed().then(function () { return true; });
    });
  }

  // A disabled submit button stops the click path, but not every browser blocks
  // implicit submission (Enter in a field) on it — and creating the same account
  // twice is the one mistake here you cannot undo from the UI.
  var gateBusy = false;

  function gateSubmit(e) {
    e.preventDefault();
    if (gateBusy) return;
    var mode = $('gateForm').dataset.mode;
    var email = $('fEmail').value.trim();
    var pass = $('fPass').value;
    if (!email) return gateError('Enter your email.');
    if (pass.length < 6) return gateError('Password must be at least 6 characters.');
    gateBusy = true;
    $('gateBtn').disabled = true;
    $('gateBtn').textContent = mode === 'create' ? 'Creating account…' : 'Signing in…';

    var done = function () { gateBusy = false; };

    if (mode === 'create') {
      var name = $('fName').value.trim();
      if (!name) { done(); return gateError('Enter a name.'); }
      window.NexleyAuth.signUpEmail(email, pass, name).then(function (data) {
        done();
        if (!data.session) {
          // showGate clears the error box, so it has to happen BEFORE the message —
          // the other way round the user got a silently reset form and no reason why
          showGate('unlock');
          gateError('Check your email to confirm your account, then sign in.');
          return;
        }
        track('account_created', { via: 'email' });
        return enterApp(data.user);
      }).catch(function (err) { done(); gateError(err.message || 'Could not create account.'); });
      return;
    }

    window.NexleyAuth.signInEmail(email, pass).then(function (data) {
      done();
      track('signed_in', { via: 'email' });
      return enterApp(data.user);
    }).catch(function (err) { done(); gateError(err.message || 'Could not sign in.'); });
  }

  function seed() {
    var s = stamp({ id: uid(), name: 'General', code: 'GEN', colour: COLOURS[0] });
    var n = stamp({
      id: uid(), subjectId: s.id, syllabusId: null, kind: 'personal', font: 'standard',
      title: 'Welcome to Nexley',
      body: '<p>Everything you write is saved on this device first, so it works offline, ' +
            'and syncs to your account whenever you have a connection — only you can ever ' +
            'read it.</p>' +
            '<h3>Notes belong to the syllabus</h3>' +
            '<p>Add a subject, hit <b>Syllabus</b> and paste in its structure. Every note ' +
            'then files against a specific dot point — which is what lets the app later ' +
            'find your gaps, target revision and pull the right questions.</p>' +
            '<h3>Your work survives updates</h3>' +
            '<ul><li>Updating replaces the app files. It never touches your notes.</li>' +
            '<li>A snapshot is taken about once a day, and before every update, import ' +
            'and restore. See <b>Snapshots</b>.</li>' +
            '<li>Deleting flags a note rather than destroying it.</li></ul>' +
            '<p>Delete this note whenever you like.</p>'
    });
    return put('subjects', s).then(function () { return put('notes', n); });
  }

  /* ============================================================
     6 · load
     ============================================================ */
  // one-time colour remap, see OLD_COLOURS. Runs inside refresh so it lands before the
  // first paint; writes are stamped so the new colour syncs like any other edit.
  function migrateColours(subjects) {
    var moved = subjects.filter(function (s) { return OLD_COLOURS.indexOf(s.colour) > -1; });
    if (!moved.length) return Promise.resolve();
    return Promise.all(moved.map(function (s) {
      s.colour = COLOURS[OLD_COLOURS.indexOf(s.colour)];
      return put('subjects', stamp(s));
    }));
  }

  function refresh(opts) {
    return Promise.all([all('subjects'), all('notes'), all('syllabus'), all('cards'),
                        all('papers'), all('commitments')]).then(function (r) {
      return migrateColours(live(r[0])).then(function () { return r; });
    }).then(function (r) {
      state.subjects = live(r[0]).sort(function (a, b) { return a.name.localeCompare(b.name); });
      state.notes = live(r[1]).sort(function (a, b) { return b.updated - a.updated; });
      state.syllabus = live(r[2]).sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      state.cards = live(r[3]);
      state.papers = live(r[4]).sort(function (a, b) { return b.sat - a.sat; });
      state.commitments = live(r[5]).sort(function (a, b) { return a.due - b.due; });
      // drop tabs whose notes have gone
      state.tabs = state.tabs.filter(noteById);
      renderSubjects();
      renderBrowser();
      renderTabs();
      // re-rendering the editor rewrites the note body and drops the caret, so a
      // background repaint leaves an open note alone
      if (!(opts && opts.keepEditor)) renderEditor();
      // a sync pull or an edit elsewhere has to reach whichever mode is on screen
      if (mode === 'classwork') renderClasswork();
      else if (mode === 'review') renderReview();
      else if (mode === 'tasks') { renderTkSubjects(); renderPlan(); }
      else if (mode === 'marks') renderMarks();
    });
  }

  function subjectById(id) { return find(state.subjects, id); }
  function nodeById(id) { return find(state.syllabus, id); }
  function noteById(id) { return find(state.notes, id); }
  function find(arr, id) {
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  }

  function topicsOf(subjectId) {
    return state.syllabus.filter(function (n) { return n.subjectId === subjectId && !n.parentId; });
  }
  function childrenOf(parentId) {
    return state.syllabus.filter(function (n) { return n.parentId === parentId; });
  }
  function notesOfNode(nodeId) {
    return state.notes.filter(function (n) { return n.syllabusId === nodeId; });
  }
  function unfiledOf(subjectId) {
    return state.notes.filter(function (n) {
      return n.subjectId === subjectId && !n.syllabusId && !isCapture(n);
    });
  }

  /* ============================================================
     7 · rail
     ============================================================ */
  /* Counts exclude captures, because clicking the row shows the notebook and the
     notebook excludes them. A rail reading "3" above a list of 2 is the app
     contradicting itself, and the number is the thing people trust least once it
     has been wrong once. */
  function renderSubjects() {
    var wrap = $('subjectList');
    var pool = notebookNotes();
    wrap.textContent = '';
    wrap.appendChild(subjectRow({ id: null, name: 'All notes', colour: 'var(--muted)' },
      pool.length, false));
    state.subjects.forEach(function (s) {
      var count = pool.filter(function (n) { return n.subjectId === s.id; }).length;
      wrap.appendChild(subjectRow(s, count, true));
    });
  }

  function subjectRow(s, count, editable) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'snav' + (state.activeSubject === s.id ? ' on' : '');

    var dot = document.createElement('i');
    dot.className = 'dot';
    dot.style.background = s.colour;
    b.appendChild(dot);

    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = s.name;
    b.appendChild(nm);

    if (editable) {
      var ed = document.createElement('button');
      ed.type = 'button';
      ed.className = 'edit';
      ed.textContent = 'edit';
      ed.title = 'Edit subject';
      ed.addEventListener('click', function (e) { e.stopPropagation(); openSubjectDialog(s); });
      b.appendChild(ed);
    }

    var ct = document.createElement('span');
    ct.className = 'ct';
    ct.textContent = count;
    b.appendChild(ct);

    b.addEventListener('click', function () {
      if (state.dirty) saveNow();
      state.activeSubject = s.id;
      state.activeNode = null;
      state.query = '';
      $('search').value = '';
      $('app').classList.remove('editing');
      state.activeNote = null;
      renderSubjects();
      renderBrowser();
      renderTabs();
      renderEditor();
    });
    return b;
  }

  /* ============================================================
     8 · browser column
     ============================================================ */
  function renderBrowser() {
    var subj = state.activeSubject ? subjectById(state.activeSubject) : null;
    var searching = !!state.query.trim();

    $('listTitle').textContent = searching ? 'Search results' : (subj ? subj.name : 'All notes');
    $('listContext').textContent = searching ? '"' + state.query.trim() + '"'
      : (subj ? (subj.code || 'Subject') : 'Everything');
    $('syllabusBtn').hidden = !subj || searching;

    var body = $('browserBody');
    body.textContent = '';

    if (searching || !subj) { $('coverage').hidden = true; return renderFlat(body); }

    var topics = topicsOf(subj.id);
    renderCoverage(subj, topics);

    if (!topics.length) {
      var box = document.createElement('div');
      box.className = 'emptytree';
      var p = document.createElement('p');
      p.textContent = 'No syllabus for ' + subj.name + ' yet. Add one and every note you write ' +
        'has somewhere to belong — that is what later lets the app find your gaps.';
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn primary';
      b.textContent = 'Add the syllabus';
      b.addEventListener('click', openSyllabusDialog);
      box.appendChild(p); box.appendChild(b);
      body.appendChild(box);
      renderUnfiled(body, subj);
      return;
    }

    topics.forEach(function (t) { body.appendChild(topicBlock(t)); });
    renderUnfiled(body, subj);
  }

  function renderCoverage(subj, topics) {
    var points = [];
    topics.forEach(function (t) { points = points.concat(childrenOf(t.id)); });
    if (!points.length) { $('coverage').hidden = true; return; }

    // "covered" means YOU have written something there — given notes don't count
    var covered = points.filter(function (p) {
      return notesOfNode(p.id).some(function (n) { return n.kind === 'personal'; });
    }).length;
    var pct = Math.round((covered / points.length) * 100);

    // Coverage says how much you have written. It deliberately does NOT fold in
    // confidence: they answer different questions, and averaging them would hide
    // both. Anything shaky is reported alongside, as a separate count.
    var shaky = points.filter(function (p) {
      return confidenceOf(p.id).band === 'shaky';
    }).length;

    $('coverage').hidden = false;
    $('covFill').style.width = pct + '%';
    $('covLabel').textContent = covered + ' / ' + points.length + ' written · ' + pct + '%'
      + (shaky ? '  ·  ' + shaky + ' shaky' : '');
  }

  function topicBlock(t) {
    var wrap = document.createElement('div');
    wrap.className = 'topic' + (state.collapsed[t.id] ? ' closed' : '');

    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'topic-head';

    var chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '▾';
    head.appendChild(chev);

    var tw = document.createElement('span');
    tw.className = 'tw';
    if (t.code) {
      var c = document.createElement('span');
      c.className = 'code';
      c.textContent = t.code;
      tw.appendChild(c);
    }
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = t.title;
    tw.appendChild(nm);
    head.appendChild(tw);

    var ed = document.createElement('button');
    ed.type = 'button';
    ed.className = 'edit';
    ed.textContent = 'edit';
    ed.addEventListener('click', function (e) { e.stopPropagation(); openNodeDialog(t, null); });
    head.appendChild(ed);

    head.addEventListener('click', function () {
      state.collapsed[t.id] = !state.collapsed[t.id];
      wrap.classList.toggle('closed');
    });
    wrap.appendChild(head);

    var bodyEl = document.createElement('div');
    bodyEl.className = 'topic-body';
    childrenOf(t.id).forEach(function (p) { bodyEl.appendChild(pointBlock(p)); });

    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'node-add';
    add.textContent = '+ dot point';
    add.addEventListener('click', function () { openNodeDialog(null, t.id); });
    bodyEl.appendChild(add);

    wrap.appendChild(bodyEl);
    return wrap;
  }

  function pointBlock(p) {
    var frag = document.createDocumentFragment();
    var notes = notesOfNode(p.id);
    var mine = notes.filter(function (n) { return n.kind === 'personal'; });

    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'dp' + (state.activeNode === p.id ? ' on' : '');

    var pip = document.createElement('i');
    pip.className = 'pip' + (mine.length ? ' has' : (notes.length ? ' given' : ''));
    pip.title = mine.length ? 'You have written here'
      : (notes.length ? 'Only given notes here — nothing of your own' : 'Nothing here yet');
    row.appendChild(pip);

    var tw = document.createElement('span');
    tw.className = 'tw';
    if (p.code) {
      var c = document.createElement('span');
      c.className = 'code';
      c.textContent = p.code;
      tw.appendChild(c);
    }
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.title;
    tw.appendChild(nm);
    row.appendChild(tw);

    var conf = confidenceOf(p.id);
    if (conf.band !== 'untouched') {
      var cb = document.createElement('span');
      cb.className = 'conf ' + conf.band;
      cb.textContent = conf.label;
      cb.title = confidenceWhy(conf);
      row.appendChild(cb);
    }

    var ed = document.createElement('button');
    ed.type = 'button';
    ed.className = 'edit';
    ed.textContent = 'edit';
    ed.addEventListener('click', function (e) { e.stopPropagation(); openNodeDialog(p, p.parentId); });
    row.appendChild(ed);

    if (notes.length) {
      var ct = document.createElement('span');
      ct.className = 'ct';
      ct.textContent = notes.length;
      row.appendChild(ct);
    }

    row.addEventListener('click', function () {
      state.activeNode = state.activeNode === p.id ? null : p.id;
      renderBrowser();
    });
    frag.appendChild(row);

    var list = document.createElement('div');
    list.className = 'notes-under';
    notes.forEach(function (n) { list.appendChild(noteRow(n)); });

    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'node-add';
    add.textContent = '+ note here';
    add.addEventListener('click', function () { newNote(p.id); });
    list.appendChild(add);
    frag.appendChild(list);

    return frag;
  }

  function noteRow(n) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'nrow' + (state.activeNote === n.id ? ' on' : '');

    var k = document.createElement('span');
    k.className = 'kind ' + (n.kind === 'syllabus' ? 'given' : 'mine');
    k.textContent = n.kind === 'syllabus' ? 'syl' : (isCapture(n) ? 'class' : 'mine');
    b.appendChild(k);

    var t = document.createElement('span');
    t.className = 't';
    t.textContent = n.title || 'Untitled note';
    b.appendChild(t);

    var dt = document.createElement('span');
    dt.className = 'dt';
    dt.textContent = when(n.updated);
    b.appendChild(dt);

    b.addEventListener('click', function () { openNote(n.id); });
    return b;
  }

  function renderUnfiled(body, subj) {
    var loose = unfiledOf(subj.id);
    if (!loose.length) return;

    var wrap = document.createElement('div');
    wrap.className = 'topic';

    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'topic-head';
    var chev = document.createElement('span');
    chev.className = 'chev';
    chev.textContent = '▾';
    var tw = document.createElement('span');
    tw.className = 'tw';
    var nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = 'Unfiled (' + loose.length + ')';
    tw.appendChild(nm);
    head.appendChild(chev); head.appendChild(tw);
    head.addEventListener('click', function () { wrap.classList.toggle('closed'); });
    wrap.appendChild(head);

    var list = document.createElement('div');
    list.className = 'topic-body';
    var inner = document.createElement('div');
    inner.className = 'notes-under';
    loose.forEach(function (n) { inner.appendChild(noteRow(n)); });
    list.appendChild(inner);
    wrap.appendChild(list);
    body.appendChild(wrap);
  }

  /* flat list — used for search and for "All notes" */
  function renderFlat(body) {
    var q = state.query.trim().toLowerCase();
    // Browsing shows the notebook only. Searching reaches captures too — you should
    // be able to find something you wrote in class without knowing it never got filed.
    var pool = q ? state.notes : notebookNotes();
    var list = pool.filter(function (n) {
      if (state.activeSubject && n.subjectId !== state.activeSubject) return false;
      if (!q) return true;
      return (n.title || '').toLowerCase().indexOf(q) > -1 ||
             plain(n.body).toLowerCase().indexOf(q) > -1;
    });

    var holder = document.createElement('div');
    holder.className = 'notes';

    if (!list.length) {
      var e = document.createElement('p');
      e.className = 'listempty';
      e.textContent = q ? 'Nothing matches that search.'
        : (state.subjects.length ? 'No notes yet. Hit "New note" to start one.'
                                 : 'Add a subject first, then start writing.');
      holder.appendChild(e);
      body.appendChild(holder);
      return;
    }

    list.forEach(function (n) {
      var s = subjectById(n.subjectId);
      var node = n.syllabusId ? nodeById(n.syllabusId) : null;
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'ncard' + (state.activeNote === n.id ? ' on' : '');

      var top = document.createElement('div');
      top.className = 'top';
      var dot = document.createElement('i');
      dot.className = 'dot';
      dot.style.background = s ? s.colour : 'var(--muted)';
      var t = document.createElement('span');
      t.className = 't';
      t.textContent = n.title || 'Untitled note';
      var dt = document.createElement('span');
      dt.className = 'dt';
      dt.textContent = when(n.updated);
      top.appendChild(dot); top.appendChild(t); top.appendChild(dt);

      var ex = document.createElement('p');
      ex.className = 'ex';
      ex.textContent = plain(n.body).slice(0, 160) || 'Empty note';

      card.appendChild(top);
      card.appendChild(ex);

      if (node) {
        var w = document.createElement('span');
        w.className = 'dt';
        w.textContent = (node.code ? node.code + ' · ' : '') + node.title;
        card.appendChild(w);
      }

      card.addEventListener('click', function () { openNote(n.id); });
      holder.appendChild(card);
    });
    body.appendChild(holder);
  }

  /* ============================================================
     9 · tabs
     ============================================================ */
  function addTab(id) {
    if (state.tabs.indexOf(id) === -1) {
      state.tabs.push(id);
      if (state.tabs.length > MAX_TABS) state.tabs.shift();
    }
    saveTabs();
  }
  function closeTab(id) {
    var i = state.tabs.indexOf(id);
    if (i > -1) state.tabs.splice(i, 1);
    saveTabs();
    if (state.activeNote === id) {
      var next = state.tabs[Math.min(i, state.tabs.length - 1)];
      if (next) { openNote(next); return; }
      closeNote();
      return;
    }
    renderTabs();
  }
  function saveTabs() {
    put('meta', { key: 'tabs', ids: state.tabs.slice() }).catch(function () {});
  }

  function renderTabs() {
    var strip = $('tabStrip');
    strip.textContent = '';
    if (state.tabs.length < 2) { strip.hidden = true; return; }
    strip.hidden = false;

    state.tabs.forEach(function (id) {
      var n = noteById(id);
      if (!n) return;
      var t = document.createElement('div');
      t.className = 'tab' + (state.activeNote === id ? ' on' : '');

      var label = document.createElement('span');
      label.className = 'tl';
      label.textContent = n.title || 'Untitled';
      label.addEventListener('click', function () { openNote(id); });
      t.appendChild(label);

      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'x';
      x.textContent = '×';
      x.title = 'Close tab';
      x.addEventListener('click', function (e) { e.stopPropagation(); closeTab(id); });
      t.appendChild(x);

      strip.appendChild(t);
    });
  }

  /* ============================================================
     10 · editor
     ============================================================ */
  var saveTimer = null;

  function openNote(id) {
    if (state.dirty) saveNow();
    state.activeNote = id;
    addTab(id);
    $('app').classList.add('editing');
    renderBrowser();
    renderTabs();
    renderEditor();
    setTimeout(function () { $('noteTitle').focus(); }, 40);
  }

  function closeNote() {
    if (state.dirty) saveNow();
    state.activeNote = null;
    $('app').classList.remove('editing');
    renderBrowser();
    renderTabs();
    renderEditor();
  }

  function activeNoteObj() { return noteById(state.activeNote); }

  function renderEditor() {
    var n = activeNoteObj();
    if (!n) {
      $('editor').hidden = true;
      $('emptyState').hidden = false;
      $('app').classList.remove('editing');
      return;
    }
    $('editor').hidden = false;
    $('emptyState').hidden = true;

    $('noteTitle').value = n.title || '';
    $('noteBody').innerHTML = n.body || '';
    // narrow shows only the "edited" line; the margin shows both (see .st-cr in app.css)
    $('stampCreated').textContent = 'Created ' + when(n.created);
    $('stampEdited').textContent = 'Edited ' + when(n.updated);
    $('noteStamp').title = 'Created ' + when(n.created) + ' · edited ' + when(n.updated);

    var sel = $('noteSubject');
    sel.textContent = '';
    state.subjects.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name;
      if (s.id === n.subjectId) o.selected = true;
      sel.appendChild(o);
    });

    renderSyllabusPicker(n);
    setKindButtons(n.kind || 'personal');
    renderCrumbAndHint(n);
    applyFont(n.font || 'standard');
    markSaved();
    countWords();
  }

  function renderSyllabusPicker(n) {
    var sel = $('noteSyllabus');
    sel.textContent = '';

    var none = document.createElement('option');
    none.value = '';
    none.textContent = 'Unfiled';
    sel.appendChild(none);

    topicsOf(n.subjectId).forEach(function (t) {
      var group = document.createElement('optgroup');
      group.label = (t.code ? t.code + ' · ' : '') + t.title;
      childrenOf(t.id).forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.id;
        o.textContent = (p.code ? p.code + ' · ' : '') + p.title;
        if (p.id === n.syllabusId) o.selected = true;
        group.appendChild(o);
      });
      if (group.children.length) sel.appendChild(group);
    });

    if (!n.syllabusId) none.selected = true;
    sel.disabled = sel.options.length <= 1;
  }

  function setKindButtons(kind) {
    $('kindPersonal').classList.toggle('on', kind !== 'syllabus');
    $('kindSyllabus').classList.toggle('on', kind === 'syllabus');
  }

  function renderCrumbAndHint(n) { renderCrumb(n); renderFilingHint(n); renderPastYou(n); }

  function renderCrumb(n) {
    var s = subjectById(n.subjectId);
    var node = n.syllabusId ? nodeById(n.syllabusId) : null;
    var c = $('crumb');
    c.textContent = '';

    var dot = document.createElement('i');
    dot.className = 'dot';
    dot.style.background = s ? s.colour : 'var(--muted)';
    c.appendChild(dot);

    var b = document.createElement('b');
    b.textContent = s ? s.name : 'No subject';
    c.appendChild(b);

    if (node) {
      var sep1 = document.createElement('span');
      sep1.className = 'sep';
      sep1.textContent = '›';
      var nd = document.createElement('span');
      nd.textContent = (node.code ? node.code + ' ' : '') + node.title;
      c.appendChild(sep1); c.appendChild(nd);
    }

    var sep2 = document.createElement('span');
    sep2.className = 'sep';
    sep2.textContent = '›';
    var ttl = document.createElement('span');
    ttl.textContent = n.title || 'Untitled note';
    c.appendChild(sep2); c.appendChild(ttl);
  }

  function markDirty() {
    state.dirty = true;
    $('savedState').textContent = 'Saving…';
    $('savedState').classList.add('dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }
  function markSaved() {
    state.dirty = false;
    $('savedState').textContent = 'Saved';
    $('savedState').classList.remove('dirty');
  }

  function saveNow() {
    var n = activeNoteObj();
    if (!n) return Promise.resolve();
    n.title = $('noteTitle').value.trim();
    n.body = $('noteBody').innerHTML;
    n.subjectId = $('noteSubject').value || n.subjectId;
    n.syllabusId = $('noteSyllabus').value || null;
    stamp(n);
    clearTimeout(saveTimer);
    return put('notes', n).then(function () {
      state.notes.sort(function (a, b) { return b.updated - a.updated; });
      renderSubjects();
      renderBrowser();
      renderTabs();
      // a save landing after the user moved on must not rewrite the new note's chrome
      if (state.activeNote !== n.id) return;
      markSaved();
      // the note has grown since it opened, so the suggestion may have changed
      renderCrumbAndHint(n);
    });
  }

  function newNote(nodeId) {
    if (!state.subjects.length) {
      toast('Add a subject first.');
      openSubjectDialog(null);
      return;
    }
    var node = nodeId ? nodeById(nodeId) : null;
    var n = stamp({
      id: uid(),
      subjectId: node ? node.subjectId : (state.activeSubject || state.subjects[0].id),
      syllabusId: node ? node.id : null,
      kind: 'personal', title: '', body: '', font: 'standard'
    });
    put('notes', n).then(function () {
      state.notes.unshift(n);
      state.query = '';
      $('search').value = '';
      openNote(n.id);
      renderSubjects();
      track('note_created', { filed: node ? 'syllabus' : 'unfiled' });
    });
  }

  function deleteNote() {
    var n = activeNoteObj();
    if (!n) return;
    if (!confirm('Delete "' + (n.title || 'Untitled note') + '"?\n\nIt is flagged as deleted, ' +
                 'not destroyed — the most recent snapshot can bring it back.')) return;
    softDelete('notes', n).then(function () {
      track('note_deleted');
      state.notes = state.notes.filter(function (x) { return x.id !== n.id; });
      closeTab(n.id);
      state.activeNote = null;
      renderSubjects();
      renderBrowser();
      renderTabs();
      renderEditor();
      toast('Note deleted. Recoverable from Snapshots.');
    });
  }

  var FONTS = ['standard', 'serif', 'hand'];
  var FONT_LABEL = { standard: 'Standard', serif: 'Serif', hand: 'Handwritten' };
  function applyFont(f) {
    var body = $('noteBody');
    body.classList.remove('font-hand', 'font-serif');
    if (f === 'hand') body.classList.add('font-hand');
    if (f === 'serif') body.classList.add('font-serif');
    $('fontBtn').textContent = 'Font: ' + (FONT_LABEL[f] || 'Standard');
  }
  function cycleFont() {
    var n = activeNoteObj();
    if (!n) return;
    var i = FONTS.indexOf(n.font || 'standard');
    n.font = FONTS[(i + 1) % FONTS.length];
    applyFont(n.font);
    markDirty();
  }

  /* Wrap the selection in a real <mark> rather than letting execCommand bake an inline
     background in — an inline colour survives into dark mode as light text on yellow. */
  function toggleHighlight() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    var body = $('noteBody');
    if (!body.contains(range.commonAncestorContainer)) return;

    var node = range.commonAncestorContainer;
    while (node && node !== body) {
      if (node.nodeType === 1 && node.tagName === 'MARK') {
        var parent = node.parentNode;
        while (node.firstChild) parent.insertBefore(node.firstChild, node);
        parent.removeChild(node);
        parent.normalize();
        return;
      }
      node = node.parentNode;
    }
    var mark = document.createElement('mark');
    try { range.surroundContents(mark); }
    catch (err) {
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
    }
    sel.removeAllRanges();
  }

  function countWords() {
    var w = plain($('noteBody').innerHTML);
    var c = w ? w.split(/\s+/).length : 0;
    $('wordCount').textContent = c + (c === 1 ? ' word' : ' words');
  }

  /* ============================================================
     11 · subjects
     ============================================================ */
  function renderSwatches() {
    var wrap = $('swatches');
    wrap.textContent = '';
    COLOURS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sw' + (c === state.pendingColour ? ' on' : '');
      b.style.background = c;
      b.setAttribute('aria-label', 'Colour ' + c);
      b.addEventListener('click', function () { state.pendingColour = c; renderSwatches(); });
      wrap.appendChild(b);
    });
  }

  function openSubjectDialog(s) {
    state.editingSubject = s;
    state.pendingColour = s ? s.colour : COLOURS[state.subjects.length % COLOURS.length];
    $('subjHeading').textContent = s ? 'Edit subject' : 'Add subject';
    $('subjName').value = s ? s.name : '';
    $('subjCode').value = s ? (s.code || '') : '';
    $('subjDelete').hidden = !s;
    renderSwatches();
    $('subjDialog').showModal();
    setTimeout(function () { $('subjName').focus(); }, 50);
  }

  function saveSubject(e) {
    e.preventDefault();
    var name = $('subjName').value.trim();
    if (!name) return;
    var s = state.editingSubject || { id: uid() };
    s.name = name;
    s.code = $('subjCode').value.trim();
    s.colour = state.pendingColour;
    stamp(s);
    var wasEditing = !!state.editingSubject;
    put('subjects', s).then(function () {
      $('subjDialog').close();
      return refresh();
    }).then(function () {
      if (!wasEditing) track('subject_created');
      toast(wasEditing ? 'Subject updated.' : 'Subject added.');
      state.editingSubject = null;
    });
  }

  function deleteSubject() {
    var s = state.editingSubject;
    if (!s) return;
    var kids = state.notes.filter(function (n) { return n.subjectId === s.id; });
    var nodes = state.syllabus.filter(function (x) { return x.subjectId === s.id; });
    var msg = 'Delete "' + s.name + '"' +
      (kids.length ? ' and its ' + kids.length + ' note' + (kids.length === 1 ? '' : 's') : '') +
      (nodes.length ? ' and its syllabus' : '') +
      '?\n\nEverything is flagged as deleted, not destroyed — the most recent snapshot can bring it back.';
    if (!confirm(msg)) return;

    Promise.all(kids.map(function (n) { return softDelete('notes', n); }))
      .then(function () { return Promise.all(nodes.map(function (x) { return softDelete('syllabus', x); })); })
      .then(function () { return softDelete('subjects', s); })
      .then(function () {
        $('subjDialog').close();
        state.editingSubject = null;
        if (state.activeSubject === s.id) state.activeSubject = null;
        state.activeNote = null;
        return refresh();
      })
      .then(function () { toast('Subject deleted. Recoverable from Snapshots.'); });
  }

  /* ============================================================
     12 · syllabus
     ============================================================ */
  function openNodeDialog(node, parentId) {
    state.editingNode = node;
    state.pendingParent = parentId;
    var isTopic = !parentId;
    $('nodeHeading').textContent = (node ? 'Edit ' : 'Add ') + (isTopic ? 'topic' : 'dot point');
    $('nodeTitleLabel').textContent = isTopic ? 'Topic' : 'Dot point';
    $('nodeCode').value = node ? (node.code || '') : '';
    $('nodeTitle').value = node ? node.title : '';
    $('nodeDelete').hidden = !node;
    $('nodeDialog').showModal();
    setTimeout(function () { $('nodeTitle').focus(); }, 50);
  }

  function saveNode(e) {
    e.preventDefault();
    var title = $('nodeTitle').value.trim();
    if (!title || !state.activeSubject) return;

    var n = state.editingNode || {
      id: uid(),
      subjectId: state.activeSubject,
      parentId: state.pendingParent || null,
      order: nextOrder(state.pendingParent || null)
    };
    n.code = $('nodeCode').value.trim();
    n.title = title;
    stamp(n);

    put('syllabus', n).then(function () {
      $('nodeDialog').close();
      state.editingNode = null;
      return refresh();
    });
  }

  function nextOrder(parentId) {
    var sibs = parentId ? childrenOf(parentId) : topicsOf(state.activeSubject);
    return sibs.reduce(function (m, s) { return Math.max(m, s.order || 0); }, 0) + 10;
  }

  function deleteNode() {
    var n = state.editingNode;
    if (!n) return;
    var kids = childrenOf(n.id);
    var affected = notesOfNode(n.id).concat(
      kids.reduce(function (acc, k) { return acc.concat(notesOfNode(k.id)); }, []));

    var msg = 'Delete "' + n.title + '"' +
      (kids.length ? ' and its ' + kids.length + ' dot point' + (kids.length === 1 ? '' : 's') : '') + '?' +
      (affected.length
        ? '\n\n' + affected.length + ' note' + (affected.length === 1 ? '' : 's') +
          ' will become Unfiled. No note is deleted.'
        : '');
    if (!confirm(msg)) return;

    // notes are never destroyed by a syllabus change — they fall back to Unfiled
    Promise.all(affected.map(function (note) {
      note.syllabusId = null;
      return put('notes', stamp(note));
    })).then(function () {
      return Promise.all(kids.map(function (k) { return softDelete('syllabus', k); }));
    }).then(function () {
      return softDelete('syllabus', n);
    }).then(function () {
      $('nodeDialog').close();
      state.editingNode = null;
      state.activeNode = null;
      return refresh();
    }).then(function () {
      toast(affected.length ? affected.length + ' note(s) moved to Unfiled.' : 'Removed.');
    });
  }

  /* Parse pasted syllabus text.
     Left margin = topic. Indented = dot point under the topic above it.
     A leading token containing a digit is treated as a code. */
  function parseSyllabus(text) {
    var out = [], currentTopic = null;
    text.split(/\r?\n/).forEach(function (raw) {
      if (!raw.trim()) return;
      var indent = raw.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
      var line = raw.trim().replace(/^[-*•·]\s*/, '');
      if (!line) return;

      var code = '', title = line, m = null;

      // "Module 5: Heredity" / "Topic 2 - Dynamics" / "Unit 1. Foundations".
      // Only these known structural words, so ordinary prose is never split.
      m = line.match(/^((?:module|topic|unit|chapter|part|section|option|focus)\s*\d+[a-z]?)\s*[:–—\-.]\s*(.+)$/i);

      // "HM-11-01 Meanings of health" / "1.1 Motion in a straight line"
      if (!m) {
        m = line.match(/^([A-Za-z0-9][A-Za-z0-9._\-\/]*\d[A-Za-z0-9._\-\/]*)[\s:.\-]+(.+)$/);
        // reject junk: over-long tokens, no real title left, and bare 4-digit numbers —
        // "1914 as a turning point" is a history dot point, not a code
        if (m && (m[1].length > 20 || m[2].trim().length < 2 || /^\d{4,}$/.test(m[1]))) m = null;
      }

      // bare leading number: "1 Kinematics"
      if (!m) m = line.match(/^(\d{1,3})[\s:.\-]+(.+)$/);

      if (m) { code = m[1]; title = m[2].trim(); }
      title = title.replace(/\s*:\s*$/, '');

      if (indent === 0) {
        currentTopic = { code: code, title: title, points: [] };
        out.push(currentTopic);
      } else {
        if (!currentTopic) {
          currentTopic = { code: '', title: 'Topic', points: [] };
          out.push(currentTopic);
        }
        currentTopic.points.push({ code: code, title: title });
      }
    });
    return out;
  }

  function openSyllabusDialog() {
    var subj = subjectById(state.activeSubject);
    if (!subj) return;
    $('sylSubject').textContent = subj.name;
    $('sylPaste').value = '';
    $('sylPreview').textContent = '';
    $('sylDialog').showModal();
    setTimeout(function () { $('sylPaste').focus(); }, 50);
  }

  function previewSyllabus() {
    var parsed = parseSyllabus($('sylPaste').value);
    var points = parsed.reduce(function (m, t) { return m + t.points.length; }, 0);
    $('sylPreview').textContent = parsed.length
      ? 'Reads as ' + parsed.length + ' topic' + (parsed.length === 1 ? '' : 's') +
        ' and ' + points + ' dot point' + (points === 1 ? '' : 's') + '.'
      : '';
  }

  function importSyllabus() {
    var parsed = parseSyllabus($('sylPaste').value);
    if (!parsed.length) return toast('Nothing to add — paste the structure first.');
    if (!state.activeSubject) return;

    var order = nextOrder(null);
    var jobs = [];

    parsed.forEach(function (t) {
      var topic = stamp({
        id: uid(), subjectId: state.activeSubject, parentId: null,
        code: t.code, title: t.title, order: order
      });
      order += 10;
      jobs.push(put('syllabus', topic));

      var childOrder = 10;
      t.points.forEach(function (p) {
        jobs.push(put('syllabus', stamp({
          id: uid(), subjectId: state.activeSubject, parentId: topic.id,
          code: p.code, title: p.title, order: childOrder
        })));
        childOrder += 10;
      });
    });

    var points = parsed.reduce(function (m, t) { return m + t.points.length; }, 0);
    snapshot('before-syllabus-import')
      .then(function () { return Promise.all(jobs); })
      .then(function () { $('sylDialog').close(); return refresh(); })
      .then(function () {
        toast('Added ' + parsed.length + ' topics and ' + points + ' dot points.');
        track('syllabus_imported', { nodes: parsed.length + points });
      });
  }

  /* ============================================================
     12b · report a problem
     ============================================================ */
  function openBugDialog() {
    var d = (window.NexleyErrors && window.NexleyErrors.diagnostics()) || {};
    var box = $('bugDiag');
    box.textContent = '';
    // rendered as text, one line per field — the reporter can read exactly what goes
    [['Version', d.app_version], ['Screen', d.view], ['Page', d.page],
     ['Window', d.viewport], ['Installed', d.standalone ? 'yes' : 'no'],
     ['Online', d.online ? 'yes' : 'no'], ['Browser', d.user_agent]
    ].forEach(function (pair) {
      if (!pair[1]) return;
      var row = document.createElement('div');
      var k = document.createElement('b');
      k.textContent = pair[0] + ': ';
      row.appendChild(k);
      row.appendChild(document.createTextNode(String(pair[1])));
      box.appendChild(row);
    });
    $('bugText').value = '';
    $('bugSend').disabled = false;
    $('bugSend').textContent = 'Send report';
    $('bugDialog').showModal();
    setTimeout(function () { $('bugText').focus(); }, 60);
  }

  function sendBugReport() {
    var text = $('bugText').value.trim();
    if (!text) { $('bugText').focus(); return; }
    $('bugSend').disabled = true;
    $('bugSend').textContent = 'Sending…';
    var done = function () {
      $('bugDialog').close();
      // honest either way: if it couldn't send now it is queued and retried, so
      // "sent" would be a lie and "failed" would be wrong too
      var queued = window.NexleyErrors && window.NexleyErrors.pending();
      // don't say "offline": it may also be queued because the server refused it
      toast(queued ? 'Saved — it will send as soon as it can.' : 'Thanks — report sent.');
    };
    if (!window.NexleyErrors) return done();
    window.NexleyErrors.report(text).then(done, done);
  }

  /* ============================================================
     12b2 · sync state
     ------------------------------------------------------------
     Sync being broken is not a background detail — it decides whether your work
     exists in more than one place. It was broken in production from the first
     deploy until 2026-09-03 and the app never said a word, because nothing ever
     read the result of a sync. This reads it.
     ============================================================ */
  var lastSync = null;
  function renderSyncState(s) {
    lastSync = s || lastSync;
    if (!lastSync) return;
    var el = $('syncState');
    var txt = $('syncText');
    if (!el) return;
    el.hidden = false;
    el.classList.remove('ok', 'warn');

    if (lastSync.state === 'ok') {
      el.classList.add('ok');
      txt.textContent = 'Synced ' + when(lastSync.at).toLowerCase();
    } else if (lastSync.state === 'offline') {
      txt.textContent = 'Offline — saved on this device';
    } else if (lastSync.state === 'signedout') {
      el.hidden = true;
    } else if (lastSync.state === 'error') {
      el.classList.add('warn');
      // never "syncing…" while it is failing: that is the lie that hid this bug
      txt.textContent = lastSync.lastOkAt
        ? 'Not syncing since ' + when(lastSync.lastOkAt).toLowerCase()
        : 'Never synced — tap to see why';
    } else {
      txt.textContent = 'Checking…';
    }
  }

  function openSyncDetail() {
    if (!lastSync) return;
    var lines = [];
    if (lastSync.state === 'ok') {
      lines.push('Everything on this device has reached your account. Last full '
        + 'round trip: ' + when(lastSync.at) + '.');
    } else if (lastSync.state === 'offline') {
      lines.push('You are offline. Everything you write is saved on this device and '
        + 'will go up on its own once you have a connection. Nothing is lost.');
    } else if (lastSync.state === 'error') {
      lines.push(lastSync.lastOkAt
        ? 'Your notes are safe on this device, but nothing has reached your account '
          + 'since ' + when(lastSync.lastOkAt) + '.'
        : 'Your notes are safe on this device, but they have never reached your '
          + 'account. Nothing has been lost — but there is no second copy, and this '
          + 'device is the only place your work exists.');
      if (lastSync.error) {
        lines.push('The server said: ' + (lastSync.error.code ? lastSync.error.code + ' — ' : '')
          + lastSync.error.message);
        if (lastSync.error.hint) lines.push('Hint: ' + lastSync.error.hint);
      }
      lines.push('Export all (in the sidebar) writes a full copy to a file you keep. '
        + 'Worth doing now if this persists.');
    }
    alert(lines.join('\n\n'));
  }

  /* ============================================================
     12b3 · feedback
     ------------------------------------------------------------
     "Report a problem" (12b) is write-only by design — bug_reports has no select
     policy, so a crash report can never be read back and note text can never leak
     out of it. That shape is right for crashes and wrong for opinions: a beta user
     who sends an idea into a hole that never answers does not send a second one.

     So feedback is its own table (migration 0008) with select-own, and this is the
     board: what you sent, what state it is in, and what Alec said back. The status
     and the reply are the server's to write — the client is granted no UPDATE at
     all, so nothing here can mark its own idea "shipped".
     ============================================================ */
  var FB_KINDS = [
    { id: 'idea',      label: 'An idea' },
    { id: 'problem',   label: 'Something broken' },
    { id: 'confusing', label: 'Confusing' },
    { id: 'praise',    label: 'This worked' }
  ];

  /* What each status says to the person who wrote it. Deliberately plain: "Sent"
     means it arrived and nobody has looked yet, and saying so is better than a
     hopeful "Received!" that implies more than happened. */
  var FB_STATUS = {
    new:      { label: 'Sent',        tone: 'wait' },
    noted:    { label: 'Read',        tone: 'wait' },
    planned:  { label: 'Planned',     tone: 'go'   },
    building: { label: 'Being built', tone: 'go'   },
    shipped:  { label: 'Shipped',     tone: 'done' },
    declined: { label: 'Not planned', tone: 'off'  }
  };

  var FB_MAX = 4000;                        // matches the CHECK in migration 0008
  var FB_SEEN_KEY = 'nexley-feedback-seen'; // id -> rev of the reply already read

  var fbKind = 'idea';
  var fbCache = [];

  /* Seen-state lives in localStorage rather than on the record, because a sync pull
     writes the server's row over the local one wholesale — any local-only field on
     it would be silently erased the moment a reply arrived, which is exactly when
     it matters. */
  function fbSeen() {
    try { return JSON.parse(localStorage.getItem(FB_SEEN_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function fbMarkSeen(rows) {
    try {
      var seen = fbSeen();
      rows.forEach(function (r) { if (r.reply) seen[r.id] = r.rev || 1; });
      localStorage.setItem(FB_SEEN_KEY, JSON.stringify(seen));
    } catch (e) {}
  }
  function fbUnread(rows) {
    var seen = fbSeen();
    return rows.filter(function (r) {
      return r.reply && seen[r.id] !== (r.rev || 1);
    }).length;
  }

  /* A quiet dot on the rail button. The only unsolicited attention the app asks
     for, and only ever because a real person wrote back. */
  function renderFeedbackBadge() {
    return all('feedback').then(function (rows) {
      fbCache = live(rows);
      var dot = $('fbDot');
      if (dot) dot.hidden = fbUnread(fbCache) === 0;
    }).catch(function () {});
  }

  function openFeedbackDialog() {
    $('fbText').value = '';
    $('fbSend').disabled = false;
    $('fbSend').textContent = 'Send';
    fbKind = 'idea';
    renderFeedbackKinds();
    renderFeedbackList();
    $('fbDialog').showModal();
    setTimeout(function () { $('fbText').focus(); }, 60);
  }

  function renderFeedbackKinds() {
    var wrap = $('fbKinds');
    wrap.textContent = '';
    FB_KINDS.forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (fbKind === k.id ? ' on' : '');
      b.textContent = k.label;
      b.setAttribute('aria-pressed', fbKind === k.id ? 'true' : 'false');
      b.addEventListener('click', function () { fbKind = k.id; renderFeedbackKinds(); });
      wrap.appendChild(b);
    });
  }

  function renderFeedbackList() {
    var wrap = $('fbList');
    wrap.textContent = '';
    return all('feedback').then(function (rows) {
      fbCache = live(rows).sort(function (a, b) { return b.created - a.created; });
      if (!fbCache.length) {
        var e = document.createElement('p');
        e.className = 'dlgnote';
        e.textContent = 'Nothing sent yet. Anything you write here reaches the person ' +
          'building Nexley, and the reply turns up in this list.';
        wrap.appendChild(e);
        return;
      }
      fbCache.forEach(function (r) { wrap.appendChild(feedbackRow(r)); });
      // opening the list IS reading it
      fbMarkSeen(fbCache);
      var dot = $('fbDot');
      if (dot) dot.hidden = true;
    });
  }

  function feedbackRow(r) {
    var row = document.createElement('div');
    row.className = 'fbitem';

    var head = document.createElement('div');
    head.className = 'fbhead';

    /* A row that has never reached the server says so. The app has been wrong about
       exactly this once already — sync spent its whole life claiming notes were on
       the account when nothing had ever left the device — so "Sent" is never shown
       for something still sitting in IndexedDB. */
    var sent = !!r.pushedRev;
    var meta = FB_STATUS[r.status] || FB_STATUS['new'];

    var st = document.createElement('span');
    st.className = 'fbstatus ' + (sent ? meta.tone : 'wait');
    st.textContent = sent ? meta.label : 'Waiting to send';
    head.appendChild(st);

    var kind = document.createElement('span');
    kind.className = 'fbkind';
    kind.textContent = (FB_KINDS.filter(function (k) { return k.id === r.kind; })[0] || {}).label || r.kind;
    head.appendChild(kind);

    var date = document.createElement('span');
    date.className = 'fbdate';
    date.textContent = when(r.created);
    head.appendChild(date);

    row.appendChild(head);

    var body = document.createElement('p');
    body.className = 'fbbody';
    body.textContent = r.body;
    row.appendChild(body);

    if (r.reply) {
      var rep = document.createElement('div');
      rep.className = 'fbreply';
      var who = document.createElement('b');
      who.textContent = 'Reply';
      rep.appendChild(who);
      var txt = document.createElement('p');
      txt.textContent = r.reply;
      rep.appendChild(txt);
      row.appendChild(rep);
    }
    return row;
  }

  function sendFeedback() {
    var text = $('fbText').value.trim();
    if (!text) { $('fbText').focus(); return; }
    if (text.length > FB_MAX) text = text.slice(0, FB_MAX);
    $('fbSend').disabled = true;
    $('fbSend').textContent = 'Sending…';

    var rec = stamp({
      id: uid(), kind: fbKind, body: text,
      status: 'new', reply: null, appVersion: APP_VERSION
    });

    /* Written locally first, always. Sending is the part allowed to fail; keeping
       what you wrote is not. */
    put('feedback', rec)
      .then(function () {
        $('fbText').value = '';
        return window.NexleySync ? window.NexleySync.run() : null;
      })
      .catch(function () { return null; })
      .then(function () { return renderFeedbackList(); })
      .then(function () {
        $('fbSend').disabled = false;
        $('fbSend').textContent = 'Send';
        return get('feedback', rec.id);
      })
      .then(function (saved) {
        track('feedback_sent', { kind: rec.kind });
        // honest either way, same rule as the bug reporter
        toast(saved && saved.pushedRev ? 'Thanks — sent.'
                                       : 'Saved — it will send as soon as it can.');
      });
  }

  /* ============================================================
     12c · classwork
     ------------------------------------------------------------
     A capture is an ordinary note with kind 'capture'. That is the whole data
     model, deliberately:
       - it syncs today, because `kind` is already a synced column. No migration,
         so Classwork cannot be blocked on a schema change reaching the server.
       - graduating one is a field edit (kind -> 'personal', set syllabusId), not a
         copy. The id, the history and the created date all survive, so "when did I
         first write this down" stays true after filing.
     The cost is that every notebook list has to exclude captures explicitly —
     see notebookNotes(). Missing one shows rough class notes inside the notebook,
     which is exactly the mess this mode exists to prevent.
     ============================================================ */
  function closeNav() { $('app').classList.remove('nav-open'); }

  /* The working area shows exactly one of: the notebook (browser + editor),
     Classwork, or Review. Everything that switches away from a mode goes through
     here so there is one place that decides what is visible. */
  var mode = 'notebook';
  function setMode(m) {
    mode = m;
    var btns = $('modeSwitch').getElementsByClassName('mode');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-mode') === m);
    }
    $('classwork').hidden = m !== 'classwork';
    $('review').hidden = m !== 'review';
    $('tasks').hidden = m !== 'tasks';
    $('marks').hidden = m !== 'marks';
    $('app').classList.toggle('moded', m !== 'notebook');

    if (m === 'classwork') {
      renderClasswork();
      // the point of this mode is that the box is already waiting
      if (!matchMedia('(pointer:coarse)').matches) $('cwInput').focus();
    }
    if (m === 'review') { session = null; renderReview(); }
    if (m === 'tasks') { renderTasks(); }
    if (m === 'marks') { renderMarks(); }
    closeNav();
  }

  function isCapture(n) { return n.kind === 'capture'; }
  function captures() { return state.notes.filter(isCapture); }
  function notebookNotes() { return state.notes.filter(function (n) { return !isCapture(n); }); }

  var CW_SUBJ_KEY = 'nexley-cw-subject';
  function cwSubject() {
    var sel = $('cwSubject');
    return sel && sel.value ? sel.value : null;
  }
  function renderCwSubjects() {
    var sel = $('cwSubject');
    var want = sel.value;
    if (!want) { try { want = localStorage.getItem(CW_SUBJ_KEY) || ''; } catch (e) {} }
    sel.textContent = '';
    state.subjects.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name;
      sel.appendChild(o);
    });
    if (want && subjectById(want)) sel.value = want;
    else if (state.activeSubject && subjectById(state.activeSubject)) sel.value = state.activeSubject;
    var none = !state.subjects.length;
    sel.disabled = none;
    $('cwSave').disabled = none;
    $('cwInput').disabled = none;
    $('cwInput').placeholder = none
      ? 'Add a subject first — captures still have to belong to one.'
      : 'What just happened in class…';
  }

  function captureNow() {
    var text = $('cwInput').value.trim();
    var subjectId = cwSubject();
    if (!text || !subjectId) return;

    // The first line becomes the title so the capture is identifiable in a list and
    // in search. The full text stays in the body — the title is a label, not a
    // truncation of the content.
    var firstLine = text.split('\n')[0].trim();
    var rec = stamp({
      id: uid(), subjectId: subjectId, syllabusId: null, kind: 'capture',
      font: 'standard',
      title: firstLine.slice(0, 140),
      body: textToHtml(text)
    });
    return put('notes', rec).then(function () {
      $('cwInput').value = '';
      $('cwInput').focus();
      try { localStorage.setItem(CW_SUBJ_KEY, subjectId); } catch (e) {}
      track('capture_made', {});
      return refresh({ keepEditor: true });
    }).then(function () { toast('Captured.'); });
  }

  function textToHtml(text) {
    return text.split(/\n{2,}/).map(function (para) {
      var d = document.createElement('p');
      // single newlines inside a paragraph survive as <br>, so a list jotted in
      // class keeps its shape
      para.split('\n').forEach(function (line, i) {
        if (i) d.appendChild(document.createElement('br'));
        d.appendChild(document.createTextNode(line));
      });
      return d.outerHTML;
    }).join('');
  }

  function renderClasswork() {
    renderCwSubjects();
    var list = $('cwList');
    list.textContent = '';

    var caps = captures().slice().sort(function (a, b) { return b.created - a.created; });
    if (!caps.length) {
      var e = document.createElement('p');
      e.className = 'rv-note';
      e.textContent = state.subjects.length
        ? 'Nothing captured yet. In a lesson, type it here and hit Capture — no subject '
          + 'tree, no filing decision, no thinking about where it goes. That comes later.'
        : 'Add a subject in the rail first. Captures still belong to a subject, so you can '
          + 'file them against its syllabus later.';
      list.appendChild(e);
      return;
    }

    // grouped by day, newest first — a lesson is a day-shaped thing
    var days = [];
    var byDay = {};
    caps.forEach(function (c) {
      var key = new Date(c.created).toDateString();
      if (!byDay[key]) { byDay[key] = []; days.push(key); }
      byDay[key].push(c);
    });

    days.forEach(function (key) {
      var wrap = document.createElement('div');
      wrap.className = 'cw-day';
      var h = document.createElement('h4');
      h.textContent = dayLabel(new Date(key));
      wrap.appendChild(h);
      byDay[key].forEach(function (c) { wrap.appendChild(captureRow(c)); });
      list.appendChild(wrap);
    });
  }

  function dayLabel(d) {
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var that = new Date(d); that.setHours(0, 0, 0, 0);
    var diff = Math.round((today - that) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long' });
  }

  function captureRow(c) {
    var row = document.createElement('div');
    row.className = 'cap';

    var s = subjectById(c.subjectId);
    var dot = document.createElement('i');
    dot.className = 'cdot';
    dot.style.background = s ? s.colour : 'var(--muted)';
    row.appendChild(dot);

    var body = document.createElement('div');
    body.className = 'cbody';
    var t = document.createElement('div');
    t.className = 'ctext';
    t.textContent = plain(c.body) || c.title || 'Empty capture';
    body.appendChild(t);

    var meta = document.createElement('div');
    meta.className = 'cmeta';
    var when1 = document.createElement('span');
    when1.textContent = new Date(c.created).toLocaleTimeString(undefined,
      { hour: 'numeric', minute: '2-digit' });
    meta.appendChild(when1);
    if (s) {
      var sn = document.createElement('span');
      sn.textContent = s.code || s.name;
      meta.appendChild(sn);
    }
    body.appendChild(meta);
    row.appendChild(body);

    var acts = document.createElement('div');
    acts.className = 'cacts';

    var fileBtn = document.createElement('button');
    fileBtn.type = 'button';
    fileBtn.textContent = 'File…';
    fileBtn.addEventListener('click', function () { openFileDialog(c); });
    acts.appendChild(fileBtn);

    var openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', function () { setMode('notebook'); openNote(c.id); });
    acts.appendChild(openBtn);

    var del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', function () {
      if (!confirm('Delete this capture?')) return;
      softDelete('notes', c).then(function () { return refresh({ keepEditor: true }); })
        .then(renderClasswork);
    });
    acts.appendChild(del);

    row.appendChild(acts);
    return row;
  }

  /* Filing is the graduation step: it sets a syllabus point and flips the kind, so
     the capture becomes an ordinary note and starts counting towards coverage. */
  var filing = null;
  function openFileDialog(c) {
    filing = c;
    $('fileExcerpt').textContent = plain(c.body).slice(0, 300) || c.title;

    var subj = $('fileSubject');
    subj.textContent = '';
    state.subjects.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id; o.textContent = s.name;
      subj.appendChild(o);
    });
    subj.value = c.subjectId;
    fillFileSyllabus();
    $('fileDialog').showModal();
  }

  function fillFileSyllabus() {
    var sel = $('fileSyllabus');
    sel.textContent = '';
    var blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Unfiled — just move it to the notebook';
    sel.appendChild(blank);
    syllabusOptions($('fileSubject').value).forEach(function (o) { sel.appendChild(o); });
  }

  /* Shared by the file dialog and the card dialog: the subject's syllabus as
     <option>s, topics as disabled group headings so the shape is readable. */
  function syllabusOptions(subjectId) {
    var out = [];
    topicsOf(subjectId).forEach(function (t) {
      var kids = childrenOf(t.id);
      if (!kids.length) return;
      var g = document.createElement('optgroup');
      g.label = (t.code ? t.code + ' · ' : '') + t.title;
      kids.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.id;
        o.textContent = (p.code ? p.code + ' · ' : '') + p.title;
        g.appendChild(o);
      });
      out.push(g);
    });
    return out;
  }

  function doFile(e) {
    if (e) e.preventDefault();
    if (!filing) return;
    var c = filing;
    filing = null;
    c.subjectId = $('fileSubject').value || c.subjectId;
    c.syllabusId = $('fileSyllabus').value || null;
    c.kind = 'personal';
    put('notes', stamp(c)).then(function () {
      $('fileDialog').close();
      track('capture_filed', { filed: c.syllabusId ? 'syllabus' : 'unfiled' });
      return refresh({ keepEditor: true });
    }).then(function () {
      renderClasswork();
      toast(c.syllabusId ? 'Filed. It is a notebook note now.' : 'Moved to the notebook, unfiled.');
    });
  }

  /* ============================================================
     12d · review — SM-2
     ------------------------------------------------------------
     SM-2 (SuperMemo 2), the algorithm Anki's default scheduler descends from.
     Chosen over anything newer because it is small, fully understood, needs no
     training data, and runs offline — which matters more here than the last few
     percent of scheduling accuracy.

     Per card: an ease factor (how easy you find it, >= 1.3), an interval in days,
     and a repetition count. Grade a card 0-5; anything under 3 is a lapse and the
     card restarts. The ease factor moves by the standard SM-2 formula, so a card
     you keep failing comes back faster forever, not just once.

     Deliberately NOT stored: any measure of "retention %" of the sort the concept
     mockups show. That number needs a decay model this scheduler does not have,
     and inventing one would be a made-up number on a study screen.
     ============================================================ */
  var DAY = 86400000;
  var MIN_EASE = 1.3;

  function newCard(fields) {
    return stamp({
      id: uid(),
      subjectId: fields.subjectId, syllabusId: fields.syllabusId || null,
      noteId: fields.noteId || null,
      front: fields.front, back: fields.back,
      ease: 2.5, interval: 0, reps: 0, lapses: 0,
      due: Date.now(),          // a new card is due immediately
      lastReviewed: null
    });
  }

  /* Returns the card mutated in place. Grade: 0 again, 3 hard, 4 good, 5 easy.

     WHERE THIS DEPARTS FROM TEXTBOOK SM-2, AND WHY.
     Original SM-2 sets the interval from the repetition count alone: first success
     1 day, second 6 days, thereafter interval x ease. The grade only moves the ease
     factor, which does not affect anything until the third review.

     That is defensible on paper and unusable in a UI. On a new card it makes Hard,
     Good and Easy all schedule for tomorrow, so the buttons show "1d / 1d / 1d" —
     three controls that visibly do the same thing. A grading choice that changes
     nothing teaches people not to grade honestly, which corrupts the one input the
     algorithm actually depends on.

     So the early intervals are grade-dependent (the same fix Anki's graduating
     intervals make), and later intervals scale the multiplier by grade. The ease
     formula below is untouched SM-2. */
  var GRADE_NAME = { 0: 'again', 3: 'hard', 4: 'good', 5: 'easy' };
  var FIRST = { 3: 1, 4: 3, 5: 5 };     // days, by grade, on the first success
  var SECOND = { 3: 4, 4: 6, 5: 9 };    // days, by grade, on the second

  function schedule(card, grade) {
    if (grade < 3) {
      card.lapses = (card.lapses || 0) + 1;
      card.reps = 0;
      card.interval = 0;
      // 10 minutes, not tomorrow: a card you just failed should come back inside
      // the same session, which is the whole point of grading it Again.
      card.due = Date.now() + 10 * 60 * 1000;
    } else {
      card.reps = (card.reps || 0) + 1;
      if (card.reps === 1) {
        card.interval = FIRST[grade];
      } else if (card.reps === 2) {
        card.interval = SECOND[grade];
      } else {
        // Hard advances slowly regardless of a high ease; Easy gets a bonus on top.
        var mult = grade === 3 ? 1.2 : (grade === 5 ? card.ease * 1.3 : card.ease);
        card.interval = Math.max(card.interval + 1, Math.round(card.interval * mult));
      }
      card.due = Date.now() + card.interval * DAY;
    }
    // SM-2's ease update, unchanged, applied on every grade including a lapse
    var q = grade;
    card.ease = Math.max(MIN_EASE,
      (card.ease || 2.5) + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    card.lastReviewed = Date.now();
    return card;
  }

  /* What the interval WOULD become, for the hint under each grade button. Pure —
     it must not touch the card, or previewing a grade would schedule it. */
  function previewInterval(card, grade) {
    var c = {
      ease: card.ease, interval: card.interval, reps: card.reps, lapses: card.lapses
    };
    schedule(c, grade);
    if (grade < 3) return '10m';
    if (c.interval < 1) return '1d';
    if (c.interval < 30) return c.interval + 'd';
    if (c.interval < 365) return Math.round(c.interval / 30) + 'mo';
    return (Math.round(c.interval / 36.5) / 10) + 'y';
  }

  function dueCards() {
    var now = Date.now();
    return state.cards.filter(function (c) { return (c.due || 0) <= now; })
      // most overdue first: the closest to being lost is the one worth the minute
      .sort(function (a, b) { return (a.due || 0) - (b.due || 0); });
  }

  var session = null;   // {queue:[ids], done:n, total:n, shown:bool}

  function startReview() {
    var due = dueCards();
    if (!due.length) return;
    session = {
      queue: due.map(function (c) { return c.id; }),
      done: 0, total: due.length, shown: false
    };
    track('review_started', { cards: due.length });
    renderReview();
  }

  function gradeCurrent(grade) {
    if (!session || !session.queue.length) return;
    var card = cardById(session.queue[0]);
    if (!card) { session.queue.shift(); return renderReview(); }

    schedule(card, grade);
    track('card_graded', { grade: GRADE_NAME[grade] });
    session.queue.shift();
    // a failed card goes back into this session, behind whatever is left
    if (grade < 3) session.queue.push(card.id);
    else session.done++;
    session.shown = false;

    put('cards', stamp(card)).then(function () {
      return refreshCards();
    }).then(renderReview);
  }

  function cardById(id) {
    for (var i = 0; i < state.cards.length; i++) if (state.cards[i].id === id) return state.cards[i];
    return null;
  }

  function refreshCards() {
    return all('cards').then(function (list) {
      state.cards = live(list);
    });
  }

  function renderReview() {
    var due = dueCards();
    var panel = $('rvPanel');
    var inSession = !!(session && session.queue.length);

    $('rvSession').hidden = !inSession;
    panel.hidden = inSession;
    $('rvStart').hidden = inSession || !due.length;
    $('rvDeckBtn').hidden = inSession;

    if (inSession) {
      var card = cardById(session.queue[0]);
      if (!card) { session.queue.shift(); return renderReview(); }
      var pct = session.total ? Math.round((session.done / session.total) * 100) : 0;
      $('rvFill').style.width = pct + '%';
      $('rvTitle').textContent = session.done + ' of ' + session.total;
      $('rvContext').textContent = 'Reviewing';

      var s = subjectById(card.subjectId);
      var node = card.syllabusId ? nodeById(card.syllabusId) : null;
      $('rvWhere').textContent = [
        s ? (s.code || s.name) : null,
        node ? (node.code || node.title) : null
      ].filter(Boolean).join(' · ') || 'Unfiled';

      $('rvFront').textContent = card.front;
      $('rvBack').textContent = card.back;
      $('rvBack').hidden = !session.shown;
      $('rvAsk').hidden = session.shown;
      $('rvGrades').hidden = !session.shown;

      if (session.shown) {
        [0, 3, 4, 5].forEach(function (g) {
          $('gi' + g).textContent = previewInterval(card, g);
        });
      }
      return;
    }

    // not in a session: either just finished, or the deck view
    session = null;
    $('rvContext').textContent = 'Review';
    $('rvTitle').textContent = due.length
      ? due.length + (due.length === 1 ? ' card due' : ' cards due')
      : (state.cards.length ? 'Nothing due' : 'No cards yet');
    renderDeck(panel, due);
  }

  function renderDeck(panel, due) {
    panel.textContent = '';

    if (!state.cards.length) {
      var note = document.createElement('p');
      note.className = 'rv-note';
      note.textContent = 'Cards are made from notes you have already written — nobody sits '
        + 'down and writes flashcards, which is why spaced repetition usually fails. Open a '
        + 'note, select the bit worth remembering and hit "+ Card" in the toolbar.';
      panel.appendChild(note);
      /* Mistakes first, and especially here: an empty deck plus a paper you
         have already broken down is the one moment the app can say exactly
         which card to write first. */
      renderMistakes(panel);
      renderSuggestions(panel);
      return;
    }

    var stats = document.createElement('div');
    stats.className = 'rv-stats';
    var soon = state.cards.filter(function (c) {
      return c.due > Date.now() && c.due < Date.now() + 7 * DAY;
    }).length;
    [[due.length, 'Due now'], [state.cards.length, 'In the deck'], [soon, 'Due this week']]
      .forEach(function (pair) {
        var d = document.createElement('div');
        d.className = 'rv-stat';
        var b = document.createElement('b');
        b.textContent = pair[0];
        var sp = document.createElement('span');
        sp.textContent = pair[1];
        d.appendChild(b); d.appendChild(sp);
        stats.appendChild(d);
      });
    panel.appendChild(stats);

    if (!due.length) {
      var n = document.createElement('p');
      n.className = 'rv-note';
      var next = state.cards.reduce(function (m, c) {
        return (!m || c.due < m) ? c.due : m;
      }, 0);
      n.textContent = next
        ? 'Nothing to review right now. The next card is due ' + when(next).toLowerCase() + '. '
          + 'Coming back early is wasted effort — that is the whole point of the schedule.'
        : 'Nothing to review right now.';
      panel.appendChild(n);
    }

    var list = state.cards.slice().sort(function (a, b) { return (a.due || 0) - (b.due || 0); });
    list.forEach(function (c) { panel.appendChild(deckRow(c)); });
    renderMistakes(panel);
    renderSuggestions(panel);
  }

  function deckRow(c) {
    var row = document.createElement('div');
    row.className = 'deckrow';

    var main = document.createElement('div');
    main.className = 'dfront';
    main.textContent = c.front;

    var meta = document.createElement('div');
    meta.className = 'dmeta';
    var chip = document.createElement('span');
    var overdue = (c.due || 0) <= Date.now();
    chip.className = 'due-chip' + (overdue ? ' now' : (c.reps ? '' : ' new'));
    chip.textContent = overdue ? 'due' : (c.reps ? when(c.due) : 'new');
    meta.appendChild(chip);

    var s = subjectById(c.subjectId);
    var node = c.syllabusId ? nodeById(c.syllabusId) : null;
    var where = document.createElement('span');
    where.textContent = [
      s ? (s.code || s.name) : null,
      node ? (node.code || node.title) : null
    ].filter(Boolean).join(' · ');
    meta.appendChild(where);

    if (c.reps) {
      var seen = document.createElement('span');
      seen.textContent = c.reps + (c.reps === 1 ? ' review' : ' reviews')
        + (c.lapses ? ' · ' + c.lapses + ' lapsed' : '');
      meta.appendChild(seen);
    }
    main.appendChild(meta);
    row.appendChild(main);

    var acts = document.createElement('div');
    acts.className = 'dacts';
    var edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', function () { openCardDialog(c); });
    acts.appendChild(edit);
    row.appendChild(acts);
    return row;
  }

  /* Candidate cards pulled out of what the user already wrote. No model, no network:
     a heading followed by prose is already a question and its answer, and a
     highlighted phrase is already the bit they decided mattered. Suggestions are
     never saved on their own — accepting one opens the normal dialog so the front
     is always something a person chose to ask. */
  function suggestions() {
    var out = [];
    var have = {};
    state.cards.forEach(function (c) { have[c.noteId + '|' + c.front] = true; });

    notebookNotes().forEach(function (n) {
      if (!n.body) return;
      var d = document.createElement('div');
      d.innerHTML = n.body;

      var kids = d.children;
      for (var i = 0; i < kids.length && out.length < 40; i++) {
        if (kids[i].tagName !== 'H3') continue;
        var answer = [];
        for (var j = i + 1; j < kids.length; j++) {
          if (kids[j].tagName === 'H3') break;
          answer.push(kids[j].textContent || '');
        }
        var back = answer.join(' ').replace(/\s+/g, ' ').trim();
        var front = (kids[i].textContent || '').trim();
        if (!front || back.length < 25) continue;
        if (have[n.id + '|' + front]) continue;
        out.push({ noteId: n.id, subjectId: n.subjectId, syllabusId: n.syllabusId,
                   front: front, back: back.slice(0, 1200), why: 'heading' });
      }
    });
    return out;
  }

  /* ============================================================
     mistake replay
     ------------------------------------------------------------
     Marks already rolls content gaps up per dot point, but it does it one
     subject at a time, on the screen you go to when you want to look at a
     mark. This is the same data on the screen you go to when you want to
     STUDY, across every subject at once — because the question "what should I
     work on" is not a per-subject question, and the answer to it is sitting in
     the papers you have already broken down.

     IT DOES NOT CLAIM A GAP IS FIXED. Nothing in the data records that: a card
     made and reviewed twice might have closed it or might not. So each row
     reports the state it can actually see — cards exist, cards are already
     queued, or there are none yet — and leaves the judgement where it belongs.

     THE DEAD END THIS CLOSES. The per-subject version says "no cards yet" and
     stops, which is honest but useless: the one point you have measurably lost
     marks on is the one point you cannot act on. Here that case gets the
     action it was missing.
     ============================================================ */
  function mistakeGaps() {
    return gapsByPoint(state.papers || [])
      .map(function (r) {
        var node = nodeById(r.syllabusId);
        if (!node) return null;
        return { node: node, lost: r.lost, count: r.count, cards: cardsOnPoint(r.syllabusId) };
      })
      .filter(Boolean);
  }

  function renderMistakes(panel) {
    var rows = mistakeGaps();
    if (!rows.length) return;

    var head = document.createElement('h4');
    head.className = 'rv-head';
    head.textContent = 'From your mistakes · ' + rows.length
      + (rows.length === 1 ? ' dot point' : ' dot points');
    panel.appendChild(head);

    var why = document.createElement('p');
    why.className = 'rv-note';
    why.style.marginTop = '10px';
    why.textContent = 'Every mark you lost to not knowing it, across every subject, worst '
      + 'first. Running out of time is a different problem and is not counted here.';
    panel.appendChild(why);

    rows.slice(0, 8).forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'deckrow';

      var main = document.createElement('div');
      main.className = 'dfront';
      main.textContent = (r.node.code ? r.node.code + ' · ' : '') + r.node.title;

      var meta = document.createElement('div');
      meta.className = 'dmeta';

      var chip = document.createElement('span');
      chip.className = 'due-chip now';
      chip.textContent = trimNum(r.lost) + ' marks';
      meta.appendChild(chip);

      var s = subjectById(r.node.subjectId);
      var where = document.createElement('span');
      where.textContent = [
        s ? (s.code || s.name) : null,
        r.count + (r.count === 1 ? ' question' : ' questions')
      ].filter(Boolean).join(' · ');
      meta.appendChild(where);

      main.appendChild(meta);
      row.appendChild(main);

      var waiting = r.cards.filter(function (c) { return c.due <= Date.now(); }).length;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ghost';

      if (!r.cards.length) {
        b.textContent = 'Write a card';
        b.addEventListener('click', function () {
          openCardDialog(null, {
            front: '', back: '',
            subjectId: r.node.subjectId, syllabusId: r.node.id, noteId: null
          }, 'mistake');
        });
      } else if (waiting === r.cards.length) {
        b.textContent = 'Already in the queue';
        b.disabled = true;
      } else {
        b.textContent = 'Bring ' + r.cards.length
          + (r.cards.length === 1 ? ' card' : ' cards') + ' forward';
        b.addEventListener('click', function () {
          b.disabled = true;
          pullForward(r.cards)
            .then(function () { return refresh(); })
            .then(function () {
              renderReview();
              track('cards_pulled_forward', { cards: r.cards.length });
              toast('Moved to the front of the review queue.');
            });
        });
      }
      row.appendChild(b);
      panel.appendChild(row);
    });
  }

  function renderSuggestions(panel) {
    var list = suggestions();
    if (!list.length) return;

    var head = document.createElement('h4');
    head.className = 'rv-head';
    head.textContent = 'From your notes · ' + list.length + ' suggested';
    panel.appendChild(head);

    var why = document.createElement('p');
    why.className = 'rv-note';
    why.style.marginTop = '10px';
    why.textContent = 'Every heading you wrote with something under it is already a question '
      + 'and an answer. Check one before you keep it — a card you did not read is a card you '
      + 'will not answer.';
    panel.appendChild(why);

    list.slice(0, 12).forEach(function (sg) {
      var row = document.createElement('div');
      row.className = 'deckrow';
      var main = document.createElement('div');
      main.className = 'dfront';
      main.textContent = sg.front;
      var meta = document.createElement('div');
      meta.className = 'dmeta';
      var chip = document.createElement('span');
      chip.className = 'due-chip new';
      chip.textContent = 'suggested';
      meta.appendChild(chip);
      var ex = document.createElement('span');
      ex.textContent = sg.back.slice(0, 90);
      meta.appendChild(ex);
      main.appendChild(meta);
      row.appendChild(main);

      var acts = document.createElement('div');
      acts.className = 'dacts';
      var keep = document.createElement('button');
      keep.type = 'button';
      keep.textContent = 'Review it';
      keep.addEventListener('click', function () { openCardDialog(null, sg, 'suggestion'); });
      acts.appendChild(keep);
      row.appendChild(acts);
      panel.appendChild(row);
    });
  }

  /* ---- card dialog ---- */
  var editingCard = null;
  var cardOrigin = 'manual';
  function openCardDialog(card, prefill, origin) {
    editingCard = card || null;
    cardOrigin = origin || 'manual';
    var src = card || prefill || {};
    $('cardHeading').textContent = card ? 'Edit card' : 'New card';
    $('cardFront').value = src.front || '';
    $('cardBack').value = src.back || '';
    $('cardDelete').hidden = !card;

    var subjectId = src.subjectId || state.activeSubject
      || (state.subjects[0] && state.subjects[0].id);
    var sel = $('cardSyllabus');
    sel.textContent = '';
    var blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Nothing in particular';
    sel.appendChild(blank);
    if (subjectId) syllabusOptions(subjectId).forEach(function (o) { sel.appendChild(o); });
    if (src.syllabusId) sel.value = src.syllabusId;

    // carried on the dialog so save doesn't have to re-derive them
    $('cardForm').dataset.subject = subjectId || '';
    $('cardForm').dataset.note = src.noteId || '';
    $('cardDialog').showModal();
  }

  function saveCard(e) {
    if (e) e.preventDefault();
    var front = $('cardFront').value.trim();
    var back = $('cardBack').value.trim();
    if (!front || !back) return;

    var job;
    if (editingCard) {
      editingCard.front = front;
      editingCard.back = back;
      editingCard.syllabusId = $('cardSyllabus').value || null;
      job = put('cards', stamp(editingCard));
    } else {
      job = put('cards', newCard({
        subjectId: $('cardForm').dataset.subject || null,
        syllabusId: $('cardSyllabus').value || null,
        noteId: $('cardForm').dataset.note || null,
        front: front, back: back
      }));
      track('card_made', { from: cardOrigin });
    }
    var wasEdit = !!editingCard;
    editingCard = null;
    job.then(refreshCards).then(function () {
      $('cardDialog').close();
      if (!$('review').hidden) renderReview();
      toast(wasEdit ? 'Card updated.' : 'Card added — it is due now.');
    });
  }

  function deleteCard() {
    if (!editingCard) return;
    if (!confirm('Delete this card? Its review history goes with it.')) return;
    var c = editingCard;
    editingCard = null;
    softDelete('cards', c).then(refreshCards).then(function () {
      $('cardDialog').close();
      if (!$('review').hidden) renderReview();
      toast('Card deleted.');
    });
  }

  /* Toolbar "+ Card": the selection is the raw material. A selection spanning a
     line break is read as question-then-answer; a single line is a front with the
     back left for the user to write, which is the honest default — only they know
     the answer they want to be able to produce. */
  function cardFromSelection() {
    var n = activeNoteObj();
    if (!n) return;
    var sel = window.getSelection();
    var text = sel && !sel.isCollapsed ? String(sel) : '';
    var front = '', back = '';
    if (text.trim()) {
      var parts = text.trim().split(/\n+/);
      if (parts.length > 1) {
        front = parts[0].trim();
        back = parts.slice(1).join('\n').trim();
      } else {
        front = parts[0].trim();
      }
    }
    openCardDialog(null, {
      front: front, back: back,
      subjectId: n.subjectId, syllabusId: n.syllabusId, noteId: n.id
    }, 'selection');
  }

  /* ============================================================
     12e · syllabus matching
     ------------------------------------------------------------
     Scores a piece of text against a subject's syllabus points and returns them
     ranked. Two things read from it: auto-filing ("which dot point is this note
     about?") and the assessment unpacker below.

     THERE IS NO MODEL HERE, AND THAT IS THE POINT. The obvious way to build
     auto-filing is to post the student's note to an API and ask. That means
     school-age users' private writing leaving the device, a consent question, a
     per-call cost, and no answer at all when the Wi-Fi is down — which for this
     app is most of a school day. But the syllabus the note has to be matched
     against is already sitting in IndexedDB, pasted in by the user. When you
     already hold the exact target text, ordinary information retrieval is the
     right tool, not a language model.

     HOW IT SCORES. Plain TF-IDF over the syllabus points as a corpus:

       - Every point becomes a document: its code, its title, and its parent
         topic's title (so a point called "Applications" still carries the word
         "biotechnology" from the module above it).
       - A term's weight is log(N / documents containing it), so syllabus verbs
         like "describe" and "analyse" cancel themselves out and rare, specific
         words — "frameshift", "equilibrium", "osmosis" — carry nearly all the
         signal.
       - IDF ALONE IS NOT ENOUGH AT THIS CORPUS SIZE, and this file used to claim
         it was. A subject has 10-40 dot points, not 10,000 documents, so a
         function word appearing in three of them scores log(10/3) = 1.2 — nearly
         as much as a real term. Measured (test/measure_matcher.js): a note
         reading "Group members: me, Sam, Priya. We are meeting at lunch on
         Tuesday" was confidently filed under "Recovery strategies and the
         physiological effects of fatigue", on the strength of the word "the" and
         nothing else. So there IS a function-word list now. It is short and it
         is only function words — nothing subject-specific, because the whole
         point is that the app never assumes what you are studying.
       - Scores are divided by sqrt(document length) so a long dot point cannot
         win on surface area alone.
       - An outcome code appearing literally in the text (BUS-11-03) is not a
         guess at all, so it short-circuits everything with a decisive score.

     WHAT IT IS NOT. It matches vocabulary, not meaning: a note that discusses a
     concept without ever naming it will not be found. That is why every caller
     presents the result as a *suggestion* with the score attached, and never
     files anything automatically.
     ============================================================ */
  var WORD = /[a-z0-9][a-z0-9'-]*/g;

  /* Function words only. Deliberately NOT a general English stopword list and
     deliberately nothing topical: "cell", "force" and "acid" are function words
     in no subject and content words in several. Anything removed here is removed
     for every student of every subject, so the bar is "carries no topical signal
     in any subject at all". */
  var FUNCTION_WORDS = {
    the: 1, and: 1, for: 1, are: 1, with: 1, that: 1, this: 1, from: 1, its: 1,
    can: 1, has: 1, have: 1, was: 1, were: 1, been: 1, being: 1, but: 1, not: 1,
    all: 1, any: 1, out: 1, into: 1, over: 1, than: 1, then: 1, they: 1, them: 1,
    their: 1, there: 1, these: 1, those: 1, which: 1, when: 1, what: 1, how: 1,
    who: 1, why: 1, you: 1, your: 1, our: 1, his: 1, her: 1, him: 1, she: 1,
    including: 1, include: 1, such: 1, also: 1, each: 1, other: 1, more: 1,
    most: 1, some: 1, only: 1, both: 1, will: 1, would: 1, should: 1, could: 1
  };
  /* A real outcome code carries two number groups (BUS-11-03, BIO 12 06) or a
     letter-number tail (MA-C1). An earlier, looser pattern also matched "TASK 3",
     which then short-circuited the scoring with a fake certainty — worse than
     missing the code entirely. */
  var CODEISH = /\b[A-Z]{2,5}[-\s]\d{1,2}[-\s][A-Z]?\d{1,2}\b|\b[A-Z]{2,5}-[A-Z]\d{1,2}\b/g;

  /* Light suffix stripping, not a real stemmer. Without it "mutations" in a note
     never meets "Mutation" in the syllabus, which was the most common way this
     matcher missed. Deliberately conservative — over-stemming collapses distinct
     terms and costs more than the plurals it fixes. */
  function stem(w) {
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (w.length > 4 && /(sses|shes|ches|xes)$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && /[^s]s$/.test(w)) return w.slice(0, -1);
    if (w.length > 5 && /ing$/.test(w)) return w.slice(0, -3);
    if (w.length > 4 && /ed$/.test(w)) return w.slice(0, -2);
    return w;
  }

  function tokenise(text) {
    var out = [];
    var m = String(text || '').toLowerCase().match(WORD);
    if (!m) return out;
    for (var i = 0; i < m.length; i++) {
      // two-letter words carry almost no topical signal and add noise
      if (m[i].length < 3) continue;
      if (FUNCTION_WORDS[m[i]]) continue;
      out.push(stem(m[i]));
    }
    return out;
  }

  /* The searchable text of a point: its own code and title, plus its parent's
     title so inherited context counts. */
  function pointText(node) {
    var parent = node.parentId ? nodeById(node.parentId) : null;
    return [node.code || '', node.title || '', parent ? parent.title : ''].join(' ');
  }

  function buildIndex(subjectId) {
    var points = [];
    topicsOf(subjectId).forEach(function (t) {
      childrenOf(t.id).forEach(function (p) { points.push(p); });
    });
    var docs = points.map(function (p) {
      var terms = {};
      tokenise(pointText(p)).forEach(function (w) { terms[w] = (terms[w] || 0) + 1; });
      var len = 0;
      for (var k in terms) if (terms.hasOwnProperty(k)) len += terms[k];
      return { node: p, terms: terms, len: Math.max(1, len) };
    });
    var df = {};
    docs.forEach(function (d) {
      for (var w in d.terms) if (d.terms.hasOwnProperty(w)) df[w] = (df[w] || 0) + 1;
    });
    return { docs: docs, df: df, n: docs.length };
  }

  /* Returns [{node, score, matched:[terms], byCode:bool}], best first.
     Scores are relative, not probabilities — only their order and their gap
     to the runner-up mean anything. */
  function matchSyllabus(text, subjectId, limit) {
    var idx = buildIndex(subjectId);
    if (!idx.n) return [];

    // an outcome code written out is a statement, not a guess
    var codes = {};
    (String(text || '').toUpperCase().match(CODEISH) || []).forEach(function (c) {
      codes[c.replace(/[\s-]/g, '')] = true;
    });

    var qTerms = {};
    tokenise(text).forEach(function (w) { qTerms[w] = true; });

    var scored = idx.docs.map(function (d) {
      var code = (d.node.code || '').toUpperCase().replace(/[\s-]/g, '');
      if (code && codes[code]) {
        return { node: d.node, score: 1000, matched: [d.node.code], byCode: true };
      }
      var s = 0, hit = [];
      for (var w in qTerms) {
        if (!qTerms.hasOwnProperty(w) || !d.terms[w]) continue;
        var idf = Math.log(idx.n / idx.df[w]);
        if (idf <= 0) continue;                 // in every point: no signal
        s += idf * d.terms[w];
        hit.push(w);
      }
      return { node: d.node, score: s / Math.sqrt(d.len), matched: hit, byCode: false };
    });

    return scored
      .filter(function (r) { return r.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, limit || 5);
  }

  /* ============================================================
     12f · unpacking an assessment notification
     ------------------------------------------------------------
     The wedge. Every student gets a task sheet weeks out — outcomes, weighting,
     format, due date — and working out what to actually study from it is a real
     weekly problem that no generic study app can solve, because it needs the
     student's own school's paperwork.

     Deliberately a plain-text paste rather than OCR or a file upload: the text
     never leaves the device, it works offline, and a screenshot of a task sheet
     is something a student can produce in seconds anyway. OCR is the same
     pipeline with a different front door and can be added later.
     ============================================================ */
  var DUE_RE = /\b(?:due|submission|hand\s*in)\b[^\n]*?(\d{1,2}\s*(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}(?:\s+\d{2,4})?|\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?)/i;
  var WEIGHT_RE = /\b(?:weight(?:ing)?|worth|value)\b[^\n]*?(\d{1,3})\s*%|(\d{1,3})\s*%[^\n]{0,20}\b(?:weight|of\s+(?:the\s+)?course|total)/i;
  var WORDS_RE = /\b(\d{3,5})\s*words?\b/i;
  var FORMAT_RE = /\b(essay|report|presentation|practical|prac|investigation|depth study|multiple choice|examination|exam|oral|portfolio|test)\b/i;

  function parseTask(text) {
    var t = String(text || '');
    var due = t.match(DUE_RE);
    var w = t.match(WEIGHT_RE);
    var words = t.match(WORDS_RE);
    var fmt = t.match(FORMAT_RE);
    var codes = [];
    var seen = {};
    (t.toUpperCase().match(CODEISH) || []).forEach(function (c) {
      var k = c.replace(/[\s-]/g, '');
      if (!seen[k]) { seen[k] = true; codes.push(c.trim()); }
    });
    return {
      due: due ? due[1].trim() : null,
      weight: w ? (w[1] || w[2]) + '%' : null,
      words: words ? words[1] : null,
      format: fmt ? fmt[1].toLowerCase() : null,
      codes: codes
    };
  }

  /* ============================================================
     12g · confidence per syllabus point
     ------------------------------------------------------------
     One reading per dot point that every other feature can consult: coverage,
     the review queue, Tasks, and later anything that recommends what to study.

     DERIVED, NEVER STORED. The obvious design is a `confidence` field updated
     whenever something happens. That creates a number that can drift out of step
     with the evidence, needs its own migration and sync path, and is impossible
     to explain when it looks wrong. Computing it on demand from cards and notes
     means it cannot be stale and every value can name its own evidence.

     BANDS, NOT PERCENTAGES. A number like "73% confident" reads exactly like the
     predicted mark this project has promised never to show, and it implies a
     precision the underlying data cannot support — a handful of self-graded
     cards is not a measurement. Four honest bands instead, each with the
     evidence attached.

     ABSENCE IS NOT WEAKNESS. A point with nothing written is "untouched", not
     "weak". Those are different facts and conflating them would make the whole
     reading dishonest: you cannot be bad at something you have never attempted.
     ============================================================ */
  function confidenceOf(nodeId) {
    var cards = state.cards.filter(function (c) { return c.syllabusId === nodeId; });
    var notes = notesOfNode(nodeId).filter(function (n) { return n.kind === 'personal'; });

    if (!cards.length && !notes.length) {
      return { band: 'untouched', label: 'Nothing written', score: null,
               notes: 0, cards: 0, due: 0 };
    }

    var due = cards.filter(function (c) { return (c.due || 0) <= Date.now(); }).length;
    var reviewed = cards.filter(function (c) { return c.reps > 0; });

    /* Only reviewed cards say anything. A deck of new cards means work has been
       prepared, not that it is known. */
    var score;
    if (!reviewed.length) {
      score = notes.length ? 0.25 : 0.15;
    } else {
      var sum = 0;
      reviewed.forEach(function (c) {
        // ease spans 1.3 (constantly failed) to ~2.8 (easy); reps cap at 5
        var byEase = Math.max(0, Math.min(1, ((c.ease || 2.5) - 1.3) / 1.5));
        var byReps = Math.min(1, (c.reps || 0) / 5);
        var lapsePenalty = Math.min(0.4, (c.lapses || 0) * 0.12);
        sum += Math.max(0, (byEase * 0.5 + byReps * 0.5) - lapsePenalty);
      });
      score = sum / reviewed.length;
      // overdue cards mean the reading is going stale, whatever it was
      if (due) score *= Math.max(0.6, 1 - (due / cards.length) * 0.4);
    }

    var band = score >= 0.7 ? 'solid' : (score >= 0.4 ? 'building' : 'shaky');
    var label = band === 'solid' ? 'Holding' : (band === 'building' ? 'Building' : 'Shaky');
    return { band: band, label: label, score: score,
             notes: notes.length, cards: cards.length, due: due };
  }

  /* Plain-English evidence for a reading, so it is never a bare verdict. */
  function confidenceWhy(c) {
    if (c.band === 'untouched') return 'No notes and no cards here yet.';
    var bits = [];
    bits.push(c.notes ? c.notes + (c.notes === 1 ? ' note' : ' notes') : 'no notes');
    bits.push(c.cards ? c.cards + (c.cards === 1 ? ' card' : ' cards') : 'no cards');
    if (c.due) bits.push(c.due + ' due for review');
    return bits.join(' · ');
  }

  /* ============================================================
     12h · auto-filing
     ------------------------------------------------------------
     An unfiled note is offered the dot point it most likely belongs to. Runs on
     the same local matcher as Tasks — no model, no network, nothing leaves the
     device, and it works with no signal.

     ALWAYS A SUGGESTION, NEVER AN ACTION. It files nothing on its own. The
     matcher reads vocabulary, not meaning, so it is confidently wrong often
     enough that silent filing would scatter someone's notes into places they
     never chose and would not think to look.
     ============================================================ */
  var MIN_SUGGEST = 0.35;   // below this the top hit is usually noise

  function suggestFiling(note) {
    if (!note || note.syllabusId || !note.subjectId) return null;
    var text = (note.title || '') + ' ' + plain(note.body || '');
    if (text.trim().length < 25) return null;      // too little to judge
    var hits = matchSyllabus(text, note.subjectId, 2);
    if (!hits.length || hits[0].score < MIN_SUGGEST) return null;
    /* One word in common is a coincidence, not evidence. Measured: a note
       describing translation without using any of its vocabulary ("reads the code
       three letters at a time") was filed under mitosis on the strength of the
       single word "cell"; one about the ATP-PC system went to the muscular system
       on "muscle" alone. Both are cases where the honest answer is silence, and
       requiring a second distinct term is what produces it. Applied here rather
       than in matchSyllabus so the ranking the task unpacker shows is unchanged —
       that view lists several candidates and labels them as inferred. */
    if ((hits[0].matched || []).length < 2 && !hits[0].byCode) return null;
    // a near-tie is not a suggestion, it is a coin toss
    if (hits[1] && hits[1].score > hits[0].score * 0.8) return null;
    return hits[0];
  }

  function renderFilingHint(note) {
    var box = $('fileHint');
    if (!box) return;
    var hit = suggestFiling(note);
    if (!hit) { box.hidden = true; return; }

    box.textContent = '';
    box.hidden = false;

    var t = document.createElement('span');
    t.className = 'fh-text';
    t.textContent = 'Looks like ' + (hit.node.code ? hit.node.code + ' · ' : '') + hit.node.title;
    box.appendChild(t);

    var why = document.createElement('span');
    why.className = 'fh-why';
    why.textContent = 'matched: ' + hit.matched.slice(0, 3).join(', ');
    box.appendChild(why);

    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'fh-yes';
    yes.textContent = 'File it here';
    yes.addEventListener('click', function () {
      var n = activeNoteObj();
      if (!n) return;
      n.syllabusId = hit.node.id;
      put('notes', stamp(n)).then(function () { return refresh({ keepEditor: true }); })
        .then(function () {
          renderSyllabusPicker(n);
          renderCrumb(n);
          box.hidden = true;
          toast('Filed against ' + (hit.node.code || hit.node.title) + '.');
        });
    });
    box.appendChild(yes);

    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'fh-no';
    no.textContent = 'Not this';
    no.addEventListener('click', function () { box.hidden = true; });
    box.appendChild(no);
  }

  /* ============================================================
     12i · past you
     ------------------------------------------------------------
     The same dot point, written twice, months apart. Nothing else in this app
     shows the distance between those two: the notebook lists them by date and
     the coverage bar counts them as "2", which says nothing about whether the
     second one is any better than the first.

     ONLY WHEN THE GAP IS REAL. Two notes written in the same week are one
     piece of thinking split across two files, and showing them as "past you"
     would be flattery dressed up as progress. The gap has to be long enough
     that you would genuinely have moved on in between, which is why this is
     silent for most notes most of the time — and it should be. A prompt that
     fires constantly is one nobody reads.

     It never claims you have improved. It shows you what you wrote and lets
     you be the judge; the app has no way to grade the difference and should
     not pretend otherwise.
     ============================================================ */
  var PAST_YOU_DAYS = 21;

  /* Pure, so the rules above are testable without a DOM: same dot point, not
     this note, not a capture, and genuinely older. Oldest wins — the earliest
     thing you wrote on a point is the honest baseline to measure against, and
     picking "any older note" would show a different one every time the list
     re-sorted. */
  function pastYouFrom(notes, note, gapDays) {
    if (!note || !note.syllabusId) return null;
    var cutoff = (note.updated || 0) - (gapDays || PAST_YOU_DAYS) * 86400000;
    var best = null;
    (notes || []).forEach(function (n) {
      if (!n || n.id === note.id) return;
      if (n.kind === 'capture') return;
      if (n.syllabusId !== note.syllabusId) return;
      if (!(n.updated < cutoff)) return;
      if (!best || n.updated < best.updated) best = n;
    });
    return best;
  }

  function pastYou(note) {
    if (!note || !note.syllabusId) return null;
    /* Narrow to the dot point first so plain() — which builds a DOM node —
       runs over a handful of notes rather than the whole notebook. */
    var sameNode = state.notes.filter(function (n) {
      return n.syllabusId === note.syllabusId
        && ((n.title || '').trim() || plain(n.body || ''));
    });
    return pastYouFrom(sameNode, note);
  }

  function renderPastYou(note) {
    var box = $('pastYou');
    if (!box) return;
    var old = note ? pastYou(note) : null;
    if (!old) { box.hidden = true; return; }

    box.textContent = '';
    box.hidden = false;

    var days = Math.round(((note.updated || Date.now()) - old.updated) / 86400000);
    var span = days >= 60 ? Math.round(days / 30) + ' months'
             : days >= 14 ? Math.round(days / 7) + ' weeks'
             : days + ' days';

    var t = document.createElement('span');
    t.className = 'fh-text';
    t.textContent = 'You wrote about this ' + span + ' ago, on ' + when(old.updated) + '.';
    box.appendChild(t);

    var why = document.createElement('span');
    why.className = 'fh-why';
    why.textContent = (old.title || plain(old.body || '')).slice(0, 60);
    box.appendChild(why);

    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'fh-yes';
    open.textContent = 'Read it';
    /* Deliberately not tracked. A new analytics event costs a hand-applied
       migration (the CHECK constraint in 0012) on both prod and dev, and
       this feature does not need a number to justify itself. */
    open.addEventListener('click', function () {
      box.hidden = true;
      openNote(old.id);
    });
    box.appendChild(open);

    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'fh-no';
    no.textContent = 'Later';
    no.addEventListener('click', function () { box.hidden = true; });
    box.appendChild(no);
  }

  /* ---- the Tasks panel ---- */
  function renderTkSubjects() {
    var sel = $('tkSubject');
    var want = sel.value || state.activeSubject;
    sel.textContent = '';
    state.subjects.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id; o.textContent = s.name;
      sel.appendChild(o);
    });
    if (want && subjectById(want)) sel.value = want;
    var none = !state.subjects.length;
    sel.disabled = none;
    $('tkGo').disabled = none;
    $('tkInput').disabled = none;
  }

  function renderTasks() {
    renderTkSubjects();
    renderPlan();
    var body = $('tkBody');
    body.textContent = '';

    if (!state.subjects.length) {
      body.appendChild(note('Add a subject and paste its syllabus first. This works by '
        + 'matching the task against the syllabus you already gave it — with no syllabus '
        + 'there is nothing to match against.'));
      return;
    }
    body.appendChild(note('Paste the notification your school sent you. Nexley pulls out the '
      + 'due date, weighting and format, works out which syllabus points it marks you '
      + 'against, and shows how much you have actually written on each.'));
  }

  /* The first line that reads like a name. Sheets usually open with the school,
     the subject and the year before they say what the task is, so the first line
     is often useless — but guessing harder than "the first substantial line" would
     be guessing, and this lands in an editable field. */
  /* NSW sheets almost always open with the year level and the subject before
     they say what the task actually is, and "Year 11 Human Movement" is useless
     as a deadline in a plan. Narrow rule, deliberately: skip the lines that are
     unambiguously headers, take the next real one, and let the student fix it in
     the dialog — this lands in an editable field, not straight into the plan. */
  var HEADERISH = /^(year|stage|yr)\s*\d+\b|^(term|semester)\s*\d+\b|^assessment (notification|task sheet)$/i;
  function taskTitle(text) {
    var lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (l.length < 4 || l.length > 80) continue;
      if (HEADERISH.test(l)) continue;
      return l;
    }
    return 'Assessment task';
  }

  function note(text) {
    var p = document.createElement('p');
    p.className = 'rv-note';
    p.textContent = text;
    return p;
  }

  function unpackTask() {
    var text = $('tkInput').value.trim();
    var subjectId = $('tkSubject').value;
    var body = $('tkBody');
    body.textContent = '';
    if (!text || !subjectId) return;

    var t = parseTask(text);
    var topics = topicsOf(subjectId);
    var hasSyllabus = topics.some(function (x) { return childrenOf(x.id).length; });

    // the facts it found, each shown only if actually present — a blank is more
    // honest than a confident-looking "—" that reads like a real answer
    var facts = document.createElement('div');
    facts.className = 'rv-stats';
    [[t.due, 'Due'], [t.weight, 'Weighting'], [t.format, 'Format'],
     [t.words ? t.words + ' words' : null, 'Length']].forEach(function (pair) {
      if (!pair[0]) return;
      var d = document.createElement('div');
      d.className = 'rv-stat';
      var b = document.createElement('b');
      b.textContent = pair[0];
      b.style.fontSize = 'var(--t-xl)';
      var sp = document.createElement('span');
      sp.textContent = pair[1];
      d.appendChild(b); d.appendChild(sp);
      facts.appendChild(d);
    });
    if (facts.children.length) body.appendChild(facts);
    else body.appendChild(note('No due date, weighting or format found in that text — '
      + 'the outcomes below are still matched on wording.'));

    /* The unpacker used to be a dead end: it told you what the task covered and
       then forgot it existed. This is the join to the plan. It opens the dialog
       prefilled rather than saving straight away, because the date and the title
       are inferred and a student should see them before they become a deadline. */
    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn primary tk-save';
    save.textContent = 'Save this to the plan';
    save.addEventListener('click', function () {
      openCommitmentDialog(null, {
        title: taskTitle(text),
        subjectId: subjectId,
        /* null, not Date.now() — parseDueDate already chose to say "I don't
           know" rather than guess (see its own comment), and silently
           substituting today here would undo exactly that. Same treatment as
           hours below: an unknown stays unknown into the dialog. */
        due: parseDueDate(t.due),
        weight: parseWeightPct(t.weight),
        hours: null
      });
    });
    body.appendChild(save);

    if (!hasSyllabus) {
      body.appendChild(note('This subject has no syllabus yet, so there is nothing to map '
        + 'the task onto. Add it from the notebook and paste this again.'));
      return;
    }

    /* Codes named in the sheet are facts. Everything else is inference from
       wording, and is labelled as such — the difference matters when a student is
       deciding what to spend a week on. */
    var byCode = [], byText = [];
    matchSyllabus(text, subjectId, 8).forEach(function (r) {
      (r.byCode ? byCode : byText).push(r);
    });
    // how many outcomes the matcher actually found — the number that says whether
    // local matching is good enough, with none of the text it matched against
    track('task_unpacked', { matched: byCode.length + byText.length });

    if (byCode.length) {
      body.appendChild(head('Outcomes this task names', byCode.length + ' stated on the sheet'));
      byCode.forEach(function (r) { body.appendChild(outcomeRow(r, true)); });
    }
    if (byText.length) {
      body.appendChild(head('Also looks relevant', 'matched on wording, not stated'));
      byText.slice(0, 5).forEach(function (r) { body.appendChild(outcomeRow(r, false)); });
    }
    if (!byCode.length && !byText.length) {
      body.appendChild(note('Nothing in that text matched this subject’s syllabus. Check '
        + 'the right subject is selected, or paste more of the sheet — the outcome list is '
        + 'usually the most useful part.'));
      return;
    }

    // the actual advice: where the weighting is at risk
    var thin = byCode.concat(byText).filter(function (r) {
      return notesOfNode(r.node.id).filter(function (n) { return n.kind === 'personal'; }).length === 0;
    });
    if (thin.length) {
      var warn = document.createElement('div');
      warn.className = 'gap';
      warn.style.marginTop = 'var(--s-6)';
      var k = document.createElement('span');
      k.className = 'k';
      k.textContent = 'Where the marks are at risk';
      var p = document.createElement('p');
      p.textContent = thin.length === 1
        ? 'You have written nothing on ' + (thin[0].node.code || thin[0].node.title)
          + '. That is what this task is marked against.'
        : 'You have written nothing on ' + thin.length + ' of the areas this task covers'
          + (t.weight ? ' — and it is worth ' + t.weight + '.' : '.');
      warn.appendChild(k); warn.appendChild(p);
      body.appendChild(warn);
    }
  }

  function head(title, sub) {
    var h = document.createElement('h4');
    h.style.cssText = 'font-family:var(--code);font-size:var(--t-xs);letter-spacing:.11em;'
      + 'text-transform:uppercase;color:var(--muted);font-weight:400;'
      + 'margin:var(--s-7) 0 var(--s-2);padding-bottom:var(--s-3);'
      + 'border-bottom:1px solid var(--rule-soft)';
    h.textContent = sub ? title + ' · ' + sub : title;
    return h;
  }

  function outcomeRow(r, stated) {
    var row = document.createElement('div');
    row.className = 'deckrow';

    var main = document.createElement('div');
    main.className = 'dfront';
    main.textContent = r.node.title;

    var meta = document.createElement('div');
    meta.className = 'dmeta';

    var chip = document.createElement('span');
    chip.className = 'due-chip' + (stated ? ' new' : '');
    chip.textContent = r.node.code || 'point';
    meta.appendChild(chip);

    var mine = notesOfNode(r.node.id).filter(function (n) { return n.kind === 'personal'; });
    var cov = document.createElement('span');
    if (mine.length) {
      cov.textContent = mine.length + (mine.length === 1 ? ' note written' : ' notes written');
    } else {
      cov.textContent = 'nothing written yet';
      cov.style.color = 'var(--warn)';
    }
    meta.appendChild(cov);

    if (!stated && r.matched.length) {
      var why = document.createElement('span');
      why.textContent = 'matched: ' + r.matched.slice(0, 3).join(', ');
      meta.appendChild(why);
    }
    main.appendChild(meta);
    row.appendChild(main);

    var acts = document.createElement('div');
    acts.className = 'dacts';
    var go = document.createElement('button');
    go.type = 'button';
    go.textContent = mine.length ? 'Open notes' : 'Start a note';
    go.addEventListener('click', function () {
      setMode('notebook');
      state.activeSubject = r.node.subjectId;
      if (mine.length) openNote(mine[0].id);
      else newNote(r.node.id);
    });
    acts.appendChild(go);
    row.appendChild(acts);
    return row;
  }

  /* ============================================================
     12g2 · term planning
     ------------------------------------------------------------
     Tasks could already unpack a notification into the syllabus points it tests,
     but it never saved anything, so nothing could answer the question a student
     actually has in week 4: is what is coming physically possible.

     WHAT THIS DOES AND DOES NOT CLAIM. Hours are attributed to the week a thing
     is DUE. That is a fact about a deadline, not a model of when you would do
     the work — the app has no idea when you would start, and pretending to know
     would produce a confident schedule built on an invented assumption. What it
     can say honestly is: this much work has to be FINISHED by this week, and if
     that is more than a week holds, it cannot all start in that week.

     Which is the real finding, and the reason for the framing: a week with 14
     hours landing in it is not a sign you are behind. It is a sign you were
     over-committed weeks ago, and the only fix available now is to start earlier.
     ============================================================ */
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  /* parseTask returns what the sheet SAID — "12 September", "20%" — because that
     is the honest thing to show next to the words it came from. The planner needs
     a date and a number, so the conversion happens here, at the boundary, and
     returns null rather than guessing when it cannot tell.

     THE YEAR PROBLEM: a notification almost never states one. Assuming the
     current year puts a December task in the past every January, and assuming
     next year puts a February task eleven months away. So: nearest future
     occurrence, and the date lands in the dialog where it can be corrected
     before anything is saved — a wrong guess is visible, not silent. */
  function parseDueDate(str, now) {
    if (!str) return null;
    var t = String(str).toLowerCase().trim();
    now = now || Date.now();
    var today = new Date(now);
    var day = null, month = null, year = null;

    var m = t.match(/^(\d{1,2})\s*(?:st|nd|rd|th)?\s+([a-z]{3,9})(?:\s+(\d{2,4}))?$/);
    if (m) {
      day = parseInt(m[1], 10);
      month = MONTHS.indexOf(m[2].slice(0, 3));
      if (m[3]) year = parseInt(m[3].length === 2 ? '20' + m[3] : m[3], 10);
    } else {
      // 12/9, 12-9-2026, 12.9.26 — day first, which is what an Australian sheet means
      m = t.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?$/);
      if (!m) return null;
      day = parseInt(m[1], 10);
      month = parseInt(m[2], 10) - 1;
      if (m[3]) year = parseInt(m[3].length === 2 ? '20' + m[3] : m[3], 10);
    }
    if (month < 0 || month > 11 || !day || day > 31) return null;

    if (year === null) {
      year = today.getFullYear();
      var candidate = new Date(year, month, day, 12, 0, 0);
      // more than a week in the past almost certainly means next year
      if (candidate.getTime() < now - 7 * 24 * 3600 * 1000) year++;
    }
    var d = new Date(year, month, day, 12, 0, 0);
    if (d.getDate() !== day || d.getMonth() !== month) return null;   // 31 Feb
    return d.getTime();
  }

  function parseWeightPct(str) {
    if (!str) return null;
    var m = String(str).match(/(\d+(?:\.\d+)?)/);
    if (!m) return null;
    var v = parseFloat(m[1]);
    return (isNaN(v) || v < 0 || v > 100) ? null : v;
  }

  var CAPACITY_KEY = 'nexley-hours-per-week';
  var DEFAULT_CAPACITY = 10;

  /* Per-device on purpose. How many hours you have in a week is a fact about
     your life this term, not study content — it is one number, re-entered in a
     tap, and it is genuinely different on a laptop you use at school and an
     iPad you use at home. Nothing is lost if it never syncs. */
  function capacity() {
    try {
      var v = parseFloat(localStorage.getItem(CAPACITY_KEY));
      if (!isNaN(v) && v > 0) return v;
    } catch (e) {}
    return DEFAULT_CAPACITY;
  }
  function setCapacity(v) {
    try { localStorage.setItem(CAPACITY_KEY, String(v)); } catch (e) {}
  }

  // Monday 00:00 local. Local, not UTC: a Sunday-night deadline in Sydney must
  // not land in the following week because the timestamp crossed midnight in UTC.
  function weekStartOf(ms) {
    var d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    var day = (d.getDay() + 6) % 7;   // Monday = 0
    d.setDate(d.getDate() - day);
    return d.getTime();
  }
  var WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  /* Unestimated commitments are counted but NOT added to the hours. A week
     reading "9 hours, plus 2 not estimated" is true. The same week reading
     "9 hours" is a lie by omission, and it is the one that gets someone to
     Friday having planned around a number that was never real. */
  function planWeeks(commitments, fromMs, weeks) {
    var start = weekStartOf(fromMs);
    var out = [];
    for (var i = 0; i < weeks; i++) {
      var wStart = start + i * WEEK_MS;
      var wEnd = wStart + WEEK_MS;
      var items = commitments.filter(function (c) {
        return !c.done && c.due >= wStart && c.due < wEnd;
      }).sort(function (a, b) { return a.due - b.due; });

      var hours = 0, unestimated = 0;
      items.forEach(function (c) {
        if (c.hours === null || c.hours === undefined) unestimated++;
        else hours += c.hours;
      });

      out.push({
        start: wStart, end: wEnd, items: items,
        hours: Math.round(hours * 100) / 100,
        unestimated: unestimated,
        count: items.length
      });
    }
    return out;
  }

  // over capacity means the work cannot all fit in the week it is due in — it
  // has to start earlier. It does not mean you are behind.
  function isOverCommitted(week, cap) {
    return week.hours > cap;
  }

  function renderPlan() {
    var body = $('tkPlan');
    if (!body) return;
    body.textContent = '';

    var live2 = state.commitments.filter(function (c) { return !c.done; });
    if (!live2.length) {
      body.appendChild(note('Nothing saved yet. Unpack a notification above and save it, or '
        + 'add one by hand — once Nexley knows what is coming it can tell you which weeks '
        + 'do not fit.'));
      return;
    }

    var cap = capacity();
    var weeks = planWeeks(state.commitments, Date.now(), 8);

    var head2 = document.createElement('div');
    head2.className = 'pl-head';
    var lab = document.createElement('label');
    lab.className = 'pl-cap';
    var sp = document.createElement('span');
    sp.textContent = 'Hours a week you actually have';
    var inp = document.createElement('input');
    inp.type = 'number';
    inp.min = '1'; inp.max = '80'; inp.step = '1';
    inp.value = cap;
    inp.addEventListener('change', function () {
      var v = parseFloat(this.value);
      if (!isNaN(v) && v > 0) { setCapacity(v); renderPlan(); }
    });
    lab.appendChild(sp); lab.appendChild(inp);
    head2.appendChild(lab);
    body.appendChild(head2);

    var any = false;
    weeks.forEach(function (w) {
      if (!w.count) return;
      any = true;
      body.appendChild(weekBlock(w, cap));
    });

    if (!any) {
      body.appendChild(note('Nothing due in the next eight weeks. That is not a trap — it '
        + 'is just what you have told Nexley about so far.'));
    }

    var later = live2.filter(function (c) { return c.due >= weekStartOf(Date.now()) + 8 * WEEK_MS; });
    if (later.length) {
      body.appendChild(note(later.length + (later.length === 1 ? ' task is' : ' tasks are')
        + ' further out than eight weeks and are not shown above.'));
    }
  }

  function weekBlock(w, cap) {
    var over = isOverCommitted(w, cap);

    var wrap = document.createElement('section');
    wrap.className = 'pl-week' + (over ? ' over' : '');

    var head2 = document.createElement('header');
    head2.className = 'pl-whead';

    var when2 = document.createElement('b');
    when2.textContent = weekLabel(w.start);
    head2.appendChild(when2);

    var load = document.createElement('span');
    load.className = 'pl-load';
    var bits = [];
    if (w.hours) bits.push(trimNum(w.hours) + 'h due');
    if (w.unestimated) bits.push(w.unestimated + ' not estimated');
    if (!bits.length) bits.push(w.count + (w.count === 1 ? ' task' : ' tasks'));
    load.textContent = bits.join(' · ');
    head2.appendChild(load);

    wrap.appendChild(head2);

    if (over) {
      /* The sentence the whole phase exists for. It is not "you are behind" —
         nothing here knows whether you are behind. It is a fact about arithmetic. */
      var warn = document.createElement('p');
      warn.className = 'pl-over';
      warn.textContent = trimNum(w.hours) + ' hours have to be finished this week and you have '
        + trimNum(cap) + '. You are not behind — this week was over-committed the day these '
        + 'were set. It has to start earlier.';
      wrap.appendChild(warn);
    }

    w.items.forEach(function (c) { wrap.appendChild(commitmentRow(c)); });
    return wrap;
  }

  function weekLabel(startMs) {
    var thisWeek = weekStartOf(Date.now());
    if (startMs === thisWeek) return 'This week';
    if (startMs === thisWeek + WEEK_MS) return 'Next week';
    var d = new Date(startMs);
    return 'Week of ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function commitmentRow(c) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'pl-row';
    row.addEventListener('click', function () { openCommitmentDialog(c); });

    var dot = document.createElement('i');
    dot.className = 'dot';
    var subj = subjectById(c.subjectId);
    dot.style.background = subj ? subj.colour : 'var(--muted)';
    row.appendChild(dot);

    var title = document.createElement('span');
    title.className = 'pl-title';
    title.textContent = c.title;
    row.appendChild(title);

    if (c.weight !== null && c.weight !== undefined) {
      var w = document.createElement('span');
      w.className = 'mk-weight';
      w.textContent = trimNum(c.weight) + '%';
      row.appendChild(w);
    }

    var hrs = document.createElement('span');
    hrs.className = 'pl-hours';
    hrs.textContent = (c.hours === null || c.hours === undefined) ? 'no estimate' : trimNum(c.hours) + 'h';
    if (c.hours === null || c.hours === undefined) hrs.classList.add('none');
    row.appendChild(hrs);

    var due = document.createElement('span');
    due.className = 'pl-due';
    due.textContent = new Date(c.due).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    row.appendChild(due);

    return row;
  }

  /* ---------- add / edit a commitment ---------- */

  var editingCommitment = null;

  function openCommitmentDialog(c, prefill) {
    editingCommitment = c || null;
    var p2 = c || prefill || {};
    $('cmHeading').textContent = c ? 'Edit this task' : 'Add a task';
    $('cmTitle').value = p2.title || '';
    /* Today is a fine default for a blank "+ Add a task" — the user sees it
       and can change it. It is NOT fine when a prefill (from the unpacker)
       was attempted and came back with no date: that means the text genuinely
       didn't say, and defaulting to today would show a guess as if it had
       been read off the notification. Leave the field empty instead, so
       saveCommitment's own check makes the student pick a real one. */
    $('cmDate').value = p2.due ? isoDay(p2.due) : ((c || prefill) ? '' : isoDay(Date.now()));
    $('cmWeight').value = (p2.weight === null || p2.weight === undefined) ? '' : p2.weight;
    $('cmHours').value = (p2.hours === null || p2.hours === undefined) ? '' : p2.hours;
    $('cmDone').checked = !!p2.done;
    $('cmDoneRow').hidden = !c;
    $('cmDelete').hidden = !c;
    $('cmError').hidden = true;
    renderCmSubjects(p2.subjectId);
    $('cmDialog').showModal();
    setTimeout(function () { $('cmTitle').focus(); }, 60);
  }

  function renderCmSubjects(want) {
    var sel = $('cmSubject');
    sel.textContent = '';
    state.subjects.forEach(function (s2) {
      var o = document.createElement('option');
      o.value = s2.id; o.textContent = s2.name;
      sel.appendChild(o);
    });
    if (want && subjectById(want)) sel.value = want;
    else if ($('tkSubject').value) sel.value = $('tkSubject').value;
  }

  function cmFail(msg) {
    var e = $('cmError');
    e.textContent = msg;
    e.hidden = false;
    return false;
  }

  function saveCommitment() {
    var title = $('cmTitle').value.trim();
    if (!title) return cmFail('What is it called? "Depth study" is enough.');

    /* dayToMs('') falls back to today, which is right for its OTHER caller
       (a paper defaults to "sat today" until you change it) but wrong here:
       an empty due date reaching that fallback would silently turn "I don't
       know" into a specific, wrong deadline. Catch it here instead. */
    if (!$('cmDate').value) {
      return cmFail("When is this due? Nexley can't slot it into a week without a date.");
    }

    var weightRaw = $('cmWeight').value.trim();
    var weight = weightRaw === '' ? null : parseFloat(weightRaw);
    if (weight !== null && (isNaN(weight) || weight < 0 || weight > 100)) {
      return cmFail('Weighting is a percentage of the course, 0 to 100. Leave it blank if you do not know.');
    }

    var hoursRaw = $('cmHours').value.trim();
    /* Blank stays blank. It is tempting to default this to something so the
       weekly total looks complete, but an invented estimate is exactly what makes
       a planner untrustworthy — and the app already handles "not estimated"
       properly, so there is nothing to gain by faking it. */
    var hours = hoursRaw === '' ? null : parseFloat(hoursRaw);
    if (hours !== null && (isNaN(hours) || hours < 0 || hours > 500)) {
      return cmFail('Hours should be a number of hours. Leave it blank if you have no idea yet.');
    }

    var rec = editingCommitment || { id: uid() };
    rec.subjectId = $('cmSubject').value || null;
    rec.title = title;
    rec.due = dayToMs($('cmDate').value);
    rec.weight = weight;
    rec.hours = hours;
    rec.done = $('cmDone').checked;
    rec.notes = rec.notes || null;

    put('commitments', stamp(rec))
      .then(function () { $('cmDialog').close(); return refresh(); })
      .then(function () {
        renderPlan();
        track('commitment_saved', { estimated: hours === null ? 'no' : 'yes' });
        toast(editingCommitment ? 'Updated.' : 'Saved.');
        editingCommitment = null;
        if (window.NexleySync) window.NexleySync.run();
      });
    return true;
  }

  function deleteCommitment() {
    if (!editingCommitment) return;
    if (!confirm('Remove "' + editingCommitment.title + '"?\n\nIt is flagged as removed '
        + 'rather than destroyed, so a snapshot can still bring it back.')) return;
    softDelete('commitments', editingCommitment)
      .then(function () { $('cmDialog').close(); return refresh(); })
      .then(function () {
        renderPlan();
        toast('Removed.');
        editingCommitment = null;
        if (window.NexleySync) window.NexleySync.run();
      });
  }

  /* ============================================================
     12h · marks
     ------------------------------------------------------------
     Real papers, actually sat, each recorded WITH the conditions it was sat
     under — because an open-notes mark and an exam mark are not the same mark.

     THE ONE RULE THIS SECTION EXISTS TO ENFORCE: marks are never averaged
     across conditions. Not "averaged with a warning", not "averaged unless you
     turn it off" — there is no code path here that produces a single number
     spanning two condition groups. That average would flatter, and always in
     the same direction: open-book and take-home marks pull it up and hide the
     exam-condition gap, which is the exact gap worth knowing about.

     Also deliberately absent: any predicted band, grade or estimate. This shows
     what happened. It does not forecast.
     ============================================================ */
  var CONDITIONS = [
    { id: 'exam',       label: 'Exam conditions', hint: 'Timed, closed book, supervised' },
    { id: 'class_test',  label: 'Class test',      hint: 'In class, timed, but not a formal exam' },
    { id: 'open_notes',  label: 'Open notes',      hint: 'You could look things up' },
    { id: 'take_home',   label: 'Take home',       hint: 'Done in your own time' },
    { id: 'practice',    label: 'Practice',        hint: 'Sat on your own, unmarked by anyone else' }
  ];

  function conditionMeta(id) {
    for (var i = 0; i < CONDITIONS.length; i++) if (CONDITIONS[i].id === id) return CONDITIONS[i];
    return { id: id, label: id, hint: '' };
  }

  /* Marks are summed and divided ONCE per group, rather than averaging each
     paper's percentage. A 9/10 quiz and a 60/100 exam are not equal evidence,
     and averaging their percentages (90% and 60% -> 75%) pretends they are.
     Summing gives 69/110 = 63%, which is what actually happened. */
  function groupByConditions(papers) {
    var groups = [];
    CONDITIONS.forEach(function (c) {
      var mine = papers.filter(function (p) { return p.conditions === c.id; });
      if (!mine.length) return;
      var mark = 0, outOf = 0;
      mine.forEach(function (p) { mark += p.mark; outOf += p.outOf; });
      groups.push({
        condition: c.id,
        label: c.label,
        count: mine.length,
        mark: mark,
        outOf: outOf,
        pct: outOf > 0 ? Math.round((mark / outOf) * 1000) / 10 : null,
        papers: mine.slice().sort(function (a, b) { return b.sat - a.sat; })
      });
    });
    return groups;
  }

  function paperPct(p) {
    if (!p.outOf) return null;
    return Math.round((p.mark / p.outOf) * 1000) / 10;
  }

  var mkSubject = null;

  function papersOf(subjectId) {
    return state.papers.filter(function (p) { return p.subjectId === subjectId; });
  }

  function renderMkSubjects() {
    var sel = $('mkSubject');
    var want = sel.value || mkSubject || state.activeSubject;
    sel.textContent = '';
    state.subjects.forEach(function (s2) {
      var o = document.createElement('option');
      o.value = s2.id; o.textContent = s2.name;
      sel.appendChild(o);
    });
    if (want && subjectById(want)) sel.value = want;
    mkSubject = sel.value || null;
    var none = !state.subjects.length;
    sel.disabled = none;
    $('mkAdd').disabled = none;
  }

  function renderMarks() {
    renderMkSubjects();
    var body = $('mkBody');
    body.textContent = '';

    if (!state.subjects.length) {
      body.appendChild(note('Add a subject first — a mark has to belong to one.'));
      return;
    }

    var mine = papersOf(mkSubject);
    if (!mine.length) {
      body.appendChild(note('No papers recorded for this subject yet. Add one and it will be '
        + 'grouped by the conditions you sat it under — marks from different conditions are '
        + 'never mixed together, because an open-notes mark and an exam mark are not the '
        + 'same mark.'));
      return;
    }

    var groups = groupByConditions(mine);

    /* Deliberately reads as several separate figures rather than one headline.
       If there is more than one group, the app says so out loud — the absence of
       a single number is a decision, and an unexplained absence looks like a
       missing feature rather than an intentional one. */
    groups.forEach(function (g) {
      body.appendChild(conditionBlock(g));
    });

    var loss = renderLossBreakdown(mine);
    if (loss) body.appendChild(loss);

    if (groups.length > 1) {
      var p2 = document.createElement('p');
      p2.className = 'mk-why';
      p2.textContent = 'These are kept apart on purpose. Averaging them together would '
        + 'produce a number that describes nothing you ever sat, and it would flatter you — '
        + 'the open-book marks would pull it up and hide the exam-condition gap.';
      body.appendChild(p2);
    }
  }

  function conditionBlock(g) {
    var wrap = document.createElement('section');
    wrap.className = 'mk-group';

    var head2 = document.createElement('header');
    head2.className = 'mk-ghead';

    var name = document.createElement('h3');
    name.textContent = g.label;
    head2.appendChild(name);

    var fig = document.createElement('b');
    fig.className = 'mk-pct';
    fig.textContent = g.pct === null ? '—' : g.pct + '%';
    head2.appendChild(fig);

    var sub = document.createElement('span');
    sub.className = 'mk-sub';
    // the raw marks stay visible next to the percentage: 69/110 is the fact,
    // 63% is the derived thing
    sub.textContent = trimNum(g.mark) + '/' + trimNum(g.outOf) + ' · '
      + g.count + (g.count === 1 ? ' paper' : ' papers');
    head2.appendChild(sub);

    wrap.appendChild(head2);

    g.papers.forEach(function (p) { wrap.appendChild(paperRow(p)); });
    return wrap;
  }

  // 12.00 -> "12", 12.50 -> "12.5". Marks are usually whole numbers and a
  // trailing ".00" on every one of them makes a list of them hard to scan.
  function trimNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return String(Math.round(n * 100) / 100);
  }

  function paperRow(p) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'mk-row';
    row.addEventListener('click', function () { openPaperDialog(p); });

    var title = document.createElement('span');
    title.className = 'mk-title';
    title.textContent = p.title;
    row.appendChild(title);

    if (p.weight !== null && p.weight !== undefined) {
      var w = document.createElement('span');
      w.className = 'mk-weight';
      w.textContent = trimNum(p.weight) + '%';
      w.title = 'Worth ' + trimNum(p.weight) + '% of the course';
      row.appendChild(w);
    }

    var when2 = document.createElement('span');
    when2.className = 'mk-when';
    when2.textContent = when(p.sat);
    row.appendChild(when2);

    var score = document.createElement('span');
    score.className = 'mk-score';
    score.textContent = trimNum(p.mark) + '/' + trimNum(p.outOf);
    row.appendChild(score);

    var pc = document.createElement('span');
    pc.className = 'mk-rowpct';
    var v = paperPct(p);
    pc.textContent = v === null ? '' : v + '%';
    row.appendChild(pc);

    return row;
  }

  /* ------------------------------------------------------------
     where the marks went
     ------------------------------------------------------------
     A mark lost to running out of time and a mark lost to not knowing the
     content are the same number and completely different problems. Only one of
     them is fixed by studying harder; one is fixed by doing a timed practice
     paper, and one by writing the answer differently. A total tells you none of
     that, which is why the total is the least useful thing on a returned script.

     The app cannot infer which is which — it has no access to the script — so
     the student says, per question, and this adds it up.
     ------------------------------------------------------------ */
  var LOSS_REASONS = [
    { id: 'unknown',    label: "Didn't know it",          fix: 'Content gap — this is the one that turns into revision.' },
    { id: 'time',       label: 'Ran out of time',         fix: 'You knew it. Practise under the clock, not more content.' },
    { id: 'misread',    label: 'Misread the question',    fix: 'Read the verb. Underline what it actually asks for.' },
    { id: 'careless',   label: 'Knew it, slipped',        fix: 'Checking time at the end is worth more than more study.' },
    { id: 'working',    label: "Didn't show working",     fix: 'Marks for method are free marks. Write the steps.' },
    { id: 'expression', label: 'Explained it badly',      fix: 'You had it. Practise writing the answer, not learning it.' }
  ];

  function reasonMeta(id) {
    for (var i = 0; i < LOSS_REASONS.length; i++) if (LOSS_REASONS[i].id === id) return LOSS_REASONS[i];
    return null;
  }

  function questionsOf(p) {
    return (p && p.questions) || [];
  }

  function lostOn(q) {
    var lost = (q.outOf || 0) - (q.mark || 0);
    return lost > 0 ? lost : 0;
  }

  /* How much of the paper the breakdown actually accounts for. A partial
     breakdown presented as a complete one is worse than no breakdown: it makes a
     student think they have found where the marks went when most of them are
     still unexplained. So this is measured and shown rather than assumed. */
  function breakdownCoverage(p) {
    var qs = questionsOf(p);
    var counted = 0;
    qs.forEach(function (q) { counted += (q.outOf || 0); });
    var lostTotal = (p.outOf || 0) - (p.mark || 0);
    var lostCounted = 0;
    qs.forEach(function (q) { lostCounted += lostOn(q); });
    return {
      questions: qs.length,
      marksCounted: counted,
      marksTotal: p.outOf || 0,
      lostCounted: lostCounted,
      lostTotal: lostTotal > 0 ? lostTotal : 0,
      complete: qs.length > 0 && counted >= (p.outOf || 0)
    };
  }

  /* Only LOST marks are grouped. A question answered perfectly has no reason to
     explain and must not pad a category — the question being answered is "where
     did the marks you did not get actually go", and full marks are not an answer
     to it. A lost mark with no reason recorded is counted separately as
     unexplained rather than quietly dropped. */
  function lossByReason(papers) {
    var totals = {}, unexplained = 0, lostAll = 0;
    papers.forEach(function (p) {
      questionsOf(p).forEach(function (q) {
        var lost = lostOn(q);
        if (!lost) return;
        lostAll += lost;
        if (!q.reason || !reasonMeta(q.reason)) { unexplained += lost; return; }
        if (!totals[q.reason]) totals[q.reason] = { lost: 0, count: 0 };
        totals[q.reason].lost += lost;
        totals[q.reason].count++;
      });
    });

    var rows = [];
    LOSS_REASONS.forEach(function (r) {
      if (!totals[r.id]) return;
      rows.push({
        reason: r.id, label: r.label, fix: r.fix,
        lost: Math.round(totals[r.id].lost * 100) / 100,
        count: totals[r.id].count,
        share: lostAll > 0 ? Math.round((totals[r.id].lost / lostAll) * 1000) / 10 : 0
      });
    });
    // biggest loss first: the point is where to spend the next hour
    rows.sort(function (a, b) { return b.lost - a.lost; });
    return { rows: rows, unexplained: Math.round(unexplained * 100) / 100, lost: Math.round(lostAll * 100) / 100 };
  }

  /* Phase 6 part three — the loop closes here.
     A mark lost to "didn't know it" names a content gap, and a content gap on a
     dot point you have review cards for is the single most actionable thing in
     the app: the exam has already told you the schedule was wrong about that
     card. So losses are rolled up per syllabus point and the cards on those
     points can be pulled forward.

     Only 'unknown' counts toward this. Running out of time is not a content gap
     and re-reviewing the card would be treating the wrong illness — that
     distinction is the entire reason part two records a reason at all. */
  function gapsByPoint(papers) {
    var byPoint = {};
    papers.forEach(function (p) {
      questionsOf(p).forEach(function (q) {
        if (q.reason !== 'unknown') return;
        var lost = lostOn(q);
        if (!lost || !q.syllabusId) return;
        if (!byPoint[q.syllabusId]) byPoint[q.syllabusId] = { syllabusId: q.syllabusId, lost: 0, count: 0 };
        byPoint[q.syllabusId].lost += lost;
        byPoint[q.syllabusId].count++;
      });
    });
    var rows = Object.keys(byPoint).map(function (k) { return byPoint[k]; });
    rows.sort(function (a, b) { return b.lost - a.lost; });
    return rows;
  }

  function cardsOnPoint(syllabusId) {
    return state.cards.filter(function (c) { return c.syllabusId === syllabusId && !c.deleted; });
  }

  /* Pulled forward, not reset. `due` moves to now and the interval collapses, so
     the card comes back in the next session — but `ease` is left alone. Ease is
     earned by how you grade the card in review, and docking it here would punish
     the same mistake twice: once by bringing the card forward and again by making
     every future interval shorter for a lapse the review queue never saw. */
  function pullForward(cards) {
    var now = Date.now();
    return Promise.all(cards.map(function (c) {
      if (c.due <= now && (c.interval || 0) === 0) return null;   // already waiting
      c.due = now;
      c.interval = 0;
      return put('cards', stamp(c));
    }).filter(Boolean));
  }

  function renderLossBreakdown(papers) {
    var res = lossByReason(papers);
    if (!res.lost) return null;

    var wrap = document.createElement('section');
    wrap.className = 'mk-loss';

    var h = document.createElement('h3');
    h.textContent = 'Where the marks went';
    wrap.appendChild(h);

    var lead = document.createElement('p');
    lead.className = 'mk-lossnote';
    lead.textContent = trimNum(res.lost) + ' marks dropped across the papers you have broken down. '
      + 'These are different problems with different fixes, which is the only reason the split is worth having.';
    wrap.appendChild(lead);

    res.rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'mk-lossrow';

      var top = document.createElement('div');
      top.className = 'mk-losstop';

      var name = document.createElement('b');
      name.textContent = r.label;
      top.appendChild(name);

      var n = document.createElement('span');
      n.className = 'mk-lossn';
      n.textContent = trimNum(r.lost) + ' marks · ' + r.count + (r.count === 1 ? ' question' : ' questions');
      top.appendChild(n);

      row.appendChild(top);

      var bar = document.createElement('div');
      bar.className = 'mk-lossbar';
      var fill = document.createElement('i');
      fill.style.width = r.share + '%';
      bar.appendChild(fill);
      row.appendChild(bar);

      var fix = document.createElement('p');
      fix.className = 'mk-lossfix';
      fix.textContent = r.fix;
      row.appendChild(fix);

      wrap.appendChild(row);
    });

    var gaps = renderGaps(papers);
    if (gaps) wrap.appendChild(gaps);

    if (res.unexplained > 0) {
      var u = document.createElement('p');
      u.className = 'mk-lossnote';
      // said plainly: an unexplained loss is the app admitting what it does not know
      u.textContent = trimNum(res.unexplained) + ' of those marks have no reason recorded yet, '
        + 'so they are not in the split above.';
      wrap.appendChild(u);
    }
    return wrap;
  }

  function renderGaps(papers) {
    var rows = gapsByPoint(papers).filter(function (r) { return nodeById(r.syllabusId); });
    if (!rows.length) return null;

    var wrap = document.createElement('div');
    wrap.className = 'mk-gaps';

    var h = document.createElement('h4');
    h.textContent = 'The content gaps, by dot point';
    wrap.appendChild(h);

    var lead = document.createElement('p');
    lead.className = 'mk-lossnote';
    lead.textContent = 'Only the marks you lost to not knowing it. Running out of time is a '
      + 'different problem and is not counted here.';
    wrap.appendChild(lead);

    rows.forEach(function (r) {
      var node = nodeById(r.syllabusId);
      var cards = cardsOnPoint(r.syllabusId);

      var row = document.createElement('div');
      row.className = 'mk-gap';

      var name = document.createElement('span');
      name.className = 'mk-gapname';
      name.textContent = (node.code ? node.code + ' · ' : '') + node.title;
      row.appendChild(name);

      var lost = document.createElement('span');
      lost.className = 'mk-lossn';
      lost.textContent = trimNum(r.lost) + ' marks';
      row.appendChild(lost);

      if (!cards.length) {
        // honest about why there is no button, rather than just not having one
        var none = document.createElement('span');
        none.className = 'mk-gapnote';
        none.textContent = 'no cards yet';
        row.appendChild(none);
      } else {
        var waiting = cards.filter(function (c) { return c.due <= Date.now(); }).length;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ghost mk-gapbtn';
        b.textContent = waiting === cards.length
          ? 'Already in the queue'
          : 'Bring ' + cards.length + (cards.length === 1 ? ' card' : ' cards') + ' forward';
        b.disabled = waiting === cards.length;
        b.addEventListener('click', function () {
          b.disabled = true;
          pullForward(cards)
            .then(function () { return refresh(); })
            .then(function () {
              renderMarks();
              track('cards_pulled_forward', { cards: cards.length });
              toast('Moved to the front of the review queue.');
            });
        });
        row.appendChild(b);
      }
      wrap.appendChild(row);
    });
    return wrap;
  }

  /* ---------- add / edit ---------- */

  var editingPaper = null;
  /* Questions are edited on a COPY and only written back in savePaper. Cancelling
     a dialog has to actually cancel — editing the live record in place would mean
     "Cancel" silently kept every question change, which is the kind of quiet
     data-loss-in-reverse that is very hard to notice. */
  var draftQuestions = [];

  function openPaperDialog(p) {
    editingPaper = p || null;
    draftQuestions = (p && p.questions ? p.questions : []).map(function (q) {
      return { id: q.id, label: q.label, mark: q.mark, outOf: q.outOf,
               reason: q.reason || null, syllabusId: q.syllabusId || null, note: q.note || null,
               response: q.response || null,
               spans: Array.isArray(q.spans) ? q.spans.map(function (s) {
                 return { id: s.id, text: s.text, positive: !!s.positive, reason: s.reason || null, note: s.note || '' };
               }) : [] };
    });
    $('pprHeading').textContent = p ? 'Edit this paper' : 'Record a paper';
    $('pprTitle').value = p ? p.title : '';
    $('pprMark').value = p ? p.mark : '';
    $('pprOutOf').value = p ? p.outOf : '';
    $('pprWeight').value = (p && p.weight !== null && p.weight !== undefined) ? p.weight : '';
    $('pprReflection').value = (p && p.reflection) || '';
    $('pprDate').value = isoDay(p ? p.sat : Date.now());
    pprConditions = p ? p.conditions : 'exam';
    renderPprConditions();
    $('pprDelete').hidden = !p;
    renderQuestions();
    $('pprError').hidden = true;
    $('pprDialog').showModal();
    setTimeout(function () { $('pprTitle').focus(); }, 60);
  }

  // <input type="date"> wants yyyy-mm-dd in LOCAL time. toISOString() converts to
  // UTC first, so in Sydney anything before 10am comes back as the previous day.
  function isoDay(ms) {
    var d = new Date(ms);
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
  }
  // and back again, at midday, so a timezone shift can never move the date
  function dayToMs(str) {
    var parts = String(str || '').split('-');
    if (parts.length !== 3) return Date.now();
    return new Date(+parts[0], +parts[1] - 1, +parts[2], 12, 0, 0).getTime();
  }

  var pprConditions = 'exam';
  function renderPprConditions() {
    var wrap = $('pprConditions');
    wrap.textContent = '';
    CONDITIONS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (pprConditions === c.id ? ' on' : '');
      b.textContent = c.label;
      b.title = c.hint;
      b.setAttribute('aria-pressed', pprConditions === c.id ? 'true' : 'false');
      b.addEventListener('click', function () {
        pprConditions = c.id;
        renderPprConditions();
        $('pprHint').textContent = c.hint;
      });
      wrap.appendChild(b);
    });
    $('pprHint').textContent = conditionMeta(pprConditions).hint;
  }

  /* Deliberately not a spreadsheet. Six fields per question would make recording
     a 30-question paper a chore nobody does twice, and a breakdown nobody fills in
     is worth nothing. Label, marks, and why — the reason is the only field that
     earns its place, because it is the one the total cannot tell you. */
  function renderQuestions() {
    var wrap = $('pprQuestions');
    wrap.textContent = '';

    draftQuestions.forEach(function (q, i) {
      var row = document.createElement('div');
      row.className = 'qrow';

      var label = document.createElement('input');
      label.type = 'text';
      label.className = 'q-label';
      label.value = q.label || '';
      label.placeholder = 'Q' + (i + 1);
      label.setAttribute('aria-label', 'Question label');
      label.addEventListener('input', function () { q.label = this.value; });
      row.appendChild(label);

      /* One flex item, not three, so flex-wrap on .qrow wraps "got / of" onto its
         own line as a unit at the modal's normal width instead of splitting the
         slash and the second number off onto their own lines. */
      var marks = document.createElement('span');
      marks.className = 'q-marks';

      var mark = document.createElement('input');
      mark.type = 'number';
      mark.className = 'q-num';
      mark.min = '0'; mark.step = '0.5';
      mark.value = (q.mark === null || q.mark === undefined) ? '' : q.mark;
      mark.placeholder = 'got';
      mark.setAttribute('aria-label', 'Marks awarded');
      mark.addEventListener('input', function () {
        q.mark = this.value === '' ? null : parseFloat(this.value);
        updateQuestionState(row, q);
      });
      marks.appendChild(mark);

      var slash = document.createElement('span');
      slash.className = 'q-slash';
      slash.textContent = '/';
      marks.appendChild(slash);

      var outOf = document.createElement('input');
      outOf.type = 'number';
      outOf.className = 'q-num';
      outOf.min = '0'; outOf.step = '0.5';
      outOf.value = (q.outOf === null || q.outOf === undefined) ? '' : q.outOf;
      outOf.placeholder = 'of';
      outOf.setAttribute('aria-label', 'Marks available');
      outOf.addEventListener('input', function () {
        q.outOf = this.value === '' ? null : parseFloat(this.value);
        updateQuestionState(row, q);
      });
      marks.appendChild(outOf);

      row.appendChild(marks);

      var why = document.createElement('select');
      why.className = 'q-why';
      why.setAttribute('aria-label', 'Why the marks were lost');
      var blank = document.createElement('option');
      blank.value = '';
      blank.textContent = 'why?';
      why.appendChild(blank);
      LOSS_REASONS.forEach(function (r) {
        var o = document.createElement('option');
        o.value = r.id; o.textContent = r.label;
        why.appendChild(o);
      });
      why.value = q.reason || '';
      why.addEventListener('change', function () {
        q.reason = this.value || null;
        updateQuestionState(row, q);
      });
      row.appendChild(why);

      /* Only offered on a question you lost marks to not knowing — that is the
         only case where linking it to a dot point does anything. Asking for it on
         every question would be four taps of admin per paper for no payoff. */
      var pts = mkSubject ? syllabusPoints(mkSubject) : [];
      if (pts.length) {
        var point = document.createElement('select');
        point.className = 'q-point';
        point.setAttribute('aria-label', 'Which dot point this question tested');
        var pb = document.createElement('option');
        pb.value = ''; pb.textContent = 'dot point?';
        point.appendChild(pb);
        pts.forEach(function (n) {
          var o = document.createElement('option');
          o.value = n.id;
          o.textContent = (n.code ? n.code + ' · ' : '') + n.title;
          point.appendChild(o);
        });
        point.value = q.syllabusId || '';
        point.addEventListener('change', function () { q.syllabusId = this.value || null; });
        row.appendChild(point);
      }

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'q-rm';
      rm.textContent = '×';
      rm.title = 'Remove this question';
      rm.setAttribute('aria-label', 'Remove this question');
      rm.addEventListener('click', function () {
        draftQuestions.splice(i, 1);
        renderQuestions();
      });
      row.appendChild(rm);

      updateQuestionState(row, q);

      var block = document.createElement('div');
      block.className = 'qblock';
      block.appendChild(row);
      block.appendChild(renderMarkedScript(q));
      wrap.appendChild(block);
    });

    renderQuestionTally();
  }

  /* ------------------------------------------------------------
     the marked script — read it, don't just total it
     ------------------------------------------------------------
     Everything above this reduces a question to a number and a category.
     That is enough to know WHAT to fix, but not enough to see it — the actual
     sentence that earned or lost the mark. This is that: paste the answer you
     wrote, select the phrase that mattered, say why. Entirely manual and
     entirely local, unlike the AI marking path in marking.js — it does not
     wait on that feature's validation, and nothing here ever writes a mark;
     it only annotates marks the student already entered above. */
  function renderMarkedScript(q) {
    var wrap = document.createElement('div');
    wrap.className = 'q-script-wrap';

    var ta = document.createElement('textarea');
    ta.className = 'q-response';
    ta.placeholder = 'Paste your written answer here to mark it up phrase by phrase (optional)';
    ta.rows = 2;
    ta.value = q.response || '';
    ta.addEventListener('input', function () { q.response = this.value; });
    ta.addEventListener('blur', function () {
      q.response = this.value.trim() || null;
      renderQuestions();
    });
    wrap.appendChild(ta);

    if (!q.response) return wrap;

    var script = document.createElement('div');
    script.className = 'q-script';
    var ranges = findSpanRanges(q.response, q.spans || []);
    var pos = 0;
    ranges.forEach(function (r) {
      if (r.start > pos) script.appendChild(document.createTextNode(q.response.slice(pos, r.start)));
      var mk = document.createElement('mark');
      mk.className = 'q-span-mark ' + (r.span.positive ? 'pos' : 'neg');
      mk.textContent = q.response.slice(r.start, r.end);
      mk.dataset.spanId = r.span.id;
      mk.tabIndex = 0;
      mk.addEventListener('click', function () { focusSpan(script, foot, r.span.id); });
      script.appendChild(mk);
      pos = r.end;
    });
    if (pos < q.response.length) script.appendChild(document.createTextNode(q.response.slice(pos)));
    wrap.appendChild(script);

    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'q-annotate';
    addBtn.textContent = '+ Annotate selection';
    /* Without this, the browser clears the text selection on mousedown as focus
       moves to the button — before the click handler below ever runs — so the
       selection this button is supposed to act on is already gone by the time
       it fires. */
    addBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    addBtn.addEventListener('click', function () {
      var sel = window.getSelection();
      var text = sel && !sel.isCollapsed ? String(sel).trim() : '';
      if (!text || !sel.rangeCount || !script.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        toast('Select a phrase in your answer first.');
        return;
      }
      q.spans = q.spans || [];
      q.spans.push({ id: uid(), text: text, positive: false, reason: null, note: '' });
      sel.removeAllRanges();
      renderQuestions();
    });
    wrap.appendChild(addBtn);

    var foot = document.createElement('div');
    foot.className = 'q-spanlist';
    (q.spans || []).forEach(function (s) {
      foot.appendChild(renderSpanRow(q, s));
    });
    wrap.appendChild(foot);

    return wrap;
  }

  function focusSpan(script, foot, id) {
    script.querySelectorAll('.q-span-mark').forEach(function (m) {
      m.classList.toggle('on', m.dataset.spanId === id);
    });
    foot.querySelectorAll('.q-span-row').forEach(function (r) {
      r.classList.toggle('on', r.dataset.spanId === id);
    });
  }

  function renderSpanRow(q, s) {
    var row = document.createElement('div');
    row.className = 'q-span-row';
    row.dataset.spanId = s.id;

    var quote = document.createElement('span');
    quote.className = 'q-span-quote';
    quote.textContent = '"' + s.text + '"';
    row.appendChild(quote);

    var kind = document.createElement('select');
    kind.className = 'q-span-kind';
    [['pos', 'Earned'], ['neg', 'Lost']].forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0]; opt.textContent = o[1];
      kind.appendChild(opt);
    });
    kind.value = s.positive ? 'pos' : 'neg';
    kind.addEventListener('change', function () {
      s.positive = this.value === 'pos';
      renderQuestions();
    });
    row.appendChild(kind);

    if (!s.positive) {
      var reason = document.createElement('select');
      reason.className = 'q-span-reason';
      var blank = document.createElement('option');
      blank.value = ''; blank.textContent = 'why?';
      reason.appendChild(blank);
      LOSS_REASONS.forEach(function (r) {
        var o = document.createElement('option');
        o.value = r.id; o.textContent = r.label;
        reason.appendChild(o);
      });
      reason.value = s.reason || '';
      reason.addEventListener('change', function () { s.reason = this.value || null; });
      row.appendChild(reason);
    }

    var note = document.createElement('input');
    note.type = 'text';
    note.className = 'q-span-note';
    note.placeholder = 'what this phrase actually did';
    note.value = s.note || '';
    note.addEventListener('input', function () { s.note = this.value; });
    row.appendChild(note);

    var rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'q-rm';
    rm.textContent = '×';
    rm.title = 'Remove this annotation';
    rm.setAttribute('aria-label', 'Remove this annotation');
    rm.addEventListener('click', function () {
      var idx = q.spans.indexOf(s);
      if (idx > -1) q.spans.splice(idx, 1);
      renderQuestions();
    });
    row.appendChild(rm);

    return row;
  }

  /* Matches each span's TEXT back to a position in the response, skipping
     ranges already claimed by an earlier span so two annotations can never
     overlap. Matches by substring, not by a stored offset, because offsets
     drift the moment the response text is edited and a stale offset would
     silently highlight the wrong words — a wrong-but-plausible-looking
     highlight is worse than one that quietly fails to show at all. */
  function findSpanRanges(response, spans) {
    var used = [];
    var ranges = [];
    (spans || []).forEach(function (sp) {
      if (!sp.text) return;
      var searchFrom = 0, start = -1, end = -1;
      while (true) {
        var found = response.indexOf(sp.text, searchFrom);
        if (found === -1) break;
        var e = found + sp.text.length;
        var overlaps = used.some(function (u) { return found < u.end && e > u.start; });
        if (!overlaps) { start = found; end = e; break; }
        searchFrom = found + 1;
      }
      if (start !== -1) {
        used.push({ start: start, end: end });
        ranges.push({ start: start, end: end, span: sp });
      }
    });
    ranges.sort(function (a, b) { return a.start - b.start; });
    return ranges;
  }

  /* A question with full marks has nothing to explain, so its "why" is hidden
     rather than sitting there empty and looking unanswered. */
  // every dot point in a subject, flattened, in syllabus order
  function syllabusPoints(subjectId) {
    var out = [];
    topicsOf(subjectId).forEach(function (t) {
      childrenOf(t.id).forEach(function (c) { out.push(c); });
    });
    return out;
  }

  function updateQuestionState(row, q) {
    var lost = lostOn(q);
    row.classList.toggle('full', !lost && q.outOf > 0);
    var why = row.querySelector('.q-why');
    if (why) why.disabled = !lost;
    /* The dot point only matters for a content gap. Shown greyed rather than
       removed so the row does not reflow every time a number changes. */
    var point = row.querySelector('.q-point');
    if (point) {
      var isGap = lost > 0 && q.reason === 'unknown';
      point.disabled = !isGap;
      point.classList.toggle('off', !isGap);
    }
  }

  /* The tally is the honesty guard: it says how much of the paper the breakdown
     accounts for, so a partial one can never read as complete. */
  function renderQuestionTally() {
    var el = $('pprTally');
    if (!draftQuestions.length) {
      el.textContent = 'Optional — but this is the part that tells you something a total cannot.';
      el.className = 'dlgnote';
      return;
    }
    var counted = 0, lost = 0;
    draftQuestions.forEach(function (q) { counted += (q.outOf || 0); lost += lostOn(q); });
    var paperOutOf = parseFloat($('pprOutOf').value);
    var msg = trimNum(counted) + ' marks broken down';
    if (!isNaN(paperOutOf) && paperOutOf > 0) {
      msg += ' of ' + trimNum(paperOutOf);
      if (counted < paperOutOf) msg += ' — ' + trimNum(paperOutOf - counted) + ' still unaccounted for';
      else if (counted > paperOutOf) msg += ' — that is more than the paper was worth, check the numbers';
    }
    msg += '. ' + trimNum(lost) + ' dropped.';
    el.textContent = msg;
    el.className = 'dlgnote' + (!isNaN(paperOutOf) && counted > paperOutOf ? ' warn' : '');
  }

  function addQuestion() {
    draftQuestions.push({ id: uid(), label: '', mark: null, outOf: null, reason: null, note: null,
      response: null, spans: [] });
    renderQuestions();
    var rows = $('pprQuestions').getElementsByClassName('qrow');
    var last = rows[rows.length - 1];
    if (last) last.querySelector('.q-label').focus();
  }

  function pprFail(msg) {
    var e = $('pprError');
    e.textContent = msg;
    e.hidden = false;
    return false;
  }

  /* Validated here as well as in the database, and the messages say what to do
     rather than what is wrong. A mark above the total is the one that matters:
     it is nearly always a typo in `out of`, and left alone it would produce a
     percentage over 100 that then poisons the whole condition group. */
  function savePaper() {
    var title = $('pprTitle').value.trim();
    var mark = parseFloat($('pprMark').value);
    var outOf = parseFloat($('pprOutOf').value);
    var weightRaw = $('pprWeight').value.trim();
    var weight = weightRaw === '' ? null : parseFloat(weightRaw);

    if (!title) return pprFail('Give it a name — "Trial paper 1" is enough to find it later.');
    if (isNaN(mark) || mark < 0) return pprFail('What mark did you get?');
    if (isNaN(outOf) || outOf <= 0) return pprFail('What was it out of?');
    if (mark > outOf) return pprFail('That mark is higher than the total. Check the "out of".');
    if (weight !== null && (isNaN(weight) || weight < 0 || weight > 100)) {
      return pprFail('Weighting is a percentage of the course, between 0 and 100. Leave it blank if you do not know.');
    }

    /* Blank rows are dropped rather than rejected: someone who taps "add
       question" and changes their mind should not be blocked from saving. A row
       with numbers in it still has to make sense. */
    var qs = draftQuestions.filter(function (q) {
      return q.label || q.mark !== null || q.outOf !== null;
    });
    for (var qi = 0; qi < qs.length; qi++) {
      var q = qs[qi];
      var name = q.label || ('question ' + (qi + 1));
      if (q.outOf === null || isNaN(q.outOf) || q.outOf <= 0) {
        return pprFail('What was ' + name + ' out of?');
      }
      if (q.mark === null || isNaN(q.mark) || q.mark < 0) {
        return pprFail('What did you get for ' + name + '?');
      }
      if (q.mark > q.outOf) {
        return pprFail(name + ' has more marks than it was worth. Check the numbers.');
      }
      if (!q.label) q.label = 'Q' + (qi + 1);
    }

    var rec = editingPaper || { id: uid() };
    rec.subjectId = mkSubject;
    rec.title = title;
    rec.sat = dayToMs($('pprDate').value);
    rec.conditions = pprConditions;
    rec.mark = mark;
    rec.outOf = outOf;
    rec.weight = weight;
    rec.reflection = $('pprReflection').value.trim() || null;
    rec.questions = qs;

    put('papers', stamp(rec))
      .then(function () { $('pprDialog').close(); return refresh(); })
      .then(function () {
        renderMarks();
        // the conditions only; never the mark, the percentage or the subject
        track('paper_recorded', { conditions: rec.conditions });
        if (qs.length) track('paper_questions_added', { questions: qs.length });
        toast(editingPaper ? 'Updated.' : 'Recorded.');
        editingPaper = null;
        if (window.NexleySync) window.NexleySync.run();
      });
    return true;
  }

  function deletePaper() {
    if (!editingPaper) return;
    // every other delete in this app asks first; a mark is a fact you cannot
    // reconstruct from memory a term later, so this one asks too
    if (!confirm('Remove "' + editingPaper.title + '"?\n\nIt is flagged as removed '
        + 'rather than destroyed, so a snapshot can still bring it back.')) return;
    // tombstone, like every other delete in the app — never a hard delete
    softDelete('papers', editingPaper)
      .then(function () { $('pprDialog').close(); return refresh(); })
      .then(function () {
        renderMarks();
        toast('Removed.');
        editingPaper = null;
        if (window.NexleySync) window.NexleySync.run();
      });
  }

  /* ============================================================
     13 · export / import / snapshots
     ============================================================ */
  function exportAll() {
    return Promise.all([all('subjects'), all('notes'), all('syllabus'), all('cards'),
                        all('papers'), all('commitments')]).then(function (r) {
      var payload = {
        // format 5 adds papers. An older Nexley reading this file ignores the key
        // rather than failing, and importing an older file simply brings no papers.
        app: 'nexley', format: 6, appVersion: APP_VERSION,
        exported: new Date().toISOString(), device: state.deviceId,
        account: state.account ? { name: state.account.name, email: state.account.email } : null,
        // tombstones included on purpose: a future sync needs to know what was deleted
        subjects: r[0], notes: r[1], syllabus: r[2], cards: r[3], papers: r[4],
        commitments: r[5]
      };
      track('export_all');
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'nexley-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('Exported ' + live(r[1]).length + ' notes.');
    });
  }

  /* Merge, never replace: newest revision of each record wins, so importing an older
     file cannot silently roll back newer work on this device. */
  function importFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); }
      catch (err) { return toast('That file is not valid JSON.'); }
      if (!data || (data.app !== 'nexley' && data.app !== 'summit-education') || !Array.isArray(data.notes)) {
        return toast('That does not look like a Nexley export.');
      }

      snapshot('before-import').then(function () {
        return Promise.all([all('subjects'), all('notes'), all('syllabus'), all('cards'),
                            all('papers'), all('commitments')]);
      }).then(function (cur) {
        var index = {}, kept = 0, skipped = 0, jobs = [];
        cur[0].forEach(function (s) { index['s:' + s.id] = s; });
        cur[1].forEach(function (n) { index['n:' + n.id] = n; });
        cur[2].forEach(function (y) { index['y:' + y.id] = y; });
        cur[3].forEach(function (c) { index['c:' + c.id] = c; });
        (cur[4] || []).forEach(function (pp) { index['p:' + pp.id] = pp; });
        (cur[5] || []).forEach(function (cm) { index['m:' + cm.id] = cm; });

        function consider(store, prefix, rec) {
          var mine = index[prefix + rec.id];
          if (mine && (mine.updated || 0) >= (rec.updated || 0)) { skipped++; return; }
          kept++;
          jobs.push(put(store, rec));
        }
        (data.subjects || []).forEach(function (s) { consider('subjects', 's:', s); });
        (data.syllabus || []).forEach(function (y) { consider('syllabus', 'y:', y); });
        data.notes.forEach(function (n) {
          // an older export has no syllabus fields — default rather than drop the note
          if (n.syllabusId === undefined) n.syllabusId = null;
          if (n.kind === undefined) n.kind = 'personal';
          consider('notes', 'n:', n);
        });
        // format 4 and later; an older file simply has none
        (data.cards || []).forEach(function (c) { consider('cards', 'c:', c); });
        // absent from format 4 and earlier, so an old export imports cleanly
        (data.papers || []).forEach(function (pp) { consider('papers', 'p:', pp); });
        // absent from format 5 and earlier
        (data.commitments || []).forEach(function (cm) { consider('commitments', 'm:', cm); });

        return Promise.all(jobs).then(refresh).then(function () {
          toast('Imported ' + kept + ' newer records. ' + skipped + ' already up to date.');
        });
      });
    };
    reader.readAsText(file);
  }

  function openSnapshots() {
    all('backups').then(function (list) {
      list.sort(function (a, b) { return b.at - a.at; });
      var wrap = $('snapList');
      wrap.textContent = '';

      if (!list.length) {
        var p = document.createElement('p');
        p.className = 'listempty';
        p.textContent = 'No snapshots yet. One is taken automatically about once a day, ' +
          'and before any import, restore or update.';
        wrap.appendChild(p);
      }

      list.forEach(function (b) {
        var row = document.createElement('div');
        row.className = 'snaprow';

        var meta = document.createElement('div');
        var t = document.createElement('b');
        t.textContent = new Date(b.at).toLocaleString();
        var sub = document.createElement('span');
        sub.textContent = live(b.notes || []).length + ' notes · ' +
          live(b.subjects || []).length + ' subjects · ' +
          live(b.syllabus || []).length + ' syllabus · ' + b.reason;
        meta.appendChild(t); meta.appendChild(sub);

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.textContent = 'Restore';
        btn.addEventListener('click', function () {
          if (!confirm('Restore this snapshot?\n\nA snapshot of right now is taken first, ' +
                       'so this is reversible.')) return;
          restore(b.id).then(function () { $('snapDialog').close(); });
        });

        row.appendChild(meta); row.appendChild(btn);
        wrap.appendChild(row);
      });
      $('snapDialog').showModal();
    });
  }

  /* ============================================================
     14 · updates
     ============================================================ */
  function setupUpdates() {
    if (!('serviceWorker' in navigator) || location.protocol.indexOf('http') !== 0) return;

    // Silent auto-update. sw.js calls skipWaiting() on install, so a freshly
    // deployed worker activates itself; when it takes control we reload once so
    // the page is running the new assets. No prompt, no button - the manual
    // "Update now" banner raced with clients.claim() and left itself stuck.
    // Notes are safe across the reload: they live in IndexedDB and are flushed
    // on visibilitychange (see the document.hidden handler below).
    var hadController = !!navigator.serviceWorker.controller;
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloaded || !hadController) return;   // first-ever install: don't reload
      reloaded = true;
      location.reload();
    });

    // updateViaCache:'none' - always revalidate sw.js itself, so a deploy is seen
    // even while GitHub Pages serves it with a 10-minute max-age.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) reg.update().catch(function () {});
      });
    }).catch(function () {});
  }

  /* ============================================================
     15 · storage durability
     ============================================================ */
  function checkStorage() {
    if (!navigator.storage || !navigator.storage.persist) return;
    navigator.storage.persist().then(function (granted) {
      var foot = document.querySelector('.rail-foot');
      if (!foot) return;
      var note = document.createElement('span');
      note.className = 'storage-note ' + (granted ? 'ok' : 'warn');
      note.textContent = granted ? 'Storage protected' : 'Export regularly';
      note.title = granted
        ? 'The browser has marked your notes as persistent and will not evict them automatically.'
        : 'The browser has not guaranteed this storage. Adding the app to your home screen usually fixes it.';
      foot.appendChild(note);

      if (navigator.storage.estimate) {
        navigator.storage.estimate().then(function (est) {
          if (!est || !est.usage) return;
          var kb = Math.max(1, Math.round(est.usage / 1024));
          note.textContent += ' · ' + (kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB');
        }).catch(function () {});
      }
    }).catch(function () {});
  }

  /* ============================================================
     16 · wiring
     ============================================================ */
  function wire() {
    $('gateForm').addEventListener('submit', gateSubmit);
    $('gateSwitch').addEventListener('click', function (e) {
      e.preventDefault();
      showGate($('gateForm').dataset.mode === 'create' ? 'unlock' : 'create');
    });
    $('googleBtn').addEventListener('click', function () {
      window.NexleyAuth.signInGoogle().catch(function (err) { gateError(err.message || 'Could not sign in with Google.'); });
    });

    $('newNote').addEventListener('click', function () { newNote(state.activeNode); });
    $('deleteNote').addEventListener('click', deleteNote);
    $('backBtn').addEventListener('click', closeNote);
    $('addSubject').addEventListener('click', function () { openSubjectDialog(null); });
    $('syllabusBtn').addEventListener('click', openSyllabusDialog);

    $('noteTitle').addEventListener('input', markDirty);
    $('noteBody').addEventListener('input', function () { markDirty(); countWords(); });
    $('noteSubject').addEventListener('change', function () {
      var n = activeNoteObj();
      if (n) { n.syllabusId = null; n.subjectId = $('noteSubject').value; renderSyllabusPicker(n); }
      markDirty();
    });
    $('noteSyllabus').addEventListener('change', markDirty);

    [['kindPersonal', 'personal'], ['kindSyllabus', 'syllabus']].forEach(function (pair) {
      $(pair[0]).addEventListener('click', function () {
        var n = activeNoteObj();
        if (!n) return;
        n.kind = pair[1];
        setKindButtons(n.kind);
        markDirty();
      });
    });

    $('noteBody').addEventListener('paste', function (e) {
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    /* One event per SEARCH, not per keystroke. The handler fires on every letter,
       so tracking it directly would turn one search into nine events and make the
       number meaningless — and it is the only event here attached to something
       typed, so it is the one worth being careful with. The query itself never
       travels; only that a search happened. */
    var searchTimer = null;
    $('search').addEventListener('input', function (e) {
      state.query = e.target.value;
      renderBrowser();
      clearTimeout(searchTimer);
      if (!state.query.trim()) return;
      searchTimer = setTimeout(function () { track('search_used'); }, 1200);
    });

    Array.prototype.forEach.call(document.querySelectorAll('.toolbar button'), function (b) {
      if (b.id === 'fontBtn') { b.addEventListener('click', cycleFont); return; }
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        $('noteBody').focus();
        if (b.dataset.cmd) document.execCommand(b.dataset.cmd, false, null);
        else if (b.dataset.block) document.execCommand('formatBlock', false, b.dataset.block);
        else if (b.dataset.mark) toggleHighlight();
        markDirty();
        countWords();
      });
    });

    $('exportBtn').addEventListener('click', exportAll);
    $('importBtn').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importFile(e.target.files[0]);
      e.target.value = '';
    });
    $('snapBtn').addEventListener('click', openSnapshots);
    $('snapClose').addEventListener('click', function () { $('snapDialog').close(); });

    $('bugBtn').addEventListener('click', openBugDialog);
    $('bugBtnGate').addEventListener('click', function (e) { e.preventDefault(); openBugDialog(); });
    $('bugCancel').addEventListener('click', function () { $('bugDialog').close(); });
    $('bugSend').addEventListener('click', sendBugReport);

    $('mkSubject').addEventListener('change', function () { mkSubject = this.value; renderMarks(); });
    $('mkAdd').addEventListener('click', function () { openPaperDialog(null); });
    $('pprCancel').addEventListener('click', function () { $('pprDialog').close(); editingPaper = null; });
    $('tkAdd').addEventListener('click', function () { openCommitmentDialog(null); });
    $('cmCancel').addEventListener('click', function () { $('cmDialog').close(); editingCommitment = null; });
    $('cmSave').addEventListener('click', saveCommitment);
    $('cmDelete').addEventListener('click', deleteCommitment);

    $('pprAddQ').addEventListener('click', addQuestion);
    $('pprOutOf').addEventListener('input', renderQuestionTally);
    $('pprSave').addEventListener('click', savePaper);
    $('pprDelete').addEventListener('click', deletePaper);

    $('fbBtn').addEventListener('click', openFeedbackDialog);
    $('fbClose').addEventListener('click', function () { $('fbDialog').close(); });
    $('fbSend').addEventListener('click', sendFeedback);

    $('lockBtn').addEventListener('click', function () {
      if (state.dirty) saveNow();
      window.NexleyAuth.signOut().then(function () { showGate('unlock'); });
    });

    // day / night — cycles system -> light -> dark. 'system' clears the override
    // and follows prefers-color-scheme.
    var THEMES = ['system', 'light', 'dark'];
    function readTheme() {
      try { var t = localStorage.getItem('nexley-theme'); return THEMES.indexOf(t) > 0 ? t : 'system'; }
      catch (e) { return 'system'; }
    }
    function applyTheme(t) {
      if (t === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', t);
      try { t === 'system' ? localStorage.removeItem('nexley-theme') : localStorage.setItem('nexley-theme', t); }
      catch (e) {}
      $('themeBtn').textContent = 'Theme: ' + t;
    }
    applyTheme(readTheme());
    $('themeBtn').addEventListener('click', function () {
      applyTheme(THEMES[(THEMES.indexOf(readTheme()) + 1) % THEMES.length]);
    });

    // phone drawer
    $('menuBtn').addEventListener('click', function () { $('app').classList.toggle('nav-open'); });
    $('railScrim').addEventListener('click', closeNav);
    // picking a subject closes the drawer — and means "show me my notebook", so it also
    // drops out of a stub mode rather than leaving a dead click
    $('subjectList').addEventListener('click', function () { setMode('notebook'); });
    $('search').addEventListener('focus', function () { setMode('notebook'); });

    // Modes. Not persisted across reloads on purpose: the app should open on your
    // notebook, not mid-review. A mode is a thing you choose to enter.
    $('modeSwitch').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.mode') : null;
      if (!b) return;
      var m = b.getAttribute('data-mode');
      setMode(m);
      track('mode_switched', { mode: m });
    });

    // classwork
    $('cwSave').addEventListener('click', captureNow);
    $('cwInput').addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); captureNow(); }
    });
    $('cwSubject').addEventListener('change', function () {
      try { localStorage.setItem(CW_SUBJ_KEY, $('cwSubject').value); } catch (err) {}
    });
    $('fileForm').addEventListener('submit', doFile);
    $('fileCancel').addEventListener('click', function () {
      filing = null;
      $('fileDialog').close();
    });
    $('fileSubject').addEventListener('change', fillFileSyllabus);

    // tasks
    $('tkGo').addEventListener('click', unpackTask);
    $('tkClear').addEventListener('click', function () {
      $('tkInput').value = '';
      renderTasks();
      $('tkInput').focus();
    });
    $('tkInput').addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); unpackTask(); }
    });

    // review
    $('rvStart').addEventListener('click', startReview);
    $('rvShow').addEventListener('click', function () {
      if (!session) return;
      session.shown = true;
      renderReview();
    });
    $('rvDeckBtn').addEventListener('click', function () { session = null; renderReview(); });
    $('rvGrades').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.grade') : null;
      if (!b) return;
      gradeCurrent(parseInt(b.getAttribute('data-grade'), 10));
    });
    // space to flip, 1-4 to grade — a review session is a keyboard loop or it is slow
    document.addEventListener('keydown', function (e) {
      if ($('review').hidden || !session || !session.queue.length) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!session.shown) { session.shown = true; renderReview(); }
        return;
      }
      if (!session.shown) return;
      var map = { '1': 0, '2': 3, '3': 4, '4': 5 };
      if (map[e.key] !== undefined) { e.preventDefault(); gradeCurrent(map[e.key]); }
    });

    // sync state
    $('syncState').addEventListener('click', openSyncDetail);
    window.addEventListener('nexley-sync-state', function (e) { renderSyncState(e.detail); });
    // whatever the state already was before this listener existed
    if (window.NexleySync && window.NexleySync.status) renderSyncState(window.NexleySync.status());

    // cards
    $('makeCard').addEventListener('click', cardFromSelection);
    $('cardForm').addEventListener('submit', saveCard);
    $('cardCancel').addEventListener('click', function () {
      editingCard = null;
      $('cardDialog').close();
    });
    $('cardDelete').addEventListener('click', deleteCard);

    $('introNext').addEventListener('click', function () {
      var n = document.querySelectorAll('.ipanel').length;
      if (introPanel < n - 1) { introPanel++; paintIntro(); return; }
      endIntro('completed');
    });
    $('introSkip').addEventListener('click', function () { endIntro('skipped'); });

    $('subjForm').addEventListener('submit', saveSubject);
    $('subjCancel').addEventListener('click', function () {
      $('subjDialog').close();
      state.editingSubject = null;
    });
    $('subjDelete').addEventListener('click', deleteSubject);

    $('nodeForm').addEventListener('submit', saveNode);
    $('nodeCancel').addEventListener('click', function () {
      $('nodeDialog').close();
      state.editingNode = null;
    });
    $('nodeDelete').addEventListener('click', deleteNode);

    $('sylPaste').addEventListener('input', previewSyllabus);
    $('sylImport').addEventListener('click', importSyllabus);
    $('sylClose').addEventListener('click', function () { $('sylDialog').close(); });
    $('sylAddTopic').addEventListener('click', function () {
      $('sylDialog').close();
      openNodeDialog(null, null);
    });

    document.addEventListener('keydown', function (e) {
      // e.key is absent on synthetic events and on some IME/composition keydowns;
      // without this the global handler throws on those keystrokes
      var k = (e.key || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 's') {
        e.preventDefault();
        if (activeNoteObj()) saveNow().then(function () { toast('Saved.'); });
      }
      if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); $('search').focus(); }
    });

    /* A pull used to write straight into IndexedDB and stop there, so signing in on a
       second device showed an empty app until you happened to reload — which looks
       exactly like your notes being gone. Repaint when a pull actually changed
       something, but never on top of unsaved typing. */
    window.addEventListener('nexley-sync-pulled', function () {
      if (!state.account) return;
      // a reply can arrive on any pull, and the dot is the only sign of it
      renderFeedbackBadge();
      if ($('fbDialog').open) renderFeedbackList();
      if (state.dirty) return;
      refresh({ keepEditor: !!state.activeNote });
    });

    // last line of defence — never lose the buffer on close or on backgrounding a tablet
    window.addEventListener('beforeunload', function () { if (state.dirty) saveNow(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && state.dirty) saveNow();
    });
    window.addEventListener('pagehide', function () { if (state.dirty) saveNow(); });
  }

  window.NexleyDB = { all: all, get: get, put: put };

  /* ============================================================
     17 · boot
     ============================================================ */
  open().then(function () {
    return get('meta', 'device');
  }).then(function (dev) {
    if (dev) return dev;
    var rec = { key: 'device', id: uid(), created: Date.now() };
    return put('meta', rec).then(function () { return rec; });
  }).then(function (dev) {
    state.deviceId = dev.id;
    return get('meta', 'tabs');
  }).then(function (tabs) {
    state.tabs = (tabs && tabs.ids) || [];
    wire();
    setupUpdates();
    $('appVersion').textContent = 'v' + APP_VERSION;

    window.NexleyAuth.onAuthStateChange(function (event, session) {
      if (event === 'SIGNED_OUT') { showGate('unlock'); return; }
      // OAuth sign-in (Google) returns via a redirect; supabase-js resolves the
      // session asynchronously, usually AFTER the getSession() below has already
      // run and shown the gate. Enter the app when that SIGNED_IN event lands.
      if (session && event === 'SIGNED_IN' && $('gate') && !$('gate').hidden) {
        enterApp(session.user);
      }
    });

    return window.NexleyAuth.getSession();
  }).then(function (session) {
    if (!session) { showGate('create'); return; }
    return enterApp(session.user);
  }).then(function () {
    checkStorage();
    return maybeAutoBackup();
  }).catch(function (err) {
    var msg = (err && err.message) || 'Unknown error';
    document.body.textContent = '';
    var box = document.createElement('div');
    box.style.cssText = 'padding:40px;font-family:system-ui;max-width:60ch;line-height:1.6';
    var h = document.createElement('h2');
    h.textContent = 'Could not open local storage';
    var p1 = document.createElement('p');
    p1.textContent = 'Nexley keeps everything in this browser profile. If you opened the file ' +
      'directly from disk, run Nexley.bat instead so it is served over http.';
    var p2 = document.createElement('p');
    p2.style.color = '#888';
    p2.textContent = msg;
    box.appendChild(h); box.appendChild(p1); box.appendChild(p2);
    document.body.appendChild(box);
  });
})();
