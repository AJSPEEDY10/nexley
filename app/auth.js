/* Summit Education — real accounts via Supabase Auth.
 * Replaces the old local-only passcode gate. Session persistence, token refresh
 * and password hashing are all handled by supabase-js — nothing custom here.
 */
(function () {
  'use strict';

  var client = window.supabase.createClient(window.SUMMIT_SUPABASE_URL, window.SUMMIT_SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  function signUpEmail(email, password, name) {
    return client.auth.signUp({
      email: email,
      password: password,
      options: { data: { name: name } }
    }).then(function (r) {
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

  window.SummitAuth = {
    client: client,
    signUpEmail: signUpEmail,
    signInEmail: signInEmail,
    signInGoogle: signInGoogle,
    signOut: signOut,
    getSession: getSession,
    onAuthStateChange: onAuthStateChange
  };
})();
