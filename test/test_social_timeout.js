/* Every call that talks to other people has an ending.
 *
 * THE TRAP THIS ENCODES, found 2026-09-09: app/social.js had ELEVEN network
 * functions and not one timeout. `offline()` catches the easy case; it does not
 * catch the common one — a network that is up and not passing traffic, where
 * navigator.onLine answers true and the request never settles.
 *
 * That is worse in this file than anywhere else in the app, because every one of
 * these calls sits behind a button that app.js disables on click and re-enables
 * in the handler. A promise that never settles means the handler never runs, so
 * the student is left with a permanently dead button still reading "Sending…"
 * and no way back except a reload — and on shareNote, no way to tell whether the
 * note went.
 *
 * Same fault and same fix as sync (60s), boot (10s) and the model proxy (45s).
 * This was the last surface in the app that still had it.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'app', 'social.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

/* Load social.js against a Supabase client whose every call hangs forever.
   The timeout is shrunk so the suite stays fast. */
function load(opts) {
  opts = opts || {};
  let src = fs.readFileSync(SRC, 'utf8');
  src = src.replace('var NET_TIMEOUT_MS = 15000;', 'var NET_TIMEOUT_MS = ' + (opts.ms || 40) + ';');

  const hang = () => new Promise(() => {});
  const q = {};
  ['select', 'insert', 'update', 'delete', 'eq', 'in', 'order', 'limit', 'single', 'maybeSingle']
    .forEach(m => { q[m] = () => q; });
  q.then = (res, rej) => hang().then(res, rej);

  const client = {
    from: () => q,
    rpc: hang,
    auth: { getUser: opts.userHangs === false
      ? () => Promise.resolve({ data: { user: { id: 'u1' } } })
      : hang }
  };
  const win = { NexleyAuth: { client }, crypto: { getRandomValues: a => a.fill(3) } };
  new Function('window', 'navigator', 'console', src)
    (win, { onLine: opts.online === false ? false : true }, { warn() {}, log() {} });
  return win.NexleySocial;
}

const NETWORKED = ['myProfile', 'claimUsername', 'findUser', 'shareNote', 'shares',
  'revokeShare', 'createComp', 'joinComp', 'myComps', 'compDetail', 'submitScore'];

(async function () {
  console.log('social — every call ends');

  /* 1. The regression: a hung connection must not hang the caller. */
  {
    const S = load({ ms: 40 });
    for (const name of NETWORKED) {
      const raced = await Promise.race([
        S[name]('a', 'b').then(() => 'resolved', e => e),
        new Promise(r => setTimeout(() => r('HUNG'), 400))
      ]);
      ok(name + ' ends rather than hanging', raced !== 'HUNG');
      if (raced instanceof Error) {
        /* \d+(\.\d+)? because the suite shrinks NET_TIMEOUT_MS to milliseconds;
           in production it is 15000, so the sentence reads "15 seconds". */
        ok(name + ' explains itself in one readable sentence',
          /did not answer after \d+(\.\d+)? seconds/.test(raced.message), raced.message);
      }
    }
  }

  /* 2. A write must not claim it failed — it must admit it does not know. */
  {
    const S = load({ ms: 30 });
    const err = await S.shareNote('someone', {}).catch(e => e);
    ok('a timed-out send does not say the note failed',
      !/failed|error|could not send/i.test(err.message), err.message);
    ok('and it reassures about the local notebook, which really is untouched',
      /nothing in your notebook is affected/i.test(err.message), err.message);
  }

  /* 3. The label names the action, so eleven calls do not share one message. */
  {
    const S = load({ ms: 30 });
    const a = (await S.shareNote('x', {}).catch(e => e)).message;
    const b = (await S.joinComp('ABCDEF', 'e', 'u').catch(e => e)).message;
    ok('two different calls produce two different messages', a !== b);
    ok('sending a note names sending', /Sending the note/.test(a), a);
    ok('joining a comp names joining', /Joining the comp/.test(b), b);
  }

  /* 4. The purely local call is NOT wrapped — a 15s race around
        crypto.getRandomValues would be noise. */
  {
    const S = load({ ms: 30 });
    const code = S.newCode();
    ok('newCode still returns synchronously', typeof code === 'string' && code.length === 6, String(code));
  }

  /* 5. The offline path is untouched: it must still fail FAST and with its own
        wording, not wait out the timeout. */
  {
    const S = load({ ms: 5000, online: false });
    const t0 = Date.now();
    const err = await S.shares().catch(e => e);
    ok('offline still fails immediately', Date.now() - t0 < 200, (Date.now() - t0) + 'ms');
    ok('offline keeps its own message', /needs the internet/i.test(err.message), err.message);
  }

  /* 6. The wrapper cannot be forgotten on a new call — everything exported
        except newCode goes through it. */
  {
    const S = load({ ms: 30 });
    const exported = Object.keys(S);
    ok('nothing new has appeared unwrapped',
      exported.length === NETWORKED.length + 1 && exported.every(k => k === 'newCode' || NETWORKED.includes(k)),
      exported.filter(k => k !== 'newCode' && !NETWORKED.includes(k)).join(', ') || 'ok');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
