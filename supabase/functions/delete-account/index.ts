/* Nexley — delete my account.
 *
 * WHY THIS IS AN EDGE FUNCTION AND NOT A CLIENT CALL: deleting a row from
 * auth.users requires the Supabase Admin API, which needs the service-role
 * key. A key that can delete any user is not a key the browser can hold —
 * same reasoning as the model proxy in supabase/functions/ai, and the same
 * shape: the browser proves who it is, the server does the privileged part.
 *
 * WHAT ACTUALLY REMOVES THE DATA: nothing in this file does. Every
 * user-owned table references auth.users(id) ON DELETE CASCADE (checked
 * against every migration on 09-07 — subjects, notes, syllabus, cards,
 * events, feedback, papers, commitments, ai_usage, note_shares, comps,
 * comp_entries), so one call to admin.auth.admin.deleteUser() removes a
 * student's entire footprint in a single transaction at the database level.
 * `bug_reports.user_id` is the one deliberate exception — it goes to NULL,
 * not cascade, because that table is already write-only and anonymized by
 * design (0004). This function is a gate in front of that one privileged
 * call, not a place that reimplements what the schema already guarantees.
 *
 * WHY A CONFIRMATION STRING IN THE BODY, NOT JUST A BUTTON PRESS: the button
 * lives in the client and can be pressed by anything that can call fetch —
 * this is the one action in the whole app with no undo, so the server asks
 * for the same explicit word server-side rather than trusting that a click
 * happened. This does not replace an "are you sure?" in the UI; it exists in
 * case the UI's own confirmation is ever skipped by a bug.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/* Fails closed to Nexley's own origin rather than '*'. This function permanently
   destroys an account, so it is the last endpoint that should answer a page it
   has never heard of — the JWT check below is the real gate, but there is no
   reason to let an arbitrary origin even reach it. Set ALLOWED_ORIGIN in Edge
   Function secrets for any other deployment; a wrong value fails loudly in one
   place instead of silently allowing everything. */
const DEFAULT_ORIGIN = 'https://ajspeedy10.github.io';
const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? DEFAULT_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // 1 · who is asking — the JWT is the only source of identity. There is no
  //     user_id field this function will ever read from the body: accepting
  //     one would turn "delete my account" into "delete anyone's account".
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

  // 2 · the explicit confirmation, checked server-side — see file header.
  let body: { confirm?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (body.confirm !== 'DELETE') {
    return json({ error: 'not_confirmed' }, 400);
  }

  // 3 · the one privileged call. Cascades delete everything; see file header
  //     for which migration guarantees which table.
  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) {
    console.error('account deletion failed', delErr.message);
    return json({ error: 'server' }, 500);
  }

  return json({ ok: true });
});
