/* Nexley — Supabase project config.
 * The URL and publishable (anon) key are NOT secrets — they're safe in client code.
 * RLS on every table is what actually protects data (see supabase/migrations/).
 * The secret key must NEVER appear in this file or anywhere under app/.
 *
 * Dev/prod separation (Supabase projects are still named summit-education* internally —
 * renaming those is cosmetic and deferred): local testing (127.0.0.1/localhost) always points at the
 * dev project so nothing testing-related ever touches real user data. Everything
 * else (the deployed site) points at production.
 */
(function () {
  var isLocal = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);

  if (isLocal) {
    window.SUMMIT_SUPABASE_URL = 'https://yvlcpngoplecigblxnkb.supabase.co';
    window.SUMMIT_SUPABASE_ANON_KEY = 'sb_publishable_up8q0ydyUHbJcffZ5Za0Jg_uyRoqLpH';
  } else {
    window.SUMMIT_SUPABASE_URL = 'https://qvijxnhigqfoinuitrue.supabase.co';
    window.SUMMIT_SUPABASE_ANON_KEY = 'sb_publishable_p1LXme9CMhWPGzv49DTyEA_is5o-rDb';
  }
})();
