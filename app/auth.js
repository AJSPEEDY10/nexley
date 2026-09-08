/* Nexley — real accounts via Supabase Auth.
 * Replaces the old local-only passcode gate. Session persistence, token refresh
 * and password hashing are all handled by supabase-js — nothing custom here.
 */
(function () {
  'use strict';

  var client = window.supabase.createClient(window.NEXLEY_SUPABASE_URL, window.NEXLEY_SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  /* birthYear, and deliberately NOT a full date of birth.
     The question this has to answer is "is this person 15 or older" — nothing
     more. A full DOB is a strong identifier and holding one would be collecting
     past what the purpose needs, which is the exact standard the Children's
     Online Privacy Code raises (strictly necessary, in the best interests of the
     child). So the form asks month and year, uses both to decide, and keeps only
     the year. See PRIVACY_IMPACT_ASSESSMENT.md. */
  function signUpEmail(email, password, name, birthYear) {
    var data = { name: name };
    if (birthYear) data.birth_year = birthYear;
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
     Google, and anyone who already had an account before this existed. */
  function setBirthYear(year) {
    return client.auth.updateUser({ data: { birth_year: year } }).then(function (r) {
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

  function signOut() {
    return client.auth.signOut().then(function (r) {
      if (r.error) throw r.error;
    });
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
    setBirthYear: setBirthYear,
    signInEmail: signInEmail,
    signInGoogle: signInGoogle,
    signInApple: signInApple,
    deleteAccount: deleteAccount,
    signOut: signOut,
    getSession: getSession,
    onAuthStateChange: onAuthStateChange
  };
})();
