/* Nexley — crash reporting and "Report a problem".
 *
 * Two ways a problem reaches us:
 *   1. automatically, when the app throws or a promise rejects unhandled
 *   2. deliberately, when someone writes one in the Report a problem dialog
 *
 * Both land in public.bug_reports (see supabase/migrations/0004_bug_reports.sql),
 * which is insert-only: not even the reporter can read the table back. Alec reads
 * it in the Supabase dashboard.
 *
 * THE THING TO BE CAREFUL ABOUT
 * This app's content is private study notes, and a crash reporter is the classic
 * way to leak exactly that — error messages and stack traces quote the data that
 * broke them. So nothing here ever touches note fields, and everything that does
 * get sent goes through scrub(): emails redacted, long values truncated, and the
 * payload has named columns only, with no free-form blob for content to hide in.
 * The one field that carries the user's own words is `note`, which they typed on
 * purpose, having been shown what else is attached.
 *
 * IT MUST NEVER MAKE THINGS WORSE
 * A reporter that throws while reporting an error is a loop that takes the app
 * down. Every path here is wrapped, failures are swallowed, the same fault is
 * only sent once per session, and there is a hard per-session cap.
 */
(function () {
  'use strict';

  var MAX_PER_SESSION = 8;
  var MAX_MESSAGE = 300;
  var MAX_STACK = 1500;
  var MAX_NOTE = 2000;
  var QUEUE_KEY = 'nexley-report-queue';
  var MAX_QUEUE = 20;

  var sentSignatures = {};
  var sentCount = 0;
  var busy = false;

  /* ---------- scrubbing ---------- */

  function scrub(s, cap) {
    if (s === null || s === undefined) return null;
    s = String(s);
    // emails are the one piece of personal data that reliably turns up in errors
    s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
    // long tokens (jwt-ish) shouldn't ride along either
    s = s.replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[token]');
    if (s.length > cap) s = s.slice(0, cap) + '…';
    return s;
  }

  /* For machine-written text (error messages, stacks) — everything scrub does, plus
     redacting quoted prose.
     Browsers quote identifiers in the useful part of an error ("reading 'toLowerCase'"),
     but a quoted span containing whitespace, or a long one, is far more likely to be
     the user's data that broke the code than a property name. So identifiers survive
     and sentences don't.
     THE LIMIT, STATED HONESTLY: this cannot catch content interpolated into a message
     without quotes. Nothing in this app does that today (the only two hand-written
     Errors are fixed strings) and nothing should start — if you ever write
     `throw new Error('Could not save ' + note.title)` you have defeated this. */
  function scrubMachine(s, cap) {
    if (s === null || s === undefined) return null;
    // inner run stops only at the SAME quote character — a naive [^'"`] class fails on
    // "mum's surgery", where the apostrophe ends the run and the sentence escapes
    s = String(s).replace(/(["'`])((?:(?!\1)[^\n])*)\1/g, function (whole, q, inner) {
      if (inner.length > 32 || /\s/.test(inner)) return q + '[redacted]' + q;
      return whole;
    });
    return scrub(s, cap);
  }

  // absolute URLs -> just the file, so reports read cleanly and carry no query strings
  function shortSource(url, line, col) {
    if (!url) return null;
    var file;
    try { file = new URL(url, location.href).pathname.split('/').pop(); }
    catch (e) { file = String(url).split('/').pop(); }
    return scrubMachine(file + (line ? ':' + line : '') + (col ? ':' + col : ''), 120);
  }

  function shortStack(stack) {
    if (!stack) return null;
    // keep the frames, drop the origin from each so it reads as file:line:col
    var cleaned = String(stack).replace(new RegExp(location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
    return scrubMachine(cleaned, MAX_STACK);
  }

  /* ---------- context ---------- */

  function currentView() {
    try {
      var el = function (id) { return document.getElementById(id); };
      if (el('intro') && !el('intro').hidden) return 'intro';
      if (el('gate') && getComputedStyle(el('gate')).display !== 'none') return 'gate';
      var app = el('app');
      if (!app || app.hidden) return 'loading';
      if (app.classList.contains('stubbed')) return 'stub';
      if (app.classList.contains('editing')) return 'editor';
      return 'notebook';
    } catch (e) { return null; }
  }

  function currentPage() {
    var f = location.pathname.split('/').pop() || 'index.html';
    if (f === 'app.html') return 'app';
    if (f === 'legal.html') return 'legal';
    return 'landing';
  }

  function diagnostics() {
    var d = {};
    try {
      d.app_version = window.NEXLEY_APP_VERSION || null;
      d.page = currentPage();
      d.view = currentView();
      d.online = !!navigator.onLine;
      d.standalone = window.navigator.standalone === true ||
        ['standalone', 'fullscreen', 'minimal-ui'].some(function (m) {
          return window.matchMedia('(display-mode: ' + m + ')').matches;
        });
      d.viewport = window.innerWidth + 'x' + window.innerHeight;
      d.user_agent = scrub(navigator.userAgent, 300);
    } catch (e) {}
    return d;
  }

  /* ---------- queue (offline, and retry) ---------- */

  function readQueue() {
    try {
      var raw = localStorage.getItem(QUEUE_KEY);
      var q = raw ? JSON.parse(raw) : [];
      return Object.prototype.toString.call(q) === '[object Array]' ? q : [];
    } catch (e) { return []; }
  }
  function writeQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUE))); } catch (e) {}
  }
  function enqueue(row) {
    var q = readQueue();
    q.push(row);
    writeQueue(q);
  }

  function uuid() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
    });
  }

  /* ---------- sending ---------- */

  function flush() {
    if (busy) return Promise.resolve();
    var q = readQueue();
    if (!q.length) return Promise.resolve();
    if (!navigator.onLine) return Promise.resolve();
    if (!window.NexleyAuth || !window.NexleyAuth.client) return Promise.resolve();

    busy = true;
    return window.NexleyAuth.getSession().then(function (session) {
      var uid = session && session.user ? session.user.id : null;
      var rows = q.map(function (r) {
        // stamp the identity at send time: a crash captured before sign-in that is
        // only sent afterwards should still be attributable
        r.user_id = r.user_id || uid;
        return r;
      });
      return window.NexleyAuth.client.from('bug_reports').insert(rows).then(function (res) {
        if (res.error) throw res.error;
        writeQueue([]);      // only ever cleared on a confirmed write
      });
    }).catch(function (err) {
      /* Keep the queue for the next attempt and never surface anything to the user —
         but DO say so in the console. An earlier version treated 42501 as an expected
         refusal and dropped the batch, which meant a misconfigured backend looked
         exactly like a working one: the queue drained, the UI said "sent", and nothing
         was ever stored. A report is only ever discarded on a confirmed write now.
         The queue is capped at MAX_QUEUE, so retrying forever cannot grow unbounded. */
      if (window.console && console.warn) {
        console.warn('[nexley] report not sent, still queued:', err && (err.message || err.code));
      }
    }).then(function () { busy = false; });
  }

  function submit(row) {
    var d = diagnostics();
    for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) row[k] = d[k];
    row.id = uuid();
    enqueue(row);
    return flush();
  }

  /* ---------- automatic capture ---------- */

  function signatureOf(message, source) {
    return scrubMachine((message || '') + '|' + (source || ''), 200);
  }

  function capture(message, source, stack) {
    try {
      if (sentCount >= MAX_PER_SESSION) return;
      var sig = signatureOf(message, source);
      if (sentSignatures[sig]) return;      // same fault, already told
      sentSignatures[sig] = true;
      sentCount++;
      submit({
        kind: 'crash',
        message: scrubMachine(message, MAX_MESSAGE) || 'Unknown error',
        stack: shortStack(stack),
        source: source || null,
        note: null,
        signature: sig
      });
    } catch (e) { /* a reporter that throws is worse than the bug */ }
  }

  window.addEventListener('error', function (e) {
    // resource load failures (img/script) surface here with no message; not useful
    if (!e || (!e.message && !e.error)) return;
    capture(e.message, shortSource(e.filename, e.lineno, e.colno),
            e.error && e.error.stack);
  });

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    if (!r) return;
    var msg = (r && r.message) || String(r);
    capture('Unhandled rejection: ' + msg, null, r && r.stack);
  });

  window.addEventListener('online', flush);

  /* ---------- the button ---------- */

  function reportProblem(note) {
    return submit({
      kind: 'user',
      message: 'Reported from the app',
      stack: null,
      source: null,
      note: scrub(note, MAX_NOTE),
      signature: null
    });
  }

  window.NexleyErrors = {
    report: reportProblem,
    diagnostics: diagnostics,
    flush: flush,
    pending: function () { return readQueue().length; },
    _capture: capture            // exposed so the behaviour is testable
  };

  // anything queued from a previous session (offline, or a crash on the way out)
  setTimeout(flush, 3000);
})();
