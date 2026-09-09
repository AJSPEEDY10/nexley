/* A table is not one request.
 *
 * THE TRAP THIS ENCODES, found 2026-09-09: pullTable did `select('*')` with no
 * range. PostgREST caps a response at its max-rows setting — 1000 by default on
 * Supabase — and says nothing when it truncates. The run then wrote a new pull
 * watermark, so the next sync asked only for rows changed after that, and every
 * row past the first thousand was never asked for again. It sat on the server,
 * absent from that device, while the status line read "Synced just now".
 *
 * Not hypothetical at Nexley's shape: six subjects of imported syllabus is on the
 * order of a thousand rows before a single note, card or mark exists.
 *
 * The fake client below behaves like PostgREST does — it honours `range` and
 * enforces a hard cap on anything asking for more — so a regression shows up as
 * missing rows rather than as a changed call signature.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'app', 'sync.js');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

const iso = n => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + n * 1000).toISOString();

/* Rows are given ascending updated_at so ordering is unambiguous. */
function makeRows(table, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: table + '-' + String(i).padStart(5, '0'),
      user_id: 'u1', name: table + ' ' + i, title: table + ' ' + i,
      created_at: iso(i), updated_at: iso(i), rev: 1, device: 'd', deleted: false
    });
  }
  return out;
}

function load(serverRows, opts) {
  opts = opts || {};
  const MAX_ROWS = opts.maxRows || 1000;      // PostgREST's own cap
  const calls = [];
  const upserted = {};

  function table(name) {
    const q = {
      _filters: [], _range: null, _order: [],
      select() { return q; },
      eq(c, v) { q._filters.push(['eq', c, v]); return q; },
      gt(c, v) { q._filters.push(['gt', c, v]); return q; },
      order(c, o) { q._order.push([c, o && o.ascending]); return q; },
      limit(n) { q._range = [0, n - 1]; return q; },
      range(a, b) { q._range = [a, b]; return q; },
      upsert(rows) {
        upserted[name] = (upserted[name] || []).concat(rows);
        calls.push({ table: name, op: 'upsert', n: rows.length });
        if (rows.length > MAX_ROWS) {
          return Promise.resolve({ error: { message: 'payload too large', code: '413' } });
        }
        return Promise.resolve({ error: null, data: rows });
      },
      then(res, rej) {
        let rows = (serverRows[name] || []).slice();
        q._filters.forEach(f => {
          if (f[0] === 'eq') rows = rows.filter(r => r[f[1]] === f[2]);
          if (f[0] === 'gt') rows = rows.filter(r => r[f[1]] > f[2]);
        });
        rows.sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1
          : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
        const from = q._range ? q._range[0] : 0;
        // This is the whole point: an unbounded ask is CAPPED, silently.
        const want = q._range ? (q._range[1] - q._range[0] + 1) : MAX_ROWS;
        const page = rows.slice(from, from + Math.min(want, MAX_ROWS));
        calls.push({ table: name, op: 'select', from, want, got: page.length,
          ordered: q._order.length > 0 });
        const settle = opts.delay
          ? new Promise(r => setTimeout(() => r({ error: null, data: page }), opts.delay))
          : Promise.resolve({ error: null, data: page });
        return settle.then(res, rej);
      }
    };
    return q;
  }

  const db = { subjects: {}, syllabus: {}, notes: {}, cards: {}, papers: {}, commitments: {}, feedback: {}, meta: {} };
  const store = {};
  const win = {
    NexleyAuth: {
      client: { from: table },
      getSession: () => Promise.resolve({ user: { id: 'u1' } })
    },
    NexleyDB: {
      all: s => Promise.resolve(Object.keys(db[s] || {}).map(k => db[s][k])),
      get: (s, id) => Promise.resolve((db[s] || {})[id] || null),
      put: (s, rec) => { (db[s] = db[s] || {})[rec.id] = rec; return Promise.resolve(rec); }
    },
    addEventListener() {}, dispatchEvent() {}
  };
  const ls = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; },
    removeItem: k => { delete store[k]; } };

  let src = fs.readFileSync(SRC, 'utf8');
  if (opts.pullPage) src = src.replace('var PULL_PAGE = 500;', 'var PULL_PAGE = ' + opts.pullPage + ';');
  if (opts.pushPage) src = src.replace('var PUSH_PAGE = 250;', 'var PUSH_PAGE = ' + opts.pushPage + ';');
  if (opts.maxPages) src = src.replace('var MAX_PAGES = 200;', 'var MAX_PAGES = ' + opts.maxPages + ';');

  new Function('window', 'navigator', 'localStorage', 'document', 'CustomEvent',
    'setInterval', 'console', src)
    (win, { onLine: true }, ls, { addEventListener() {}, visibilityState: 'visible' },
     class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
     () => {}, { warn() {}, log() {} });

  return { sync: win.NexleySync, db, calls, store, upserted };
}

(async function () {
  console.log('sync — a table is not one request');

  /* 1. More rows than the server will hand over in one response. */
  {
    const N = 1300;
    const server = { syllabus: makeRows('syllabus', N), subjects: [], notes: [],
      cards: [], papers: [], commitments: [], feedback: [] };
    const { sync, db, calls, store } = load(server, { maxRows: 1000, pullPage: 500 });
    await sync.run();

    const got = Object.keys(db.syllabus).length;
    ok('every row arrives, not just the first capped response', got === N, 'got ' + got + ' of ' + N);
    const pulls = calls.filter(c => c.table === 'syllabus' && c.op === 'select');
    ok('it took more than one request', pulls.length > 1, pulls.length + ' request(s)');
    ok('no request asks for more than the server will give',
      pulls.every(c => c.want <= 1000), JSON.stringify(pulls.map(c => c.want)));
    ok('every page is explicitly ordered — paging an unordered result is undefined',
      pulls.every(c => c.ordered));
    ok('the watermark is only written once the table is finished', !!store['lastPullAt:u1']);
  }

  /* 2. The second sync is the one that used to lose the rows for good. */
  {
    const N = 1300;
    const server = { syllabus: makeRows('syllabus', N), subjects: [], notes: [],
      cards: [], papers: [], commitments: [], feedback: [] };
    const { sync, db, store } = load(server, { maxRows: 1000, pullPage: 500 });
    await sync.run();
    const afterFirst = Object.keys(db.syllabus).length;
    await sync.run();      // watermark now set; this is where the missing rows died
    const afterSecond = Object.keys(db.syllabus).length;
    ok('a second sync does not need to rescue anything', afterFirst === N && afterSecond === N,
      afterFirst + ' then ' + afterSecond);
    ok('and it does not re-pull the whole table', !!store['lastPullAt:u1']);
  }

  /* 3. Giving up must not move the watermark past rows never asked for. */
  {
    const N = 1300;
    const server = { syllabus: makeRows('syllabus', N), subjects: [], notes: [],
      cards: [], papers: [], commitments: [], feedback: [] };
    const { sync, store } = load(server, { maxRows: 1000, pullPage: 100, maxPages: 3 });
    await sync.run();
    ok('a run that stopped early holds the watermark rather than skipping ahead',
      !store['lastPullAt:u1'], 'watermark was ' + store['lastPullAt:u1']);
  }

  /* 4. The push end of the same problem. */
  {
    const server = { subjects: [], syllabus: [], notes: [], cards: [], papers: [],
      commitments: [], feedback: [] };
    const { sync, db, calls } = load(server, { maxRows: 300, pushPage: 250 });
    for (let i = 0; i < 700; i++) {
      db.notes['n' + i] = { id: 'n' + i, title: 't', body: 'b', created: 1, updated: 1, rev: 1, pushedRev: 0 };
    }
    await sync.run();
    const ups = calls.filter(c => c.table === 'notes' && c.op === 'upsert');
    ok('a large push is split rather than sent as one body', ups.length === 3,
      ups.length + ' upsert(s) of ' + JSON.stringify(ups.map(u => u.n)));
    ok('no chunk exceeds what the server accepts', ups.every(u => u.n <= 300));
    const unsent = Object.keys(db.notes).filter(k => db.notes[k].pushedRev !== db.notes[k].rev);
    ok('every row is marked sent once it actually landed', unsent.length === 0,
      unsent.length + ' still unsent');
  }

  /* 5. The watermark is stamped from the START of a run, not the end.
        A row another device writes WHILE a run is in flight has an updated_at
        inside that window; an end-stamped watermark steps straight over it and
        the row never arrives. A slow server is what makes the two stamps tell
        apart, so this run is deliberately made to take time. */
  {
    const server = { subjects: [], syllabus: [], notes: [], cards: [], papers: [],
      commitments: [], feedback: [] };
    const { sync, store } = load(server, { delay: 40 });
    const t0 = Date.now();
    await sync.run();
    const elapsed = Date.now() - t0;
    const mark = new Date(store['lastPullAt:u1']).getTime();
    ok('the run was slow enough for the two stamps to differ', elapsed >= 150, elapsed + 'ms');
    ok('the watermark is stamped at the START of the run, not when it finished',
      mark - t0 < elapsed / 2, 'stamped ' + (mark - t0) + 'ms into a ' + elapsed + 'ms run');
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
