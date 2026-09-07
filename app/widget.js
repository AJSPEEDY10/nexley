/* Nexley — the data bridge for the native home-screen widget.
 *
 * WHY THIS EXISTS AT ALL. A native widget (Android AppWidgetProvider, iOS
 * WidgetKit) runs as separate native code — it cannot read the WebView's own
 * IndexedDB, which is where every other piece of app state actually lives.
 * `@capacitor/preferences` is the standard bridge: it writes to Android
 * SharedPreferences / iOS UserDefaults under the hood, which native code CAN
 * read directly, and JS can write to the same place through one plugin call.
 * This file is the only thing on the JS side that knows the widget exists.
 *
 * WHAT CROSSES THE BRIDGE, AND WHAT DELIBERATELY DOES NOT. A count and the
 * next task's title and due date — the same "what's due, not how you feel
 * about it" boundary commitments.js already draws for the app itself (see
 * its own migration header). No subject content, no marks, no note text: a
 * home-screen widget is visible to anyone glancing at the phone, which is a
 * more public surface than the app itself, so it gets LESS detail than the
 * in-app plan view, not the same amount.
 *
 * KEY NAME. Must match exactly on both sides — see the Android
 * DueWidgetProvider.kt and iOS widget code, both of which read the literal
 * string 'nexley_widget_data' from the same native storage this writes to.
 */
(function () {
  'use strict';

  var KEY = 'nexley_widget_data';

  function native() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  function plugin() {
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
  }

  /* Called from the same place notifications.js is — every commitment save,
     delete, and refresh already routes through renderPlan(). Keeping both
     hooked from one place means neither can drift out of sync with the other
     by having its own, separately-remembered call site. */
  function update(commitments) {
    if (!native() || !plugin()) return Promise.resolve();

    var now = Date.now();
    var weekMs = 7 * 24 * 60 * 60 * 1000;
    var upcoming = (commitments || [])
      .filter(function (c) { return !c.done && c.due; })
      .sort(function (a, b) { return a.due - b.due; });

    var dueThisWeek = upcoming.filter(function (c) { return c.due <= now + weekMs; }).length;
    var next = upcoming.length ? upcoming[0] : null;

    var payload = {
      dueThisWeek: dueThisWeek,
      nextTitle: next ? next.title : null,
      nextDue: next ? next.due : null,
      updatedAt: now
    };

    return plugin().set({ key: KEY, value: JSON.stringify(payload) }).catch(function (err) {
      // Same call as notifications.js and analytics.js make for the same
      // reason: a widget that shows stale data for a while costs nobody
      // anything, and must never block or interrupt real app functionality.
      console.warn('[widget] update failed', err && err.message);
    });
  }

  window.NexleyWidget = { update: update };
})();
