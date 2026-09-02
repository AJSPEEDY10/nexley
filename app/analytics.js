/* Nexley — product analytics.
 *
 * OFF BY DEFAULT. Nothing loads and no request is made unless a key is set in
 * config.js (window.NEXLEY_POSTHOG_KEY). Absent key = this file is inert.
 *
 * ---------------------------------------------------------------------------
 * BEFORE TURNING THIS ON, UPDATE app/legal.html.
 * The privacy policy currently promises no third-party tracking, and Nexley is
 * aimed at high-school students including some under 13. Enabling analytics
 * without disclosing it would make that page untrue. Paste this into legal.html
 * under "What we collect", in the same commit as the key:
 *
 *   <h3>Anonymous usage statistics</h3>
 *   <p>Nexley records a small number of anonymous events — such as the app being
 *   opened, a note being created, or a syllabus being imported — so we can tell
 *   which parts of the app are actually used. These events never include the
 *   content, titles or subjects of your notes, and they are not linked to your
 *   account or to any profile. They are processed by PostHog. If your browser
 *   sends a Do Not Track or Global Privacy Control signal, Nexley records
 *   nothing at all.</p>
 *
 * And change the "We do not run third-party advertising or ad-tracking" bullet
 * so it stays accurate (it still is — this is not ad-tracking — but the new
 * section should sit next to it).
 * ---------------------------------------------------------------------------
 *
 * WHY THIS IS NOT JUST posthog.init():
 *
 * This is a notebook. Its DOM contains the user's private study notes, and their
 * note titles are in the page title. PostHog's defaults — autocapture, session
 * recording, pageview capture — would send that content to a third party. So:
 *
 *   - autocapture OFF, session recording OFF, pageviews OFF, heatmaps OFF
 *   - no identified person profiles; events are anonymous
 *   - events come from a fixed ALLOWED list, not free-form strings
 *   - properties are schema-checked: numbers, booleans and short known enums
 *     only. A string that isn't in the schema's enum is dropped, so it is
 *     structurally impossible to send a note title through here by mistake.
 *
 * If you need a new event, add it to ALLOWED. That is the point: adding one is
 * a deliberate act with a visible diff, not something a call site can do on its
 * own.
 */
(function () {
  'use strict';

  /* event name -> allowed properties.
     'count' = a non-negative integer. Anything listed as an array is an enum. */
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
    snapshot_restored: {}
  };

  function optedOut() {
    try {
      if (navigator.globalPrivacyControl) return true;
      var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
      return dnt === '1' || dnt === 'yes';
    } catch (e) { return false; }
  }

  // strip anything not explicitly permitted for this event
  function clean(name, props) {
    var schema = ALLOWED[name];
    var out = {};
    if (!props) return out;
    for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      var rule = schema[k];
      var v = props[k];
      if (!rule) continue;                                   // not in the schema
      if (rule === 'count') {
        if (typeof v === 'number' && isFinite(v) && v >= 0) out[k] = Math.floor(v);
        continue;
      }
      if (Object.prototype.toString.call(rule) === '[object Array]') {
        if (rule.indexOf(v) > -1) out[k] = v;                 // known value only
      }
    }
    return out;
  }

  var ready = false;
  var queue = [];

  function track(name, props) {
    if (!Object.prototype.hasOwnProperty.call(ALLOWED, name)) {
      // a typo'd or ad-hoc event name is a bug, not something to send
      if (window.console && console.warn) console.warn('[analytics] unknown event:', name);
      return;
    }
    var payload = clean(name, props);
    if (!ready) { queue.push([name, payload]); return; }
    try { window.posthog.capture(name, payload); } catch (e) {}
  }

  function boot() {
    var key = window.NEXLEY_POSTHOG_KEY;
    if (!key || optedOut()) return;          // stays inert; nothing is loaded

    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/posthog-js@1/dist/array.js';
    s.async = true;
    s.onload = function () {
      try {
        window.posthog.init(key, {
          api_host: window.NEXLEY_POSTHOG_HOST || 'https://us.i.posthog.com',
          autocapture: false,             // would capture note text
          capture_pageview: false,        // page titles contain note titles
          capture_pageleave: false,
          disable_session_recording: true,
          disable_surveys: true,
          enable_heatmaps: false,
          person_profiles: 'never',       // anonymous events only
          respect_dnt: true
        });
        ready = true;
        for (var i = 0; i < queue.length; i++) track(queue[i][0], queue[i][1]);
        queue = [];
      } catch (e) {}
    };
    s.onerror = function () { queue = []; };   // never grows without bound
    document.head.appendChild(s);
  }

  // `sanitize` is exposed deliberately: the guarantee that note content cannot get
  // out through here is the whole point of this file, so it has to be checkable.
  window.NexleyAnalytics = { track: track, events: ALLOWED, sanitize: clean };
  boot();
})();
