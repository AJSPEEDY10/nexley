/* Nexley — the adversarial case set for AI marking. Spends REAL Groq quota
 * against the LIVE proxy and is judged by a HUMAN, not asserted against here.
 * See app/marking.js and test/test_marking.js for the part that doesn't need
 * a model: prompt construction and reading the answer back.
 *
 * WHY THIS ISN'T A NODE SCRIPT. The proxy requires a real signed-in Supabase
 * JWT (supabase/functions/ai/index.ts reads the user id from it and trusts
 * nothing in the body) and Claude-in-Chrome's own tooling refuses to hand a
 * session token back out of the page — correctly, since that token is a
 * live credential. So this runs INSIDE the signed-in app, in the browser
 * console, and only ever reports parsed marking output, never the token.
 *
 * HOW TO RUN
 *   1. Open the live, signed-in app: https://ajspeedy10.github.io/nexley/app.html
 *   2. Paste PROBE_SCRIPT (below) into devtools and press enter.
 *   3. Read `window.__nexleyProbe` — one entry per case, or `daily_limit` /
 *      `account_limit` (429) once quota runs out. AI_DAILY_LIMIT is 10/day per
 *      student, resetting at UTC midnight (10am AEST). Each case costs one call.
 *   4. Judge each raw response BY HAND against the case's "watching for" note.
 *      Nothing here can assert correctness — that's the whole reason this file
 *      exists instead of another block in test_marking.js.
 *
 * THE CASES, and why each one is here (from the 2026-09-05 handover: "the
 * first realistic marking test failed honestly" by inventing a standard the
 * criteria never stated):
 *
 *   silent_detail        — the criterion needs outside knowledge to judge at
 *                           all ("correctly states the duration" — correct
 *                           compared to what, if not what the marker knows
 *                           duration to actually be?). Rule 2 has to allow
 *                           this while still forbidding invented numbers.
 *                           Watching for: full marks, no invented range, no
 *                           unsupported criterion.
 *   half_right           — one of two required things is missing. Watching
 *                           for: partial credit (not 0), no invention.
 *   different_wording     — right idea, different words to the obvious
 *                           phrasing. Watching for: marked on substance, not
 *                           penalised for not matching a wording nobody
 *                           required. (Live run 09-05 exposed a mistake in
 *                           THIS test case, not the model — see PROBE LOG.)
 *   irrelevant_wrong_fact — the response volunteers a wrong claim that the
 *                           supplied criterion doesn't cover. Watching for:
 *                           the covered criterion still marked on its own
 *                           terms — Rule 1 (the criteria are the only
 *                           standard) under the pressure of an obviously
 *                           wrong nearby sentence.
 *   ambiguous_criterion   — the criterion itself is vague about what counts.
 *                           Watching for: UNCLEAR with a real explanation of
 *                           what the criteria fail to specify (rule 4), not a
 *                           confident invented checklist.
 *
 * PROBE LOG
 *   2026-09-05, 3 of 5 ran before hitting the 10/day per-student ceiling
 *   (already partly spent earlier the same session on real marking tests).
 *   silent_detail: 2/2, no invented threshold, quoted+judged the real
 *     duration correctly — the exact case Rule 2 was reworded for.
 *   half_right: 1/2, correct partial credit, no invention.
 *   different_wording: 1/2 — NOT a marker bug. This test case claimed "heat"
 *     as the ATP-PC system's only by-product, which is wrong; the model
 *     correctly used outside knowledge to judge that against the real
 *     by-products (creatine, inorganic phosphate) rather than accepting it
 *     as an honest paraphrase. Legitimate under the reworded Rule 2 (judge
 *     correctness; don't add requirements). Fix the case's chemistry before
 *     re-running, or leave it — it already demonstrated the right behaviour.
 *   irrelevant_wrong_fact, ambiguous_criterion: NOT YET RUN — hit the daily
 *     cap. Re-run after reset (10am AEST) and update this log.
 */
const PROBE_SCRIPT = `
async function runNexleyProbe() {
  const sess = await window.NexleyAuth.getSession();
  const key = sess ? sess.access_token : null;
  if (!key) return { status: 'no_session' };

  const CASES = [
    {
      name: 'silent_detail',
      question: 'Explain how the ATP-PC and anaerobic glycolytic systems predominate during exercise.',
      outOf: 2,
      criteria: '- 2 marks: correctly states the duration each system predominates',
      response: 'The ATP-PC system predominates for about the first 10 seconds of exercise, and the anaerobic glycolytic system predominates from there up to roughly 2 minutes.'
    },
    {
      name: 'half_right',
      question: 'Explain the fuel source of the ATP-PC and anaerobic glycolytic systems.',
      outOf: 2,
      criteria: '- 2 marks: correctly identifies the fuel source of BOTH systems',
      response: 'The ATP-PC system uses stored creatine phosphate as its fuel source.'
    },
    {
      name: 'different_wording',
      question: 'Explain the by-products of the ATP-PC and anaerobic glycolytic systems.',
      outOf: 2,
      criteria: '- 2 marks: correctly identifies the by-products of BOTH systems',
      response: 'The ATP-PC system produces heat as its only by-product, while the anaerobic glycolytic system produces lactate and hydrogen ions.'
    },
    {
      name: 'irrelevant_wrong_fact',
      question: 'Explain the fuel source of the ATP-PC and anaerobic glycolytic systems.',
      outOf: 2,
      criteria: '- 2 marks: correctly identifies the fuel source of BOTH systems',
      response: 'The ATP-PC system uses creatine phosphate, and the anaerobic glycolytic system uses glucose/glycogen. Also, both systems require oxygen to function.'
    },
    {
      name: 'ambiguous_criterion',
      question: 'Describe how the ATP-PC and anaerobic glycolytic systems interact during exercise.',
      outOf: 2,
      criteria: '- 2 marks: describes how the two energy systems interact during exercise',
      response: 'Both systems work together, with the ATP-PC system dominating early and handing over to the glycolytic system as intensity and duration increase.'
    }
  ];

  const out = [];
  for (const c of CASES) {
    const p = window.NexleyMarking.buildPrompt(c);
    let entry = { name: c.name };
    try {
      const r = await fetch(window.NEXLEY_SUPABASE_URL + '/functions/v1/ai', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + key,
          'apikey': window.NEXLEY_SUPABASE_ANON_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ system: p.system, user: p.user })
      });
      const d = await r.json();
      if (!r.ok) { entry.httpError = r.status; entry.body = d; out.push(entry); continue; }
      const parsed = window.NexleyMarking.parseMarking(d.text, c.outOf);
      entry.raw = d.text;
      entry.mark = parsed.mark;
      entry.outOf = parsed.outOf;
      entry.problems = parsed.problems;
      entry.unsupported = window.NexleyMarking.unsupportedCriteria(parsed, c.criteria);
      entry.remaining = d.remaining;
    } catch (e) {
      entry.error = String(e);
    }
    out.push(entry);
  }
  window.__nexleyProbe = out;
  console.table(out.map(e => ({ name: e.name, mark: e.mark, outOf: e.outOf,
    problems: (e.problems || []).join(','), unsupported: (e.unsupported || []).join(' | '),
    httpError: e.httpError || '' })));
  return out;
}
runNexleyProbe();
`;

if (typeof module !== 'undefined') module.exports = { PROBE_SCRIPT };
console.log('Paste PROBE_SCRIPT into the console of the signed-in live app. See header comment for how to read the result.');
