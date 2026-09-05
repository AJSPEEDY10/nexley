/* Nexley — marking against criteria the student supplied.
 *
 * THE PROMPT LIVES HERE, IN THE CLIENT, ON PURPOSE. The proxy is a gate and a
 * pipe and has no opinion about the task, so what the model is actually asked is
 * visible in the app's own source rather than hidden in a server nobody reads.
 * If this ever marks something unfairly, the reason is in this file.
 *
 * WHAT THIS IS NOT. It is not a predicted band, and it is not a real mark. A
 * real mark is one a teacher gave you, and that is what makes the conditions
 * grouping in Marks mean anything (see app.js 12h). An AI mark must never be
 * written into a paper record.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT
 * The first realistic test of this feature, 2026-09-05, produced a response that
 * looked authoritative and was wrong in a specific way: given the criterion
 * "correctly states the duration each system predominates", the model failed the
 * student against "the expected 30s-2min range" — a number that appeared nowhere
 * in the criteria — and awarded 0/2 where the student had plainly got half of it
 * right. It marked harshly against a standard it invented.
 *
 * So the rules below are not politeness. Each one is aimed at that:
 *   - quote the criterion before judging it, so an invented standard has to be
 *     written down next to the real one to survive
 *   - outside knowledge may be used to JUDGE whether what was written is correct,
 *     never to ADD a requirement the criterion never stated — "correctly states
 *     the duration" cannot be judged without knowing what the duration actually
 *     is, but that is not licence to invent "must fall in the 30s-2min range"
 *   - partial credit is explicitly allowed, because "0/2 for half right" was the
 *     other half of the same failure
 *   - "the criteria do not settle this" is an available answer, so the model has
 *     somewhere to go other than inventing
 */
(function () {
  'use strict';

  var RULES = [
    'You mark ONE student response against marking criteria supplied by the user.',
    '',
    'ABSOLUTE RULES:',
    '1. The supplied criteria are the ONLY standard. You may not use any other',
    '   standard, syllabus, rubric, band descriptor or remembered mark scheme.',
    '2. You may use outside knowledge to JUDGE whether what the student wrote is',
    '   correct for a criterion — but never to ADD a requirement, number, range or',
    '   threshold the criterion did not itself state. "Correctly states the',
    '   duration" lets you judge accuracy against what you know the duration to',
    '   be; it does NOT let you invent "must fall in the 30s-2min range" if the',
    '   criterion never named a range. If you catch yourself writing a number,',
    '   range or threshold that is not in the criteria, that is this rule',
    '   breaking: remove it.',
    '3. Award PARTIAL credit. If a criterion covers two things and the student got',
    '   one, that is half the marks, not none.',
    '4. If the criteria do not settle whether something earns a mark, write',
    '   UNCLEAR for that criterion and say what the criteria fail to specify.',
    '   Guessing is worse than saying so.',
    '5. Never state or imply a band, grade, ATAR, percentage or predicted result.',
    '6. Never award more marks than the criterion is worth, or more than the total.',
    '',
    'FORMAT — exactly this, nothing before or after:',
    'MARK: <awarded>/<total>',
    'Then one line per criterion:',
    '- "<the criterion, quoted word for word>" — <awarded>/<available> — <why>',
    'Then:',
    'WHAT TO FIX:',
    '- <specific, doable>',
    '- <specific, doable>'
  ].join('\n');

  /* Quoting the criterion verbatim is load-bearing, not decoration. A model that
     has to write the criterion down immediately before judging against it has to
     put its invented standard next to the real one, where both the student and
     the parser can see them disagree. */
  function buildPrompt(paper) {
    var lines = [];
    if (paper.question) {
      lines.push('QUESTION' + (paper.outOf ? ' (' + paper.outOf + ' marks)' : '') + ':');
      lines.push(paper.question.trim());
      lines.push('');
    }
    lines.push('MARKING CRITERIA — the only standard you may use:');
    lines.push(String(paper.criteria || '').trim());
    lines.push('');
    lines.push('STUDENT RESPONSE:');
    lines.push(String(paper.response || '').trim());
    return { system: RULES, user: lines.join('\n') };
  }

  /* ---------- reading the answer back ----------
     Parsed rather than shown raw, so the app can CHECK it. A marker that returns
     7/6, or invents a criterion that was never supplied, has failed and the
     student should see that it failed rather than a confident wrong number. */
  var MARK_RE = /^\s*MARK:\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/im;
  var LINE_RE = /^\s*[-*]\s*"([^"]+)"\s*[—–-]\s*(UNCLEAR|\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*[—–-]?\s*(.*)$/;

  function parseMarking(text, expectedOutOf) {
    var out = { ok: false, mark: null, outOf: null, criteria: [], fixes: [], problems: [] };
    if (!text) { out.problems.push('empty'); return out; }

    var m = MARK_RE.exec(text);
    if (m) {
      out.mark = parseFloat(m[1]);
      out.outOf = parseFloat(m[2]);
    } else {
      out.problems.push('no_mark_line');
    }

    var inFixes = false;
    String(text).split('\n').forEach(function (raw) {
      var line = raw.trim();
      if (/^WHAT TO FIX/i.test(line)) { inFixes = true; return; }
      if (inFixes) {
        if (/^[-*]\s+/.test(line)) out.fixes.push(line.replace(/^[-*]\s+/, '').trim());
        return;
      }
      var c = LINE_RE.exec(line);
      if (!c) return;
      out.criteria.push({
        criterion: c[1].trim(),
        unclear: c[2].toUpperCase() === 'UNCLEAR',
        awarded: c[2].toUpperCase() === 'UNCLEAR' ? null : parseFloat(c[2]),
        available: c[3] ? parseFloat(c[3]) : null,
        why: (c[4] || '').trim()
      });
    });

    /* Checks the model cannot talk its way past. Arithmetic is not a matter of
       opinion, so a marker that fails these is reported as broken rather than
       shown as a result. */
    if (out.mark !== null && out.outOf !== null) {
      if (out.mark > out.outOf) out.problems.push('mark_above_total');
      if (out.mark < 0) out.problems.push('negative_mark');
      if (expectedOutOf && out.outOf !== expectedOutOf) out.problems.push('wrong_total');
    }
    out.criteria.forEach(function (c) {
      if (c.available !== null && c.awarded !== null && c.awarded > c.available) {
        out.problems.push('criterion_above_available');
      }
    });
    if (!out.criteria.length) out.problems.push('no_criteria_lines');

    out.ok = out.problems.length === 0;
    return out;
  }

  /* Every criterion the marker claims to have judged must actually appear in the
     criteria the student supplied. This is the direct check on the failure that
     started all of this: a marker judging against something nobody gave it.
     Compared on words rather than characters so punctuation and case do not
     produce false alarms. */
  function unsupportedCriteria(parsed, criteriaText) {
    var hay = String(criteriaText || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
    return parsed.criteria.filter(function (c) {
      var words = c.criterion.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/).filter(function (w) { return w.length > 3; });
      if (!words.length) return false;
      var hits = words.filter(function (w) { return hay.indexOf(w) > -1; }).length;
      // most of the quoted criterion should be findable in what was supplied
      return (hits / words.length) < 0.7;
    }).map(function (c) { return c.criterion; });
  }

  window.NexleyMarking = {
    buildPrompt: buildPrompt,
    parseMarking: parseMarking,
    unsupportedCriteria: unsupportedCriteria,
    RULES: RULES
  };
})();
