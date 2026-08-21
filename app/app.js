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

  var APP_VERSION = '0.3.0';
  var DB_NAME = 'summit-edu';
  var DB_VER = 3;
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
  }

  function open() {
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) { migrate(e.target.result, e.target.transaction, e.oldVersion); };
      req.onsuccess = function () { db = req.result; res(db); };
      req.onerror = function () { rej(req.error); };
      req.onblocked = function () {
        rej(new Error('Another tab has an older version of Nexley open. Close it and reload.'));
      };
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

  /* ============================================================
     2 · backups
     ============================================================ */
  function snapshot(reason) {
    return Promise.all([all('subjects'), all('notes'), all('syllabus')]).then(function (r) {
      return put('backups', {
        id: uid(), at: Date.now(), reason: reason || 'auto', appVersion: APP_VERSION,
        subjects: r[0], notes: r[1], syllabus: r[2]
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
          .concat((b.syllabus || []).map(function (s) { return put('syllabus', s); }));
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

  function plain(html) {
    var d = document.createElement('div');
    d.innerHTML = html || '';
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

  var COLOURS = ['#1E4D3E', '#2E6F8E', '#8A5A2B', '#7A3B5C', '#4A6B2F', '#A8721B', '#3F4C8A', '#A8391F'];

  /* ============================================================
     4 · state
     ============================================================ */
  var state = {
    account: null, deviceId: null,
    subjects: [], notes: [], syllabus: [],
    activeSubject: null, activeNode: null, activeNote: null,
    tabs: [], collapsed: {},
    query: '', dirty: false,
    editingSubject: null, editingNode: null, pendingParent: null,
    pendingColour: COLOURS[0]
  };

  /* ============================================================
     5 · gate
     ============================================================ */
  function showGate(mode) {
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
  }
  function gateError(msg) { var el = $('gateErr'); el.textContent = msg; el.hidden = false; $('gateBtn').disabled = false; }

  function enterApp(user) {
    state.account = { id: user.id, name: (user.user_metadata && user.user_metadata.name) || '', email: user.email };
    $('gate').hidden = true; $('app').hidden = false;
    return refresh().then(function () { window.SummitSync.run(); });
  }

  function gateSubmit(e) {
    e.preventDefault();
    var mode = $('gateForm').dataset.mode;
    var email = $('fEmail').value.trim();
    var pass = $('fPass').value;
    if (!email) return gateError('Enter your email.');
    if (pass.length < 6) return gateError('Password must be at least 6 characters.');
    $('gateBtn').disabled = true;

    if (mode === 'create') {
      var name = $('fName').value.trim();
      if (!name) { $('gateBtn').disabled = false; return gateError('Enter a name.'); }
      window.SummitAuth.signUpEmail(email, pass, name).then(function (data) {
        if (!data.session) {
          gateError('Check your email to confirm your account, then sign in.');
          showGate('unlock');
          return;
        }
        return seed().then(function () { return enterApp(data.user); });
      }).catch(function (err) { gateError(err.message || 'Could not create account.'); });
      return;
    }

    window.SummitAuth.signInEmail(email, pass).then(function (data) {
      return enterApp(data.user);
    }).catch(function (err) { gateError(err.message || 'Could not sign in.'); });
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
  function refresh() {
    return Promise.all([all('subjects'), all('notes'), all('syllabus')]).then(function (r) {
      state.subjects = live(r[0]).sort(function (a, b) { return a.name.localeCompare(b.name); });
      state.notes = live(r[1]).sort(function (a, b) { return b.updated - a.updated; });
      state.syllabus = live(r[2]).sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      // drop tabs whose notes have gone
      state.tabs = state.tabs.filter(noteById);
      renderSubjects();
      renderBrowser();
      renderTabs();
      renderEditor();
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
    return state.notes.filter(function (n) { return n.subjectId === subjectId && !n.syllabusId; });
  }

  /* ============================================================
     7 · rail
     ============================================================ */
  function renderSubjects() {
    var wrap = $('subjectList');
    wrap.textContent = '';
    wrap.appendChild(subjectRow({ id: null, name: 'All notes', colour: 'var(--muted)' },
      state.notes.length, false));
    state.subjects.forEach(function (s) {
      var count = state.notes.filter(function (n) { return n.subjectId === s.id; }).length;
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
    k.textContent = n.kind === 'syllabus' ? 'syl' : 'mine';
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
    var list = state.notes.filter(function (n) {
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
    $('noteStamp').textContent = 'Created ' + when(n.created) + ' · edited ' + when(n.updated);

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
      .then(function () { toast('Added ' + parsed.length + ' topics and ' + points + ' dot points.'); });
  }

  /* ============================================================
     13 · export / import / snapshots
     ============================================================ */
  function exportAll() {
    return Promise.all([all('subjects'), all('notes'), all('syllabus')]).then(function (r) {
      var payload = {
        app: 'summit-education', format: 3, appVersion: APP_VERSION,
        exported: new Date().toISOString(), device: state.deviceId,
        account: state.account ? { name: state.account.name, email: state.account.email } : null,
        // tombstones included on purpose: a future sync needs to know what was deleted
        subjects: r[0], notes: r[1], syllabus: r[2]
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'summit-' + new Date().toISOString().slice(0, 10) + '.json';
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
      if (!data || data.app !== 'summit-education' || !Array.isArray(data.notes)) {
        return toast('That does not look like a Nexley export.');
      }

      snapshot('before-import').then(function () {
        return Promise.all([all('subjects'), all('notes'), all('syllabus')]);
      }).then(function (cur) {
        var index = {}, kept = 0, skipped = 0, jobs = [];
        cur[0].forEach(function (s) { index['s:' + s.id] = s; });
        cur[1].forEach(function (n) { index['n:' + n.id] = n; });
        cur[2].forEach(function (y) { index['y:' + y.id] = y; });

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

    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return;
      reloading = true;
      location.reload();
    });

    navigator.serviceWorker.register('sw.js').then(function (reg) {
      function offer(worker) {
        if (!worker) return;
        var bar = $('updateBar');
        bar.hidden = false;
        $('updateNow').onclick = function () {
          Promise.resolve(state.dirty ? saveNow() : null)
            .then(function () { return snapshot('before-update'); })
            .then(function () { worker.postMessage({ type: 'SKIP_WAITING' }); });
        };
        $('updateLater').onclick = function () { bar.hidden = true; };
      }

      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);

      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) offer(nw);
        });
      });

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
      window.SummitAuth.signInGoogle().catch(function (err) { gateError(err.message || 'Could not sign in with Google.'); });
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

    $('lockBtn').addEventListener('click', function () {
      if (state.dirty) saveNow();
      window.SummitAuth.signOut().then(function () { showGate('unlock'); });
    });

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
      var k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 's') {
        e.preventDefault();
        if (activeNoteObj()) saveNow().then(function () { toast('Saved.'); });
      }
      if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); $('search').focus(); }
    });

    // last line of defence — never lose the buffer on close or on backgrounding a tablet
    window.addEventListener('beforeunload', function () { if (state.dirty) saveNow(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && state.dirty) saveNow();
    });
    window.addEventListener('pagehide', function () { if (state.dirty) saveNow(); });
  }

  window.SummitDB = { all: all, get: get, put: put };

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

    window.SummitAuth.onAuthStateChange(function (event) {
      if (event === 'SIGNED_OUT') showGate('unlock');
    });

    return window.SummitAuth.getSession();
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
      'directly from disk, run Summit.bat instead so it is served over http.';
    var p2 = document.createElement('p');
    p2.style.color = '#888';
    p2.textContent = msg;
    box.appendChild(h); box.appendChild(p1); box.appendChild(p2);
    document.body.appendChild(box);
  });
})();
