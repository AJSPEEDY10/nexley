/* Nexley — local task reminders, native only.
 *
 * WHY THIS ONLY DOES ANYTHING INSIDE THE NATIVE WRAP. A browser tab that is
 * not open cannot fire an OS notification days later — there is nothing
 * running to fire it from. Capacitor's own web implementation of this plugin
 * only shows a notification while the page is foregrounded, which is not a
 * reminder, it is a toast with extra steps. So this module is a deliberate
 * no-op everywhere except inside `window.Capacitor.isNativePlatform()`, and
 * every function below checks that before touching the plugin.
 *
 * WHAT IT SCHEDULES: one reminder per undone commitment with a future due
 * date, at 6pm the evening before it is due. Not the day itself — the whole
 * point of term planning (see `plan.js`) is knowing what is coming in enough
 * time to act on it, and a reminder that fires the same day is a receipt,
 * not a warning.
 *
 * WHY RESCHEDULE EVERYTHING RATHER THAN DIFF IT. Commitments are a handful of
 * rows for one student, not thousands — cancelling and rescheduling the full
 * set on every save is simpler than tracking which single row changed, and
 * "simpler" here means "cannot drift out of sync with what commitments.js
 * actually contains", which a diffed version could.
 *
 * ID SCHEME. LocalNotifications wants a 32-bit int id, and Nexley's own ids
 * are opaque strings (see `uid()`). `hashId` folds a string into a stable
 * positive 32-bit int so the same commitment always maps to the same
 * notification id — which is what makes "cancel everything, reschedule
 * everything" safe to call repeatedly without leaking duplicate
 * notifications for the same task.
 */
(function () {
  'use strict';

  var EVENING_HOUR = 18; // 6pm the evening before a due date

  function native() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  function plugin() {
    /* Loaded from the Capacitor plugin registry rather than imported, so this
       file works whether or not the plugin bundle is present — on the web
       build `native()` is already false and this is never reached. */
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  }

  function hashId(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h) || 1; // 0 is a valid hash but not a valid notification id to rely on
  }

  function enabled() {
    try { return localStorage.getItem('nexley-reminders') === 'on'; } catch (e) { return false; }
  }

  function setEnabled(on) {
    try { localStorage.setItem('nexley-reminders', on ? 'on' : 'off'); } catch (e) {}
  }

  /* Asks the OS for permission. Call this from an explicit user action (a
     Settings toggle), never on app load — an unprompted permission dialog on
     first open is exactly the kind of thing that gets an app a 1-star review
     before anyone has seen what it does. */
  function requestPermission() {
    if (!native() || !plugin()) return Promise.resolve(false);
    return plugin().requestPermissions().then(function (r) {
      var granted = r && r.display === 'granted';
      setEnabled(granted);
      return granted;
    });
  }

  /* The other half of requestPermission — turning the Settings toggle off has
     to actually cancel what is already scheduled, not just stop scheduling
     new ones. `enabled` gates rescheduleAll(), but a task due tomorrow that
     was scheduled yesterday would otherwise still fire tonight even though
     the toggle now reads off. */
  function disable() {
    setEnabled(false);
    if (!native() || !plugin()) return Promise.resolve();
    return plugin().getPending().then(function (pending) {
      var ours = (pending && pending.notifications || [])
        .filter(function (n) { return n.extra && n.extra.nexleyCommitment; })
        .map(function (n) { return { id: n.id }; });
      return ours.length ? plugin().cancel({ notifications: ours }) : null;
    }).catch(function () {}); // best-effort — see rescheduleAll's own catch for why
  }

  function reminderTime(dueMs) {
    var d = new Date(dueMs);
    d.setDate(d.getDate() - 1);
    d.setHours(EVENING_HOUR, 0, 0, 0);
    return d;
  }

  /* Cancels every reminder this module could have scheduled, then schedules
     fresh ones from the commitments actually passed in. Safe to call after
     every save, delete, or sync — see file header for why a full
     reschedule is the right call here rather than a diff. */
  function rescheduleAll(commitments) {
    if (!native() || !plugin() || !enabled()) return Promise.resolve();
    var p = plugin();

    return p.getPending().then(function (pending) {
      var ours = (pending && pending.notifications || [])
        .filter(function (n) { return n.extra && n.extra.nexleyCommitment; })
        .map(function (n) { return { id: n.id }; });
      return ours.length ? p.cancel({ notifications: ours }) : null;
    }).then(function () {
      var now = Date.now();
      var toSchedule = (commitments || [])
        .filter(function (c) { return !c.done && c.due && c.due > now; })
        .map(function (c) {
          var at = reminderTime(c.due);
          // A commitment due tomorrow morning has already missed its evening-
          // before slot by the time this runs; fire in a minute instead of
          // silently dropping the only reminder it will ever get.
          if (at.getTime() <= now) at = new Date(now + 60 * 1000);
          return {
            id: hashId(c.id),
            title: 'Due tomorrow: ' + c.title,
            body: c.hours ? ('About ' + c.hours + ' hours of work, by your own estimate.')
                           : 'No time estimate on this one yet.',
            schedule: { at: at },
            extra: { nexleyCommitment: c.id }
          };
        });
      if (!toSchedule.length) return null;
      return p.schedule({ notifications: toSchedule });
    }).catch(function (err) {
      // A reminder that fails to schedule costs nobody anything but itself —
      // same "drop it, don't surface it" call analytics.js makes, and for the
      // same reason: this is not core functionality and must never block it.
      console.warn('[notifications] reschedule failed', err && err.message);
    });
  }

  window.NexleyNotifications = {
    supported: native,
    enabled: enabled,
    requestPermission: requestPermission,
    disable: disable,
    rescheduleAll: rescheduleAll
  };
})();
