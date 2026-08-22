/* ============================================================
   INTEL — HISTORY STORE + SIGNAL BACKTESTER

   Every threshold in this module — cascade at 55, stress at 80, correlation spike at 0.25 — is
   currently a JUDGEMENT, not a measurement. That is the honest starting position, and it is the
   thing this file exists to fix.

   Each snapshot is appended to a JSONL file with the market state AND the prices needed to score
   it later. Once enough of them accumulate, the backtester can answer the questions the brief
   asks directly from recorded evidence:

     "When market stress > 80, what happened over the next 15m / 1h / 4h?"
     "When cascade confidence > 70%, how often did the market recover?"
     "When OI fell sharply while price fell, what happened next?"

   UNTIL THERE IS A SAMPLE, IT SAYS SO. The backtester returns `insufficient` with the count it
   actually has rather than a percentage computed from four observations. A win rate over six
   samples is not a base rate; presenting one as though it were is how a plausible number ends up
   sizing a real position.

   WHY JSONL AND NOT A DATABASE: this platform is deliberately zero-dependency, and the container
   is rebuilt on every deploy. An append-only text file survives restarts, needs no driver, and
   can be inspected with a text editor. The cost is that history starts empty after a redeploy of
   an ephemeral host — which is stated in the response rather than hidden.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const S = require('./stats');

const MAX_LINES = 20000;             // ~2 weeks at one snapshot per minute; trimmed from the front
const TRACK_COINS = 12;              // prices stored per snapshot, for forward-return scoring
const HORIZONS = { '15m': 15, '1h': 60, '4h': 240 };
const TOLERANCE = 0.35;              // a snapshot within ±35% of the target horizon can score it
const MIN_SAMPLE = 20;               // below this the backtester reports insufficient, not a rate

module.exports = function createHistory(opts) {
  const o = opts || {};
  const FILE = path.join(o.dir || __dirname, 'intel-history.jsonl');
  let lines = null;                  // lazy-loaded cache of parsed rows
  let writeFails = 0;

  function load() {
    if (lines) return lines;
    try {
      const raw = fs.readFileSync(FILE, 'utf8');
      lines = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    } catch (e) { lines = []; }
    return lines;
  }

  /* One compact row per snapshot. Deliberately small: the whole point is that months of these
     stay readable and cheap. Prices are kept for the top coins so forward returns can be scored
     against whichever coins both snapshots share. */
  function record(intel) {
    if (!intel || !intel.ok) return false;
    const px = {};
    const coins = (intel.__prices || {});
    let n = 0;
    for (const tk of Object.keys(coins)) { if (n >= TRACK_COINS) break; if (coins[tk] > 0) { px[tk] = +(+coins[tk]).toPrecision(8); n++; } }

    const row = {
      ts: intel.ts,
      regime: intel.regime && intel.regime.regime,
      breadth: intel.breadth && intel.breadth.ok ? intel.breadth.score : null,
      stress: intel.breadth && intel.breadth.ok ? intel.breadth.altStress : null,
      cascade: intel.liquidation && intel.liquidation.ok ? intel.liquidation.cascade.confidence : null,
      cascadeSide: intel.liquidation && intel.liquidation.ok ? intel.liquidation.cascade.side : null,
      cascadeMode: intel.liquidation && intel.liquidation.ok ? intel.liquidation.mode : null,
      corr: intel.correlation && intel.correlation.ok ? intel.correlation.avgCorrBtc : null,
      oi: intel.oi && intel.oi.available ? intel.oi.market.oiChange : null,
      funding: intel.funding && intel.funding.available ? intel.funding.medianRate : null,
      vacuum: intel.liquidity && intel.liquidity.ok ? !!intel.liquidity.marketVacuum : null,
      recovery: intel.recovery && intel.recovery.ok ? intel.recovery.recoveryProb : null,
      px
    };
    const arr = load();
    arr.push(row);
    if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES);
    try {
      // Rewrite wholesale when trimming, append otherwise — appends are the common path.
      if (arr.length >= MAX_LINES) fs.writeFileSync(FILE, arr.map(r => JSON.stringify(r)).join('\n') + '\n');
      else fs.appendFileSync(FILE, JSON.stringify(row) + '\n');
      writeFails = 0;
      return true;
    } catch (e) { writeFails++; return false; }
  }

  /* Forward return between two snapshots, averaged over the coins BOTH of them priced.
     Averaging over the intersection is what makes this robust to the universe rotating — a coin
     that dropped out of the top 40 simply does not vote. */
  function forwardReturn(a, b) {
    const keys = Object.keys(a.px || {}).filter(k => b.px && b.px[k] > 0 && a.px[k] > 0);
    if (!keys.length) return null;
    const rets = keys.map(k => b.px[k] / a.px[k] - 1);
    return { basket: S.mean(rets), btc: (a.px.BTC > 0 && b.px.BTC > 0) ? b.px.BTC / a.px.BTC - 1 : null, coins: keys.length };
  }

  function findForward(arr, i, mins) {
    const target = arr[i].ts + mins * 60000;
    const lo = arr[i].ts + mins * 60000 * (1 - TOLERANCE);
    const hi = arr[i].ts + mins * 60000 * (1 + TOLERANCE);
    let best = null, bestGap = Infinity;
    for (let j = i + 1; j < arr.length; j++) {
      const t = arr[j].ts;
      if (t < lo) continue;
      if (t > hi) break;
      const gap = Math.abs(t - target);
      if (gap < bestGap) { best = arr[j]; bestGap = gap; }
    }
    return best;
  }

  /* Run one condition over the whole store. `test` is a predicate on a row. */
  function backtest(name, test, opts2) {
    const arr = load();
    const o2 = opts2 || {};
    if (!arr.length) {
      return { ok: false, name, insufficient: true, samples: 0, snapshots: 0,
        reason: 'No history recorded yet. The store begins filling once the intel loop runs, and resets if the host is redeployed with ephemeral storage.' };
    }
    const matches = [];
    for (let i = 0; i < arr.length; i++) {
      let hit = false;
      try { hit = !!test(arr[i]); } catch (e) { hit = false; }
      if (!hit) continue;
      const row = { ts: arr[i].ts, regime: arr[i].regime, forward: {} };
      for (const h of Object.keys(HORIZONS)) {
        const fwd = findForward(arr, i, HORIZONS[h]);
        if (fwd) row.forward[h] = forwardReturn(arr[i], fwd);
      }
      if (Object.keys(row.forward).length) matches.push(row);
    }

    const horizons = {};
    for (const h of Object.keys(HORIZONS)) {
      const vals = matches.map(m => m.forward[h] && m.forward[h].basket).filter(S.isNum);
      const btcVals = matches.map(m => m.forward[h] && m.forward[h].btc).filter(S.isNum);
      horizons[h] = vals.length ? {
        samples: vals.length,
        sufficient: vals.length >= (o2.minSample || MIN_SAMPLE),
        meanReturn: S.mean(vals),
        medianReturn: S.median(vals),
        pctPositive: vals.filter(v => v > 0).length / vals.length * 100,
        btcMeanReturn: btcVals.length ? S.mean(btcVals) : null,
        worst: Math.min(...vals), best: Math.max(...vals)
      } : { samples: 0, sufficient: false };
    }

    const total = Math.max(...Object.values(horizons).map(h => h.samples || 0));
    return {
      ok: true, name,
      snapshots: arr.length,
      spanHours: arr.length > 1 ? (arr[arr.length - 1].ts - arr[0].ts) / 3600000 : 0,
      samples: matches.length,
      insufficient: total < (o2.minSample || MIN_SAMPLE),
      minSample: o2.minSample || MIN_SAMPLE,
      horizons,
      note: total < (o2.minSample || MIN_SAMPLE)
        ? `Only ${total} scored occurrence(s). Below ${o2.minSample || MIN_SAMPLE} this is not a base rate and no percentage should be acted on.`
        : null,
      recent: matches.slice(-5)
    };
  }

  /* The three questions the brief names, plus the thresholds they use. */
  const SIGNALS = {
    'high-stress': { label: 'Altcoin stress above 80', test: r => S.isNum(r.stress) && r.stress > 80 },
    'cascade-70': { label: 'Liquidation cascade confidence above 70%', test: r => S.isNum(r.cascade) && r.cascade > 70 },
    'oi-price-down': { label: 'Open interest falling while price fell', test: r => S.isNum(r.oi) && r.oi < -0.01 && S.isNum(r.breadth) && r.breadth < -20 },
    'correlation-spike': { label: 'Altcoin/BTC correlation above 0.8', test: r => S.isNum(r.corr) && r.corr > 0.8 },
    'liquidity-vacuum': { label: 'Market-wide liquidity vacuum flagged', test: r => r.vacuum === true },
    'extreme-risk-off': { label: 'Breadth below -60', test: r => S.isNum(r.breadth) && r.breadth < -60 }
  };

  function runAll(opts2) {
    const out = {};
    for (const k of Object.keys(SIGNALS)) out[k] = { ...backtest(k, SIGNALS[k].test, opts2), label: SIGNALS[k].label };
    return out;
  }

  function stats() {
    const arr = load();
    return {
      snapshots: arr.length,
      first: arr.length ? arr[0].ts : null,
      last: arr.length ? arr[arr.length - 1].ts : null,
      spanHours: arr.length > 1 ? (arr[arr.length - 1].ts - arr[0].ts) / 3600000 : 0,
      file: FILE, writeFails, maxLines: MAX_LINES, minSample: MIN_SAMPLE
    };
  }

  function recent(limit) {
    const arr = load();
    return arr.slice(Math.max(0, arr.length - (limit || 100)));
  }

  return { record, backtest, runAll, stats, recent, SIGNALS, HORIZONS, __reset: () => { lines = []; try { fs.unlinkSync(FILE); } catch (e) { } } };
};

module.exports.MIN_SAMPLE = MIN_SAMPLE;
module.exports.HORIZONS = HORIZONS;
