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

  var APP_VERSION = '0.10.0';
  // errors.js loads before this and stamps crash reports with it
  window.NEXLEY_APP_VERSION = APP_VERSION;
  var DB_NAME = 'nexley';
  var OLD_DB_NAME = 'summit-edu';   // pre-0.4.1 name; contents adopted once on first open
  var DB_VER = 4;
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
    return Promise.all([all('subjects'), all('notes'), all('syllabus'), all('cards')]).then(function (r) {
      return put('backups', {
        id: uid(), at: Date.now(), reason: reason || 'auto', appVersion: APP_VERSION,
        subjects: r[0], notes: r[1], syllabus: r[2], cards: r[3]
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
          // snapshots taken before 0.10.0 have no cards key — leave the deck alone
          .concat((b.cards || []).map(function (c) { return put('cards', c); }));
        return Promise.all(jobs);
      }).then(function () {
        state.activeNote = null;
        state.tabs = [];
        return refresh();
      }).then(function () { toast('Restored the snapshot from ' + when(b.at) + '.'); });
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
    subjects: [], notes: [], syllabus: [], cards: [],
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
        return enterApp(data.user);
      }).catch(function (err) { done(); gateError(err.message || 'Could not create account.'); });
      return;
    }

    window.NexleyAuth.signInEmail(email, pass).then(function (data) {
      done();
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
    return Promise.all([all('subjects'), all('notes'), all('syllabus'), all('cards')]).then(function (r) {
      return migrateColours(live(r[0])).then(function () { return r; });
    }).then(function (r) {
      state.subjects = live(r[0]).sort(function (a, b) { return a.name.localeCompare(b.name); });
      state.notes = live(r[1]).sort(function (a, b) { return b.updated - a.updated; });
      state.syllabus = live(r[2]).sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      state.cards = live(r[3]);
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

    $('coverage').hidden = false;
    $('covFill').style.width = pct + '%';
    $('covLabel').textContent = covered + ' / ' + points.length + ' written · ' + pct + '%';
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
    renderCrumb(n);
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
      renderCrumb(n);
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
    $('app').classList.toggle('moded', m !== 'notebook');

    if (m === 'classwork') {
      renderClasswork();
      // the point of this mode is that the box is already waiting
      if (!matchMedia('(pointer:coarse)').matches) $('cwInput').focus();
    }
    if (m === 'review') { session = null; renderReview(); }
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
      track('capture_filed', { filed: !!c.syllabusId });
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

  function renderSuggestions(panel) {
    var list = suggestions();
    if (!list.length) return;

    var h = document.createElement('div');
    h.className = 'rv-stat';
    var head = document.createElement('h4');
    head.style.cssText = 'font-family:var(--code);font-size:.625rem;letter-spacing:.11em;'
      + 'text-transform:uppercase;color:var(--muted);font-weight:400;margin:26px 0 4px;'
      + 'padding-bottom:7px;border-bottom:1px solid var(--rule-soft)';
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
      keep.addEventListener('click', function () { openCardDialog(null, sg); });
      acts.appendChild(keep);
      row.appendChild(acts);
      panel.appendChild(row);
    });
  }

  /* ---- card dialog ---- */
  var editingCard = null;
  function openCardDialog(card, prefill) {
    editingCard = card || null;
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
      track('card_made', {});
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
    });
  }

  /* ============================================================
     13 · export / import / snapshots
     ============================================================ */
  function exportAll() {
    return Promise.all([all('subjects'), all('notes'), all('syllabus'), all('cards')]).then(function (r) {
      var payload = {
        app: 'nexley', format: 4, appVersion: APP_VERSION,
        exported: new Date().toISOString(), device: state.deviceId,
        account: state.account ? { name: state.account.name, email: state.account.email } : null,
        // tombstones included on purpose: a future sync needs to know what was deleted
        subjects: r[0], notes: r[1], syllabus: r[2], cards: r[3]
      };
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
        return Promise.all([all('subjects'), all('notes'), all('syllabus'), all('cards')]);
      }).then(function (cur) {
        var index = {}, kept = 0, skipped = 0, jobs = [];
        cur[0].forEach(function (s) { index['s:' + s.id] = s; });
        cur[1].forEach(function (n) { index['n:' + n.id] = n; });
        cur[2].forEach(function (y) { index['y:' + y.id] = y; });
        cur[3].forEach(function (c) { index['c:' + c.id] = c; });

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

    $('search').addEventListener('input', function (e) {
      state.query = e.target.value;
      renderBrowser();
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
      if (!state.account || state.dirty) return;
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
