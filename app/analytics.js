/* Nexley — first-party product analytics.
 *
 * Writes to the `events` table in Nexley's own Supabase project. No third party
 * is involved: usage data goes to the same backend that already holds the notes,
 * and to nowhere else.
 *
 * ⚠ THE HOSTING REGION IS UNCONFIRMED. app/legal.html says Tokyo; the August
 * decision log says Sydney. They cannot both be right, and the privacy policy
 * makes this claim to users. Confirm it in the Supabase dashboard (Project
 * Settings -> General -> Region) and correct whichever is wrong. It does not
 * change whether this file is the right design — removing a third-party
 * processor is an improvement either way — but it does change what legal.html
 * must say about cross-border disclosure under APP 8.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT POSTHOG (this file used to load it).
 * PostHog Cloud is US or EU only, and adding it means a second overseas
 * processor holding behavioural data about minors — one more party to name in
 * the privacy policy, one more transfer to justify under APP 8, and a
 * third-party script running on a page full of someone's private study notes.
 * Sending the same events to the backend that already holds the notes adds no
 * new recipient at all. That argument holds whatever region the project is in.
 *
 * The cost is PostHog's dashboards. At this stage the questions are "do people
 * come back" and "which parts get used", and those are a few SQL queries.
 * ---------------------------------------------------------------------------
 *
 * WHAT KEEPS NOTE CONTENT OUT — four layers, none of them "remember to be careful":
 *
 *   1. Events come from a fixed ALLOWED list. An unknown name is dropped and
 *      warned about, so a typo cannot invent an event.
 *   2. Properties are schema-checked: non-negative integers and short known
 *      enums only. A string that is not in the enum is discarded, so it is
 *      structurally impossible to pass a note title through here.
 *   3. The table has no content column, and a CHECK caps the whole properties
 *      object at 200 characters (see supabase/migrations/0007_events.sql).
 *   4. Nothing is sent at all if the browser signals Do Not Track or Global
 *      Privacy Control, or if nobody is signed in.
 *
 * `sanitize` is exported deliberately: the guarantee above is the entire point
 * of this file, so it has to be testable from the console.
 *
 * ADDING AN EVENT means editing ALLOWED here *and* the constraint in migration
 * 0007. Two deliberate acts with visible diffs, in two places. That friction is
 * the feature.
 */
(function () {
  'use strict';

  /* event name -> allowed properties.
     'count' = a non-negative integer. An array = an enum of permitted values. */
  var ALLOWED = {
    app_opened:        {},
    intro_finished:    { how: ['completed', 'skipped'] },
    account_created:   { via: ['email', 'google'] },
    signed_in:         { via: ['email', 'google'] },
    subject_created:   {},
    note_created:      { filed: ['syllabus', 'unfiled'] },
    note_deleted:      {},
    syllabus_imported: { nodes: 'count' },
    search_used:       {},
    mode_switched:     { mode: ['notebook', 'classwork', 'review'] },
    export_all:        {},
    snapshot_restored: {},
    // classwork + review, added 0.10.0
    capture_made:      {},
    capture_filed:     { filed: ['syllabus', 'unfiled'] },
    card_made:         { from: ['selection', 'suggestion', 'manual'] },
    review_started:    { cards: 'count' },
    card_graded:       { grade: ['again', 'hard', 'good', 'easy'] }
  };

  var MAX_QUEUE = 60;          // a session that never flushes cannot grow forever
  var FLUSH_EVERY = 45 * 1000;

  function optedOut() {
    try {
      if (navigator.globalPrivacyControl) return true;
      var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
      return dnt === '1' || dnt === 'yes';
    } catch (e) { return false; }
  }

  /* strip anything not explicitly permitted for this event */
  function clean(name, props) {
    var schema = ALLOWED[name];
    var out = {};
    if (!schema || !props) return out;
    for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      var rule = schema[k];
      var v = props[k];
      if (!rule) continue;                                    // not in the schema
      if (rule === 'count') {
        if (typeof v === 'number' && isFinite(v) && v >= 0) out[k] = Math.floor(v);
        continue;
      }
      if (Object.prototype.toString.call(rule) === '[object Array]') {
        if (rule.indexOf(v) > -1) out[k] = v;                 // a known value only
      }
    }
    return out;
  }

  var queue = [];
  var sending = false;
  var off = optedOut();

  function track(name, props) {
    if (off) return;
    if (!Object.prototype.hasOwnProperty.call(ALLOWED, name)) {
      // an ad-hoc or typo'd event name is a bug, not something to send
      if (window.console && console.warn) console.warn('[analytics] unknown event:', name);
      return;
    }
    if (queue.length >= MAX_QUEUE) return;
    queue.push({
      name: name,
      props: clean(name, props),
      app_version: String(window.NEXLEY_APP_VERSION || '').slice(0, 20)
    });
  }

  /* Analytics is the one place in this app where dropping data silently is the
     right call. Unlike a note or a crash report, a lost event costs nobody
     anything, and retrying forever on a signed-out or offline device would be
     worse than losing it. So: one attempt per flush, no retry queue, no error
     surfaced to the user. */
  function flush() {
    if (off || sending || !queue.length) return Promise.resolve(0);
    if (!window.NexleyAuth || !navigator.onLine) return Promise.resolve(0);

    sending = true;
    var batch = queue;
    queue = [];

    return window.NexleyAuth.getSession().then(function (session) {
      if (!session) return 0;                    // signed out: nothing is recorded
      var rows = batch.map(function (e) {
        return {
          user_id: session.user.id,
          name: e.name,
          props: e.props,
          app_version: e.app_version
        };
      });
      return window.NexleyAuth.client.from('events').insert(rows).then(function (res) {
        if (res.error) throw res.error;
        return rows.length;
      });
    }).catch(function (err) {
      console.warn('[analytics] batch dropped', err && err.message);
      return 0;
    }).then(function (n) {
      sending = false;
      return n;
    });
  }

  setInterval(flush, FLUSH_EVERY);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });

  window.NexleyAnalytics = {
    track: track,
    events: ALLOWED,
    sanitize: clean,
    flush: flush,
    pending: function () { return queue.length; },
    optedOut: function () { return off; }
  };
})();
