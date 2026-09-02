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
  var isLocal = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);

  /* Product analytics — OFF. Set NEXLEY_POSTHOG_KEY to a PostHog *project* key
     (public, safe in client code — never a personal API key) to switch it on.
     Leave it unset for local testing so development never pollutes real numbers.
     READ THE HEADER OF analytics.js FIRST: app/legal.html must be updated in the
     same commit, because it currently promises no third-party tracking and this
     app is used by under-13s. */
  // window.NEXLEY_POSTHOG_KEY = 'phc_...';
  // window.NEXLEY_POSTHOG_HOST = 'https://us.i.posthog.com';

  if (isLocal) {
    window.NEXLEY_SUPABASE_URL = 'https://yvlcpngoplecigblxnkb.supabase.co';
    window.NEXLEY_SUPABASE_ANON_KEY = 'sb_publishable_up8q0ydyUHbJcffZ5Za0Jg_uyRoqLpH';
  } else {
    window.NEXLEY_SUPABASE_URL = 'https://qvijxnhigqfoinuitrue.supabase.co';
    window.NEXLEY_SUPABASE_ANON_KEY = 'sb_publishable_p1LXme9CMhWPGzv49DTyEA_is5o-rDb';
  }
})();
