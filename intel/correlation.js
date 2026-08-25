/* ============================================================
   INTEL — CORRELATION ENGINE

   The question this answers is not "are these two coins related" — over any long window in crypto
   they all are. It is "is the market currently trading as FORTY assets or as ONE?", because those
   two markets need completely different position sizing. A book of eight uncorrelated alt longs
   is diversified; the same book at correlation 0.9 is one position at 8x size, and the trader
   usually cannot see the difference until the margin call.

   MEASURED ON RETURNS, NEVER PRICES (see stats.js for why that distinction is load-bearing).

   TREND AND SPIKE WITHOUT A DATABASE: correlation "rising" is detected by splitting the window
   in half and comparing the recent half to the earlier one. That is self-contained — it needs no
   stored history, so it works on the very first call after a deploy, when a history-based
   z-score would have nothing to compare against and would have to return null exactly when a
   cascade is most likely to be underway.
   ============================================================ */

const S = require('./stats');

const MIN_HALF = 8;                  // samples per half-window before a trend claim is allowed
const SPIKE_JUMP = 0.25;             // rise in correlation between halves that counts as a spike
const SPIKE_LEVEL = 0.70;            // …and the level it must reach, so 0.1→0.35 is not a "spike"
const HIGH_CORR = 0.75;
const DECOUPLE_CORR = 0.35;
const SYNC_SELL_PCT = 80;            // the brief's threshold: 80%+ of alts down with BTC down
const FOCUS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'SUI', 'APT'];
const MATRIX_CAP = 12;

/* Volume-weighted basket return series for a window — "the market" as one synthetic asset.
   Weighted by traded value so a micro-cap's 20% candle does not outvote BTC. */
function basketReturns(snap, tks, winKey) {
  const rows = tks.map(tk => ({ w: +snap.coins[tk].qv || 0, r: (snap.coins[tk].win[winKey] || {}).ret || [] }))
    .filter(x => x.r.length);
  if (!rows.length) return [];
  const n = Math.min(...rows.map(x => x.r.length));
  const out = [];
  for (let i = 0; i < n; i++) {
    // Index from the END so series of unequal length stay aligned on the most recent bar.
    const vals = rows.map(x => x.r[x.r.length - n + i]);
    const ws = rows.map(x => x.w);
    out.push(S.weightedMean(vals, ws));
  }
  return out;
}

function corrHalves(a, b) {
  const p = S.pairFinite(a, b);
  if (p.x.length < MIN_HALF * 2) return { full: S.pearson(a, b), prior: null, recent: null };
  const mid = Math.floor(p.x.length / 2);
  return {
    full: S.pearson(p.x, p.y),
    prior: S.pearson(p.x.slice(0, mid), p.y.slice(0, mid), MIN_HALF),
    recent: S.pearson(p.x.slice(mid), p.y.slice(mid), MIN_HALF)
  };
}

function correlation(snap, ctx) {
  const tks = (snap && snap.tickers) || [];
  if (tks.length < 5 || !snap.coins.BTC) {
    return { ok: false, reason: !snap || !snap.coins || !snap.coins.BTC ? 'BTC series unavailable — every correlation here is measured against it' : `only ${tks.length} coins loaded`, windows: {} };
  }
  const alts = snap.alts || [];
  const windows = {};

  for (const wk of (snap.windows || [])) {
    const btcRet = (snap.coins.BTC.win[wk] || {}).ret;
    const ethRet = snap.coins.ETH ? (snap.coins.ETH.win[wk] || {}).ret : null;
    if (!btcRet || btcRet.length < MIN_HALF) { windows[wk] = { ok: false, reason: 'insufficient BTC samples' }; continue; }
    const basket = basketReturns(snap, tks, wk);

    const per = {};
    for (const tk of tks) {
      const r = (snap.coins[tk].win[wk] || {}).ret;
      if (!r || !r.length) continue;
      const h = corrHalves(r, btcRet);
      per[tk] = {
        btc: h.full,
        btcPrior: h.prior, btcRecent: h.recent,
        eth: ethRet ? S.pearson(r, ethRet) : null,
        market: basket.length ? S.pearson(r, basket) : null
      };
    }

    const altCorrs = alts.map(tk => per[tk] && per[tk].btc).filter(S.isNum);
    const avgCorrBtc = S.mean(altCorrs);
    const priorVals = alts.map(tk => per[tk] && per[tk].btcPrior).filter(S.isNum);
    const recentVals = alts.map(tk => per[tk] && per[tk].btcRecent).filter(S.isNum);
    const priorAvg = S.mean(priorVals), recentAvg = S.mean(recentVals);
    const delta = (S.isNum(priorAvg) && S.isNum(recentAvg)) ? recentAvg - priorAvg : null;

    windows[wk] = {
      ok: true,
      n: btcRet.length,
      avgCorrBtc,
      priorAvgCorrBtc: priorAvg,
      recentAvgCorrBtc: recentAvg,
      delta,
      trend: !S.isNum(delta) ? 'unknown' : delta >= 0.12 ? 'rising' : delta <= -0.12 ? 'falling' : 'stable',
      spike: S.isNum(delta) && S.isNum(recentAvg) && delta >= SPIKE_JUMP && recentAvg >= SPIKE_LEVEL,
      per
    };
  }

  /* The headline read is the 1h window — long enough to be stable, short enough to reflect what
     is happening now. Falls through to whatever window did compute if 1h did not. */
  const head = windows['1h'] && windows['1h'].ok ? windows['1h']
    : Object.values(windows).find(w => w && w.ok) || null;

  /* ---- SYNCHRONISED MARKET SELLING ----
     Exactly the brief's rule: BTC down, and 80%+ of tracked alts down with it. Deliberately
     measured on plain 4h returns rather than on correlation, because correlation says the market
     is moving TOGETHER and says nothing about which way. Both facts are needed. */
  const btcRet4h = S.retOver(snap.coins.BTC.fine && snap.coins.BTC.fine.close, 16);
  const altRets = alts.map(tk => S.retOver(snap.coins[tk].fine && snap.coins[tk].fine.close, 16)).filter(S.isNum);
  const downCount = altRets.filter(r => r < 0).length;
  const pctAltsDown = altRets.length ? downCount / altRets.length * 100 : null;
  const sync = {
    flag: S.isNum(btcRet4h) && btcRet4h < 0 && S.isNum(pctAltsDown) && pctAltsDown >= SYNC_SELL_PCT,
    pctAltsDown, btcRet4h, sample: altRets.length,
    threshold: SYNC_SELL_PCT
  };

  /* ---- DECOUPLING ----
     A coin whose correlation to BTC has fallen well below the crowd's while the crowd is tightly
     packed. Direction comes from its own return: down while the market is up is bearish
     decoupling and is the more actionable of the two. */
  const decoupled = [];
  if (head && head.ok && S.isNum(head.avgCorrBtc)) {
    for (const tk of alts) {
      const cb = head.per[tk] && head.per[tk].btc;
      if (!S.isNum(cb)) continue;
      if (cb < DECOUPLE_CORR && head.avgCorrBtc - cb > 0.25) {
        const r = S.retOver(snap.coins[tk].fine && snap.coins[tk].fine.close, 16);
        decoupled.push({ tk, corr: +cb.toFixed(2), ret4h: r, dir: S.isNum(r) ? (r > 0 ? 'bullish' : 'bearish') : null });
      }
    }
    decoupled.sort((a, b) => a.corr - b.corr);
  }

  /* ---- FOCUS MATRIX ----
     Full pairwise correlations, but only across a bounded set — the named majors plus the
     biggest by traded value. A 40x40 matrix across four windows is 6,400 numbers nobody reads
     and a payload that would dominate the response. */
  const byVol = tks.slice().sort((a, b) => (+snap.coins[b].qv || 0) - (+snap.coins[a].qv || 0));
  const focusSet = [];
  for (const tk of FOCUS) if (snap.coins[tk] && !focusSet.includes(tk)) focusSet.push(tk);
  for (const tk of byVol) { if (focusSet.length >= MATRIX_CAP) break; if (!focusSet.includes(tk)) focusSet.push(tk); }
  const matrix = {};
  const mwk = head === windows['1h'] ? '1h' : Object.keys(windows).find(k => windows[k] === head);
  if (mwk) {
    for (const a of focusSet) {
      const ra = (snap.coins[a].win[mwk] || {}).ret; if (!ra) continue;
      matrix[a] = {};
      for (const b of focusSet) {
        if (a === b) { matrix[a][b] = 1; continue; }
        const rb = (snap.coins[b].win[mwk] || {}).ret; if (!rb) continue;
        const v = S.pearson(ra, rb);
        matrix[a][b] = S.isNum(v) ? +v.toFixed(2) : null;
      }
    }
  }

  const avg = head ? head.avgCorrBtc : null;
  return {
    ok: true,
    windows,
    headWindow: mwk || null,
    avgCorrBtc: avg,
    level: !S.isNum(avg) ? 'unknown' : avg >= HIGH_CORR ? 'high' : avg >= 0.5 ? 'moderate' : 'low',
    trend: head ? head.trend : 'unknown',
    spike: !!(head && head.spike),
    singleRiskAsset: S.isNum(avg) && avg >= HIGH_CORR,
    synchronizedSelling: sync,
    decoupled,
    matrix, matrixWindow: mwk || null, focus: focusSet,
    inputs: ['returnSeries', 'tradedValueWeights']
  };
}

module.exports = { correlation, basketReturns, HIGH_CORR, DECOUPLE_CORR, SYNC_SELL_PCT, SPIKE_JUMP, SPIKE_LEVEL };
