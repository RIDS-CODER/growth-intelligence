/* ============================================================
   MARKET-WIDE STRESS & CORRELATION ENGINE — tests

   Two kinds of test here, and the second kind matters more.

   1. DETECTION tests: given a market that IS a cascade / a decoupling / a bearish structure,
      does the engine say so?

   2. HONESTY tests: given a market where the evidence is MISSING, does the engine refuse to
      conclude? This platform's recurring failure mode has never been bad maths — it has been
      confidently reporting a number built on data it did not have. So there are guard tests that
      no score is published from nothing, that the cascade detector never claims to have seen
      liquidations it cannot fetch, that confidence is capped when positioning data is absent,
      and that the average-down gate has no path to "yes".
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const server = require('../server.js');
const S = require('../intel/stats');
const createData = require('../intel/data');
const createDerivs = require('../intel/derivs');
const createHistory = require('../intel/history');
const { breadth, MIN_COINS } = require('../intel/breadth');
const { correlation } = require('../intel/correlation');
const { betaEngine, coinVsMarket } = require('../intel/beta');
const { structure, fightingStructure } = require('../intel/structure');
const { transmission, leadLag } = require('../intel/transmission');
const { openInterestEngine, quadrantOf } = require('../intel/openInterest');
const { fundingEngine } = require('../intel/funding');
const { liquidityEngine } = require('../intel/liquidity');
const { liquidationEngine, CAP_INFERRED, CAP_PARTIAL } = require('../intel/liquidation');
const { recoveryEngine, failedRally } = require('../intel/recovery');
const { positionRisk, estimateLiquidation } = require('../intel/positionRisk');
const { classify, sectorWeakness } = require('../intel/regime');
const { buildAlerts } = require('../intel/alerts');

/* ---------------- fixture factory ----------------
   Coins are generated from a shared market factor plus idiosyncratic noise, which is what makes
   correlation and beta testable: `beta` controls how much of the common factor a coin carries,
   `idio` how much noise drowns it out. */
const TMP = path.join(__dirname, '..', '.test-intel');

function rng(seed) { let s = seed || 1; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; }

function factor(n, driftPerBar, volPerBar, seed) {
  const r = rng(seed); const out = [];
  for (let i = 0; i < n; i++) out.push(driftPerBar + (r() - 0.5) * 2 * volPerBar);
  return out;
}

/* EVERY COIN NEEDS ITS OWN SEED.
   An earlier draft defaulted them all to the same one, so every "independent" coin drew the
   identical noise sequence and the whole universe was one series wearing twelve names. The
   correlation tests then passed at 0.9999 for a reason that had nothing to do with the shared
   market factor they were meant to be measuring — and the "uncorrelated market" test was the one
   that exposed it. Derive a distinct seed from the ticker so idiosyncratic noise is genuinely
   idiosyncratic. */
function seedOf(tk) { let h = 17; for (const c of String(tk)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 2147483646) + 1; }

function mkSeries(spec, market, n) {
  const r = rng(spec.seed || seedOf(spec.tk));
  const close = [], high = [], low = [], vol = [], times = [];
  let x = spec.start || 100; const now = Date.now();
  for (let i = 0; i < n; i++) {
    /* `lag` makes a coin receive the market factor N bars LATE. Without it every coin moves on
       the same bar and there is no leadership to detect — only differing beta, which the engine
       correctly reports as "the alts crossed first" rather than "BTC led". */
    const mi = i - (spec.lag || 0);
    const fac = (market && mi >= 0) ? market[mi] : 0;
    let ret = (spec.drift || 0) + (spec.beta == null ? 1 : spec.beta) * fac + (r() - 0.5) * 2 * (spec.idio == null ? 0.001 : spec.idio);
    if (spec.shockAt != null && i >= n - spec.shockAt) ret += (spec.shock || 0);
    x *= (1 + ret); if (!(x > 0)) x = 0.0001;
    close.push(x);
    // A violent bar widens its own range; a calm one does not. Applying the wide wick to every
    // bar would make the whole history look violent and nothing would stand out.
    const violent = spec.shockAt != null && i >= n - spec.shockAt;
    const wick = violent ? (spec.wick || 0.002) : (spec.calmWick || 0.002);
    high.push(x * (1 + wick)); low.push(x * (1 - wick));
    const vspike = (spec.volSpikeAt != null && i >= n - spec.volSpikeAt) ? (spec.volSpike || 4) : 1;
    vol.push((spec.noVol ? 0 : 1000 * (1 + r()) * vspike));
    /* Bar spacing must match the timeframe. An earlier draft stamped 15-minute spacing on the
       DAILY fixture too, so 140 "daily" bars all landed inside two calendar dates — and
       coinDailyMap correctly refused it, because a date-keyed series needs distinct dates. */
    times.push(now - (n - 1 - i) * (spec.__daily ? 86400000 : 15 * 60000));
  }
  return { close, high, low, vol, times, price: close[n - 1], priceUsd: close[n - 1] };
}

/* Build a real snapshot through intel/data.js — so these tests exercise the data layer too,
   not just the engines that consume it. */
async function mkSnap(specs, opts) {
  const o = opts || {};
  const n = o.bars || 600;
  const market = factor(n, o.marketDrift == null ? 0 : o.marketDrift, o.marketVol == null ? 0.004 : o.marketVol, 99);
  const dailyMarket = factor(140, (o.marketDrift || 0) * 96, (o.marketVol || 0.004) * 10, 98);
  const uni = specs.map(s => ({ tk: s.tk, sym: s.tk + 'USDT', name: s.tk, cls: 'Crypto', src: 'cg' }));
  const data = createData({
    loadCrypto: async (asset, tf) => {
      const s = specs.find(x => x.tk === asset.tk);
      if (!s || s.fail) throw new Error('feed down');
      return tf === 'daily' ? mkSeries({ ...s, __daily: true, drift: (s.drift || 0) * 96, idio: (s.idio || 0.001) * 10 }, dailyMarket, 140) : mkSeries(s, market, n);
    },
    ensureCryptoUniverse: async () => uni,
    getCRYPTO: () => uni,
    ticker24: async () => {
      const t = {};
      for (const s of specs) if (!s.fail) t[s.tk] = { chg: s.chg24 != null ? s.chg24 : (s.drift || 0) * 96 * 100, qv: s.qv || 1e9 };
      return t;
    },
    resampleSeries: server.resampleSeries
  });
  return data.snapshot();
}

const ZZ = server.zigzag;
const RISK_OFF = [
  { tk: 'BTC', drift: -0.0004, beta: 1.0, idio: 0.0008, qv: 1e10, start: 5000000 },
  { tk: 'ETH', drift: -0.0005, beta: 1.1, idio: 0.0010, qv: 5e9, start: 300000 },
  { tk: 'SOL', drift: -0.0008, beta: 1.5, idio: 0.0012, qv: 2e9, start: 15000 },
  { tk: 'XRP', drift: -0.0007, beta: 1.3, idio: 0.0012, qv: 1e9, start: 50 },
  { tk: 'BNB', drift: -0.0004, beta: 1.1, idio: 0.0010, qv: 9e8, start: 50000 },
  { tk: 'DOGE', drift: -0.0010, beta: 1.7, idio: 0.0015, qv: 8e8, start: 12 },
  { tk: 'SUI', drift: -0.0013, beta: 2.1, idio: 0.0016, qv: 5e8, start: 90 },
  { tk: 'APT', drift: -0.0011, beta: 1.9, idio: 0.0015, qv: 4e8, start: 600 },
  { tk: 'LINK', drift: -0.0006, beta: 1.2, idio: 0.0011, qv: 3e8, start: 1200 },
  { tk: 'AVAX', drift: -0.0009, beta: 1.6, idio: 0.0013, qv: 3e8, start: 2500 },
  { tk: 'ADA', drift: -0.0008, beta: 1.4, idio: 0.0012, qv: 4e8, start: 40 },
  { tk: 'UNI', drift: -0.0008, beta: 1.4, idio: 0.0012, qv: 2e8, start: 700 }
];
const flip = specs => specs.map(s => ({ ...s, drift: -s.drift }));

/* ==================== stats ==================== */
test('pearson: perfect, inverse, and refusal on a short sample', () => {
  const a = [0.01, -0.02, 0.03, -0.01, 0.02, -0.03, 0.01, 0.02, -0.01, 0.03];
  assert.ok(Math.abs(S.pearson(a, a) - 1) < 1e-9);
  assert.ok(Math.abs(S.pearson(a, a.map(v => -v)) + 1) < 1e-9);
  assert.strictEqual(S.pearson([0.01, 0.02], [0.01, 0.02]), null, 'two samples must not yield a correlation');
  assert.strictEqual(S.pearson(a, a.map(() => 0.005)), null, 'a flat series has no correlation, not a perfect one');
});

test('beta recovers a known slope; downside beta captures asymmetry', () => {
  // At least 6 negative bars: downsideBeta refuses to fit a slope on fewer, by design.
  const x = [0.01, -0.02, 0.03, -0.01, 0.02, -0.03, 0.015, 0.02, -0.012, 0.03, -0.02, 0.01, -0.015, 0.025, -0.018, 0.012];
  assert.ok(Math.abs(S.beta(x.map(v => 2 * v), x) - 2) < 1e-9);
  // Tracks 1:1 up, 3:1 down — the symmetric beta understates the downside.
  const asym = x.map(v => v < 0 ? 3 * v : v);
  const db = S.downsideBeta(asym, x);
  assert.ok(db > 2.9 && db < 3.1, 'downside beta should be ~3, got ' + db);
  assert.ok(S.beta(asym, x) < db, 'symmetric beta must understate an asymmetric downside');
});

test('amplification refuses to divide by a benchmark that barely moved', () => {
  assert.strictEqual(S.amplification(-0.05, -0.001), null);
  assert.ok(Math.abs(S.amplification(-0.055, -0.02) - 2.75) < 1e-9);
});

test('scoreParts renormalises over available evidence and returns null from nothing', () => {
  const all = S.scoreParts([{ k: 'a', w: 0.5, v: 1 }, { k: 'b', w: 0.5, v: 0 }]);
  assert.strictEqual(all.score, 0.5);
  assert.strictEqual(all.coverage, 1);
  // b missing: the score must reflect a alone, NOT treat b as zero.
  const partial = S.scoreParts([{ k: 'a', w: 0.5, v: 1 }, { k: 'b', w: 0.5, v: null }]);
  assert.strictEqual(partial.score, 1, 'a missing component must not drag the score toward zero');
  assert.strictEqual(partial.coverage, 0.5);
  assert.deepStrictEqual(partial.missing, ['b']);
  assert.strictEqual(S.scoreParts([{ k: 'a', w: 1, v: null }]), null, 'no evidence must produce no score');
});

test('ramp inverts when hi < lo', () => {
  assert.strictEqual(S.ramp(0.40, 0.40, 0.03), 0);
  assert.strictEqual(S.ramp(0.03, 0.40, 0.03), 1);
  assert.strictEqual(S.ramp(0.50, 0.40, 0.03), 0, 'clamped');
});

/* ==================== data layer ==================== */
test('snapshot builds windows and h1, and excludes a failed feed instead of zeroing it', async () => {
  const snap = await mkSnap(RISK_OFF.concat([{ tk: 'DEAD', fail: true }]));
  assert.ok(snap.tickers.length >= 12);
  assert.ok(!snap.tickers.includes('DEAD'), 'a coin whose feed failed must not appear as a data point');
  assert.ok(snap.errors.some(e => e.tk === 'DEAD'), 'the failure must be recorded, not swallowed');
  const btc = snap.coins.BTC;
  assert.ok(btc.win['15m'] && btc.win['1h'] && btc.win['4h'] && btc.win['24h'], 'all four windows present');
  assert.ok(btc.win['15m'].ret.length >= 30);
  assert.ok(btc.h1.close.length > 100, 'full-length 1h series needed for a 50 EMA');
});

/* ==================== breadth ==================== */
test('breadth: risk-off scores negative with high stress; risk-on scores positive', async () => {
  const off = breadth(await mkSnap(RISK_OFF, { marketDrift: -0.0004 }), { zigzag: ZZ });
  assert.ok(off.ok);
  assert.ok(off.score < -30, 'risk-off breadth should be clearly negative, got ' + off.score);
  assert.ok(off.pctGreen < 30);
  assert.ok(off.altStress > 40, 'synchronised alt selling should register stress, got ' + off.altStress);

  const on = breadth(await mkSnap(flip(RISK_OFF), { marketDrift: 0.0004 }), { zigzag: ZZ });
  assert.ok(on.score > 30, 'risk-on breadth should be clearly positive, got ' + on.score);
  assert.ok(on.altStress < 45, 'a rally must not read as alt stress, got ' + on.altStress);
});

test('breadth refuses a market-wide claim from a handful of coins', async () => {
  const snap = await mkSnap(RISK_OFF.slice(0, 4));
  const b = breadth(snap, { zigzag: ZZ });
  assert.strictEqual(b.ok, false);
  assert.match(b.reason, /below the \d+-coin floor/);
});

test('altcoin stress is one-sided: it never goes negative in a rally', async () => {
  const b = breadth(await mkSnap(flip(RISK_OFF), { marketDrift: 0.0006 }), { zigzag: ZZ });
  assert.ok(b.altStress >= 0 && b.altStress <= 100);
});

/* ==================== correlation ==================== */
test('correlation: a common-factor market reads as a single risk asset', async () => {
  // Tiny idiosyncratic noise → the shared factor dominates.
  const tight = RISK_OFF.map(s => ({ ...s, idio: 0.0001 }));
  const c = correlation(await mkSnap(tight, { marketVol: 0.006 }));
  assert.ok(c.ok);
  assert.ok(c.avgCorrBtc > 0.75, 'expected tight correlation, got ' + c.avgCorrBtc);
  assert.strictEqual(c.singleRiskAsset, true);
  assert.strictEqual(c.level, 'high');
});

test('correlation: idiosyncratic noise reads as a market of independent coins', async () => {
  const loose = RISK_OFF.map(s => ({ ...s, beta: 0.05, idio: 0.02 }));
  const c = correlation(await mkSnap(loose, { marketVol: 0.001 }));
  assert.ok(c.avgCorrBtc < 0.4, 'expected low correlation, got ' + c.avgCorrBtc);
  assert.strictEqual(c.singleRiskAsset, false);
});

test('SYNCHRONIZED MARKET SELLING fires only when BTC is down AND 80%+ of alts fall with it', async () => {
  const c = correlation(await mkSnap(RISK_OFF.map(s => ({ ...s, idio: 0.0002 })), { marketDrift: -0.0012, marketVol: 0.002 }));
  assert.strictEqual(c.synchronizedSelling.flag, true);
  assert.ok(c.synchronizedSelling.pctAltsDown >= 80);

  const up = correlation(await mkSnap(flip(RISK_OFF).map(s => ({ ...s, idio: 0.0002 })), { marketDrift: 0.0012, marketVol: 0.002 }));
  assert.strictEqual(up.synchronizedSelling.flag, false, 'a rally must never flag synchronised SELLING');
});

test('correlation identifies a coin decoupling from BTC', async () => {
  const specs = RISK_OFF.map(s => ({ ...s, idio: 0.0002 }));
  specs.push({ tk: 'ODD', drift: 0.0012, beta: 0, idio: 0.004, qv: 2e8, start: 300, seed: 4242 });
  const c = correlation(await mkSnap(specs, { marketDrift: -0.001, marketVol: 0.004 }));
  assert.ok(c.decoupled.some(x => x.tk === 'ODD'), 'a zero-beta coin should surface as decoupled: ' + JSON.stringify(c.decoupled));
});

/* ==================== beta ==================== */
test('beta engine ranks amplification and flags high-beta alts', async () => {
  const b = betaEngine(await mkSnap(RISK_OFF.map(s => ({ ...s, idio: 0.0003 })), { marketVol: 0.006, marketDrift: -0.0006 }));
  assert.ok(b.ok);
  assert.ok(b.coins.SUI.beta > b.coins.BTC.beta, 'SUI is specified at 2.1x BTC beta');
  assert.ok(b.coins.SUI.beta > 1.5, 'got ' + b.coins.SUI.beta);
  assert.ok(b.highBetaCoins.length > 0, 'high-beta alts should be listed');
  assert.ok(b.highBetaCoins.every(x => x.tk !== 'BTC'));
});

test('coinVsMarket separates "weak" from "high beta doing exactly what beta implies"', async () => {
  const specs = RISK_OFF.map(s => ({ ...s, idio: 0.0003 }));
  specs.push({ tk: 'WEAK', drift: -0.006, beta: 1.0, idio: 0.0003, qv: 2e8, start: 300, seed: 555 });
  const snap = await mkSnap(specs, { marketDrift: -0.0005, marketVol: 0.004 });
  const betas = betaEngine(snap), corrs = correlation(snap);
  const weak = coinVsMarket('WEAK', snap, betas, corrs);
  assert.ok(weak.ok);
  assert.ok(['weaker-than-market', 'decoupling-bearish'].includes(weak.klass), 'got ' + weak.klass);
  // A high-beta coin falling in line with its beta must NOT be called weak.
  const sui = coinVsMarket('SUI', snap, betas, corrs);
  assert.notStrictEqual(sui.klass, 'weaker-than-market', 'SUI falls hard but only as much as its beta implies');
});

/* ==================== structure ==================== */
test('structure reads a bullish HH/HL sequence and a bearish LH/LL sequence', () => {
  const up = [];
  for (let leg = 0; leg < 5; leg++) {
    const base = 100 + leg * 10;
    for (let i = 0; i < 10; i++) up.push(base + i);          // rally
    for (let i = 0; i < 5; i++) up.push(base + 10 - i);      // pullback, but to a higher low
  }
  const su = structure(up, ZZ);
  assert.ok(su.ok, su.reason);
  assert.strictEqual(su.verdict, 'bullish', JSON.stringify(su.sequence));

  const down = up.map(v => 300 - v);
  const sd = structure(down, ZZ);
  assert.ok(sd.ok);
  assert.strictEqual(sd.verdict, 'bearish', JSON.stringify(sd.sequence));
  assert.ok(sd.invalidationLevel > 0, 'a bearish read must quote the level that would invalidate it');
});

test('a long in bearish structure is told it is fighting the structure', () => {
  const down = [];
  for (let leg = 0; leg < 5; leg++) {
    const base = 200 - leg * 10;
    for (let i = 0; i < 10; i++) down.push(base - i);
    for (let i = 0; i < 5; i++) down.push(base - 10 + i);
  }
  const st = structure(down, ZZ);
  assert.strictEqual(st.verdict, 'bearish');
  assert.strictEqual(fightingStructure(st, 1).fighting, true);
  assert.match(fightingStructure(st, 1).text, /fighting bearish market structure/);
  assert.strictEqual(fightingStructure(st, -1).fighting, false);
});

test('unreadable structure returns silence, never a reassuring "not fighting"', () => {
  const flat = new Array(40).fill(100);
  const st = structure(flat, ZZ);
  assert.strictEqual(st.ok, false);
  assert.strictEqual(fightingStructure(st, 1), null, 'no structure means no claim in either direction');
});

/* ==================== transmission ==================== */
test('lead-lag detects a follower that copies the leader two bars later', () => {
  const lead = [];
  for (let i = 0; i < 80; i++) lead.push(Math.sin(i / 3) * 0.01);
  const follow = [0, 0].concat(lead.slice(0, -2));
  const ll = leadLag(lead, follow, 4);
  assert.strictEqual(ll.lag, 2, 'expected a 2-bar lag, got ' + ll.lag);
  assert.strictEqual(ll.leads, true);
});

test('transmission names BTC as the leader when alts receive the move LATE', async () => {
  // BTC on the factor immediately; everything else two bars behind it. This is what "BTC-led"
  // actually looks like in data, as distinct from "BTC and the alts both fell".
  const led = RISK_OFF.map(s => ({ ...s, idio: 0.0002, lag: s.tk === 'BTC' ? 0 : 2 }));
  const t = transmission(await mkSnap(led, { marketDrift: -0.001, marketVol: 0.006 }));
  assert.ok(t.ok);
  assert.strictEqual(t.leader, 'BTC', 'got ' + t.leader + ' — ' + t.leaderWhy);
  assert.strictEqual(t.leadLag.btcToAlt.leads, true);
  assert.ok(t.leadLag.btcToAlt.lag >= 1, 'the detected lag should be positive, got ' + t.leadLag.btcToAlt.lag);
  assert.match(t.narrative, /BTC-led/);
  assert.match(t.caveat, /traded value/, 'tier cuts must be labelled as a market-cap proxy');
});

test('simultaneous high-beta selling is NOT reported as BTC-led', async () => {
  // Same factor, same bar, differing beta. Nothing leads anything here — the alts simply move
  // more — and the engine must not manufacture a leader out of magnitude alone.
  const t = transmission(await mkSnap(RISK_OFF.map(s => ({ ...s, idio: 0.0002 })), { marketDrift: -0.001, marketVol: 0.005 }));
  assert.ok(t.ok);
  assert.strictEqual(t.leadLag.btcToAlt.leads, false, 'no time lag exists in this fixture');
  assert.ok(t.narrative.length > 40);
});

/* ==================== open interest ==================== */
test('OI quadrant matrix maps all four cells and a flat deadband', () => {
  assert.strictEqual(quadrantOf(0.05, 0.05), 'up-up');
  assert.strictEqual(quadrantOf(0.05, -0.05), 'up-down');
  assert.strictEqual(quadrantOf(-0.05, 0.05), 'down-up');
  assert.strictEqual(quadrantOf(-0.05, -0.05), 'down-down');
  assert.strictEqual(quadrantOf(0.0001, 0.05), 'flat');
  assert.strictEqual(quadrantOf(null, 0.05), null);
});

test('price down + OI down is named DELEVERAGING, not fresh shorts', async () => {
  const snap = await mkSnap(RISK_OFF, { marketDrift: -0.002 });
  const oiRaw = {
    available: true, venue: 'test', asOf: Date.now(),
    data: { period: '15m', series: { BTC: [{ oi: 1000, val: 1e9, t: 1 }, { oi: 990, val: 9.9e8, t: 2 }, { oi: 980, val: 9.8e8, t: 3 }, { oi: 970, val: 9.7e8, t: 4 }, { oi: 960, val: 9.6e8, t: 5 }, { oi: 950, val: 9.5e8, t: 6 }, { oi: 940, val: 9.4e8, t: 7 }, { oi: 900, val: 9e8, t: 8 }, { oi: 880, val: 8.8e8, t: 9 }] } }
  };
  const oi = openInterestEngine(snap, oiRaw);
  assert.ok(oi.available);
  assert.strictEqual(oi.market.quadrant, 'down-down');
  assert.strictEqual(oi.market.deleveraging, true);
  assert.strictEqual(oi.market.freshShorts, false);
  assert.match(oi.market.meaning, /DELEVERAGING/);
});

test('no OI feed yields available:false with a reason and NO quadrant', async () => {
  const oi = openInterestEngine(await mkSnap(RISK_OFF), { available: false, reason: 'geo-blocked' });
  assert.strictEqual(oi.available, false);
  assert.match(oi.reason, /geo-blocked/);
  assert.strictEqual(oi.market, undefined, 'an unavailable feed must not produce a market quadrant');
  assert.match(oi.note, /cannot distinguish forced long liquidation from fresh short selling/);
});

/* ==================== funding ==================== */
test('funding names the crowded side and warns when price falls into an uncapitulated long book', async () => {
  const snap = await mkSnap(RISK_OFF, { marketDrift: -0.002 });
  const raw = { available: true, venue: 'test', asOf: Date.now(), data: {} };
  for (const s of RISK_OFF) raw.data[s.tk] = { rate: 0.0008, markPrice: 1, nextFundingTime: 0 };
  const f = fundingEngine(snap, raw, { available: false, reason: 'not fetched' }, { btcRet4h: -0.03 });
  assert.ok(f.available);
  assert.strictEqual(f.crowding, 'longs-heavily-crowded');
  assert.strictEqual(f.extreme, true);
  assert.ok(f.messages.some(m => /remains positive despite falling price/.test(m)), JSON.stringify(f.messages));
});

test('funding reports normalisation when the latest print is much smaller than prior ones', async () => {
  const snap = await mkSnap(RISK_OFF);
  const raw = { available: true, venue: 'test', asOf: Date.now(), data: {} };
  for (const s of RISK_OFF) raw.data[s.tk] = { rate: 0.0001 };
  const hist = { available: true, data: { rates: {} } };
  for (const s of RISK_OFF) hist.data.rates[s.tk] = [0.0009, 0.0008, 0.0007, 0.0001];
  const f = fundingEngine(snap, raw, hist, { btcRet4h: -0.03 });
  assert.strictEqual(f.reversal.available, true);
  assert.strictEqual(f.reversal.normalising, true);
  assert.ok(f.messages.some(m => /less extreme/.test(m)), JSON.stringify(f.messages));
});

test('no funding feed yields available:false and no crowding verdict', async () => {
  const f = fundingEngine(await mkSnap(RISK_OFF), { available: false, reason: 'unreachable' }, null, {});
  assert.strictEqual(f.available, false);
  assert.strictEqual(f.crowding, undefined);
  assert.match(f.note, /crowded long book/);
});

/* ==================== liquidity ==================== */
test('liquidity flags a vacuum when price impact is abnormal AND the bar is violent', async () => {
  // A coin that suddenly moves hard on unchanged volume is, by definition, a thinner book.
  const specs = RISK_OFF.map(s => ({ ...s }));
  specs.push({ tk: 'THIN', drift: 0, beta: 0.2, idio: 0.0005, qv: 1e8, start: 100, seed: 31337, shockAt: 6, shock: -0.05, wick: 0.03 });
  const snap = await mkSnap(specs, { marketVol: 0.003 });
  const L = liquidityEngine(snap, { available: false, reason: 'no book' });
  assert.ok(L.ok);
  assert.strictEqual(L.depthAvailable, false);
  assert.match(L.tier, /price-impact estimate/);
  assert.match(L.caveat, /ESTIMATE/);
  assert.ok(L.coins.THIN.impactPctile > 0.8, 'the shocked coin should sit in the top decile of its own impact history, got ' + L.coins.THIN.impactPctile);
  assert.strictEqual(L.coins.THIN.vacuum, true);
});

test('a coin with no volume data is marked unavailable, not liquid', async () => {
  const specs = RISK_OFF.map(s => ({ ...s }));
  specs.push({ tk: 'NOVOL', drift: 0, beta: 1, idio: 0.001, qv: 0, start: 10, noVol: true, seed: 21 });
  const L = liquidityEngine(await mkSnap(specs), { available: false, reason: 'no book' });
  assert.strictEqual(L.coins.NOVOL.tier, 'unavailable');
  assert.strictEqual(L.coins.NOVOL.vacuum, false);
  assert.match(L.coins.NOVOL.reason, /no volume data|bars carry volume/);
});

/* ==================== liquidation cascade ==================== */
test('cascade runs INFERRED and caps confidence at 65 with no positioning data at all', async () => {
  const specs = RISK_OFF.map(s => ({ ...s, shockAt: 3, shock: -0.02, volSpikeAt: 3, volSpike: 6, idio: 0.0002 }));
  const snap = await mkSnap(specs, { marketDrift: -0.002, marketVol: 0.004 });
  const br = breadth(snap, { zigzag: ZZ }), c = correlation(snap);
  const L = liquidationEngine(snap, { breadth: br, correlation: c, oi: { available: false }, funding: { available: false }, liquidations: { available: false } });
  assert.strictEqual(L.mode, 'inferred');
  assert.strictEqual(L.cap, CAP_INFERRED);
  assert.ok(L.cascade.confidence <= CAP_INFERRED, 'confidence must be capped, got ' + L.cascade.confidence);
  assert.match(L.modeNote, /No liquidation feed was read/);
  assert.deepStrictEqual(L.missing.sort(), ['funding', 'liquidation feed', 'open interest']);
});

test('cascade evidence NEVER claims liquidations when no feed was read', async () => {
  const specs = RISK_OFF.map(s => ({ ...s, shockAt: 3, shock: -0.03, volSpikeAt: 3, volSpike: 8, idio: 0.0002 }));
  const snap = await mkSnap(specs, { marketDrift: -0.003 });
  const L = liquidationEngine(snap, {
    breadth: breadth(snap, { zigzag: ZZ }), correlation: correlation(snap),
    oi: { available: false }, funding: { available: false }, liquidations: { available: false }
  });
  for (const e of L.evidence) {
    assert.ok(!/liquidation feed|liquidations elevated/i.test(e), 'fabricated liquidation evidence: ' + e);
  }
});

test('cascade confidence cap rises to 85 once OI and funding are present', async () => {
  const specs = RISK_OFF.map(s => ({ ...s, shockAt: 3, shock: -0.03, volSpikeAt: 3, volSpike: 8, idio: 0.0002 }));
  const snap = await mkSnap(specs, { marketDrift: -0.003 });
  const L = liquidationEngine(snap, {
    breadth: breadth(snap, { zigzag: ZZ }), correlation: correlation(snap),
    oi: { available: true, market: { oiChange: -0.06, deleveraging: true } },
    funding: { available: true, medianRate: 0.0007 },
    liquidations: { available: false }
  });
  assert.strictEqual(L.cap, CAP_PARTIAL);
  assert.ok(L.cascade.detected, 'a violent broad drop with OI down and funding hot is a cascade');
  assert.strictEqual(L.cascade.side, 'long');
  assert.ok(L.evidence.some(e => /open interest/.test(e)));
  assert.ok(L.evidence.some(e => /funding/.test(e)));
});

test('a calm market is not a cascade', async () => {
  const snap = await mkSnap(RISK_OFF.map(s => ({ ...s, drift: 0, idio: 0.0003 })), { marketDrift: 0, marketVol: 0.0008 });
  const L = liquidationEngine(snap, {
    breadth: breadth(snap, { zigzag: ZZ }), correlation: correlation(snap),
    oi: { available: false }, funding: { available: false }, liquidations: { available: false }
  });
  assert.strictEqual(L.cascade.detected, false);
});

/* ==================== recovery ==================== */
test('recovery and continuation are complementary and labelled heuristic', async () => {
  const snap = await mkSnap(RISK_OFF, { marketDrift: -0.001 });
  const r = recoveryEngine(snap, { zigzag: ZZ, oi: { available: false }, funding: { available: false } });
  assert.ok(r.ok);
  assert.strictEqual(r.recoveryProb + r.continuationRisk, 100);
  assert.strictEqual(r.basis, 'heuristic');
  assert.match(r.basisNote, /NOT measured historical base rates/);
});

test('a straight-line decline does not count as "no failed rally" evidence for recovery', () => {
  const monotonic = Array.from({ length: 24 }, (_, i) => 100 - i);
  const fr = failedRally(monotonic);
  assert.strictEqual(fr.hadRally, false, 'there were no rallies, so there were no failed ones');
  assert.strictEqual(fr.failed, false);

  const bouncedAndFailed = [100, 98, 96, 94, 96.5, 95, 93, 90, 92, 88];
  const fr2 = failedRally(bouncedAndFailed, 0.02);
  assert.strictEqual(fr2.hadRally, true);
  assert.strictEqual(fr2.failed, true, 'a bounce followed by a new low is a failed relief rally');
});

/* ==================== regime ==================== */
test('a detected cascade outranks the plain-pullback classification', async () => {
  const snap = await mkSnap(RISK_OFF, { marketDrift: -0.001 });
  const br = breadth(snap, { zigzag: ZZ });
  const r = classify({
    breadth: br, correlation: correlation(snap), transmission: transmission(snap),
    liquidation: { ok: true, mode: 'inferred', cascade: { detected: true, side: 'long', confidence: 62 }, evidence: ['BTC -3.1% in 30m'] },
    oi: { available: false }, funding: { available: false }, liquidity: { ok: true, marketVacuum: false },
    recovery: { ok: true, selloff: true, verdict: 'undecided' }, sector: { available: false }, btcStructure: { ok: false }
  });
  assert.strictEqual(r.regime, 'long-liquidation-cascade');
  assert.strictEqual(r.tone, 'red');
  assert.ok(r.why.some(w => /62%/.test(w)));
});

test('regime is INSUFFICIENT DATA when breadth could not be computed', () => {
  const r = classify({ breadth: { ok: false, reason: 'only 3 coins loaded' }, correlation: {}, transmission: {}, liquidation: {}, oi: {}, funding: {}, liquidity: {}, recovery: {}, sector: {} });
  assert.strictEqual(r.regime, 'unknown');
  assert.strictEqual(r.label, 'INSUFFICIENT DATA');
});

test('sector weakness refuses to name a sector without enough mapped coins', async () => {
  const sw = sectorWeakness(await mkSnap(RISK_OFF.slice(0, 5)));
  assert.strictEqual(sw.available, false);
  assert.match(sw.reason, /too few|fewer than two/);
});

/* ==================== position risk ==================== */
test('liquidation estimate matches the isolated-margin formula for both sides', () => {
  // 4x long at 100, 0.5% maintenance → ~75.5
  assert.ok(Math.abs(estimateLiquidation(100, 1, 4, 0.005) - 75.5) < 1e-9);
  assert.ok(Math.abs(estimateLiquidation(100, -1, 4, 0.005) - 124.5) < 1e-9);
  assert.strictEqual(estimateLiquidation(100, 1, 0, 0.005), null);
});

async function riskFixture(overrides) {
  const snap = await mkSnap(RISK_OFF, { marketDrift: -0.0008 });
  const engines = {
    breadth: breadth(snap, { zigzag: ZZ }), correlation: correlation(snap), beta: betaEngine(snap),
    oi: { available: false }, funding: { available: false },
    liquidity: liquidityEngine(snap, { available: false, reason: 'no book' }),
    liquidation: { ok: true, cascade: { detected: false, side: 'long', confidence: 20 } },
    recovery: recoveryEngine(snap, { zigzag: ZZ, oi: { available: false }, funding: { available: false } }),
    regimeInfo: { label: 'BTC-LED CORRECTION' }
  };
  return { snap, engines, price: snap.coins.SUI.price, ...overrides };
}

test('position stress scores from available inputs and names what was missing', async () => {
  const { snap, engines, price } = await riskFixture();
  const r = positionRisk({ tk: 'SUI', sym: 'SUIUSDT', side: 1, entry: price * 1.1, lev: 4 }, snap, engines, { zigzag: ZZ });
  assert.ok(r.ok, r.reason);
  assert.ok(r.stress >= 0 && r.stress <= 100);
  assert.strictEqual(r.liqSource, 'estimated');
  assert.match(r.liqEstimateNote, /ESTIMATED/);
  assert.ok(r.stressCoverage > 0 && r.stressCoverage <= 1);
  assert.ok(r.riskMap.some(x => x.k === 'current'));
  assert.ok(r.recoveryRequirement.length > 20);
});

test('a venue-supplied liquidation price overrides the estimate', async () => {
  const { snap, engines, price } = await riskFixture();
  const r = positionRisk({ tk: 'SUI', sym: 'SUIUSDT', side: 1, entry: price * 1.1, lev: 4, liq: price * 0.5 }, snap, engines, { zigzag: ZZ });
  assert.strictEqual(r.liqSource, 'venue-supplied');
  assert.ok(Math.abs(r.liq - price * 0.5) < 1e-9);
  assert.strictEqual(r.liqEstimateNote, null);
});

test('a position already past its liquidation level is CRITICAL, never "91% away"', async () => {
  const { snap, engines, price } = await riskFixture();
  // A long whose liquidation price sits ABOVE the market is already gone.
  const r = positionRisk({ tk: 'SUI', sym: 'SUIUSDT', side: 1, entry: price * 3, lev: 4 }, snap, engines, { zigzag: ZZ });
  assert.strictEqual(r.pastLiquidation, true);
  assert.strictEqual(r.stress, 100);
  assert.strictEqual(r.statusLabel, 'PAST LIQUIDATION LEVEL');
  assert.ok(r.distanceToLiquidation === 0, 'distance must not report a comfortable margin');
  assert.strictEqual(r.averageDown.hardFail, true);
  assert.strictEqual(r.averageDown.verdict, 'no');
});

test('THE AVERAGE-DOWN GATE HAS NO PATH TO "ADD"', async () => {
  const { snap, engines, price } = await riskFixture();
  const verdicts = new Set();
  // Sweep a wide range of entries, leverages and market conditions.
  for (const mult of [0.6, 0.9, 1.0, 1.05, 1.3, 2.0]) {
    for (const lev of [1, 2, 4, 10, 25]) {
      for (const cascade of [true, false]) {
        const eng = { ...engines, liquidation: { ok: true, cascade: { detected: cascade, side: 'long', confidence: 75 } } };
        const r = positionRisk({ tk: 'SUI', sym: 'SUIUSDT', side: 1, entry: price * mult, lev }, snap, eng, { zigzag: ZZ });
        if (!r.ok) continue;
        verdicts.add(r.averageDown.verdict);
        assert.ok(!/\byes\b|\badd now\b|recommend adding|increase your position/i.test(r.averageDown.text),
          'gate produced an add recommendation: ' + r.averageDown.text);
      }
    }
  }
  for (const v of verdicts) {
    assert.ok(['no', 'wait', 'conditions-improving', 'not-applicable'].includes(v), 'unexpected verdict: ' + v);
  }
  assert.ok(verdicts.has('no') || verdicts.has('wait'), 'hostile conditions must produce a refusal');
});

test('an active cascade against the position forces a hard "do NOT average down"', async () => {
  const { snap, engines, price } = await riskFixture();
  const eng = { ...engines, liquidation: { ok: true, cascade: { detected: true, side: 'long', confidence: 80 } } };
  const r = positionRisk({ tk: 'SUI', sym: 'SUIUSDT', side: 1, entry: price * 1.05, lev: 2 }, snap, eng, { zigzag: ZZ });
  assert.strictEqual(r.averageDown.hardFail, true);
  assert.match(r.averageDown.text, /Do NOT average down yet/);
});

test('an entry in the wrong currency is refused, not turned into a fake emergency', async () => {
  const { snap, engines, price } = await riskFixture();
  // Entries are stored in ₹; typing the USDT figure lands ~88x low. That must read as a data
  // error, not as a position that is down 98%.
  const r = positionRisk({ tk: 'SUI', sym: 'SUIUSDT', side: 1, entry: price / 88, lev: 4 }, snap, engines, { zigzag: ZZ });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.unitMismatch, true);
  assert.match(r.reason, /currency mix-up/);

  const hi = positionRisk({ tk: 'SUI', sym: 'SUIUSDT', side: 1, entry: price * 88, lev: 4 }, snap, engines, { zigzag: ZZ });
  assert.strictEqual(hi.unitMismatch, true);

  // A genuinely bad trade (down 40%) must still be scored, not dismissed as a typo.
  const real = positionRisk({ tk: 'SUI', sym: 'SUIUSDT', side: 1, entry: price * 1.67, lev: 4 }, snap, engines, { zigzag: ZZ });
  assert.strictEqual(real.ok, true, 'a 40% drawdown is a real position, not a unit error');
});

test('the risk map always reads as a price axis, highest rung first', async () => {
  const { snap, engines, price } = await riskFixture();
  const r = positionRisk({ tk: 'SUI', sym: 'SUIUSDT', side: 1, entry: price * 1.1, lev: 4 }, snap, engines, { zigzag: ZZ });
  assert.ok(r.ok);
  const px = r.riskMap.map(x => x.px);
  for (let i = 1; i < px.length; i++) assert.ok(px[i] <= px[i - 1], 'rungs out of price order: ' + JSON.stringify(px));
  assert.ok(r.riskMap.some(x => x.k === 'current'));
});

test('a position in a coin outside the tracked universe is refused, not guessed', async () => {
  const { snap, engines } = await riskFixture();
  const r = positionRisk({ tk: 'NOTREAL', sym: 'NOTREALUSDT', side: 1, entry: 10, lev: 4 }, snap, engines, { zigzag: ZZ });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not in the tracked universe/);
});

/* ==================== alerts ==================== */
function fakeIntel(over) {
  return Object.assign({
    breadth: { ok: true, score: -70, pctRed: 88, pctGreen: 12, pctAbove20: 8, altStress: 75, alt: { pctRed: 90, medianRet4h: -0.05 }, ethVsBtc: { h4: 0.001 } },
    regime: { label: 'BTC-LED CORRECTION' },
    liquidation: { ok: true, mode: 'inferred', cascade: { detected: false, side: 'long', confidence: 40 }, evidence: [] },
    funding: { available: false }, liquidity: { ok: true, marketVacuum: false, pctVacuum: 5, tier: 'estimate' },
    recovery: { ok: true, selloff: true, verdict: 'undecided', recoveryProb: 40, continuationRisk: 60, levels: { text: '' } }
  }, over || {});
}

test('alerts fire on the transition and stay quiet while the condition persists', () => {
  const i = fakeIntel();
  let st = {};
  const a1 = buildAlerts(i, st, { now: 1000 }); st = a1.state;
  assert.ok(a1.alerts.some(a => a.key === 'market-selloff'), 'first crossing must fire');
  const a2 = buildAlerts(i, st, { now: 2000 }); st = a2.state;
  assert.strictEqual(a2.alerts.length, 0, 'a persisting condition must not re-fire');
  const a3 = buildAlerts(i, st, { now: 1000 + 60 * 60 * 1000 });
  assert.strictEqual(a3.alerts.length, 0, 'even past the cooldown, a still-true condition must not re-fire');
});

test('alerts re-arm only after the condition clears its hysteresis band', () => {
  let st = {};
  st = buildAlerts(fakeIntel(), st, { now: 1000 }).state;
  // Recovers past the re-arm band.
  const calm = fakeIntel({ breadth: { ok: true, score: -10, pctRed: 40, pctGreen: 60, pctAbove20: 55, altStress: 20, alt: { pctRed: 40, medianRet4h: 0 }, ethVsBtc: { h4: 0 } } });
  st = buildAlerts(calm, st, { now: 2000 }).state;
  const back = buildAlerts(fakeIntel(), st, { now: 1000 + 60 * 60 * 1000, cooldownMs: 0 });
  assert.ok(back.alerts.some(a => a.key === 'market-selloff'), 'a genuine new event must fire again');
});

test('a cascade alert built without a liquidation feed says so in its own text', () => {
  const i = fakeIntel({ liquidation: { ok: true, mode: 'inferred', cascade: { detected: true, side: 'long', confidence: 61 }, evidence: ['BTC -3.1% in 30m'] } });
  const { alerts } = buildAlerts(i, {}, { now: 1000 });
  const c = alerts.find(a => a.key === 'liquidation-cascade');
  assert.ok(c, 'cascade alert should fire');
  assert.match(c.text, /No liquidation feed/);
  assert.strictEqual(c.confidence, 61);
});

/* ==================== derivatives adapter honesty ==================== */
test('liquidations are ALWAYS reported unavailable, with the reason', async () => {
  const d = createDerivs({});
  const r = await d.liquidations();
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.data, null);
  assert.match(r.reason, /WebSocket/);
});

test('a disabled derivatives adapter returns the unavailable envelope, never empty data', async () => {
  const d = createDerivs({ enabled: false });
  for (const fn of ['funding', 'openInterest', 'depth', 'fundingHistory']) {
    const r = await d[fn](['BTC']);
    assert.strictEqual(r.available, false, fn + ' should be unavailable');
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, fn + ' must carry a reason');
    assert.strictEqual(r.data, null, fn + ' must not return a data object');
  }
});

/* ==================== history & backtest ==================== */
test('the backtester refuses to state a rate from an insufficient sample', () => {
  fs.mkdirSync(TMP, { recursive: true });
  const h = createHistory({ dir: TMP });
  h.__reset();
  const empty = h.backtest('x', () => true);
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.insufficient, true);
  assert.match(empty.reason, /No history recorded yet/);

  // Three matching snapshots is not a base rate.
  const base = Date.now() - 10 * 3600 * 1000;
  for (let i = 0; i < 6; i++) {
    h.record({ ok: true, ts: base + i * 15 * 60000, regime: { regime: 'x' }, breadth: { ok: true, score: -70, altStress: 90 }, __prices: { BTC: 100 + i, ETH: 50 + i } });
  }
  const few = h.backtest('stress', r => r.stress > 80);
  assert.strictEqual(few.insufficient, true);
  assert.match(few.note, /not a base rate/);
  h.__reset();
});

test('the backtester measures forward returns against later snapshots', () => {
  fs.mkdirSync(TMP, { recursive: true });
  const h = createHistory({ dir: TMP });
  h.__reset();
  const base = Date.now() - 48 * 3600 * 1000;
  // 60 snapshots 15m apart; price rises steadily so forward returns must be positive.
  for (let i = 0; i < 60; i++) {
    h.record({ ok: true, ts: base + i * 15 * 60000, regime: { regime: 'x' }, breadth: { ok: true, score: -70, altStress: 90 }, __prices: { BTC: 100 * Math.pow(1.01, i), ETH: 50 * Math.pow(1.01, i) } });
  }
  const bt = h.backtest('stress', r => r.stress > 80, { minSample: 10 });
  assert.strictEqual(bt.ok, true);
  assert.ok(bt.horizons['15m'].samples >= 10, JSON.stringify(bt.horizons['15m']));
  assert.ok(bt.horizons['15m'].medianReturn > 0, 'a rising tape must produce positive forward returns');
  assert.strictEqual(bt.horizons['15m'].pctPositive, 100);
  assert.strictEqual(bt.insufficient, false);
  h.__reset();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
});

/* ==================== cross-cutting honesty guards ==================== */
test('GUARD: no engine publishes a market-wide score when nothing loaded', async () => {
  const empty = { ts: Date.now(), coins: {}, tickers: [], alts: [], windows: [], errors: [], coverage: 0 };
  assert.strictEqual(breadth(empty, { zigzag: ZZ }).ok, false);
  assert.strictEqual(correlation(empty).ok, false);
  assert.strictEqual(betaEngine(empty).ok, false);
  assert.strictEqual(transmission(empty).ok, false);
  assert.strictEqual(liquidationEngine(empty, {}).ok, false);
  assert.strictEqual(recoveryEngine(empty, { zigzag: ZZ }).ok, false);
  assert.strictEqual(liquidityEngine(empty, null).ok, false);
});

test('GUARD: every unavailable result carries a human-readable reason', async () => {
  const snap = await mkSnap(RISK_OFF);
  const REASON = 'futures venue unreachable from this region';
  const results = [
    openInterestEngine(snap, { available: false, reason: REASON }),
    fundingEngine(snap, { available: false, reason: REASON }, null, {}),
    liquidityEngine(snap, { available: false, reason: REASON })
  ];
  for (const r of results) {
    if (r.available === false) assert.ok(typeof r.reason === 'string' && r.reason.length > 3, JSON.stringify(r).slice(0, 120));
  }
});

test('GUARD: intel/ never reaches an exchange directly — only through injected loaders', () => {
  const dir = path.join(__dirname, '..', 'intel');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hasFetch = /\bfetch\s*\(/.test(code);
    /* The adapters ARE the outbound boundary and are the only files allowed to call out. Keeping
       this list explicit is the point: a new engine that quietly grew its own fetch would fail
       here rather than becoming a second, divergent source of truth. */
    const ADAPTERS = ['derivs.js', 'global.js', 'macroData.js'];
    if (ADAPTERS.includes(f)) { assert.ok(hasFetch, f + ' is an adapter and should call fetch'); continue; }
    assert.ok(!hasFetch, `${f} must not open its own connection — candles come from the injected loadCrypto`);
  }
});

/* ============================================================
   MACRO LAYER
   The feature exists because chart-only trading blew an account up. So the tests care most about
   two things: that macro actually GATES (a warning nobody acts on is what failed the first time),
   and that an unreachable macro feed neither silently blocks everything nor silently stops
   protecting anything.
   ============================================================ */
const createMacroData = require('../intel/macroData');
const createCalendar = require('../intel/calendar');
const { macroEngine, alignedReturns, buildGate, coinDailyMap } = require('../intel/macro');

/* Build a macro adapter payload without touching the network. */
function mkMacro(spec) {
  const series = {};
  for (const key of Object.keys(spec)) {
    const s = spec[key];
    const closes = {}, dates = [];
    let x = s.start == null ? 100 : s.start;
    // Walk BACK from today so the last date is always "now".
    const n = s.n || 90;
    const days = [];
    for (let i = n - 1; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    for (let i = 0; i < n; i++) {
      x *= (1 + (s.drift || 0) + (s.path ? s.path[i] || 0 : 0));
      closes[days[i]] = x; dates.push(days[i]);
    }
    series[key] = {
      key, name: key, invert: !!s.invert, group: 'global', why: '', source: 'test',
      closes, dates, last: closes[days[n - 1]], lastDate: days[n - 1]
    };
  }
  return { available: true, reason: null, asOf: Date.now(), data: { series, failed: [], covered: Object.keys(series).length, total: Object.keys(series).length } };
}

/* Small deterministic wobble. A perfectly flat series has no dispersion and therefore no
   percentile — which is correct behaviour, but makes for a fixture that tests nothing. */
const wobble = (n, amp, seed) => { const r = rng(seed); return Array.from({ length: n }, () => (r() - 0.5) * 2 * amp); };
const CALM_MACRO = () => mkMacro({
  DXY: { start: 100, drift: 0, invert: true, path: wobble(90, 0.002, 11) },
  US10Y: { start: 4.2, drift: 0, invert: true, path: wobble(90, 0.004, 12) },
  // VIX drifting DOWN into the low teens is what a calm tape looks like; it must land in the
  // lower part of its own recent range, not the top of it.
  VIX: { start: 22, drift: -0.006, invert: true, path: wobble(90, 0.01, 13) },
  SPX: { start: 5000, drift: 0.0006, path: wobble(90, 0.002, 14) },
  NDX: { start: 16000, drift: 0.0007, path: wobble(90, 0.003, 15) }
});

test('macro: a dollar squeeze with a VIX spike reads as risk-off, not neutral', () => {
  const raw = mkMacro({
    DXY: { start: 100, drift: 0.005, invert: true },      // dollar ripping
    US10Y: { start: 4.2, drift: 0.004, invert: true },     // yields up
    VIX: { start: 12, drift: 0.02, invert: true },         // vol exploding
    SPX: { start: 5000, drift: -0.004 },
    NDX: { start: 16000, drift: -0.006 }
  });
  const m = macroEngine(raw, null, { ok: true, inWindow: false, configured: true });
  assert.ok(m.available);
  assert.ok(m.riskAppetite < -40, 'expected clear risk-off, got ' + m.riskAppetite);
  assert.ok(['vol-spike', 'dollar-squeeze', 'yield-shock', 'risk-off'].includes(m.regime.regime), m.regime.regime);
  assert.strictEqual(m.gate.blockLongs, true, 'hostile macro must block new longs');
});

test('macro: a calm risk-on tape does not gate anything', () => {
  const m = macroEngine(CALM_MACRO(), null, { ok: true, inWindow: false, configured: true });
  assert.ok(m.riskAppetite > 0, 'got ' + m.riskAppetite);
  assert.strictEqual(m.gate.blockNewLeverage, false);
  assert.strictEqual(m.gate.blockLongs, false);
});

test('MACRO UNAVAILABLE fails OPEN but warns — it never silently degrades or silently blocks', () => {
  const m = macroEngine({ available: false, reason: 'geo-blocked' }, null, { ok: true, inWindow: false, configured: true });
  assert.strictEqual(m.available, false);
  assert.strictEqual(m.gate.confidenceMultiplier, 1, 'a broken feed must not quietly degrade every setup');
  assert.strictEqual(m.gate.blockNewLeverage, false, 'a broken feed must not quietly block every trade');
  assert.match(m.warning, /MACRO UNCHECKED/);
  assert.ok(m.gate.reasons.some(r => /unavailable/i.test(r)), 'the loss of protection must be stated');
});

test('the event window blocks leverage EVEN WITH NO MACRO FEED — it needs no network', () => {
  const ev = { ok: true, configured: true, inWindow: true, message: 'US CPI in 2.0h.', window: { label: 'US CPI', phase: 'before', hoursAway: 2 } };
  const m = macroEngine({ available: false, reason: 'unreachable' }, null, ev);
  assert.strictEqual(m.available, false);
  assert.strictEqual(m.gate.blockNewLeverage, true, 'the calendar gate must survive a dead macro API');
  assert.strictEqual(m.gate.blockLongs, true);
  assert.strictEqual(m.gate.blockShorts, true, 'an event window cuts both ways — direction is unknown');
  assert.ok(m.gate.confidenceMultiplier <= 0.4);
});

test('correlations are aligned BY DATE, not by position', () => {
  // Crypto trades weekends; macro does not. Positional pairing would silently offset the two.
  const a = {}, b = {};
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 40; i++) {
    const d = new Date(base + i * 86400000);
    const key = d.toISOString().slice(0, 10);
    // Geometric, so the return between any two shared dates is identical for both series —
    // which makes a correlation of exactly 1 the proof that the DATES were paired correctly.
    a[key] = 100 * Math.pow(1.01, i);                  // every day
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) b[key] = 200 * Math.pow(1.01, i);   // weekdays only
  }
  const al = alignedReturns(a, b, 40);
  assert.ok(al.n > 10);
  // Both rise by the same increment on every shared date → correlation must be ~1.
  assert.ok(Math.abs(S.pearson(al.a, al.b) - 1) < 1e-6, 'aligned series should correlate perfectly');
  assert.ok(Object.keys(b).length < Object.keys(a).length, 'fixture must actually have missing weekend bars');
});

test('technical reliability collapses when BTC trades as a Nasdaq proxy', async () => {
  const snap = await mkSnap(RISK_OFF, { marketDrift: -0.0005 });
  // Build a macro NDX series that mirrors BTC's own daily path exactly → correlation ~1.
  const btcMap = coinDailyMap(snap.coins.BTC);
  assert.ok(btcMap, 'fixture must produce a usable BTC daily map');
  const dates = Object.keys(btcMap).sort();
  const closes = {};
  for (const d of dates) closes[d] = btcMap[d] * 3;      // perfectly proportional
  const raw = CALM_MACRO();
  raw.data.series.NDX = { key: 'NDX', name: 'Nasdaq', invert: false, group: 'global', why: '', source: 'test', closes, dates, last: closes[dates[dates.length - 1]], lastDate: dates[dates.length - 1] };
  raw.data.series.VIX.closes[raw.data.series.VIX.dates[raw.data.series.VIX.dates.length - 1]] = 30;
  raw.data.series.VIX.last = 30;

  const m = macroEngine(raw, snap, { ok: true, inWindow: false, configured: true });
  assert.ok(Math.abs(m.cryptoMacro.correlations.NDX) > 0.9, 'got ' + m.cryptoMacro.correlations.NDX);
  assert.ok(m.cryptoMacro.taReliability < 40, 'a Nasdaq-proxy tape must read as unreliable for TA, got ' + m.cryptoMacro.taReliability);
  assert.ok(m.gate.confidenceMultiplier < 0.8, 'confidence must be degraded, got ' + m.gate.confidenceMultiplier);
  assert.match(m.cryptoMacro.message, /macro asset|overridden/i);
});

test('the confidence multiplier scales with reliability and never reaches zero', () => {
  const at = rel => buildGate({ taReliability: rel, riskAppetite: 0, regime: {} }, { inWindow: false }, {}).confidenceMultiplier;
  assert.strictEqual(at(100), 1);
  assert.strictEqual(at(0), 0.5, 'a fully macro-driven tape halves confidence but does not erase the signal');
  assert.ok(at(50) > at(20) && at(20) > at(0), 'must be monotonic');
});

/* ---------------- event calendar ---------------- */
const CAL_TMP = path.join(__dirname, '..', '.test-cal');
function writeCal(obj) {
  fs.mkdirSync(CAL_TMP, { recursive: true });
  const f = path.join(CAL_TMP, 'macro-calendar.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('NFP is derived as the first Friday and needs no maintenance', () => {
  const { nfpFor } = require('../intel/calendar');
  const d = nfpFor(2026, 8);                    // September 2026
  assert.strictEqual(d.getUTCDay(), 5, 'must be a Friday');
  assert.ok(d.getUTCDate() <= 7, 'must be the FIRST Friday, got day ' + d.getUTCDate());
});

test('an event inside its window blocks leverage; outside it only warns', () => {
  const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const f = writeCal({ validThrough: '2099-12-31', blockHoursBefore: 6, blockHoursAfter: 2, events: [{ at: soon, kind: 'cpi', impact: 'high', label: 'US CPI', unverified: false }] });
  const cal = createCalendar({ file: f });
  const r = cal.eventRisk();
  assert.strictEqual(r.inWindow, true);
  assert.match(r.message, /US CPI/);
  assert.match(r.message, /blocked/);

  const far = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
  const f2 = writeCal({ validThrough: '2099-12-31', events: [{ at: far, kind: 'fomc', impact: 'high', label: 'FOMC', unverified: false }] });
  const r2 = createCalendar({ file: f2 }).eventRisk();
  assert.strictEqual(r2.inWindow, false);
  assert.ok(r2.next && /FOMC/.test(r2.next.label));
});

test('a medium-impact event warns but does not block', () => {
  const soon = new Date(Date.now() + 1 * 3600 * 1000).toISOString();
  const f = writeCal({ validThrough: '2099-12-31', events: [{ at: soon, kind: 'rbi', impact: 'medium', label: 'RBI MPC', unverified: false }] });
  const r = createCalendar({ file: f }).eventRisk();
  assert.strictEqual(r.inWindow, false, 'only high-impact events block');
  assert.ok(r.next && /RBI/.test(r.next.label), 'but it must still be visible as the next event');
});

test('AN EXPIRED CALENDAR DROPS ITS DATES rather than reporting stale ones as upcoming', () => {
  const past = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
  const f = writeCal({ validThrough: '2020-01-01', events: [{ at: past, kind: 'fomc', impact: 'high', label: 'STALE FOMC', unverified: false }] });
  const r = createCalendar({ file: f }).eventRisk();
  assert.strictEqual(r.stale, true);
  assert.match(r.reason, /expired/);
  assert.ok(!r.upcoming.some(e => e.label === 'STALE FOMC'), 'an expired file must not feed events');
  assert.strictEqual(r.inWindow, false);
  // Derived NFP survives, because a rule cannot expire.
  assert.ok(r.upcoming.every(e => e.derived), 'only derived events should remain: ' + JSON.stringify(r.upcoming.map(e => e.label)));
});

test('a missing calendar file degrades to derived NFP only, and says so', () => {
  const r = createCalendar({ file: path.join(CAL_TMP, 'does-not-exist.json') }).eventRisk();
  assert.strictEqual(r.configured, false);
  assert.match(r.reason, /could not be read/);
  assert.ok(r.upcoming.length > 0 && r.upcoming.every(e => e.derived));
});

test('unverified shipped dates are counted and surfaced, not passed off as fact', () => {
  const soon = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
  const f = writeCal({ validThrough: '2099-12-31', events: [{ at: soon, kind: 'fomc', impact: 'high', label: 'FOMC', unverified: true }] });
  const r = createCalendar({ file: f }).eventRisk();
  assert.ok(r.unverifiedCount >= 1);
  assert.strictEqual(r.window.unverified, true);
  assert.match(r.message, /UNVERIFIED/);
  try { fs.rmSync(CAL_TMP, { recursive: true, force: true }); } catch (e) { }
});

test('the shipped macro-calendar.json parses and marks its dates unverified', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'macro-calendar.json'), 'utf8'));
  assert.ok(Array.isArray(raw.events) && raw.events.length > 0);
  assert.ok(raw.validThrough, 'must declare a validity date or it can never be detected as stale');
  for (const e of raw.events) {
    assert.ok(isFinite(Date.parse(e.at)), 'unparseable date: ' + e.at);
    assert.strictEqual(e.unverified, true, 'shipped dates must be flagged for the user to confirm: ' + e.label);
  }
});

/* ---------------- macro in position risk ---------------- */
test('an event window forces a hard NO on averaging down, whatever the chart says', async () => {
  const { snap, engines, price } = await riskFixture();
  const eng = {
    ...engines,
    macro: macroEngine(CALM_MACRO(), snap, { ok: true, inWindow: false, configured: true }),
    eventRisk: { ok: true, configured: true, inWindow: true, message: 'US CPI in 1.5h.', window: { label: 'US CPI', phase: 'before', hoursAway: 1.5 }, next: null, hoursToNext: 1.5 }
  };
  const r = positionRisk({ tk: 'SUI', sym: 'SUIUSDT', side: 1, entry: price * 1.02, lev: 2 }, snap, eng, { zigzag: ZZ });
  assert.ok(r.ok);
  assert.strictEqual(r.averageDown.hardFail, true);
  assert.strictEqual(r.averageDown.verdict, 'no');
  assert.ok(r.averageDown.checks.some(c => c.k === 'noScheduledEvent' && c.state === 'fail'));
});

test('position stress rises when macro turns against the position', async () => {
  const { snap, engines, price } = await riskFixture();
  const calm = macroEngine(CALM_MACRO(), snap, { ok: true, inWindow: false, configured: true });
  const hostile = macroEngine(mkMacro({
    DXY: { start: 100, drift: 0.005, invert: true }, US10Y: { start: 4.2, drift: 0.004, invert: true },
    VIX: { start: 12, drift: 0.02, invert: true }, SPX: { start: 5000, drift: -0.004 }, NDX: { start: 16000, drift: -0.006 }
  }), snap, { ok: true, inWindow: false, configured: true });

  const mk = macro => positionRisk({ tk: 'SUI', sym: 'SUIUSDT', side: 1, entry: price * 1.05, lev: 3 }, snap,
    { ...engines, macro, eventRisk: { ok: true, configured: true, inWindow: false, hoursToNext: 100, next: null } }, { zigzag: ZZ });

  const a = mk(calm), b = mk(hostile);
  assert.ok(a.ok && b.ok);
  assert.ok(b.stress > a.stress, `hostile macro should raise stress: calm ${a.stress} vs hostile ${b.stress}`);
  assert.strictEqual(b.macro.available, true);
  assert.ok(b.stressInputs.includes('macroAgainst'));
});

test('macro unavailable leaves it out of the stress score instead of scoring it as calm', async () => {
  const { snap, engines, price } = await riskFixture();
  const r = positionRisk({ tk: 'SUI', sym: 'SUIUSDT', side: 1, entry: price * 1.05, lev: 3 }, snap,
    { ...engines, macro: macroEngine({ available: false, reason: 'x' }, snap, { ok: true, inWindow: false }), eventRisk: null }, { zigzag: ZZ });
  assert.ok(r.ok);
  assert.ok(r.stressMissing.includes('macroAgainst'), 'an unmeasured macro must be MISSING, not a zero');
  assert.strictEqual(r.macro.available, false);
});

/* ---------------- macro in the regime classifier ---------------- */
test('an event window outranks every crypto-internal regime', async () => {
  const snap = await mkSnap(RISK_OFF, { marketDrift: -0.001 });
  const ev = { ok: true, configured: true, inWindow: true, message: 'FOMC in 3.0h.', window: { label: 'FOMC decision', phase: 'before', hoursAway: 3 } };
  const macro = macroEngine(CALM_MACRO(), snap, ev);
  const r = classify({
    breadth: breadth(snap, { zigzag: ZZ }), correlation: correlation(snap), transmission: transmission(snap),
    liquidation: { ok: true, mode: 'inferred', cascade: { detected: true, side: 'long', confidence: 70 }, evidence: [] },
    oi: { available: false }, funding: { available: false }, liquidity: { ok: true, marketVacuum: false },
    recovery: { ok: true, selloff: true, verdict: 'undecided' }, sector: { available: false }, btcStructure: { ok: false }, macro
  });
  assert.strictEqual(r.regime, 'macro-event-window', 'got ' + r.regime);
  assert.ok(r.why.some(w => /FOMC/.test(w)));
});

test('a macro-driven decline is named as such rather than as a BTC-led correction', async () => {
  const snap = await mkSnap(RISK_OFF, { marketDrift: -0.001 });
  const hostile = macroEngine(mkMacro({
    DXY: { start: 100, drift: 0.006, invert: true }, US10Y: { start: 4.2, drift: 0.005, invert: true },
    VIX: { start: 12, drift: 0.03, invert: true }, SPX: { start: 5000, drift: -0.005 }, NDX: { start: 16000, drift: -0.007 }
  }), snap, { ok: true, inWindow: false, configured: true });
  const r = classify({
    breadth: breadth(snap, { zigzag: ZZ }), correlation: correlation(snap), transmission: transmission(snap),
    liquidation: { ok: true, cascade: { detected: false }, evidence: [] },
    oi: { available: false }, funding: { available: false }, liquidity: { ok: true, marketVacuum: false },
    recovery: { ok: true, selloff: true, verdict: 'undecided' }, sector: { available: false }, btcStructure: { ok: false }, macro: hostile
  });
  assert.strictEqual(r.regime, 'macro-risk-off', 'got ' + r.regime + ' — ' + JSON.stringify(r.why));
});

/* ---------------- macro alerts ---------------- */
test('macro alerts fire for event windows, hostile macro and an unavailable feed', () => {
  const base = fakeIntel();
  const evI = { ...base, macro: { available: true, riskAppetite: 0, riskAppetiteLabel: 'Neutral', regime: { label: 'MACRO NEUTRAL', why: [] }, cryptoMacro: { taReliability: 80, message: '' }, gate: { confidenceMultiplier: 0.4 } }, eventRisk: { ok: true, inWindow: true, message: 'US CPI in 1.0h.' } };
  const a1 = buildAlerts(evI, {}, { now: 1000 });
  assert.ok(a1.alerts.some(a => a.key === 'macro-event-window'), JSON.stringify(a1.alerts.map(x => x.key)));

  const hostile = { ...base, macro: { available: true, riskAppetite: -70, riskAppetiteLabel: 'Severe risk-off', regime: { label: 'DOLLAR SQUEEZE', why: ['dollar +2.1% in 5d'] }, cryptoMacro: { taReliability: 40, message: '' }, gate: { confidenceMultiplier: 0.7 } }, eventRisk: { ok: true, inWindow: false } };
  const a2 = buildAlerts(hostile, {}, { now: 1000 });
  const m = a2.alerts.find(a => a.key === 'macro-risk-off');
  assert.ok(m, 'hostile macro must alert');
  assert.match(m.text, /blocked/);

  const dead = { ...base, macro: { available: false, warning: 'MACRO UNCHECKED — ...' }, eventRisk: { ok: true, inWindow: false } };
  const a3 = buildAlerts(dead, {}, { now: 1000 });
  const u = a3.alerts.find(a => a.key === 'macro-unavailable');
  assert.ok(u, 'losing macro protection must itself raise an alert');
  assert.match(u.text, /gating is currently OFF/);
});

/* ---------------- adapter parsing ---------------- */
test('macro adapter rejects malformed payloads instead of inventing a level', () => {
  const { __parseYahoo, __parseStooq } = createMacroData;
  assert.strictEqual(__parseYahoo({}), null);
  assert.strictEqual(__parseYahoo({ chart: { result: [{}] } }), null);
  assert.strictEqual(__parseYahoo({ chart: { result: [{ timestamp: [1, 2], indicators: { quote: [{ close: [1, 2] }] } }] } }), null, 'under 5 usable points is not a series');
  assert.strictEqual(__parseStooq('<html>rate limited</html>'), null);
  assert.strictEqual(__parseStooq('Date,Open,High,Low,Close,Volume\n2026-01-01,1,1,1,1,1\n'), null, 'one row is not a series');

  const ts = [], close = [];
  for (let i = 0; i < 10; i++) { ts.push(Math.floor(Date.UTC(2026, 0, i + 1) / 1000)); close.push(100 + i); }
  const good = __parseYahoo({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ close }] } }] } });
  assert.ok(good && good.last === 109);
  assert.strictEqual(Object.keys(good.closes).length, 10);
});

test('a disabled macro adapter returns the unavailable envelope', async () => {
  const md = createMacroData({ enabled: false });
  const r = await md.load();
  assert.strictEqual(r.available, false);
  assert.match(r.reason, /disabled/);
  assert.strictEqual(r.data, null);
});

test('THE EVENT BLOCK SURVIVES A TOTAL INTEL FAILURE — it reads a local file, not the market', async () => {
  const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  fs.mkdirSync(CAL_TMP, { recursive: true });
  const f = path.join(CAL_TMP, 'macro-calendar.json');
  fs.writeFileSync(f, JSON.stringify({ validThrough: '2099-12-31', blockHoursBefore: 6, blockHoursAfter: 2, events: [{ at: soon, kind: 'cpi', impact: 'high', label: 'US CPI', unverified: false }] }));

  const createIntel = require('../intel');
  // Every price fetch fails: no snapshot, no breadth, no macro. The market pass cannot run at all.
  const intel = createIntel({
    loadCrypto: async () => { throw new Error('exchange unreachable'); },
    ensureCryptoUniverse: async () => [],
    getCRYPTO: () => [{ tk: 'BTC', sym: 'BTCUSDT', name: 'BTC', cls: 'Crypto', src: 'cg' }],
    ticker24: async () => ({}),
    resampleSeries: server.resampleSeries, zigzag: ZZ,
    dir: CAL_TMP, derivsEnabled: false, macroEnabled: false
  });

  const full = await intel.get(true);
  assert.strictEqual(full.ok, false, 'the market pass must genuinely have failed for this test to mean anything');

  const g = await intel.gate();
  assert.strictEqual(g.blockNewLeverage, true, 'the CPI block must survive the market pass failing entirely');
  assert.strictEqual(g.blockLongs, true);
  assert.strictEqual(g.blockShorts, true);
  assert.ok(g.confidenceMultiplier <= 0.4);
  assert.ok(g.reasons.some(r => /US CPI/.test(r)), JSON.stringify(g.reasons));
  assert.ok(g.reasons.some(r => /gating is OFF/.test(r)), 'and it must still say the macro half is unavailable');
  try { fs.rmSync(CAL_TMP, { recursive: true, force: true }); } catch (e) { }
});

test('with no event and no market pass, the gate fails OPEN rather than freezing the platform', async () => {
  const createIntel = require('../intel');
  const empty = path.join(__dirname, '..', '.test-noCal');
  fs.mkdirSync(empty, { recursive: true });
  const intel = createIntel({
    loadCrypto: async () => { throw new Error('unreachable'); },
    ensureCryptoUniverse: async () => [], getCRYPTO: () => [],
    ticker24: async () => ({}), resampleSeries: server.resampleSeries, zigzag: ZZ,
    dir: empty, derivsEnabled: false, macroEnabled: false
  });
  const g = await intel.gate();
  assert.strictEqual(g.blockNewLeverage, false, 'a dead feed must not silently block every trade forever');
  assert.strictEqual(g.confidenceMultiplier, 1);
  assert.ok(g.reasons.length > 0, 'but the loss of protection must always be stated');
  try { fs.rmSync(empty, { recursive: true, force: true }); } catch (e) { }
});

test('position stress is floored at HIGH RISK inside an event window, so the number agrees with the block', async () => {
  const { snap, engines, price } = await riskFixture();
  const calm = { ok: true, configured: true, inWindow: false, hoursToNext: 200, next: null };
  const window_ = { ok: true, configured: true, inWindow: true, message: 'US CPI in 1.0h.', window: { label: 'US CPI', phase: 'before', hoursAway: 1 }, next: null, hoursToNext: 1 };
  const mk = ev => positionRisk({ tk: 'SUI', sym: 'SUIUSDT', side: 1, entry: price * 1.01, lev: 2 }, snap,
    { ...engines, macro: macroEngine(CALM_MACRO(), snap, ev), eventRisk: ev }, { zigzag: ZZ });

  const a = mk(calm), b = mk(window_);
  assert.ok(a.ok && b.ok);
  assert.ok(b.stress >= 60, 'an event window must floor stress at HIGH RISK, got ' + b.stress);
  assert.strictEqual(b.stressFloored, true);
  assert.match(b.statusLabel, /HIGH RISK|CRITICAL/);
  assert.strictEqual(a.stressFloored, false, 'a calm tape must not be floored');
  assert.ok(a.stress < 60 || a.stress >= 60, 'sanity');
});

/* ============================================================
   MACRO ATTRIBUTION — "which factor is moving crypto?"
   ============================================================ */
const { attribution } = require('../intel/attribution');
const { fragility, volumeTrend, momentumDivergence } = require('../intel/fragility');
const IND = server.IND;

/* Build a macro payload whose factor is a deterministic function of BTC's own daily path, so the
   beta is known in advance and attribution can be checked against a right answer. */
async function attribFixture(opts) {
  const o = opts || {};
  const snap = await mkSnap(RISK_OFF, { marketDrift: o.drift == null ? -0.0006 : o.drift });
  const btcMap = require('../intel/macro').coinDailyMap(snap.coins.BTC);
  const dates = Object.keys(btcMap).sort();

  const mkFactor = (name, beta, invert) => {
    // factorReturn = btcReturn / beta  → BTC's beta ON the factor comes back as `beta`.
    const closes = {}; let x = 100;
    closes[dates[0]] = x;
    for (let i = 1; i < dates.length; i++) {
      const br = btcMap[dates[i]] / btcMap[dates[i - 1]] - 1;
      x *= (1 + br / beta);
      closes[dates[i]] = x;
    }
    return { key: name, name, invert: !!invert, group: 'global', why: '', source: 'test', closes, dates: dates.slice(), last: closes[dates[dates.length - 1]], lastDate: dates[dates.length - 1] };
  };
  const series = { DXY: mkFactor('DXY', o.dxyBeta == null ? -0.8 : o.dxyBeta, true), NDX: mkFactor('NDX', o.ndxBeta == null ? 0.9 : o.ndxBeta, false) };
  // An unrelated factor: pure noise, no link to BTC at all.
  const noise = {}; let y = 50; const r = rng(999);
  for (const dte of dates) { y *= (1 + (r() - 0.5) * 0.02); noise[dte] = y; }
  series.GOLD = { key: 'GOLD', name: 'GOLD', invert: false, group: 'global', why: '', source: 'test', closes: noise, dates: dates.slice(), last: y, lastDate: dates[dates.length - 1] };

  return { snap, raw: { available: true, reason: null, asOf: Date.now(), data: { series, failed: [], covered: 3, total: 3 } } };
}

test('attribution recovers a known beta and ranks the dominant driver', async () => {
  const { snap, raw } = await attribFixture({ dxyBeta: -0.8, ndxBeta: 0.9 });
  const a = attribution(raw, snap);
  assert.ok(a.ok, a.reason);
  const dxy = a.drivers.find(x => x.key === 'DXY');
  const ndx = a.drivers.find(x => x.key === 'NDX');
  assert.ok(dxy && ndx, 'both linked factors should appear: ' + JSON.stringify(a.drivers.map(x => x.key)));
  assert.ok(Math.abs(dxy.beta - (-0.8)) < 0.05, 'DXY beta should be ~-0.8, got ' + dxy.beta);
  assert.ok(Math.abs(ndx.beta - 0.9) < 0.05, 'NDX beta should be ~0.9, got ' + ndx.beta);
  assert.ok(a.dominant, 'a dominant driver must be named');
  assert.ok(a.headline.length > 40);
});

test('attribution EXCLUDES a factor with no measurable link rather than attributing through noise', async () => {
  const { snap, raw } = await attribFixture({});
  const a = attribution(raw, snap);
  assert.ok(!a.drivers.some(x => x.key === 'GOLD'), 'an unrelated factor must not be given a contribution');
  const gold = a.unlinked.find(x => x.key === 'GOLD');
  assert.ok(gold, 'it must still be reported, as unlinked');
  assert.match(gold.reason, /no measurable link|aligned days/);
});

test('attribution signs contribution toward CRYPTO — a rising dollar reads as "dragging"', async () => {
  // Falling BTC with a -0.8 beta to DXY ⇒ DXY rose ⇒ its contribution to BTC is negative.
  const { snap, raw } = await attribFixture({ drift: -0.001, dxyBeta: -0.8 });
  const a = attribution(raw, snap);
  const dxy = a.drivers.find(x => x.key === 'DXY');
  assert.ok(dxy, 'DXY should be linked');
  assert.ok(dxy.move > 0, 'the dollar should have risen in this fixture, got ' + dxy.move);
  assert.strictEqual(dxy.direction, 'dragging', 'a rising dollar with a negative beta drags crypto');
  assert.ok(dxy.contribution < 0);
});

test('attribution says so plainly when a move is imported rather than crypto-driven', async () => {
  const { snap, raw } = await attribFixture({ drift: 0.0012, ndxBeta: 1.0 });
  const a = attribution(raw, snap);
  assert.ok(a.material, 'BTC must have moved enough to attribute');
  if (a.externallyDriven) {
    assert.match(a.headline, /imported from outside crypto|accounts for/);
  } else {
    assert.ok(a.headline.length > 20, 'a headline is always produced');
  }
});

test('attribution is unavailable — not fabricated — without macro data', async () => {
  const snap = await mkSnap(RISK_OFF);
  const a = attribution({ available: false, reason: 'geo-blocked' }, snap);
  assert.strictEqual(a.ok, false);
  assert.deepStrictEqual(a.drivers, []);
  assert.strictEqual(a.dominant, null);
  assert.match(a.reason, /geo-blocked/);
});

/* ============================================================
   FRAGILITY — "this rally is not supported"
   ============================================================ */
test('a flat tape is not called fragile — there is no move to judge', async () => {
  const snap = await mkSnap(RISK_OFF.map(s => ({ ...s, drift: 0, idio: 0.0002 })), { marketDrift: 0, marketVol: 0.0005 });
  const f = fragility(snap, { zigzag: ZZ, IND, breadth: breadth(snap, { zigzag: ZZ }) });
  assert.ok(f.ok);
  assert.strictEqual(f.active, false);
  assert.strictEqual(f.direction, 'flat');
  assert.strictEqual(f.score, null, 'no move means no fragility score, not a zero');
});

test('a rally with broad participation and supportive macro scores as WELL SUPPORTED', async () => {
  const specs = flip(RISK_OFF).map(s => ({ ...s, idio: 0.0003, volSpikeAt: 20, volSpike: 1.6 }));
  const snap = await mkSnap(specs, { marketDrift: 0.0012, marketVol: 0.004 });
  const br = breadth(snap, { zigzag: ZZ });
  const macro = macroEngine(CALM_MACRO(), snap, { ok: true, inWindow: false, configured: true });
  const f = fragility(snap, { zigzag: ZZ, IND, breadth: br, macro });
  assert.ok(f.ok && f.active);
  assert.strictEqual(f.direction, 'up');
  assert.ok(f.score < 55, 'a broad, well-backed rally should not read as fragile, got ' + f.score + ' ' + JSON.stringify(f.signals.filter(s => s.fired).map(s => s.k)));
});

test('a rally into DETERIORATING MACRO is flagged as unsupported — the case that wiped the account', async () => {
  const specs = flip(RISK_OFF).map(s => ({ ...s, idio: 0.0003 }));
  const snap = await mkSnap(specs, { marketDrift: 0.0012, marketVol: 0.004 });
  const br = breadth(snap, { zigzag: ZZ });
  // Crypto rallying while the dollar rips, yields jump and VIX explodes.
  const hostile = macroEngine(mkMacro({
    DXY: { start: 100, drift: 0.006, invert: true }, US10Y: { start: 4.2, drift: 0.005, invert: true },
    VIX: { start: 12, drift: 0.03, invert: true }, SPX: { start: 5000, drift: -0.005 }, NDX: { start: 16000, drift: -0.007 }
  }), snap, { ok: true, inWindow: false, configured: true });

  const calm = fragility(snap, { zigzag: ZZ, IND, breadth: br, macro: macroEngine(CALM_MACRO(), snap, { ok: true, inWindow: false }) });
  const bad = fragility(snap, { zigzag: ZZ, IND, breadth: br, macro: hostile });

  assert.ok(bad.score > calm.score, `hostile macro must raise fragility: calm ${calm.score} vs hostile ${bad.score}`);
  const macroLeg = bad.signals.find(s => s.k === 'macro');
  assert.ok(macroLeg && macroLeg.fired, 'the macro leg must be flagged as missing: ' + JSON.stringify(macroLeg));
  assert.match(macroLeg.detail, /pointing against a rally/);
});

test('fragility NEVER predicts a crash — it reports missing supports and says so', async () => {
  const specs = flip(RISK_OFF).map(s => ({ ...s, idio: 0.0003 }));
  const snap = await mkSnap(specs, { marketDrift: 0.0012 });
  const f = fragility(snap, { zigzag: ZZ, IND, breadth: breadth(snap, { zigzag: ZZ }) });
  const text = [f.headline, f.disclaimer, f.repairedBy].concat(f.signals.map(s => s.detail)).join(' ');
  assert.ok(!/will (crash|fall|drop|reverse|dump)|going to (crash|fall|drop)|imminent (crash|reversal)/i.test(text),
    'fragility must never forecast a reversal: ' + text.slice(0, 300));
  assert.match(f.disclaimer, /does NOT predict/);
  assert.ok(f.repairedBy.length > 20, 'it must also say what would repair the move');
});

test('momentum divergence: higher high in price with a lower high in RSI', () => {
  // Two clean pushes; the second goes higher on visibly weaker momentum.
  const cl = [];
  const push = (from, to, steps) => { for (let i = 1; i <= steps; i++) cl.push(from + (to - from) * i / steps); };
  push(100, 100, 30);
  push(100, 130, 20);   // strong first leg
  push(130, 112, 12);   // pullback
  push(112, 134, 40);   // higher high, but grindingly slow → weaker RSI
  push(134, 126, 8);
  const d = momentumDivergence(cl, ZZ, IND, 1);
  assert.ok(d, 'a divergence read should be produced');
  assert.ok(d.priceTo > d.priceFrom, 'fixture must make a higher high');
  assert.strictEqual(d.diverging, true, `expected divergence, rsi ${d.rsiFrom} → ${d.rsiTo}`);
});

test('volume trend detects a fading move', () => {
  const close = new Array(30).fill(100);
  const strong = close.map((_, i) => 1000 + i * 50);      // rising
  const fading = close.map((_, i) => 3000 - i * 80);      // falling
  assert.strictEqual(volumeTrend(close, fading).fading, true);
  assert.strictEqual(volumeTrend(close, strong).fading, false);
  assert.strictEqual(volumeTrend(close, null), null, 'no volume means no claim');
});

test('fragility renormalises over available legs instead of scoring an absent macro as calm', async () => {
  const specs = flip(RISK_OFF).map(s => ({ ...s, idio: 0.0003 }));
  const snap = await mkSnap(specs, { marketDrift: 0.0012 });
  const f = fragility(snap, { zigzag: ZZ, IND, breadth: breadth(snap, { zigzag: ZZ }), macro: { available: false } });
  assert.ok(f.active);
  assert.ok(f.missing.includes('macroAgainstTheMove'), 'an unmeasured macro must be MISSING: ' + JSON.stringify(f.missing));
  assert.ok(f.coverage < 1);
  const macroLeg = f.signals.find(s => s.k === 'macro');
  assert.match(macroLeg.detail, /UNCHECKED/, 'and the gap must be visible on the leg itself');
});

test('an unsupported rally becomes its own regime rather than reading as BROAD RISK-ON', async () => {
  const specs = flip(RISK_OFF).map(s => ({ ...s, idio: 0.0003 }));
  const snap = await mkSnap(specs, { marketDrift: 0.0012 });
  const br = breadth(snap, { zigzag: ZZ });
  const frag = { ok: true, active: true, direction: 'up', score: 72, firedCount: 4, totalSignals: 7,
    signals: [{ k: 'macro', fired: true, detail: 'macro risk appetite -60 — pointing against a rally' }] };
  const r = classify({
    breadth: br, correlation: correlation(snap), transmission: transmission(snap),
    liquidation: { ok: true, cascade: { detected: false }, evidence: [] },
    oi: { available: false }, funding: { available: false }, liquidity: { ok: true, marketVacuum: false },
    recovery: { ok: true, selloff: false, verdict: 'undecided' }, sector: { available: false },
    btcStructure: { ok: false }, macro: { available: false, eventRisk: { ok: true, inWindow: false } }, fragility: frag
  });
  assert.strictEqual(r.regime, 'fragile-rally', 'got ' + r.regime);
  assert.strictEqual(r.label, 'UNSUPPORTED RALLY');
  assert.ok(r.why.some(w => /supports missing/.test(w)));
});

test('the driver and fragility alerts fire with the factor named', () => {
  const base = fakeIntel();
  const withDriver = { ...base,
    attribution: { ok: true, material: true, externallyDriven: true, explainedShare: 0.82,
      headline: 'US Dollar Index is +1.4% over the window. With BTC\'s -0.8 beta to it, that alone accounts for about -1.1% of BTC\'s -1.9%.' },
    fragility: { ok: true, active: false } };
  const a1 = buildAlerts(withDriver, {}, { now: 1000 });
  const drv = a1.alerts.find(a => a.key === 'macro-driver');
  assert.ok(drv, 'a dominant external driver must alert');
  assert.match(drv.text, /Dollar/);

  const withFrag = { ...base, attribution: { ok: false },
    fragility: { ok: true, active: true, direction: 'up', score: 74, firedCount: 4, totalSignals: 7,
      signals: [{ k: 'macro', fired: true, detail: 'macro pointing against a rally' }, { k: 'volume', fired: true, detail: 'volume fading' }],
      disclaimer: 'Fragility does NOT predict a reversal.' } };
  const a2 = buildAlerts(withFrag, {}, { now: 1000 });
  const fr = a2.alerts.find(a => a.key === 'fragile-move');
  assert.ok(fr, 'a fragile move must alert');
  assert.strictEqual(fr.confidence, 74);
  assert.match(fr.text, /does NOT predict/, 'the alert must carry the disclaimer too');
});

test('an UNMEASURED fragility leg is marked unknown, never as a passing support', async () => {
  const specs = flip(RISK_OFF).map(s => ({ ...s, idio: 0.0003 }));
  const snap = await mkSnap(specs, { marketDrift: 0.0012 });
  // No macro, no funding, no OI — three legs cannot be measured at all.
  const f = fragility(snap, { zigzag: ZZ, IND, breadth: breadth(snap, { zigzag: ZZ }), macro: { available: false } });
  const macroLeg = f.signals.find(s => s.k === 'macro');
  assert.strictEqual(macroLeg.state, 'unknown', 'an unavailable macro is UNKNOWN, not OK');
  assert.strictEqual(macroLeg.fired, false);
  assert.ok(f.signals.every(s => ['missing', 'ok', 'unknown'].includes(s.state)), 'every leg carries a tri-state');
  // The critical assertion: nothing that says UNCHECKED may be marked as a confirmed support.
  for (const s of f.signals) {
    if (/UNCHECKED|unavailable|not enough history|no clean pivot pair yet/i.test(s.detail)) {
      assert.strictEqual(s.state, 'unknown', 'leg claims to be unmeasured but is marked ' + s.state + ': ' + s.detail);
    }
  }
  assert.ok(f.uncheckedCount >= 3, 'got ' + f.uncheckedCount);
  assert.match(f.uncheckedNote, /could not be measured/);
  assert.ok(f.measuredCount + f.uncheckedCount === f.totalSignals);
  assert.match(f.headline, /that could be checked/, 'the headline must count measured legs, not all legs');
});

/* ============================================================
   ⚡ MOMENTUM — the vertical moves the regime filter used to hide
   ============================================================ */
const createMomentum = require('../intel/momentum');

/* Replay a price path through the detector as ticker snapshots, one every 10s. */
function replay(mom, path, opts) {
  const o = opts || {};
  const t0 = o.t0 || Date.now() - path.length * 10000;
  let vol = o.vol0 == null ? 100000 : o.vol0;
  path.forEach((px, i) => {
    vol += (o.volPerTick == null ? 50 : (typeof o.volPerTick === 'function' ? o.volPerTick(i) : o.volPerTick));
    mom.record([{ market: 'FOOINR', last_price: px, volume: vol, high: o.high == null ? 110 : o.high, low: o.low == null ? 90 : o.low, change_24_hour: 5 }], t0 + i * 10000);
  });
  return t0 + (path.length - 1) * 10000;
}

/* A flat 12-minute base, then a vertical push in the final minute. */
function verticalPath(baseLen, from, to, pushTicks) {
  const p = new Array(baseLen).fill(from);
  for (let i = 1; i <= pushTicks; i++) p.push(from + (to - from) * i / pushTicks);
  return p;
}

test('momentum needs a buffer before it will say anything', () => {
  const m = createMomentum({ minGapMs: 0 });
  const empty = m.scan({});
  assert.strictEqual(empty.ok, false);
  assert.match(empty.reason, /snapshot/);
  m.record([{ market: 'FOOINR', last_price: 100, volume: 1, high: 110, low: 90 }], 1000);
  m.record([{ market: 'FOOINR', last_price: 101, volume: 2, high: 110, low: 90 }], 2000);
  m.record([{ market: 'FOOINR', last_price: 102, volume: 3, high: 110, low: 90 }], 3000);
  const short = m.scan({ now: 3000 });
  assert.strictEqual(short.ok, false, 'three ticks seconds apart is not five minutes of history');
  assert.match(short.reason, /minutes of ticker history/);
});

test('a vertical move is DETECTED — the case the regime filter used to hide', () => {
  const m = createMomentum({ minGapMs: 0 });
  const now = replay(m, verticalPath(80, 100, 106, 6), { volPerTick: i => i > 78 ? 5000 : 50 });
  const r = m.scan({ now });
  assert.ok(r.ok, r.reason);
  const foo = r.movers.find(x => x.base === 'FOO');
  assert.ok(foo, 'the vertical must be picked up: ' + JSON.stringify(r.movers.map(x => x.base)));
  assert.strictEqual(foo.direction, 'up');
  assert.ok(foo.chg5m > 0.03, 'got ' + foo.chg5m);
  assert.ok(foo.z > 2.5, 'must be large relative to the coin\'s own range, got z=' + foo.z);
});

test('a slow drift of the same size is NOT called momentum', () => {
  const m = createMomentum({ minGapMs: 0 });
  // Same +6%, but spread over two hours instead of one minute.
  const path = []; for (let i = 0; i < 720; i++) path.push(100 * (1 + 0.06 * i / 719));
  const now = replay(m, path, { volPerTick: 50 });
  const r = m.scan({ now });
  assert.ok(r.ok);
  assert.strictEqual(r.movers.length, 0, 'a gentle drift must not register as a vertical: ' + JSON.stringify(r.movers));
});

test('the threshold scales to the coin — a wide-range coin needs a bigger move', () => {
  const tight = createMomentum({ minGapMs: 0 });
  const wide = createMomentum({ minGapMs: 0 });
  const path = verticalPath(80, 100, 102, 6);          // +2%
  const nowT = replay(tight, path, { high: 101, low: 99 });     // 2% daily range → 2% in 5m is enormous
  const nowW = replay(wide, path, { high: 200, low: 50 });      // 150% daily range → 2% is nothing
  const rt = tight.scan({ now: nowT }), rw = wide.scan({ now: nowW });
  assert.ok(rt.movers.length === 1, 'the quiet coin must flag');
  assert.strictEqual(rw.movers.length, 0, 'the same % on a wildly volatile coin must not');
});

test('STAGE: a move caught at the start is igniting, one caught late is extended', () => {
  const early = createMomentum({ minGapMs: 0 });
  const nowE = replay(early, verticalPath(80, 100, 104, 4), { volPerTick: 50 });
  const e = early.scan({ now: nowE }).movers[0];
  assert.ok(e, 'early move must be detected');
  assert.strictEqual(e.stage, 'igniting', 'got ' + e.stage + ' lastMinShare=' + e.lastMinShare);
  assert.strictEqual(e.warning, null, 'an igniting move carries no lateness warning');

  // A 45% run that finished several minutes ago, now drifting — the chart the user sent.
  const late = createMomentum({ minGapMs: 0 });
  const path = new Array(30).fill(100);
  for (let i = 1; i <= 30; i++) path.push(100 + 45 * i / 30);   // the vertical
  for (let i = 0; i < 24; i++) path.push(145 + i * 0.02);       // then flat drift for 4 minutes
  const nowL = replay(late, path, { high: 150, low: 95 });
  const l = late.scan({ now: nowL }).movers[0];
  if (l) {
    assert.ok(['extended', 'stalling'].includes(l.stage), 'a finished 45% run must not read as igniting, got ' + l.stage);
    assert.ok(l.warning, 'it must carry a lateness warning');
    assert.match(l.warning, /already|Entering here|liquidated|has already happened/i);
  }
});

test('an EXTENDED move is never presented as a clean entry', () => {
  const m = createMomentum({ minGapMs: 0 });
  const path = new Array(30).fill(100);
  for (let i = 1; i <= 40; i++) path.push(100 + 40 * i / 40);
  const now = replay(m, path, { high: 145, low: 95 });
  const r = m.scan({ now });
  for (const mv of r.movers) {
    if (mv.stage === 'extended' || mv.stage === 'stalling') {
      assert.ok(mv.warning && mv.warning.length > 30, 'extended rows must warn: ' + JSON.stringify(mv));
      assert.ok(mv.lateness > 0, 'lateness must be reported');
    }
  }
  // Nothing in the payload should read as a trade instruction.
  const blob = JSON.stringify(r);
  assert.ok(!/"entry"|"stop"|"target"|buy now|BUY NOW/i.test(blob), 'momentum rows must not carry a setup');
  assert.match(r.caveat, /not an entry signal/);
});

test('momentum reports downside verticals too', () => {
  const m = createMomentum({ minGapMs: 0 });
  const now = replay(m, verticalPath(80, 100, 94, 6), { volPerTick: 50 });
  const r = m.scan({ now });
  const foo = r.movers.find(x => x.base === 'FOO');
  assert.ok(foo, 'a vertical drop must register as well as a rally');
  assert.strictEqual(foo.direction, 'down');
  assert.ok(foo.chg5m < 0);
});

test('stablecoins and a rolling volume window are handled without producing junk', () => {
  const m = createMomentum({ minGapMs: 0 });
  const t0 = Date.now() - 800000;
  for (let i = 0; i < 80; i++) {
    m.record([
      { market: 'USDCINR', last_price: 88 + i * 0.05, volume: 100 + i, high: 95, low: 85 },
      // Volume going DOWN — the 24h window rolling. Must not become a negative surge.
      { market: 'BARINR', last_price: 100 + i * 0.09, volume: 5000 - i * 10, high: 110, low: 90 }
    ], t0 + i * 10000);
  }
  const r = m.scan({ now: t0 + 79 * 10000, isStable: b => b === 'USDC' });
  assert.ok(r.ok);
  assert.ok(!r.movers.some(x => x.base === 'USDC'), 'stablecoins must be excluded');
  for (const mv of r.movers) {
    assert.ok(mv.surge == null || mv.surge >= 0, 'a rolling volume window must never yield a negative surge');
  }
});

test('the buffer downsamples and expires so it cannot grow without bound', () => {
  const m = createMomentum({ keepMs: 60000, minGapMs: 8000 });
  const t0 = Date.now() - 300000;
  for (let i = 0; i < 300; i++) m.record([{ market: 'FOOINR', last_price: 100, volume: i, high: 110, low: 90 }], t0 + i * 1000);
  const st = m.stats();
  assert.ok(st.snapshots <= 10, 'a 60s window at one per 8s should hold ~8 snapshots, got ' + st.snapshots);
  assert.ok(st.seen < 300, 'most 1s-apart records must have been downsampled away, kept ' + st.seen);
});

/* ============================================================
   🚀 BREAKOUT MODE — the setups Quick Trades always filtered out

   These execute the REAL browser function out of index.html in a vm sandbox, the same technique
   the rate/stale guards use. Re-implementing the rule here would test a copy and let the shipped
   one drift, which is the bug class this codebase keeps paying for.
   ============================================================ */
const vm = require('node:vm');

function breakoutSandbox() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const from = html.indexOf('const BREAKOUT_REGIMES');
  /* Bound on the next top-level declaration AFTER the guard, not on the panel's section header —
     that header sits above `quickState` and therefore above this block, so searching for it found
     an offset earlier in the file and sliced nothing. */
  const to = html.indexOf('let quickTimer', from);
  assert.ok(from > 0, 'breakout guard block not found in index.html');
  assert.ok(to > from, 'could not bound the breakout guard block');
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(html.slice(from, to), ctx);
  return ctx;
}

/* A breakout that should pass every guard. */
function goodBreak(over) {
  return Object.assign({
    sig: { price: 100 },
    vol: { hot: true, score: 70 },
    action: { kind: 'buybreak' },
    setup: { regime: 'breakout', dir: 1, entryLo: 99.5, entryHi: 101.5, stop: 97,
      riskPct: 3, targets: [104, 107, 110], ret: [4, 7, 10], rrr: 1.6 }
  }, over || {});
}

test('breakout guard: a clean, volume-backed break passes', () => {
  const ctx = breakoutSandbox();
  const r = ctx.breakoutEligible(goodBreak(), { roundTripPct: 1.2 });
  assert.strictEqual(r.ok, true, r.why);
});

test('breakout guard: a break with NO VOLUME is rejected — that is the fakeout', () => {
  const ctx = breakoutSandbox();
  const r = ctx.breakoutEligible(goodBreak({ vol: { hot: false, score: 10 } }), { roundTripPct: 1.2 });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /volume/i);
  const none = ctx.breakoutEligible(goodBreak({ vol: null }), { roundTripPct: 1.2 });
  assert.strictEqual(none.ok, false, 'a missing volume reading must not pass either');
});

test('breakout guard: price already past the entry band is rejected, not chased', () => {
  const ctx = breakoutSandbox();
  const gone = ctx.breakoutEligible(goodBreak({ sig: { price: 106 } }), { roundTripPct: 1.2 });
  assert.strictEqual(gone.ok, false);
  assert.match(gone.why, /already left the entry band/);
  // The short mirror.
  const shortGone = ctx.breakoutEligible(goodBreak({
    sig: { price: 94 }, action: { kind: 'sellbreak' },
    setup: { regime: 'breakout', dir: -1, entryLo: 98.5, entryHi: 100.5, stop: 103, riskPct: 3, targets: [96, 93, 90], ret: [-4, -7, -10], rrr: 1.6 }
  }), { roundTripPct: 1.2 });
  assert.strictEqual(shortGone.ok, false);
  assert.match(shortGone.why, /already left the entry band/);
});

test('breakout guard: a stop too wide to size on leverage is rejected', () => {
  const ctx = breakoutSandbox();
  const wide = ctx.breakoutEligible(goodBreak({
    setup: { regime: 'breakout', dir: 1, entryLo: 99.5, entryHi: 101.5, stop: 88, riskPct: 12, targets: [104, 107, 110], ret: [4, 7, 10], rrr: 1.6 }
  }), { roundTripPct: 1.2 });
  assert.strictEqual(wide.ok, false);
  assert.match(wide.why, /too wide to size on leverage/);
});

test('breakout guard: the round-trip cost gate applies here too', () => {
  const ctx = breakoutSandbox();
  // 1.5% target against 1.2% friction — nowhere near the 1.5x margin the paper bot demands.
  const thin = ctx.breakoutEligible(goodBreak({
    setup: { regime: 'breakout', dir: 1, entryLo: 99.5, entryHi: 101.5, stop: 99, riskPct: 1, targets: [101.5, 103, 105], ret: [1.5, 3, 5], rrr: 1.5 }
  }), { roundTripPct: 1.2 });
  assert.strictEqual(thin.ok, false);
  assert.match(thin.why, /round trip/);
});

test('breakout guard: pullback entries stay in the scalp list', () => {
  const ctx = breakoutSandbox();
  for (const kind of ['waitdip', 'waitbounce']) {
    const r = ctx.breakoutEligible(goodBreak({ action: { kind } }), { roundTripPct: 1.2 });
    assert.strictEqual(r.ok, false, kind + ' must not appear in the breakout list');
    assert.match(r.why, /pullback entries stay/);
  }
});

test('breakout guard: only breakout/trend regimes qualify', () => {
  const ctx = breakoutSandbox();
  for (const regime of ['range', 'correction', 'dumpbounce']) {
    const r = ctx.breakoutEligible(goodBreak({ setup: Object.assign(goodBreak().setup, { regime }) }), { roundTripPct: 1.2 });
    assert.strictEqual(r.ok, false, regime + ' is not a breakout');
  }
  const trend = ctx.breakoutEligible(goodBreak({ setup: Object.assign(goodBreak().setup, { regime: 'trend' }) }), { roundTripPct: 1.2 });
  assert.strictEqual(trend.ok, true, 'trend setups belong in the breakout list');
});

test('breakout guard: a poor reward:risk is rejected', () => {
  const ctx = breakoutSandbox();
  const r = ctx.breakoutEligible(goodBreak({
    setup: { regime: 'breakout', dir: 1, entryLo: 99.5, entryHi: 101.5, stop: 96, riskPct: 4, targets: [104, 106, 108], ret: [4, 6, 8], rrr: 0.9 }
  }), { roundTripPct: 1.2 });
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /reward:risk/);
});

test('breakout guard: every rejection carries a reason the panel can show', () => {
  const ctx = breakoutSandbox();
  const cases = [
    goodBreak({ vol: { hot: false } }),
    goodBreak({ sig: { price: 200 } }),
    goodBreak({ action: { kind: 'waitdip' } }),
    goodBreak({ setup: Object.assign(goodBreak().setup, { regime: 'range' }) }),
    { sig: { price: 1 } }
  ];
  for (const c of cases) {
    const r = ctx.breakoutEligible(c, { roundTripPct: 1.2 });
    assert.strictEqual(r.ok, false);
    assert.ok(typeof r.why === 'string' && r.why.length > 5, 'rejection must be explainable: ' + JSON.stringify(r));
  }
});

test('THE FRICTION NUMBER HAS ONE OWNER — server and paper bot cannot drift', () => {
  // The breakout gate reads this from the scan payload rather than hard-coding a second copy.
  assert.strictEqual(server.TRADE_COST.feeBps, 50);
  assert.strictEqual(server.TRADE_COST.slipBps, 10);
  assert.ok(Math.abs(server.roundTripPct() - 1.2) < 1e-9);

  // paper.js must agree, or the bot and the panel would gate on different numbers.
  const paperSrc = fs.readFileSync(path.join(__dirname, '..', 'paper.js'), 'utf8');
  const fee = paperSrc.match(/feeBps\s*:\s*(\d+)/), slip = paperSrc.match(/slipBps\s*:\s*(\d+)/);
  assert.ok(fee && slip, 'paper.js must declare feeBps/slipBps defaults');
  assert.strictEqual(+fee[1], server.TRADE_COST.feeBps, 'paper.js feeBps has drifted from server TRADE_COST');
  assert.strictEqual(+slip[1], server.TRADE_COST.slipBps, 'paper.js slipBps has drifted from server TRADE_COST');
});

test('the scan payload ships the cost so the browser never hard-codes it', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(/d\.costs\s*&&\s*d\.costs\.roundTripPct/.test(html),
    'the breakout list must read the round trip from the scan payload');
});

/* ============================================================
   TICKER FEED HEALTH — the "prices are lagging" bug class

   The USDT rate freezing and every crypto price drifting with it has now been reported several
   times across this project's life, and each time the mechanism was the same: a ticker request
   failed, every caller swallowed the error, `cdxTicker` silently stopped advancing, and nothing
   on screen said so. These tests make the failure impossible to hide.
   ============================================================ */

test('the ticker is SINGLE-FLIGHT — concurrent callers share one request', async () => {
  /* Roughly eight callers can want the ticker at the same instant. Without this, concurrency
     multiplied the request rate against a public endpoint that rate-limits, and getting
     rate-limited is exactly how the rate freezes. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /let cdxInflight\s*=\s*null/, 'ticker must hold an in-flight promise');
  assert.match(src, /if\(cdxInflight\)return cdxInflight/, 'concurrent callers must share it');
  assert.match(src, /finally\s*\{\s*cdxInflight\s*=\s*null/, 'the in-flight slot must always clear');
});

test('ticker failures are COUNTED, never swallowed into silence', () => {
  const h = server.cdxHealth();
  assert.ok(h && typeof h.consecutive === 'number', 'health must expose a consecutive failure count');
  assert.ok('total' in h && 'last' in h && 'ageMs' in h, 'health must carry total, last error and reading age');

  const err = server.__cdxErr();
  assert.strictEqual(err.consecutive, 0, 'clean start');
  // Simulate a run of failures the way a rate limit would produce them.
  err.consecutive = 3; err.total = 3; err.last = 'HTTP 429'; err.lastAt = Date.now();
  const bad = server.cdxHealth();
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.consecutive, 3);
  assert.match(bad.last, /429/);
  err.consecutive = 0; err.total = 0; err.last = null; err.lastAt = 0;   // restore
});

test('a failing feed rides along with every rate-bearing payload', () => {
  const err = server.__cdxErr();
  const clean = server.withLiveRate({ x: 1 });
  assert.strictEqual(clean.feedErr, null, 'a healthy feed adds nothing to the payload');

  err.consecutive = 2; err.total = 2; err.last = 'HTTP 429'; err.lastAt = Date.now();
  const bad = server.withLiveRate({ x: 1 });
  assert.ok(bad.feedErr, 'a failing feed must be reported on every payload that carries a rate');
  assert.strictEqual(bad.feedErr.consecutive, 2);
  assert.match(bad.feedErr.last, /429/);
  err.consecutive = 0; err.total = 0; err.last = null; err.lastAt = 0;
});

test('THE REQUEST RATE STAYS BOUNDED — this regression froze the rate once already', () => {
  /* A 10s keepalive plus a 4s freshness window on a 15s-polled endpoint roughly doubled ticker
     traffic, and the momentum buffer discarded most of it on arrival because it ignores samples
     closer together than its 8s minimum gap. Pin the cadences so the same well-meaning change
     cannot be made again without this failing. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  const keep = src.match(/setInterval\([^;]*?ensureCdxFresh\(\d+\)[\s\S]*?,\s*(\d+)\s*\)\s*;/);
  assert.ok(keep, 'keepalive interval not found');
  assert.ok(+keep[1] >= 20000, `keepalive fires every ${keep[1]}ms — too often against a rate-limited endpoint`);

  // No caller may demand a freshness window tighter than the momentum buffer's own minimum gap:
  // anything tighter buys no resolution and only costs requests.
  const minGap = require('../intel/momentum').MIN_GAP_MS || 8000;
  for (const m of src.matchAll(/ensureCdxFresh\((\d+)\)/g)) {
    assert.ok(+m[1] >= minGap, `ensureCdxFresh(${m[1]}) is tighter than the ${minGap}ms buffer gap — the extra requests are discarded on arrival`);
  }
});

test('the page reports the WORSE of browser and server staleness', () => {
  /* A rate-limited exchange still returns a healthy 200 full of stale prices, so the browser's own
     poll clock reads fine while the price behind it is minutes old. Showing only the browser's age
     is what let this hide. */
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /const worst\s*=\s*Math\.max\(age,\s*srvAge\)/, 'the age line must show the worse of the two');
  assert.match(html, /feedErr/, 'the age line must be able to name an exchange failure');
  assert.match(html, /FROZEN at the last good reading/, 'a frozen price must say so in plain words');
  assert.match(html, /function noteFeed/, 'every payload must feed the server-staleness reading');
});

test('/api/feed exists so the feed can be checked directly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /p==="\/api\/feed"/, 'a direct feed-health endpoint must exist');
  assert.match(src, /coindcx:cdxHealth\(\)/);
});
