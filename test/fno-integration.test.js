/* ============================================================
   F&O — END TO END

   The unit tests prove each module in isolation. These prove the wiring: that a full pass runs
   from a contract master through the chain, the volatility read, the structure selection and the
   trade plan, that every stage degrades to a reason instead of a crash, and that the panel and
   the endpoints actually connect to it.

   The orchestrator is driven with injected `quotes` and `candles` — the same dependency-injection
   pattern the rest of the platform uses — so the whole pipeline runs deterministically here
   despite the sandbox proxy blocking every real market endpoint.
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BS = require('../fno/bs');
const createFno = require('../fno');

const NOW = Date.UTC(2026, 8, 15, 6, 0);
const DAY = 86400000;
const LOT = 75;
const EXPIRIES = [Date.UTC(2026, 8, 22), Date.UTC(2026, 8, 29), Date.UTC(2026, 9, 27)];
const F = 24000, RATE = 0.065;

const smile = (K, days) => 0.12 + 0.006 * Math.log(days / 7) - 0.5 * Math.log(K / F) + 2 * Math.pow(Math.log(K / F), 2);

/* A synthetic NSE_FO master plus a quote function that prices every key off the same smile. */
function rig(opts) {
  const o = opts || {};
  const rows = [];
  const strikes = [];
  for (let k = 22000; k <= 26000; k += 50) strikes.push(k);
  for (const exp of EXPIRIES) {
    for (const k of strikes) {
      for (const t of ['CE', 'PE']) {
        rows.push({
          instrument_key: `NSE_FO|${exp}-${k}${t}`, trading_symbol: `NIFTY${k}${t}`,
          asset_symbol: 'NIFTY', instrument_type: t, expiry: exp,
          strike_price: k, lot_size: o.lotSize || LOT, tick_size: 0.05, segment: 'NSE_FO'
        });
      }
    }
    rows.push({
      instrument_key: `NSE_FO|FUT-${exp}`, trading_symbol: 'NIFTYFUT', asset_symbol: 'NIFTY',
      instrument_type: 'FUT', expiry: exp, lot_size: o.lotSize || LOT, segment: 'NSE_FO'
    });
  }

  let quoteCalls = 0, keysSeen = 0;
  const quotes = o.quotes || (async keys => {
    quoteCalls++; keysSeen += keys.length;
    const out = {};
    for (const key of keys) {
      const m = /\|(\d+)-(\d+)(CE|PE)$/.exec(key);
      if (!m) continue;
      const exp = Number(m[1]), K = Number(m[2]), type = m[3];
      const T = BS.yearsToExpiry(NOW, exp);
      const days = T * 365;
      const px = BS.price(type, F, K, T, smile(K, days), RATE);
      if (!(px > 0.01)) { out[key] = { ltp: px, bid: 0, ask: 0.05, oi: 100, volume: 1 }; continue; }
      out[key] = { ltp: px, bid: px * 0.995, ask: px * 1.005, oi: 5000, volume: 2000 };
    }
    return out;
  });

  /* Daily candles for the index: a deterministic walk at about 12% annualised. */
  const candles = o.candles || (async () => {
    let s = 7, px = 23000;
    const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
    const n = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
    const close = [], high = [], low = [], open = [];
    const sd = 0.12 / Math.sqrt(252);
    for (let i = 0; i < 400; i++) {
      const op = px * Math.exp(sd * 0.3 * n());
      const cl = op * Math.exp(sd * 0.9 * n());
      close.push(cl); open.push(op);
      high.push(Math.max(op, cl) * 1.002); low.push(Math.min(op, cl) * 0.998);
      px = cl;
    }
    return { close, high, low, open, times: close.map((_, i) => NOW - (400 - i) * DAY) };
  });

  const tmp = path.join(os.tmpdir(), 'fno-test-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmp, { recursive: true });

  const fno = createFno({
    dir: tmp, cacheFile: null, now: () => NOW,
    quotes, candles,
    macroData: o.macroData || null, calendar: o.calendar || null
  });
  // Inject the master directly, bypassing the download the sandbox cannot make.
  fno.instruments.load = (() => {
    const built = fno.instruments.__build({ NSE_FO: rows, BSE_FO: [] });
    return async () => built.ok
      ? { available: true, reason: null, asOf: NOW, data: built, source: 'test fixture' }
      : { available: false, reason: built.reason, asOf: null, data: null };
  })();

  return { fno, tmp, stats: () => ({ quoteCalls, keysSeen }), rows, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/* ============================================================
   1. THE FULL PASS
   ============================================================ */

test('a full pass runs master → chain → volatility → structures → plan', async () => {
  const r = rig();
  try {
    const d = await r.fno.board({ underlying: 'NIFTY', capital: 1500000, riskPct: 0.02, view: 'up', targetLevel: 24400 });
    assert.ok(d.ok, d.reason);

    // The chain recovered the forward the fixture was priced from.
    assert.ok(Math.abs(d.chain.forward - F) < 1, `forward ${d.chain.forward}`);
    assert.ok(d.chain.atmIv > 0.10 && d.chain.atmIv < 0.15, `ATM IV ${d.chain.atmIv}`);
    assert.equal(d.chain.lotSize, LOT, 'the lot size came from the master');

    // The volatility layer ran, with a term structure from more than one expiry.
    assert.ok(d.vol, 'a volatility read is present');
    assert.ok(d.vol.termStructure.ok, 'a term structure was built: ' + d.vol.termStructure.reason);
    assert.ok(d.vol.termStructure.points.length >= 2);
    assert.ok(d.vol.realized.ok, 'realized vol computed: ' + d.vol.realized.reason);
    assert.ok(d.vol.realized.yangZhang > 0, 'and Yang-Zhang ran, so the open came through the candle loader');
    assert.ok(d.vol.assessment.ok, 'a verdict was reached');

    // Structures were proposed and a plan was built for the winner.
    assert.ok(d.strategy.ok, d.strategy.reason);
    assert.ok(d.strategy.best, 'at ₹15 lakh something fits');
    assert.ok(d.plan && d.plan.ok, 'and it produced a plan');
    assert.ok(d.plan.summary.includes('NIFTY'));
    assert.ok(d.plan.timeStop.ok && /^\d{4}-\d{2}-\d{2}$/.test(d.plan.timeStop.date));
    assert.ok(d.plan.targetVerdict, 'the supplied target was assessed');

    // Expiries are offered for the selector.
    assert.ok(d.expiries.length >= 2);
    assert.ok(d.expiries[0].expiry < d.expiries[1].expiry, 'nearest first');
    assert.equal(d.costRates.verified, false, 'the unverified rate badge travels all the way out');
  } finally { r.cleanup(); }
});

test('only a window of strikes is quoted, not the whole board', async () => {
  /* A NIFTY expiry lists 160 strikes. Quoting all of them on three expiries would be a large,
     slow request for rows nobody will trade. */
  const r = rig();
  try {
    await r.fno.board({ underlying: 'NIFTY', capital: 1000000 });
    const s = r.stats();
    const allKeys = r.rows.filter(x => x.instrument_type !== 'FUT').length;
    assert.ok(s.keysSeen < allKeys * 0.35,
      `quoted ${s.keysSeen} of ${allKeys} listed contracts — the window is not being applied`);
    assert.ok(s.keysSeen > 40, 'but enough to build a surface and reach the 25-delta wings');
  } finally { r.cleanup(); }
});

test('the pass is cached, and force bypasses it', async () => {
  const r = rig();
  try {
    await r.fno.board({ underlying: 'NIFTY', capital: 1000000 });
    const after1 = r.stats().quoteCalls;
    await r.fno.board({ underlying: 'NIFTY', capital: 1000000 });
    assert.equal(r.stats().quoteCalls, after1, 'a repeat within the TTL hits the cache');
    await r.fno.board({ underlying: 'NIFTY', capital: 1000000, force: true });
    assert.ok(r.stats().quoteCalls > after1, 'force refetches');
  } finally { r.cleanup(); }
});

/* ============================================================
   2. DEGRADING RATHER THAN CRASHING
   ============================================================ */

test('no capital means no structures, but the chain and volatility still publish', async () => {
  /* Capital is genuinely required — every position number scales off it — but refusing to show
     the chain because of a missing input would be punishing the user for a blank field. */
  const r = rig();
  try {
    const d = await r.fno.board({ underlying: 'NIFTY' });
    assert.ok(d.ok, 'the pass still succeeds');
    assert.ok(d.chain.forward > 0, 'the chain is there');
    assert.ok(d.vol.assessment, 'and the volatility read');
    assert.equal(d.strategy.ok, false);
    assert.ok(/enter your available capital/i.test(d.strategy.reason), d.strategy.reason);
    assert.equal(d.plan, undefined, 'and no plan is invented without a size');
  } finally { r.cleanup(); }
});

test('a dead quote feed reports the stage it died at', async () => {
  const r = rig({ quotes: async () => ({}) });
  try {
    const d = await r.fno.board({ underlying: 'NIFTY', capital: 1000000 });
    assert.equal(d.ok, false);
    assert.equal(d.stage, 'chain');
    assert.ok(/empty result/.test(d.reason), d.reason);
    assert.ok(/market is closed/.test(d.reason) && /Upstox login/.test(d.reason),
      'and names both plausible causes rather than guessing one');
  } finally { r.cleanup(); }
});

test('a throwing quote feed is caught and named', async () => {
  const r = rig({ quotes: async () => { throw new Error('403 from the proxy'); } });
  try {
    const d = await r.fno.board({ underlying: 'NIFTY', capital: 1000000 });
    assert.equal(d.ok, false);
    assert.ok(/quote fetch failed/.test(d.reason), d.reason);
    assert.ok(/403/.test(d.reason), 'the underlying error survives to the user');
  } finally { r.cleanup(); }
});

test('the real HTTP status survives to the user, not a failure count', async () => {
  /* The first version of the quote loader caught its errors and reported "1 request(s) failed",
     which turned an answer into a shrug. 401 means the daily login expired, 400 means the request
     shape is wrong, 404 means the path is, 429 means rate limits — and only the status says which.
     The message must be long enough to carry it. */
  const r = rig({ quotes: async () => { throw new Error('no quotes for 74 contracts. Tried /v2/market-quote/quotes then /v2/market-quote/ltp — HTTP 401 https://api.upstox.com/v2/market-quote/quotes. A 401 means the daily Upstox login has expired.'); } });
  try {
    const d = await r.fno.board({ underlying: 'NIFTY', capital: 1000000 });
    assert.equal(d.ok, false);
    assert.ok(/HTTP 401/.test(d.reason), 'the status code reaches the screen: ' + d.reason);
    assert.ok(/login has expired/.test(d.reason), 'and so does what to do about it');
    assert.ok(/market-quote\/ltp/.test(d.reason), 'including that the fallback was also tried');
  } finally { r.cleanup(); }
});

test('a degraded LTP-only feed still produces a board, and says it is degraded', async () => {
  /* When the full-quote endpoint is unavailable the loader falls back to the LTP endpoint this
     server has always used. Degraded data beats no options tab — but spreads become unknowable,
     so the panel has to say which feed it got rather than presenting guesses as measurements. */
  const base = rig();
  const inner = base.fno;
  base.cleanup();

  const r = rig({
    quotes: async keys => {
      const full = {};
      for (const key of keys) {
        const m = /\|(\d+)-(\d+)(CE|PE)$/.exec(key);
        if (!m) continue;
        const T = BS.yearsToExpiry(NOW, Number(m[1]));
        const px = BS.price(m[3], F, Number(m[2]), T, smile(Number(m[2]), T * 365), RATE);
        if (px > 0.01) full[key] = { ltp: px, bid: null, ask: null, oi: null, volume: null };
      }
      Object.defineProperty(full, '__degraded', { value: 'full market quote unavailable (HTTP 404) — fell back to last-traded prices', enumerable: false });
      return full;
    }
  });
  try {
    const d = await r.fno.board({ underlying: 'NIFTY', capital: 1500000 });
    assert.ok(d.ok, 'a board is still produced: ' + d.reason);
    assert.ok(Math.abs(d.chain.forward - F) < 2, 'the forward still comes out of parity on LTPs');
    assert.equal(d.chain.quality.feedDegraded, true);
    assert.ok(d.chain.quality.warnings.some(w => /fell back to last-traded prices/.test(w)),
      JSON.stringify(d.chain.quality.warnings));
    // And spreads are reported as unknown rather than as zero.
    assert.equal(d.chain.quality.medianSpreadPct, null, 'no bid/ask means no measurable spread');
    assert.equal(d.chain.quality.onMid, 0);
  } finally { r.cleanup(); }
  assert.ok(inner, 'fixture sanity');
});

test('no candles costs the realized-vol inputs and nothing else', async () => {
  const r = rig({ candles: async () => { throw new Error('historical-candle 404'); } });
  try {
    const d = await r.fno.board({ underlying: 'NIFTY', capital: 1500000 });
    assert.ok(d.ok, 'the pass still completes');
    assert.equal(d.vol.realized.ok, false);
    assert.ok(/candle fetch failed/.test(d.vol.realized.reason), d.vol.realized.reason);
    // The term structure needs no candles at all, so it must survive.
    assert.ok(d.vol.termStructure.ok, 'the term structure is unaffected');
    assert.ok(d.vol.assessment.ok, 'and a verdict is still reached from what remains');
    assert.ok(d.vol.assessment.coverage < 1, 'on reduced coverage');
  } finally { r.cleanup(); }
});

test('an unknown underlying is refused with a reason', async () => {
  const r = rig();
  try {
    const d = await r.fno.board({ underlying: 'BANKNIFTY', capital: 1000000 });
    assert.equal(d.ok, false);
    assert.equal(d.stage, 'expiries');
    assert.ok(/no unexpired contracts listed for BANKNIFTY/.test(d.reason), d.reason);
  } finally { r.cleanup(); }
});

/* ============================================================
   3. THE MACRO REUSE
   ============================================================ */

test('India VIX is converted from percentage points to a fraction', async () => {
  /* The bug this test exists to prevent: India VIX arrives as 13.5 while every implied vol in
     this stack is 0.135. Comparing them without dividing puts the percentile a hundred times out
     and reads every market on record as historically calm. */
  const dates = [], closes = {};
  for (let i = 0; i < 150; i++) {
    const dt = new Date(NOW - (150 - i) * DAY).toISOString().slice(0, 10);
    dates.push(dt);
    closes[dt] = 9 + (i % 50) * 0.2;                   // 9 to 19 VIX POINTS
  }
  const macroData = { load: async () => ({ available: true, data: { series: { INDIAVIX: { dates, closes } } } }) };

  const r = rig({ macroData });
  try {
    const d = await r.fno.board({ underlying: 'NIFTY', capital: 1500000 });
    assert.ok(d.ok);
    const p = d.vol.ivPercentile;
    assert.ok(p.ok, 'a percentile was computed from the VIX series: ' + p.reason);
    assert.equal(d.vol.ivHistory.source, 'India VIX');
    assert.equal(d.vol.ivHistory.exact, false, 'and it is flagged as a substitute');
    assert.ok(/stand-in/.test(d.vol.ivHistory.note));

    // The series must be on the same scale as an implied vol: fractions, not points.
    assert.ok(p.min > 0.05 && p.max < 0.30, `VIX series should be fractions, got min ${p.min} max ${p.max}`);
    assert.ok(p.percentile > 0 && p.percentile < 1, `an ATM IV of ${d.chain.atmIv} should sit inside a 9-19% VIX range, got percentile ${p.percentile}`);
  } finally { r.cleanup(); }
});

test('a scheduled event before expiry reaches the verdict and the exit rules', async () => {
  const calendar = {
    eventRisk: () => ({ blocked: true, next: { label: 'US CPI', at: EXPIRIES[0] - 2 * DAY, impact: 'high' } })
  };
  const r = rig({ calendar });
  try {
    const d = await r.fno.board({ underlying: 'NIFTY', capital: 1500000, view: 'up' });
    assert.ok(d.ok);
    assert.ok(d.vol.event && d.vol.event.inWindow, 'the event was picked up from the shared calendar');
    assert.equal(d.vol.event.label, 'US CPI');
    assert.ok(d.vol.assessment.eventWarning, 'and reaches the volatility verdict');
    assert.ok(/US CPI/.test(d.vol.assessment.eventWarning));
    if (d.plan && d.plan.ok) {
      assert.ok(d.plan.exits.some(e => /after the scheduled event/.test(e.trigger)),
        'and becomes an exit rule: ' + d.plan.exits.map(e => e.trigger).join(' | '));
    }
  } finally { r.cleanup(); }
});

test('a broken calendar does not take the options tab down', async () => {
  const calendar = { eventRisk: () => { throw new Error('macro-calendar.json is malformed'); } };
  const r = rig({ calendar });
  try {
    const d = await r.fno.board({ underlying: 'NIFTY', capital: 1500000 });
    assert.ok(d.ok, 'the pass survives a bad calendar edit');
    assert.equal(d.vol.event, null, 'and simply has no event to report');
  } finally { r.cleanup(); }
});

/* ============================================================
   4. THE IV HISTORY STORE
   ============================================================ */

test('one ATM implied vol is recorded per underlying per session', async () => {
  const r = rig();
  try {
    await r.fno.board({ underlying: 'NIFTY', capital: 1000000 });
    const s1 = r.fno.ivStats();
    assert.equal(s1.rows, 1, 'one row after one pass');
    assert.equal(s1.byUnderlying.NIFTY, 1);

    // A second pass on the same day updates the row rather than appending a duplicate.
    await r.fno.board({ underlying: 'NIFTY', capital: 1000000, force: true });
    assert.equal(r.fno.ivStats().rows, 1, 'still one row for the session');
    assert.equal(r.fno.ivStats().writeFails, 0);

    // It survives a reload from disk, which is the entire point of writing it out.
    const raw = fs.readFileSync(path.join(r.tmp, 'fno-iv-history.jsonl'), 'utf8').trim().split('\n');
    assert.equal(raw.length, 1);
    const row = JSON.parse(raw[0]);
    assert.equal(row.u, 'NIFTY');
    assert.ok(row.iv > 0.10 && row.iv < 0.15, `recorded IV ${row.iv}`);
    assert.ok(row.dte > 0, 'with the days to expiry it was measured at');
  } finally { r.cleanup(); }
});

test('once enough of its own history accrues, it stops leaning on India VIX', async () => {
  /* The substitution is a bootstrap, not a permanent arrangement. Recorded readings for the
     actual underlying must take over as soon as there are enough of them — including for
     BANKNIFTY and SENSEX, which have no volatility index to borrow. */
  const dates = [], closes = {};
  for (let i = 0; i < 150; i++) {
    const dt = new Date(NOW - (150 - i) * DAY).toISOString().slice(0, 10);
    dates.push(dt); closes[dt] = 12 + (i % 20) * 0.1;
  }
  const macroData = { load: async () => ({ available: true, data: { series: { INDIAVIX: { dates, closes } } } }) };
  const r = rig({ macroData });
  try {
    const before = await r.fno.board({ underlying: 'NIFTY', capital: 1000000 });
    assert.equal(before.vol.ivHistory.source, 'India VIX', 'starts on the substitute');

    // Backfill a quarter of its own readings, as ninety sessions of running would produce.
    r.fno.__resetIv();
    const rows = [];
    for (let i = 0; i < 90; i++) rows.push({ u: 'NIFTY', d: new Date(NOW - (91 - i) * DAY).toISOString().slice(0, 10), iv: 0.11 + (i % 10) * 0.004, dte: 7, ts: NOW });
    fs.writeFileSync(path.join(r.tmp, 'fno-iv-history.jsonl'), rows.map(x => JSON.stringify(x)).join('\n') + '\n');

    const after = await r.fno.board({ underlying: 'NIFTY', capital: 1000000, force: true });
    assert.match(after.vol.ivHistory.source, /recorded/, 'switches to its own data');
    assert.equal(after.vol.ivHistory.exact, true, 'which needs no caveat');
    assert.equal(after.vol.ivPercentile.ok, true);
  } finally { r.cleanup(); }
});

/* ============================================================
   5. THE WIRING — endpoints and panel
   ============================================================ */

const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

test('every F&O endpoint the panel calls is served', () => {
  const served = new Set();
  for (const m of srv.matchAll(/p==="(\/api\/fno[a-z/-]*)"/g)) served.add(m[1]);
  assert.ok(served.has('/api/fno'), 'the main pass');
  assert.ok(served.has('/api/fno/list'), 'the underlying/expiry list');
  assert.ok(served.has('/api/fno/expiry'), 'the settle-or-square-off decision');
  assert.ok(served.has('/api/fno/costs'), 'the cost calculator');
  assert.ok(served.has('/api/fno/health'), 'the health check');

  const called = new Set();
  for (const m of script.matchAll(/fetch\('(\/api\/fno[a-z/-]*)/g)) called.add(m[1]);
  assert.ok(called.size >= 2, 'the panel calls the engine');
  for (const c of called) assert.ok(served.has(c), `the panel calls ${c}, which the server does not serve`);
});

test('the F&O module is constructed with injected dependencies, never by requiring the server', () => {
  /* The rule the whole platform is built on: fno/ must not require server.js, or the two become
     circular and the options tab can silently read a different feed from the card beside it. */
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'fno'))) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(__dirname, '..', 'fno', f), 'utf8');
    assert.ok(!/require\(['"]\.\.\/server/.test(src), `fno/${f} requires server.js — that is circular`);
  }
  assert.ok(/require\('\.\/fno'\)\(\{/.test(srv), 'the server constructs it with injected deps');
  assert.ok(/quotes:\s*upstoxFullQuotes/.test(srv), 'and hands it this server\'s quote loader');
  assert.ok(/macroData:\s*intel\.macroData/.test(srv), 'reusing the macro feed rather than opening a second one');
  assert.ok(/calendar:\s*intel\.calendar/.test(srv), 'and the shared event calendar');
});

test('the quote loader asks for depth and open interest, not just a last price', () => {
  /* Half the value of the chain analytics is knowing the difference between a live two-sided
     market and an hour-old print, which the LTP endpoint cannot tell you. */
  assert.ok(/market-quote\/quotes\?instrument_key=/.test(srv), 'it uses the full-quote endpoint');
  const fn = srv.slice(srv.indexOf('async function upstoxFullQuotes'), srv.indexOf('async function upstoxLTP'));
  for (const field of ['bid', 'ask', 'oi', 'volume', 'ltp']) {
    assert.ok(new RegExp('\\b' + field + ':').test(fn), `the parser does not produce ${field}`);
  }
  assert.ok(/depth/.test(fn), 'bid and ask come from the depth block');
});

test('the panel exists, is reachable, and renders the honest states', () => {
  assert.ok(/id="fnoPanel"/.test(html), 'the panel container exists');
  assert.ok(/onclick="toggleFno\(\)"/.test(html), 'and a button opens it');
  assert.ok(/function toggleFno\(/.test(script), 'which is defined');

  // Capital comes from the page's existing risk bar — one source of truth for the whole dashboard.
  assert.ok(/getElementById\('capital'\)/.test(script.slice(script.indexOf('function fnoQuery'))),
    'the options panel reads capital from the shared risk bar');

  // The "nothing fits" branch must be rendered, not swallowed.
  assert.ok(/Nothing here fits your capital and risk budget/.test(script), 'the refusal case is rendered');
  assert.ok(/capitalNeededAtThisRisk/.test(script), 'along with what would be needed');
  assert.ok(/Cost rates are unverified/.test(script), 'the unverified-rates warning is shown');
  assert.ok(/UNBOUNDED — this can lose more than the account holds/.test(script), 'unbounded risk is spelled out');
  assert.ok(/Time stop/.test(script), 'the time stop is rendered');
});

test('the generated IV history file is gitignored', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(/^fno-iv-history\.jsonl$/m.test(gi), 'the recorded IV log must not be committed');
  assert.ok(/^fno-instruments\.json$/m.test(gi), 'nor the contract-master cache');
  // The cost config, by contrast, IS committed — it is configuration the user edits, not state.
  assert.ok(!/fno-costs\.json/.test(gi), 'fno-costs.json is config and must stay committed');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'fno-costs.json')));
});
