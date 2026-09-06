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
 *   different_wording     — every fact correct, none of it in the words a
 *                           marking guide would use: "phosphagen system" for
 *                           ATP-PC, "free phosphate" for inorganic phosphate,
 *                           "glycolysis run without oxygen" for anaerobic
 *                           glycolysis. Watching for: full marks. Anything
 *                           less means it is marking vocabulary rather than
 *                           understanding, which is the failure this whole
 *                           prompt exists to prevent, pointed the other way.
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
 *   different_wording: 1/2 — NOT a marker bug, a bug in the CASE. It claimed
 *     "heat" as the ATP-PC system's only by-product, which is simply wrong,
 *     and the model correctly marked it against the real by-products rather
 *     than accepting it as a paraphrase — legitimate under the reworded
 *     Rule 2 (judge correctness; do not add requirements). Worth remembering
 *     that an adversarial case can itself be the thing that is wrong.
 *     REWRITTEN 09-06 to be genuinely correct-but-differently-worded, so it
 *     now tests what it was meant to test.
 *   irrelevant_wrong_fact, ambiguous_criterion: NOT YET RUN — hit the daily
 *     cap. Re-run after reset (10am AEST) and update this log.
 *
 *   2026-09-06, 10:17 AEST, the remaining three run after the reset. THE SET IS
 *   NOW COMPLETE — all five have been run and judged by hand.
 *   different_wording (rewritten): 2/2. Read "phosphagen system", "free
 *     phosphate" and "glycolysis run without oxygen" as the things they are and
 *     gave full marks. It marks understanding, not vocabulary.
 *   irrelevant_wrong_fact: 2/2, and this is the cleanest result of the five.
 *     The volunteered wrong claim ("both systems require oxygen") did NOT cost
 *     a mark, because the supplied criterion was about fuel sources and nothing
 *     else — Rule 1 holding under pressure. The wrong claim still got named,
 *     in WHAT TO FIX, where it belongs.
 *   ambiguous_criterion: 2/2 — a PARTIAL result, recorded honestly.
 *     The failure this case exists to catch (invent a checklist for a vague
 *     criterion, then deduct against it) did NOT happen; it gave the benefit of
 *     the doubt, which is the right way to be wrong here. But Rule 4's UNCLEAR
 *     path never fired either — the vagueness surfaced as advice instead:
 *     "include brief details on the typical time frames (e.g. ATP-PC
 *     predominates for ~0-10 s)". The criteria never asked for time frames.
 *     The mark was unaffected, so this is the softest possible form of the
 *     original bug, but a student reading a 2/2 next to a "what to fix" cannot
 *     tell whether that advice is why something was withheld.
 *     ACTIONED: Rule 7 added to marking.js — anything in WHAT TO FIX that the
 *     criteria did not require must say "(not required by the criteria)".
 *     Verified against the live model on this same case; see below.
 *
 *   2026-09-06, Rule 7 verification (1 further call, same case, rule spliced
 *   into the live system prompt): mark unchanged at 2/2, and the two
 *   beyond-the-criteria suggestions are GONE — WHAT TO FIX came back as
 *   "None (response meets the criteria)". Not what the rule asked for (it
 *   offered a tag, not a ban) and worth knowing: told to label advice as not
 *   required, this model prefers to drop it. That is a small loss of useful
 *   coaching in exchange for a mark sheet that cannot be misread, which is the
 *   right side of the trade for a tool a student reads alone. Do not "fix"
 *   this by softening rule 7 without re-running the whole set.
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
      response: 'The phosphagen system leaves behind creatine and free phosphate, while glycolysis run without oxygen yields lactate and H+ ions.'
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
