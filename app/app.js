/* Summit Education
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
 *      Retrofitting those later would mean touching every note ever written.
 *   5. BACKUPS ARE AUTOMATIC. A rolling snapshot means a bad update or a mis-tap is
 *      recoverable without relying on the user having exported.
 */

(function () {
  'use strict';

  var APP_VERSION = '0.2.0';
  var DB_NAME = 'summit-edu';
  var DB_VER = 2;            // bump + extend migrate() for any schema change
  var BACKUP_KEEP = 7;
  var BACKUP_EVERY = 20 * 60 * 60 * 1000;   // ~daily

  var db = null;

  /* ============================================================
     1 · storage
     ============================================================ */

  /* Additive only. Each block runs for anyone coming from a lower version, in order,
     so a user on v1 gets v2 cleanly and a brand-new user gets both in one pass. */
  function migrate(d, txn, from) {
    if (from < 1) {
      d.createObjectStore('meta', { keyPath: 'key' });
      d.createObjectStore('subjects', { keyPath: 'id' });
      var n = d.createObjectStore('notes', { keyPath: 'id' });
      n.createIndex('subjectId', 'subjectId', { unique: false });
      n.createIndex('updated', 'updated', { unique: false });
    }

    if (from < 2) {
      // rolling local snapshots
      if (!d.objectStoreNames.contains('backups')) {
        d.createObjectStore('backups', { keyPath: 'id' });
      }
      // sync-shaped fields on everything that already exists
      ['notes', 'subjects'].forEach(function (name) {
        if (!d.objectStoreNames.contains(name)) return;
        var store = txn.objectStore(name);
        store.openCursor().onsuccess = function (e) {
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
  }

  function open() {
    return new Promise(function (res, rej) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        migrate(e.target.result, e.target.transaction, e.oldVersion);
      };
      req.onsuccess = function () { db = req.result; res(db); };
      req.onerror = function () { rej(req.error); };
      req.onblocked = function () {
        rej(new Error('Another tab has an older version of Summit open. Close it and reload.'));
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

  /* Stamp a record on every write. This is what makes sync possible later without a
     migration — and what makes "which copy is newer" answerable. */
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
    return Promise.all([all('subjects'), all('notes')]).then(function (r) {
      var rec = {
        id: uid(),
        at: Date.now(),
        reason: reason || 'auto',
        appVersion: APP_VERSION,
        subjects: r[0],
        notes: r[1]
      };
      return put('backups', rec);
    }).then(function () {
      return all('backups');
    }).then(function (list) {
      // keep only the most recent few — this is a safety net, not an archive
      list.sort(function (a, b) { return b.at - a.at; });
      return Promise.all(list.slice(BACKUP_KEEP).map(function (b) {
        return hardDelete('backups', b.id);
      }));
    });
  }

  function maybeAutoBackup() {
    return all('backups').then(function (list) {
      var newest = list.reduce(function (m, b) { return Math.max(m, b.at); }, 0);
      if (Date.now() - newest < BACKUP_EVERY) return;
      return snapshot('auto');
    }).catch(function () { /* a failed backup must never block the app */ });
  }

  function restore(backupId) {
    return get('backups', backupId).then(function (b) {
      if (!b) return;
      return snapshot('before-restore').then(function () {
        var jobs = (b.subjects || []).map(function (s) { return put('subjects', s); })
          .concat((b.notes || []).map(function (n) { return put('notes', n); }));
        return Promise.all(jobs);
      }).then(function () {
        state.activeNote = null;
        return refresh();
      }).then(function () {
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

  function plain(html) {
    var d = document.createElement('div');
    d.innerHTML = html || '';
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /* Local convenience lock only — NOT security. Anyone with access to this device can
     read the database directly. Said plainly in the UI too. */
  function hash(str) {
    var h = 5381, i;
    for (i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return String(h >>> 0);
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
    account: null,
    deviceId: null,
    subjects: [],
    notes: [],
    activeSubject: null,
    activeNote: null,
    query: '',
    dirty: false,
    editingSubject: null,
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
      ? 'Create your account. Everything stays on this device.'
      : 'Welcome back' + (state.account && state.account.name ? ', ' + state.account.name : '') + '.';
    $('passLabel').innerHTML = creating ? 'Passcode <em>(optional)</em>' : 'Passcode';
    $('fPass').placeholder = creating ? 'leave blank for none' : 'enter passcode';
    $('gateBtn').textContent = creating ? 'Create account' : 'Unlock';
    $('gateErr').hidden = true;
    $('fName').value = '';
    $('fPass').value = '';
    setTimeout(function () { (creating ? $('fName') : $('fPass')).focus(); }, 60);
    $('gateForm').dataset.mode = creating ? 'create' : 'unlock';
  }

  function gateError(msg) {
    var el = $('gateErr');
    el.textContent = msg;
    el.hidden = false;
  }

  function gateSubmit(e) {
    e.preventDefault();
    var mode = $('gateForm').dataset.mode;
    var pass = $('fPass').value;

    if (mode === 'create') {
      var name = $('fName').value.trim();
      if (!name) return gateError('Enter a name.');
      var acct = {
        key: 'account', name: name,
        pass: pass ? hash(pass) : null,
        created: Date.now()
      };
      put('meta', acct).then(function () {
        state.account = acct;
        return seed();
      }).then(function () {
        $('gate').hidden = true;
        $('app').hidden = false;
        return refresh();
      });
      return;
    }

    if (state.account.pass && hash(pass) !== state.account.pass) {
      return gateError('That passcode does not match. Try again.');
    }
    $('gate').hidden = true;
    $('app').hidden = false;
    refresh();
  }

  function seed() {
    var s = stamp({ id: uid(), name: 'General', code: 'GEN', colour: COLOURS[0] });
    var n = stamp({
      id: uid(), subjectId: s.id, font: 'standard',
      title: 'Welcome to Summit',
      body: '<p>Everything you write is stored on this device. There is no server behind ' +
            'this app and nothing is uploaded.</p>' +
            '<h3>Your work is safe across updates</h3>' +
            '<ul><li>Updating the app replaces its files. It never touches your notes — ' +
            'they live in a separate store.</li>' +
            '<li>A snapshot is taken automatically about once a day. Open ' +
            '<b>Snapshots</b> in the sidebar to roll back.</li>' +
            '<li>Deleting a note flags it rather than destroying it.</li>' +
            '<li><b>Export</b> writes everything to a file whenever you want it.</li></ul>' +
            '<h3>Next</h3>' +
            '<ul><li>Filing notes against syllabus areas</li>' +
            '<li>Linking notes to each other</li>' +
            '<li>Handwriting</li></ul>' +
            '<p>Delete this note whenever you like.</p>'
    });
    return put('subjects', s).then(function () { return put('notes', n); });
  }

  /* ============================================================
     6 · load + render
     ============================================================ */
  function refresh() {
    return Promise.all([all('subjects'), all('notes')]).then(function (r) {
      state.subjects = live(r[0]).sort(function (a, b) { return a.name.localeCompare(b.name); });
      state.notes = live(r[1]).sort(function (a, b) { return b.updated - a.updated; });
      renderSubjects();
      renderList();
      renderEditor();
    });
  }

  function subjectById(id) {
    for (var i = 0; i < state.subjects.length; i++) {
      if (state.subjects[i].id === id) return state.subjects[i];
    }
    return null;
  }

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
      ed.addEventListener('click', function (e) {
        e.stopPropagation();
        openSubjectDialog(s);
      });
      b.appendChild(ed);
    }

    var ct = document.createElement('span');
    ct.className = 'ct';
    ct.textContent = count;
    b.appendChild(ct);

    b.addEventListener('click', function () {
      if (state.dirty) saveNow();
      state.activeSubject = s.id;
      state.query = '';
      $('search').value = '';
      $('app').classList.remove('editing');
      state.activeNote = null;
      renderSubjects();
      renderList();
      renderEditor();
    });
    return b;
  }

  function visibleNotes() {
    var q = state.query.trim().toLowerCase();
    return state.notes.filter(function (n) {
      if (state.activeSubject && n.subjectId !== state.activeSubject) return false;
      if (!q) return true;
      return (n.title || '').toLowerCase().indexOf(q) > -1 ||
             plain(n.body).toLowerCase().indexOf(q) > -1;
    });
  }

  function renderList() {
    var subj = state.activeSubject ? subjectById(state.activeSubject) : null;
    $('listTitle').textContent = state.query ? 'Search results' : (subj ? subj.name : 'All notes');
    $('listContext').textContent = state.query
      ? '"' + state.query + '"' : (subj ? (subj.code || 'Subject') : 'Everything');

    var list = visibleNotes();
    var wrap = $('noteList');
    wrap.textContent = '';

    if (!list.length) {
      var e = document.createElement('p');
      e.className = 'listempty';
      e.textContent = state.query ? 'Nothing matches that search.'
        : (state.subjects.length ? 'No notes here yet. Hit "New note" to start one.'
                                 : 'Add a subject first, then start writing.');
      wrap.appendChild(e);
      return;
    }

    list.forEach(function (n) {
      var s = subjectById(n.subjectId);
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
      card.addEventListener('click', function () { openNote(n.id); });
      wrap.appendChild(card);
    });
  }

  /* ============================================================
     7 · editor
     ============================================================ */
  var saveTimer = null;

  function openNote(id) {
    if (state.dirty) saveNow();
    state.activeNote = id;
    $('app').classList.add('editing');
    renderList();
    renderEditor();
    setTimeout(function () { $('noteTitle').focus(); }, 40);
  }

  function closeNote() {
    if (state.dirty) saveNow();
    state.activeNote = null;
    $('app').classList.remove('editing');
    renderList();
    renderEditor();
  }

  function activeNoteObj() {
    for (var i = 0; i < state.notes.length; i++) {
      if (state.notes[i].id === state.activeNote) return state.notes[i];
    }
    return null;
  }

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

    var s = subjectById(n.subjectId);
    var c = $('crumb');
    c.textContent = '';
    var dot = document.createElement('i');
    dot.className = 'dot';
    dot.style.background = s ? s.colour : 'var(--muted)';
    var b = document.createElement('b');
    b.textContent = s ? s.name : 'No subject';
    var sep = document.createElement('span');
    sep.textContent = '›';
    var ttl = document.createElement('span');
    ttl.textContent = n.title || 'Untitled note';
    c.appendChild(dot); c.appendChild(b); c.appendChild(sep); c.appendChild(ttl);

    applyFont(n.font || 'standard');
    markSaved();
    countWords();
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
    stamp(n);
    clearTimeout(saveTimer);
    return put('notes', n).then(function () {
      state.notes.sort(function (a, b) { return b.updated - a.updated; });
      renderSubjects();
      renderList();
      // a save landing after the user moved on must not rewrite the new note's chrome
      if (state.activeNote !== n.id) return;
      markSaved();
      var s = subjectById(n.subjectId);
      var c = $('crumb');
      if (c.children.length >= 4) {
        c.children[1].textContent = s ? s.name : 'No subject';
        c.children[3].textContent = n.title || 'Untitled note';
      }
    });
  }

  function newNote() {
    if (!state.subjects.length) {
      toast('Add a subject first.');
      openSubjectDialog(null);
      return;
    }
    var n = stamp({
      id: uid(),
      subjectId: state.activeSubject || state.subjects[0].id,
      title: '', body: '', font: 'standard'
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
      state.activeNote = null;
      renderSubjects();
      renderList();
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
     8 · subjects
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
      b.addEventListener('click', function () {
        state.pendingColour = c;
        renderSwatches();
      });
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
    var msg = kids.length
      ? 'Delete "' + s.name + '" and its ' + kids.length + ' note' + (kids.length === 1 ? '' : 's') +
        '?\n\nThey are flagged as deleted, not destroyed — the most recent snapshot can bring them back.'
      : 'Delete "' + s.name + '"?';
    if (!confirm(msg)) return;

    Promise.all(kids.map(function (n) { return softDelete('notes', n); }))
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
     9 · export / import / snapshots
     ============================================================ */
  function exportAll() {
    return Promise.all([all('subjects'), all('notes')]).then(function (r) {
      var payload = {
        app: 'summit-education',
        format: 2,
        appVersion: APP_VERSION,
        exported: new Date().toISOString(),
        device: state.deviceId,
        account: state.account ? { name: state.account.name, created: state.account.created } : null,
        // tombstones included on purpose: a future sync needs to know what was deleted
        subjects: r[0],
        notes: r[1]
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
        return toast('That does not look like a Summit export.');
      }

      snapshot('before-import').then(function () {
        return Promise.all([all('subjects'), all('notes')]);
      }).then(function (cur) {
        var index = {};
        cur[0].forEach(function (s) { index['s:' + s.id] = s; });
        cur[1].forEach(function (n) { index['n:' + n.id] = n; });

        var kept = 0, skipped = 0, jobs = [];
        function consider(store, prefix, rec) {
          var mine = index[prefix + rec.id];
          if (mine && (mine.updated || 0) >= (rec.updated || 0)) { skipped++; return; }
          kept++;
          jobs.push(put(store, rec));
        }
        (data.subjects || []).forEach(function (s) { consider('subjects', 's:', s); });
        data.notes.forEach(function (n) { consider('notes', 'n:', n); });

        return Promise.all(jobs).then(function () {
          return refresh();
        }).then(function () {
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
          'and before any import or restore.';
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
          live(b.subjects || []).length + ' subjects · ' + b.reason;
        meta.appendChild(t); meta.appendChild(sub);

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.textContent = 'Restore';
        btn.addEventListener('click', function () {
          if (!confirm('Restore this snapshot?\n\nAnything newer is kept, and a snapshot of ' +
                       'right now is taken first, so this is reversible.')) return;
          restore(b.id).then(function () { $('snapDialog').close(); });
        });

        row.appendChild(meta);
        row.appendChild(btn);
        wrap.appendChild(row);
      });

      $('snapDialog').showModal();
    });
  }

  /* ============================================================
     10 · updates

     The app must be updatable daily without disturbing work in progress. So a new
     version is NOT applied the moment it downloads — it waits, the user is told, and it
     is applied on their say-so after the current note has been flushed to disk.
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
          // flush before anything swaps underneath us
          Promise.resolve(state.dirty ? saveNow() : null).then(function () {
            return snapshot('before-update');
          }).then(function () {
            worker.postMessage({ type: 'SKIP_WAITING' });
          });
        };
        $('updateLater').onclick = function () { bar.hidden = true; };
      }

      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);

      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          // "installed" with an existing controller means this is an update, not a first install
          if (nw.state === 'installed' && navigator.serviceWorker.controller) offer(nw);
        });
      });

      // look for a new version whenever the app is brought back to the foreground
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) reg.update().catch(function () {});
      });
    }).catch(function () { /* the app works without it, just not offline */ });
  }

  /* ============================================================
     11 · storage durability
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
     12 · wiring
     ============================================================ */
  function wire() {
    $('gateForm').addEventListener('submit', gateSubmit);

    $('newNote').addEventListener('click', newNote);
    $('deleteNote').addEventListener('click', deleteNote);
    $('backBtn').addEventListener('click', closeNote);
    $('addSubject').addEventListener('click', function () { openSubjectDialog(null); });

    $('noteTitle').addEventListener('input', markDirty);
    $('noteBody').addEventListener('input', function () { markDirty(); countWords(); });
    $('noteSubject').addEventListener('change', markDirty);

    $('noteBody').addEventListener('paste', function (e) {
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    $('search').addEventListener('input', function (e) {
      state.query = e.target.value;
      renderList();
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
      if (!state.account.pass) return toast('No passcode set — nothing to lock.');
      showGate('unlock');
    });

    $('subjForm').addEventListener('submit', saveSubject);
    $('subjCancel').addEventListener('click', function () {
      $('subjDialog').close();
      state.editingSubject = null;
    });
    $('subjDelete').addEventListener('click', deleteSubject);

    document.addEventListener('keydown', function (e) {
      var k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 's') {
        e.preventDefault();
        if (activeNoteObj()) saveNow().then(function () { toast('Saved.'); });
      }
      if ((e.ctrlKey || e.metaKey) && k === 'k') {
        e.preventDefault();
        $('search').focus();
      }
    });

    // last line of defence — never lose the buffer on close or on backgrounding a tablet
    window.addEventListener('beforeunload', function () { if (state.dirty) saveNow(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && state.dirty) saveNow();
    });
    window.addEventListener('pagehide', function () { if (state.dirty) saveNow(); });
  }

  /* ============================================================
     13 · boot
     ============================================================ */
  open().then(function () {
    return get('meta', 'device');
  }).then(function (dev) {
    if (dev) return dev;
    var rec = { key: 'device', id: uid(), created: Date.now() };
    return put('meta', rec).then(function () { return rec; });
  }).then(function (dev) {
    state.deviceId = dev.id;
    return get('meta', 'account');
  }).then(function (acct) {
    wire();
    setupUpdates();
    $('appVersion').textContent = 'v' + APP_VERSION;

    if (!acct) { showGate('create'); return; }
    state.account = acct;
    if (acct.pass) { showGate('unlock'); }
    else { $('gate').hidden = true; $('app').hidden = false; refresh(); }
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
    p1.textContent = 'Summit keeps everything in this browser profile. If you opened the file ' +
      'directly from disk, run Summit.bat instead so it is served over http.';
    var p2 = document.createElement('p');
    p2.style.color = '#888';
    p2.textContent = msg;
    box.appendChild(h); box.appendChild(p1); box.appendChild(p2);
    document.body.appendChild(box);
  });
})();
