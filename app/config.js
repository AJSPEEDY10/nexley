/* Nexley — Supabase project config.
 * The URL and publishable (anon) key are NOT secrets — they're safe in client code.
 * RLS on every table is what actually protects data (see supabase/migrations/).
 * The secret key must NEVER appear in this file or anywhere under app/.
 *
 * Dev/prod separation: local testing (127.0.0.1/localhost) always points at the
 * dev Supabase project (nexley-dev) so nothing testing-related ever touches real
 * user data. Everything else (the deployed site) points at production (nexley).
 * The project *refs* in the URLs below are opaque Supabase-assigned strings and
 * don't change on rename.
 */
(function () {
  /* Capacitor's WebView serves local files from https://localhost by default on
     both iOS and Android — the exact hostname the dev check below exists to
     detect. Without this, every native build would silently point at the DEV
     Supabase project. window.Capacitor only exists inside a native wrap, never
     on the web, so this can't misfire for real local development. */
  var isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var isLocal = !isNative && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);

  /* Product analytics is FIRST-PARTY and always on for signed-in users — it
     writes to the `events` table in this same Supabase project (Sydney), so
     there is no key to configure and no third party involved. See
     app/analytics.js for what is collected and the four layers that keep note
     content out of it. Nothing is recorded if the browser sends Do Not Track or
     Global Privacy Control, or while signed out. */

  if (isLocal) {
    window.NEXLEY_SUPABASE_URL = 'https://yvlcpngoplecigblxnkb.supabase.co';
    window.NEXLEY_SUPABASE_ANON_KEY = 'sb_publishable_up8q0ydyUHbJcffZ5Za0Jg_uyRoqLpH';
  } else {
    window.NEXLEY_SUPABASE_URL = 'https://qvijxnhigqfoinuitrue.supabase.co';
    window.NEXLEY_SUPABASE_ANON_KEY = 'sb_publishable_p1LXme9CMhWPGzv49DTyEA_is5o-rDb';
  }
})();
