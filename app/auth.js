/* Nexley — real accounts via Supabase Auth.
 * Replaces the old local-only passcode gate. Session persistence, token refresh
 * and password hashing are all handled by supabase-js — nothing custom here.
 */
(function () {
  'use strict';

  var client = window.supabase.createClient(window.NEXLEY_SUPABASE_URL, window.NEXLEY_SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  /* schoolYear, not a date of birth.

     Nexley is a syllabus app and Year 11 and Year 12 are different courses, so
     this is something the product wants regardless — setup, not screening. It is
     also far less personal than a birth date, which an earlier version of this
     asked for and no longer does. There is no minimum age; see the "school year"
     note in app.js for why that gate was removed. */
  function signUpEmail(email, password, name, schoolYear) {
    var data = { name: name };
    if (schoolYear) data.school_year = schoolYear;
    return client.auth.signUp({
      email: email,
      password: password,
      options: { data: data }
    }).then(function (r) {
      if (r.error) throw r.error;
      return r.data;
    });
  }

  /* For the accounts the sign-up form cannot reach: anyone who came in through
     Google, and anyone who already had an account before this was asked. */
  function setSchoolYear(year) {
    return client.auth.updateUser({ data: { school_year: year } }).then(function (r) {
      if (r.error) throw r.error;
      return r.data;
    });
  }

  function signInEmail(email, password) {
    return client.auth.signInWithPassword({ email: email, password: password }).then(function (r) {
      if (r.error) throw r.error;
      return r.data;
    });
  }

  function signInGoogle() {
    return client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname }
    }).then(function (r) {
      if (r.error) throw r.error;
      return r.data;
    });
  }

  /* Not optional once Google exists: Apple requires that any app offering a
   * third-party login also offer Sign in with Apple, as a privacy-respecting
   * alternative. Same shape as signInGoogle — supabase-js does not
   * distinguish providers beyond the string. */
  function signInApple() {
    return client.auth.signInWithOAuth({
      provider: 'apple',
      options: { redirectTo: window.location.origin + window.location.pathname }
    }).then(function (r) {
      if (r.error) throw r.error;
      return r.data;
    });
  }

  /* The one action in the app with no undo. Confirmed twice: once by whatever
   * the caller's UI does before calling this, and again server-side (see
   * supabase/functions/delete-account) — this function passes the literal
   * word through rather than deciding locally that "the user clicked a
   * button" was confirmation enough.
   *
   * Signs out and clears the local session on success, because the account
   * this session belonged to no longer exists — leaving a stale "signed in"
   * client state around would be its own small bug. */
  function deleteAccount() {
    return getSession().then(function (sess) {
      if (!sess || !sess.access_token) throw { status: 401, body: null };
      return fetch(window.NEXLEY_SUPABASE_URL + '/functions/v1/delete-account', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + sess.access_token,
          'apikey': window.NEXLEY_SUPABASE_ANON_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ confirm: 'DELETE' })
      });
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw { status: r.status, body: body };
        return body;
      });
    }).then(function (body) {
      return signOut().then(function () { return body; });
    });
  }

  /* Locking must always lock.
   *
   * signOut() is a network call — it revokes the refresh token server-side. The
   * caller was `signOut().then(showGate)` with no catch and no timeout, so on a
   * connection that failed the gate never appeared, and on one that hung nothing
   * happened at all: "Lock this device" did nothing, and the student handed over
   * an unlocked iPad. Supabase's own scope:'local' is not the escape hatch it
   * looks like — read the vendored source, it still calls admin.signOut first and
   * can hang the same way.
   *
   * So: five seconds for a clean revoke, then forget the session here instead.
   * That leaves the server-side token alive until it expires on its own, which is
   * worse than a clean revoke and enormously better than not locking. Resolves
   * with 'local' when it had to fall back, so the caller can reload and drop the
   * in-memory session too. It never rejects — a lock that throws is a lock that
   * did not happen. */
  function forgetSessionLocally() {
    try {
      var kill = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (/^sb-.+-auth-token/.test(k)) kill.push(k);
      }
      kill.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
  }

  function signOut() {
    var settled = false;
    var live = client.auth.signOut().then(function (r) {
      settled = true;
      if (r.error) { forgetSessionLocally(); return 'local'; }
      return 'clean';
    }, function () {
      settled = true;
      forgetSessionLocally();
      return 'local';
    });
    var guard = new Promise(function (resolve) {
      setTimeout(function () {
        if (settled) return resolve('clean');
        forgetSessionLocally();
        resolve('local');
      }, 5000);
    });
    return Promise.race([live, guard]);
  }

  function getSession() {
    return client.auth.getSession().then(function (r) {
      if (r.error) throw r.error;
      return r.data.session;
    });
  }

  function onAuthStateChange(cb) {
    client.auth.onAuthStateChange(function (event, session) { cb(event, session); });
  }

  window.NexleyAuth = {
    client: client,
    signUpEmail: signUpEmail,
    setSchoolYear: setSchoolYear,
    signInEmail: signInEmail,
    signInGoogle: signInGoogle,
    signInApple: signInApple,
    deleteAccount: deleteAccount,
    signOut: signOut,
    getSession: getSession,
    onAuthStateChange: onAuthStateChange
  };
})();
