/* ============================================================
   INTEL — LIQUIDITY VACUUM DETECTOR

   A liquidity vacuum is when the book thins out so far that ordinary-sized market orders start
   moving price several percent. It is the mechanism behind most "how did it drop 9% in two
   minutes" candles on mid-cap alts, and it is invisible on a price chart until after it happens.

   TWO TIERS, AND THE UI ALWAYS SAYS WHICH ONE IT IS LOOKING AT:

   1. MEASURED DEPTH — real order book: spread, resting value within ±0.5% of mid, bid/ask
      imbalance. Only available when derivs.js can reach a venue, and only for a handful of
      symbols because it costs one request per book. This is the real thing.

   2. PRICE IMPACT (always available, no network) — the Amihud illiquidity ratio,
      |return| ÷ traded value, per bar. It measures exactly the property that matters: how far
      price travels per unit of money. It is computed from candles this platform already has, so
      it works for every coin, at every moment, including when the futures venue is unreachable.

   Tier 2 is an ESTIMATE and is labelled one. It is not order-book depth, it cannot see a spoofed
   bid wall, and it says nothing about which side of the book vanished. What it can do is answer
   "is this coin moving further per rupee traded than it normally does", which is the question a
   trader sizing a leveraged position actually needs answered.

   THE BASELINE IS EACH COIN AGAINST ITSELF. A fixed illiquidity threshold would flag every
   micro-cap permanently and BTC never. Percentile-against-own-history means "unusual for THIS
   coin", which is the only version of the claim that is actionable.
   ============================================================ */

const S = require('./stats');

const RECENT_BARS = 8;               // 2h at 15m — the move in progress
const BASELINE_MIN = 120;            // need a real distribution before calling anything unusual
const VACUUM_PCTILE = 0.85;
const RANGE_EXPANSION = 2.0;         // current true range vs ATR
const WIDE_SPREAD_PCT = 0.15;        // measured-depth tier: spread above this is genuinely wide

/* Per-bar Amihud ratio: |return| / traded value. Bars with no volume are dropped rather than
   treated as infinitely illiquid — a missing volume field is a data gap, not a vacuum. */
function impactSeries(close, vol) {
  const out = [];
  if (!close || !vol || vol.length !== close.length) return out;
  for (let i = 1; i < close.length; i++) {
    const p0 = close[i - 1], p1 = close[i], v = +vol[i];
    if (!(p0 > 0) || !(p1 > 0) || !(v > 0)) { out.push(null); continue; }
    const quote = v * p1;
    if (!(quote > 0)) { out.push(null); continue; }
    out.push(Math.abs(p1 / p0 - 1) / quote);
  }
  return out;
}

/* True range of the recent bars against a CALM baseline — "is it moving violently right now"
   independent of how much traded.

   THE BASELINE MUST PREDATE THE MOVE. Comparing the current bar against the immediately preceding
   fifteen sounds right and is quietly self-defeating: a flush that runs for six bars raises the
   very average it is being measured against, so by the third bar of a genuine cascade the ratio
   has collapsed back toward 1.0 and the detector goes quiet exactly when it should be loudest.
   The baseline therefore skips the recent window entirely and measures against the period before
   it — which is the comparison a trader makes by eye anyway ("this is huge versus this morning"). */
const BASE_SKIP = 8;                 // bars of "now" excluded from the baseline
const BASE_LEN = 30;                 // bars of calm behind that

function rangeExpansion(high, low, close) {
  if (!high || !low || !close || close.length < BASE_SKIP + BASE_LEN + 2) return null;
  const n = close.length;
  const tr = [];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  }
  // Normalise by price so a trending coin's ranges stay comparable across the window.
  const pct = tr.map((v, i) => close[i + 1] > 0 ? v / close[i + 1] : null);
  const recent = S.mean(pct.slice(pct.length - Math.min(3, pct.length)));
  const baseEnd = pct.length - BASE_SKIP;
  const base = S.median(pct.slice(Math.max(0, baseEnd - BASE_LEN), Math.max(1, baseEnd)));
  return (S.isNum(recent) && S.isNum(base) && base > 0) ? recent / base : null;
}

function liquidityEngine(snap, depthResult, ctx) {
  const tks = (snap && snap.tickers) || [];
  if (!tks.length) return { ok: false, reason: 'no coins loaded', coins: {} };

  const books = (depthResult && depthResult.available) ? (depthResult.data.books || {}) : null;
  const coins = {};
  let vacuumCount = 0, scored = 0;

  for (const tk of tks) {
    const coin = snap.coins[tk];
    const f = coin.fine || {};
    const imp = impactSeries(f.close, f.vol);
    const usable = imp.filter(S.isNum);

    let impactPctile = null, recentImpact = null, baselineImpact = null;
    if (usable.length >= BASELINE_MIN) {
      const recentVals = imp.slice(Math.max(0, imp.length - RECENT_BARS)).filter(S.isNum);
      recentImpact = S.median(recentVals);
      const baseVals = usable.slice(0, Math.max(0, usable.length - RECENT_BARS));
      baselineImpact = S.median(baseVals);
      if (S.isNum(recentImpact) && baseVals.length >= BASELINE_MIN) {
        impactPctile = S.percentileOf(baseVals, recentImpact);
      }
    }

    const expansion = rangeExpansion(f.high, f.low, f.close);
    const book = books && books[tk] ? books[tk] : null;

    /* A vacuum needs BOTH thinness and violence. Thin-and-quiet is an illiquid coin sitting
       still, which is a sizing problem, not an event. */
    const thin = S.isNum(impactPctile) && impactPctile >= VACUUM_PCTILE;
    const violent = S.isNum(expansion) && expansion >= RANGE_EXPANSION;
    const bookThin = book ? (book.spreadPct >= WIDE_SPREAD_PCT) : null;
    const vacuum = !!((thin && violent) || (bookThin && violent));

    if (S.isNum(impactPctile)) scored++;
    if (vacuum) vacuumCount++;

    coins[tk] = {
      tier: book ? 'measured-depth' : (S.isNum(impactPctile) ? 'price-impact-estimate' : 'unavailable'),
      impactPctile, recentImpact, baselineImpact,
      rangeExpansion: expansion,
      vacuum,
      reason: !S.isNum(impactPctile) && !book
        ? (usable.length ? `only ${usable.length} bars carry volume — need ${BASELINE_MIN} for a baseline` : 'no volume data on this feed')
        : null,
      book: book ? { spreadPct: book.spreadPct, bidValue: book.bidValue, askValue: book.askValue, imbalance: book.imbalance, bandPct: book.bandPct } : null
    };
  }

  const flagged = tks.filter(t => coins[t].vacuum)
    .map(t => ({ tk: t, impactPctile: coins[t].impactPctile, rangeExpansion: coins[t].rangeExpansion, tier: coins[t].tier }))
    .sort((a, b) => (b.impactPctile || 0) - (a.impactPctile || 0));

  const pctVacuum = scored > 0 ? vacuumCount / scored * 100 : null;

  return {
    ok: scored > 0 || !!books,
    reason: scored === 0 && !books ? 'no coin has enough volume history for a liquidity baseline' : null,
    depthAvailable: !!books,
    depthReason: books ? null : ((depthResult && depthResult.reason) || 'order-book adapter not configured'),
    tier: books ? 'measured-depth (partial) + price-impact estimate' : 'price-impact estimate only',
    coins, scored,
    vacuumCount, pctVacuum,
    flagged: flagged.slice(0, 10),
    marketVacuum: S.isNum(pctVacuum) && pctVacuum >= 25,
    message: S.isNum(pctVacuum) && pctVacuum >= 25
      ? 'Market depth has deteriorated across a meaningful share of the board — relatively small market orders can currently produce unusually large price movements. Reduce order size and avoid market orders on the thin names.'
      : null,
    inputs: books ? ['orderBookDepth', 'priceImpactRatio', 'trueRange'] : ['priceImpactRatio', 'trueRange'],
    caveat: books
      ? 'Depth is measured for a subset of symbols only; the rest use the price-impact estimate.'
      : 'No order-book feed is reachable, so this is a price-impact ESTIMATE from candles — it cannot see spread, bid walls, or which side of the book thinned.'
  };
}

module.exports = { liquidityEngine, impactSeries, rangeExpansion, VACUUM_PCTILE, RANGE_EXPANSION };
