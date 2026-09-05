/* Nexley — the model proxy.
 *
 * WHY THIS EXISTS AT ALL: an API key shipped in a PWA is a public key. Anyone
 * can open devtools, read it, and spend the quota. So the key lives here, on the
 * server, and the browser never sees it. That is the entire reason for this file
 * — everything else is bookkeeping.
 *
 * WHAT IT GUARANTEES
 *   1. The caller is signed in. Supabase verifies the JWT before this runs; we
 *      read the user id from it and never trust one sent in the body.
 *   2. The caller has quota left. The count is a table row, incremented
 *      atomically, so it survives cold starts and cannot be raised by the client
 *      (migration 0013).
 *   3. The provider is one that does not train on submitted text. Verified
 *      2026-09-05: Groq and Cloudflare Workers AI do not; Google's FREE Gemini
 *      tier does, which is why it is not an option here — legal.html promises
 *      notes are not used to train any AI model, and that promise is the product.
 *   4. Nothing a student wrote is ever logged. Errors log a code and a length,
 *      never the text. A proxy that logs prompts is a copy of everyone's notes.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: no prompt construction, no marking logic, no
 * opinion about the task. It is a gate and a pipe. The prompt is built by the
 * caller so that what the model was actually asked is visible in the app's own
 * source, not hidden in a server nobody reads.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

/* A day's worth of marking for one student, with room to be wrong a few times.
   Low on purpose: this is the cost ceiling, and the failure mode of setting it
   too low is a student seeing "you have used today's 25" — annoying, and fixable
   in one edit. The failure mode of setting it too high is a bill. */
const DAILY_LIMIT = Number(Deno.env.get('AI_DAILY_LIMIT') ?? '25');

/* Caps the request itself. A marking request is a question, a response and its
   criteria — a few thousand characters. Anything far larger is a bug or an abuse
   and should be refused before it reaches a paid endpoint. */
const MAX_CHARS = 12000;

const PROVIDER = (Deno.env.get('AI_PROVIDER') ?? 'groq').toLowerCase();
const GROQ_KEY = Deno.env.get('GROQ_API_KEY') ?? '';
const CF_ACCOUNT = Deno.env.get('CF_ACCOUNT_ID') ?? '';
const CF_TOKEN = Deno.env.get('CF_API_TOKEN') ?? '';

const GROQ_MODEL = Deno.env.get('GROQ_MODEL') ?? 'llama-3.3-70b-versatile';
const CF_MODEL = Deno.env.get('CF_MODEL') ?? '@cf/meta/llama-3.1-8b-instruct';

/* The allow-headers list has to name every header the browser will send, or the
   preflight fails and the call never leaves the page as an opaque "Failed to
   fetch" with nothing in the console. supabase-js sends `apikey` and
   `x-client-info` alongside the Authorization header, and the first version of
   this file listed neither — which is exactly how it failed. */
const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

/* Both are OpenAI-shaped enough that one interface covers them. Kept switchable
   by env rather than hardcoded: whichever free tier changes its terms first, the
   other is one environment variable away, and neither is baked into the client. */
async function callModel(system: string, user: string): Promise<string> {
  if (PROVIDER === 'groq') {
    if (!GROQ_KEY) throw new Error('not_configured');
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,          // marking should be boring and repeatable
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
    if (!r.ok) throw new Error('provider_' + r.status);
    const d = await r.json();
    return d?.choices?.[0]?.message?.content ?? '';
  }

  if (PROVIDER === 'cloudflare') {
    if (!CF_ACCOUNT || !CF_TOKEN) throw new Error('not_configured');
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${CF_MODEL}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CF_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        })
      }
    );
    if (!r.ok) throw new Error('provider_' + r.status);
    const d = await r.json();
    return d?.result?.response ?? '';
  }

  throw new Error('unknown_provider');
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // 1 · who is asking. The JWT is the only source of identity — a user_id in the
  //     body would let anyone spend anyone else's quota.
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'signed_out' }, 401);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );

  const { data: userData, error: userErr } = await admin.auth.getUser(
    authHeader.replace('Bearer ', '')
  );
  if (userErr || !userData?.user) return json({ error: 'signed_out' }, 401);
  const userId = userData.user.id;

  // 2 · what is being asked
  let body: { system?: string; user?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const system = String(body.system ?? '').slice(0, 4000);
  const user = String(body.user ?? '');
  if (!user.trim()) return json({ error: 'bad_request' }, 400);
  if (system.length + user.length > MAX_CHARS) {
    return json({ error: 'too_long', max: MAX_CHARS }, 413);
  }

  // 3 · quota. Taken BEFORE the call, so a provider timeout cannot be retried
  //     into an unbounded bill. A failed call costs the student one of their
  //     allowance, which is the safe direction to be wrong in.
  const { data: used, error: quotaErr } = await admin.rpc('ai_usage_take', {
    p_user: userId,
    p_limit: DAILY_LIMIT
  });
  if (quotaErr) {
    console.error('quota check failed', quotaErr.code ?? 'unknown');
    return json({ error: 'server' }, 500);
  }
  if (used === null) {
    return json({ error: 'daily_limit', limit: DAILY_LIMIT, remaining: 0 }, 429);
  }

  // 4 · the call
  try {
    const text = await callModel(system, user);
    return json({
      text,
      remaining: Math.max(0, DAILY_LIMIT - (used as number)),
      limit: DAILY_LIMIT
    });
  } catch (e) {
    /* Length and code only. The prompt is a student's own writing and must not
       appear in a log — that is the whole reason this proxy is trusted with it. */
    const msg = e instanceof Error ? e.message : 'unknown';
    console.error('model call failed', msg, 'chars=' + (system.length + user.length));
    if (msg === 'not_configured') return json({ error: 'not_configured' }, 503);
    return json({ error: 'provider_unavailable' }, 502);
  }
});
