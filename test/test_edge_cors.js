/* Nexley — the edge functions must fail CLOSED on CORS.

   THE BUG THIS EXISTS TO PREVENT. Both Edge Functions used to read

     'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*'

   so a missing secret did not fail — it opened. `ALLOWED_ORIGIN` was never set,
   which meant the deployed answer to a preflight from ANY page on the internet
   was `*`, on both functions. That matters differently for each:

     - `ai` is a model proxy. `*` lets any site on the internet spend this
       account's Groq quota using a visitor's own session token.
     - `delete-account` permanently destroys an account. The JWT check is the
       real gate, but there is no reason for an unknown origin to reach it.

   The fix is a named constant, not a secret: DEFAULT_ORIGIN is Nexley's own
   origin, so an unset environment variable now fails in ONE diagnosable place
   (a CORS error) instead of silently allowing everything.

   WHY A STATIC TEST AND NOT A LIVE ONE. This file only proves the SOURCE is
   right. It cannot prove the deployed function is right, and on 2026-09-08 the
   source was fixed and committed while production kept serving `*` for two days
   with nothing reporting the gap. Proving the deployed side needs the network,
   so it lives in test/probe_deploy_drift.js — run that after deploying. Both
   halves are needed: this one stops the code regressing, that one stops the
   deploy being forgotten. */
const fs = require('fs');
const path = require('path');

const fnDir = path.join(__dirname, '..', 'supabase', 'functions');
const NEXLEY_ORIGIN = 'https://ajspeedy10.github.io';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\nedge function CORS\n');

const fns = fs.readdirSync(fnDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .filter(n => fs.existsSync(path.join(fnDir, n, 'index.ts')));

ok('there are edge functions to check', fns.length > 0, 'none found under supabase/functions/');

for (const fn of fns) {
  const src = fs.readFileSync(path.join(fnDir, fn, 'index.ts'), 'utf8');

  // 1 · the fallback is never a wildcard, however it is spelled
  ok(fn + ': no wildcard CORS fallback',
    !/\?\?\s*['"]\*['"]/.test(src) && !/Allow-Origin['"]\s*:\s*['"]\*['"]/.test(src),
    "found a `?? '*'` or a literal '*' allow-origin");

  // 2 · the fallback that IS there is Nexley's own origin, named as a constant
  //     so it is greppable and cannot be a stray literal in the header object
  ok(fn + ': DEFAULT_ORIGIN is Nexley’s own origin',
    new RegExp("const DEFAULT_ORIGIN\\s*=\\s*['\"]" + NEXLEY_ORIGIN + "['\"]").test(src));

  ok(fn + ': the header uses DEFAULT_ORIGIN as its fallback',
    /Allow-Origin['"]\s*:\s*Deno\.env\.get\(['"]ALLOWED_ORIGIN['"]\)\s*\?\?\s*DEFAULT_ORIGIN/.test(src));

  // 3 · a response whose origin depends on a request header MUST vary on it,
  //     or a shared cache can hand one origin's answer to another
  ok(fn + ": Vary: Origin is set", /['"]Vary['"]\s*:\s*['"]Origin['"]/.test(src));

  // 4 · the allow-headers list has to name every header supabase-js sends or the
  //     preflight fails as an opaque "Failed to fetch" with an empty console.
  //     This failed exactly once, by omitting the last two.
  for (const h of ['authorization', 'content-type', 'apikey', 'x-client-info']) {
    const m = src.match(/Allow-Headers['"]\s*:\s*['"]([^'"]+)['"]/);
    ok(fn + ': allow-headers names ' + h,
      !!m && m[1].toLowerCase().includes(h),
      m ? 'list is: ' + m[1] : 'no Allow-Headers at all');
  }

  // 5 · OPTIONS must be answered, or the preflight never gets a chance to pass
  ok(fn + ': answers OPTIONS preflight',
    /req\.method\s*===\s*['"]OPTIONS['"]/.test(src));
}

// ---------------------------------------------------------------------------
// The model proxy has one extra invariant: a call that cannot end.
// Without a timeout a stalled provider connection holds the function open until
// the platform's own wall clock kills it, with the student's daily quota
// already spent and a spinner on screen the whole time. The quota comment in
// that file reasoned about "a provider timeout" for months while no timeout
// existed.
// ---------------------------------------------------------------------------
if (fns.includes('ai')) {
  const ai = fs.readFileSync(path.join(fnDir, 'ai', 'index.ts'), 'utf8');
  ok('ai: provider call has a timeout budget', /PROVIDER_TIMEOUT_MS/.test(ai));
  ok('ai: every provider fetch passes an abort signal',
    (ai.match(/signal:\s*AbortSignal\.timeout\(/g) || []).length ===
    (ai.match(/await fetch\(/g) || []).length,
    'a fetch without `signal: AbortSignal.timeout(...)` can hang forever');
  ok('ai: a timeout surfaces as its own error, not a generic 502',
    /provider_timeout/.test(ai));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
