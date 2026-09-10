/* Nexley — does the DEPLOYED edge function match the one in this repo?

   THE GAP THIS EXISTS TO CLOSE. On 2026-09-08 both Edge Functions were fixed to
   stop falling back to `Access-Control-Allow-Origin: *`, committed, and pushed.
   Nothing deployed them. On 2026-09-10 production was still answering `*` to a
   preflight from an arbitrary origin — two days of a security fix that existed
   only in git, with every test green the whole time, because every test read
   the repo and no test ever asked the server.

   Edge functions are the one part of Nexley that `git push` does NOT ship. The
   app is GitHub Pages, so pushing IS deploying; functions are deployed
   separately and silently stay old. That asymmetry is the whole bug, and a
   green suite actively hides it.

   WHAT THIS CHECKS, WITHOUT ANY CREDENTIAL. A CORS preflight is unauthenticated
   and public: OPTIONS with an Origin header gets back the exact
   Access-Control-Allow-Origin the DEPLOYED code computed. That one header is
   enough to tell the old build from the new one, so this needs no service-role
   key, no login and no token — which is why it can be part of the deploy ritual
   rather than something only Alec can run.

   It cannot prove the whole file matches, only this header. It is a smoke
   alarm, not an audit: it tells you the deploy was forgotten, which is the
   failure that actually happened.

   THE STATUS CODE IS NOT OPTIONAL, and the first draft of this file got it
   wrong. A function that does not exist answers 404 — with a Cloudflare-level
   `Access-Control-Allow-Origin: *` attached, because the gateway answers, not
   Nexley's code. Reading the header alone therefore reports a MISSING function
   as a DRIFTED one, which is how this probe told me dev's `ai` was serving a
   stale build when dev has never had an `ai` function at all. Three states,
   kept distinct: 404 is NOT DEPLOYED, a 2xx whose header disagrees is DRIFT,
   and a 2xx that agrees is the only pass.

   HOW TO RUN
     node test/probe_deploy_drift.js            # prod (default)
     node test/probe_deploy_drift.js --dev      # dev project
     node test/probe_deploy_drift.js --ref xxx  # any project ref

   Exit 0 = deployed matches the repo. Exit 1 = DRIFT, deploy it.
   Exit 2 = could not reach the network, which is NOT a pass. */
const fs = require('fs');
const path = require('path');

const PROD_REF = 'qvijxnhigqfoinuitrue';
const DEV_REF = 'yvlcpngoplecigblxnkb';

const argv = process.argv.slice(2);
const refArg = argv.indexOf('--ref');
const ref = refArg !== -1 ? argv[refArg + 1]
  : argv.includes('--dev') ? DEV_REF
  : PROD_REF;
const label = ref === PROD_REF ? 'PRODUCTION' : ref === DEV_REF ? 'dev' : ref;

const fnDir = path.join(__dirname, '..', 'supabase', 'functions');

/* A deliberately foreign origin. If the deployed function is failing closed it
   will answer with Nexley's origin regardless of what we claim to be; if it is
   failing open it hands this back, or `*`. Either way we learn the truth. */
const HOSTILE_ORIGIN = 'https://not-nexley.example.com';

let drift = 0, checked = 0, unreachable = 0, missing = 0;

/* The expected value comes from the committed source, not from a constant here,
   so this file does not become a third copy of the same fact to drift against. */
function expectedOriginFor(src) {
  const m = src.match(/const DEFAULT_ORIGIN\s*=\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

async function probe(fn) {
  const src = fs.readFileSync(path.join(fnDir, fn, 'index.ts'), 'utf8');
  const expected = expectedOriginFor(src);
  const url = `https://${ref}.supabase.co/functions/v1/${fn}`;

  if (!expected) {
    console.log(`  SKIP  ${fn} — no DEFAULT_ORIGIN in the committed source to compare against`);
    return;
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        'Origin': HOSTILE_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type'
      },
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    unreachable++;
    console.log(`  ????  ${fn} — could not reach ${url}: ${e.name}`);
    return;
  }

  const live = res.headers.get('access-control-allow-origin');

  /* 404 is the gateway answering, not Nexley's code — and the gateway attaches
     its own `*`. Never read the header without reading this first. */
  if (res.status === 404) {
    missing++;
    console.log(`  ABSENT ${fn} — not deployed to ${label} at all (404)`);
    console.log(`        the '*' on this response is Cloudflare's, not Nexley's — nothing is stale here,`);
    console.log(`        there is simply no function. Deploy it if ${label} is meant to have one.`);
    return;
  }

  checked++;

  if (live === expected) {
    console.log(`  OK    ${fn} — deployed answers ${live}`);
  } else if (live === '*') {
    drift++;
    console.log(`  DRIFT ${fn} — deployed answers '*' to ${HOSTILE_ORIGIN}`);
    console.log(`        the repo expects ${expected}. This build predates the fail-closed fix.`);
  } else {
    drift++;
    console.log(`  DRIFT ${fn} — deployed answers ${live === null ? '(no header)' : live}`);
    console.log(`        the repo expects ${expected}.`);
    console.log(`        If ALLOWED_ORIGIN is set as a secret this may be intentional — check it before redeploying.`);
  }
}

(async () => {
  console.log(`\nedge deploy drift — ${label} (${ref})\n`);

  const fns = fs.readdirSync(fnDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(fnDir, d.name, 'index.ts')))
    .map(d => d.name);

  for (const fn of fns) await probe(fn);

  if (unreachable) {
    console.log(`\n  ${unreachable} function(s) unreachable — this is NOT a pass, run it again with a network.\n`);
    process.exit(2);
  }
  if (drift) {
    console.log(`\n  ${drift} of ${checked} DRIFTED. Deploy: Supabase dashboard > Edge Functions > the`);
    console.log(`  function > Code > paste supabase/functions/<name>/index.ts > Deploy updates.`);
    console.log(`  (Or \`npx supabase login\` once, then \`npx supabase functions deploy <name>\`.)\n`);
    process.exit(1);
  }
  const absentNote = missing ? `, ${missing} not deployed here` : '';
  console.log(`\n  ${checked} deployed function(s) match the repo${absentNote}\n`);
})();
