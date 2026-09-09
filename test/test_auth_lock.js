/* "Lock this device" must always lock.
 *
 * THE TRAP THIS ENCODES: signOut() is a network call — it revokes the refresh
 * token server-side. The caller was `signOut().then(showGate)` with no catch and
 * no timeout, so a failing connection meant the gate never appeared and a hanging
 * one meant nothing happened at all: the button did nothing and the student handed
 * over an unlocked iPad.
 *
 * Supabase's own scope:'local' is not the escape hatch it looks like — the
 * vendored source still calls admin.signOut() first and can hang identically — so
 * the fallback clears the stored session here. These tests run the real
 * app/auth.js against a stubbed client.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'app', 'auth.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

/* `behaviour` decides what client.auth.signOut() does: 'clean', 'error', or
   'hang'. The 5s guard is shrunk to keep the suite fast. */
function load(behaviour, guardMs) {
  let src = fs.readFileSync(SRC, 'utf8');
  src = src.replace('}, 5000);', '}, ' + (guardMs || 40) + ');');

  const store = {
    'sb-abc123-auth-token': '{"access_token":"x"}',
    'sb-abc123-auth-token-code-verifier': 'v',
    'nexley-theme': 'light'            // must survive: it is not a session
  };
  const localStorage = {
    get length() { return Object.keys(store).length; },
    key: i => Object.keys(store)[i],
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: k => { delete store[k]; }
  };
  const auth = {
    signOut: () => {
      if (behaviour === 'hang') return new Promise(() => {});
      if (behaviour === 'error') return Promise.resolve({ error: { message: 'network' } });
      if (behaviour === 'throw') return Promise.reject(new Error('offline'));
      return Promise.resolve({ error: null });
    },
    getSession: () => Promise.resolve({ data: { session: null }, error: null }),
    onAuthStateChange: () => {}
  };
  const win = {
    supabase: { createClient: () => ({ auth }) },
    NEXLEY_SUPABASE_URL: 'https://example.test',
    NEXLEY_SUPABASE_ANON_KEY: 'anon'
  };
  new Function('window', 'localStorage', 'fetch', 'console', src)
    (win, localStorage, () => Promise.reject(new Error('no network in test')), { warn() {} });
  return { auth: win.NexleyAuth, store };
}

const sessionKeys = store => Object.keys(store).filter(k => /^sb-/.test(k));

(async function () {
  console.log('auth — locking always locks');

  /* 1. The happy path is unchanged. */
  {
    const { auth, store } = load('clean');
    const how = await auth.signOut();
    ok('a clean revoke reports itself as clean', how === 'clean', 'got ' + how);
    ok('a clean revoke leaves the local clear-out to supabase', sessionKeys(store).length === 2);
  }

  /* 2. The hang — the reason this exists. */
  {
    const { auth, store } = load('hang', 30);
    const how = await Promise.race([auth.signOut(), new Promise(r => setTimeout(() => r('HUNG'), 400))]);
    ok('a hanging sign-out still resolves', how !== 'HUNG', 'got ' + how);
    ok('and says it had to fall back', how === 'local', 'got ' + how);
    ok('the stored session is gone even though the server never answered',
      sessionKeys(store).length === 0, 'left: ' + sessionKeys(store).join(','));
    ok('unrelated preferences are not collateral damage', store['nexley-theme'] === 'light');
  }

  /* 3. A returned error and a thrown rejection are the same promise to a caller
        that has no catch — both used to leave the gate unshown. */
  for (const mode of ['error', 'throw']) {
    const { auth, store } = load(mode, 400);
    let rejected = false;
    const how = await auth.signOut().catch(() => { rejected = true; });
    ok('signOut never rejects (' + mode + ') — a lock that throws is a lock that did not happen', !rejected);
    ok('it falls back on ' + mode, how === 'local', 'got ' + how);
    ok('the session is cleared on ' + mode, sessionKeys(store).length === 0);
  }

  /* 4. Every OTHER auth call must end too.
        Found while writing a handover note that claimed the waiting pass was
        finished: only signOut was bounded. Each of these sits behind a button
        app.js disables on click, so a hang is a permanently dead button — on the
        sign-in screen, and on delete-account. */
  {
    const hang = () => new Promise(() => {});
    let src = fs.readFileSync(SRC, 'utf8')
      .replace('var AUTH_TIMEOUT_MS = 15000;', 'var AUTH_TIMEOUT_MS = 40;')
      .replace('var DELETE_TIMEOUT_MS = 30000;', 'var DELETE_TIMEOUT_MS = 40;');
    const auth = {
      signUp: hang, signInWithPassword: hang, signInWithOAuth: hang,
      updateUser: hang, getSession: hang, signOut: () => Promise.resolve({ error: null }),
      onAuthStateChange: () => {}
    };
    const win = { supabase: { createClient: () => ({ auth }) },
      location: { origin: 'https://example.test', pathname: '/nexley/app.html' },
      NEXLEY_SUPABASE_URL: 'https://example.test', NEXLEY_SUPABASE_ANON_KEY: 'anon' };
    const store = {};
    const ls = { get length() { return Object.keys(store).length; }, key: i => Object.keys(store)[i],
      getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } };
    new Function('window', 'localStorage', 'fetch', 'console', src)
      (win, ls, hang, { warn() {} });
    const A = win.NexleyAuth;

    const calls = [
      ['signUpEmail', ['e', 'p', 'n', '11'], 'Creating your account'],
      ['signInEmail', ['e', 'p'], 'Signing you in'],
      ['signInGoogle', [], 'Taking you to Google'],
      ['signInApple', [], 'Taking you to Apple'],
      ['setSchoolYear', ['11'], 'Saving your school year'],
      ['getSession', [], 'Checking your account'],
      ['deleteAccount', [], 'Deleting your account']
    ];
    for (const [name, args, label] of calls) {
      const r = await Promise.race([
        A[name](...args).then(() => 'resolved', e => e),
        new Promise(res => setTimeout(() => res('HUNG'), 500))
      ]);
      ok(name + ' ends rather than hanging', r !== 'HUNG');
      if (r instanceof Error) {
        ok(name + ' names its own action, not a generic failure',
          r.message.startsWith(label), r.message.slice(0, 60));
      }
    }
    ok('signOut is NOT double-wrapped — it keeps its own contract',
      (await A.signOut()) === 'clean');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
