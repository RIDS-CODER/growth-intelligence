/* ============================================================
   INTEL — DERIVATIVES ADAPTER (open interest, funding, depth)

   READ THIS BEFORE TRUSTING ANY NUMBER OUT OF THIS FILE.

   The platform's entire price pipeline is SPOT: CoinDCX spot ticker + candles, Binance spot
   klines, Upstox equities. Open interest, funding and order-book depth do not exist anywhere in
   it. This adapter is the only place that reaches for them, and it reaches for a venue the
   deployment may not be able to talk to at all.

   THE HONESTY CONTRACT. Every function returns the same envelope:

       { available: false, reason: "...", asOf: null, data: null }
       { available: true,  reason: null,  asOf: 1699999999999, data: {...}, venue: "binance-futures" }

   `available:false` is a RESULT, not an error to be smoothed over. Callers must branch on it.
   Nothing in this file ever substitutes 0, a default, or a "typical" value for a number it
   could not fetch — a fabricated funding rate would flow straight into a liquidation-cascade
   confidence score and out to the trader as evidence.

   WHY THIS WILL PROBABLY READ UNAVAILABLE IN PRODUCTION
   The go-live guide puts this server in DigitalOcean Bangalore, because CoinDCX refuses
   connections from outside India. Binance restricts Indian retail access, so the same placement
   that makes spot prices correct is likely to make these futures endpoints unreachable. That is
   a genuine, unresolved gap — not a bug to be worked around — and the UI states it rather than
   hiding it.

   LIQUIDATIONS ARE NOT AVAILABLE AT ALL. Binance removed the public REST force-order endpoint;
   the only public source is the `!forceOrder@arr` WebSocket stream, which this zero-dependency,
   restart-on-deploy server has nowhere to persist. `liquidations()` therefore always reports
   unavailable, and the cascade detector runs in INFERRED mode with a capped confidence and a
   visible label. It never claims to have seen a liquidation.

   ADDING A VENUE: implement the same envelope and the same four functions. CoinDCX publishes a
   futures API; it is deliberately not implemented here because its response shape could not be
   verified from this environment, and guessing a schema is how invented data gets shipped.
   ============================================================ */

const DEFAULT_HOSTS = ['https://fapi.binance.com'];
const REQ_TIMEOUT = 6000;
const UNSUPPORTED = 'no configured venue exposes this over REST';

const envHosts = () => {
  const raw = process.env.INTEL_FAPI_HOSTS || '';
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_HOSTS;
};

const off = reason => ({ available: false, reason, asOf: null, data: null, venue: null });
const on = (data, venue) => ({ available: true, reason: null, asOf: Date.now(), data, venue: venue || 'binance-futures' });

/* Futures endpoints are a best-effort side quest, never the thing holding up the panel.
   A hard timeout matters more here than anywhere else in the codebase: server.js's getJSON has
   none, and one hung futures socket would stall the whole Market Health snapshot behind it. */
async function fget(pathq) {
  let last = null;
  for (const host of envHosts()) {
    try {
      const r = await fetch(host + pathq, { signal: AbortSignal.timeout(REQ_TIMEOUT) });
      if (!r.ok) { last = new Error('HTTP ' + r.status); continue; }
      return await r.json();
    } catch (e) { last = e; }
  }
  throw last || new Error('unreachable');
}

const shortErr = e => String((e && e.message) || e).slice(0, 90);
const num = v => { const n = +v; return isFinite(n) ? n : null; };

module.exports = function createDerivs(opts) {
  const cfg = opts || {};
  const enabled = cfg.enabled !== false && process.env.INTEL_DERIVS !== 'off';
  const symbolOf = tk => String(tk).toUpperCase() + 'USDT';

  const cache = new Map();
  const cget = (k, ttl) => { const e = cache.get(k); return e && Date.now() - e.t < ttl ? e.v : null; };
  const cset = (k, v) => { cache.set(k, { t: Date.now(), v }); return v; };

  /* ---- FUNDING: one request covers every symbol ----
     premiumIndex with no symbol returns the whole board, so funding across 40 coins costs a
     single call. Rates are per funding interval (8h on most Binance perps), NOT annualised —
     the interpretation layer is what turns 0.0005 into "longs are crowded". */
  async function funding() {
    if (!enabled) return off('derivatives adapter disabled (INTEL_DERIVS=off)');
    const hit = cget('funding', 60 * 1000); if (hit) return hit;
    try {
      const j = await fget('/fapi/v1/premiumIndex');
      if (!Array.isArray(j) || !j.length) return cset('funding', off('unexpected premiumIndex shape'));
      const out = {};
      for (const x of j) {
        if (!x || typeof x.symbol !== 'string' || !x.symbol.endsWith('USDT')) continue;
        const rate = num(x.lastFundingRate);
        if (rate == null) continue;                       // a symbol without a rate is skipped, not zeroed
        out[x.symbol.slice(0, -4)] = {
          rate,
          markPrice: num(x.markPrice),
          nextFundingTime: num(x.nextFundingTime)
        };
      }
      if (!Object.keys(out).length) return cset('funding', off('premiumIndex returned no usable rows'));
      return cset('funding', on(out));
    } catch (e) { return cset('funding', off('funding fetch failed: ' + shortErr(e))); }
  }

  /* ---- FUNDING HISTORY: for "is funding reversing?" ----
     Per symbol, so it is limited to the handful of coins the caller actually cares about. */
  async function fundingHistory(tickers, limit) {
    if (!enabled) return off('derivatives adapter disabled (INTEL_DERIVS=off)');
    const list = (tickers || []).slice(0, cfg.maxPerSymbol || 12);
    if (!list.length) return off('no symbols requested');
    const key = 'fh:' + list.join(',');
    const hit = cget(key, 5 * 60 * 1000); if (hit) return hit;
    const out = {}; let failures = 0;
    for (const tk of list) {
      try {
        const j = await fget(`/fapi/v1/fundingRate?symbol=${symbolOf(tk)}&limit=${limit || 8}`);
        if (!Array.isArray(j) || !j.length) { failures++; continue; }
        const rates = j.map(x => num(x.fundingRate)).filter(v => v != null);
        if (rates.length) out[tk] = rates;                 // oldest → newest, as the venue returns them
      } catch (e) { failures++; }
    }
    if (!Object.keys(out).length) return cset(key, off('funding history unavailable for all ' + list.length + ' symbols'));
    return cset(key, on({ rates: out, failures }));
  }

  /* ---- OPEN INTEREST: current level plus recent history ----
     openInterestHist gives both the level and where it was N periods ago, so one call answers
     "how much OI, and which way is it moving". Per symbol → capped to the top coins by traded
     value, because 40 sequential futures calls would take longer than the panel's refresh. */
  async function openInterest(tickers, period) {
    if (!enabled) return off('derivatives adapter disabled (INTEL_DERIVS=off)');
    const list = (tickers || []).slice(0, cfg.maxPerSymbol || 12);
    if (!list.length) return off('no symbols requested');
    const per = period || '15m';
    const key = 'oi:' + per + ':' + list.join(',');
    const hit = cget(key, 2 * 60 * 1000); if (hit) return hit;
    const out = {}; let failures = 0;
    for (const tk of list) {
      try {
        const j = await fget(`/futures/data/openInterestHist?symbol=${symbolOf(tk)}&period=${per}&limit=48`);
        if (!Array.isArray(j) || j.length < 2) { failures++; continue; }
        const series = j.map(x => ({ oi: num(x.sumOpenInterest), val: num(x.sumOpenInterestValue), t: num(x.timestamp) }))
          .filter(x => x.oi != null);
        if (series.length < 2) { failures++; continue; }
        out[tk] = series;                                  // oldest → newest
      } catch (e) { failures++; }
    }
    if (!Object.keys(out).length) return cset(key, off('open interest unavailable for all ' + list.length + ' symbols'));
    return cset(key, on({ series: out, period: per, failures }));
  }

  /* ---- ORDER-BOOK DEPTH ----
     The genuine article for the liquidity engine, and the most expensive call here — one book
     per symbol. Callers pass only the coins that matter (open positions, the movers on screen).
     When this is unavailable the liquidity engine falls back to a price-impact measure computed
     from candles, which is clearly labelled as an estimate rather than measured depth. */
  async function depth(tickers, band) {
    if (!enabled) return off('derivatives adapter disabled (INTEL_DERIVS=off)');
    const list = (tickers || []).slice(0, cfg.maxDepth || 8);
    if (!list.length) return off('no symbols requested');
    const pct = band || 0.005;
    const key = 'depth:' + pct + ':' + list.join(',');
    const hit = cget(key, 30 * 1000); if (hit) return hit;
    const out = {}; let failures = 0;
    for (const tk of list) {
      try {
        const j = await fget(`/fapi/v1/depth?symbol=${symbolOf(tk)}&limit=100`);
        if (!j || !Array.isArray(j.bids) || !Array.isArray(j.asks) || !j.bids.length || !j.asks.length) { failures++; continue; }
        const bestBid = num(j.bids[0][0]), bestAsk = num(j.asks[0][0]);
        if (!(bestBid > 0) || !(bestAsk > 0)) { failures++; continue; }
        const mid = (bestBid + bestAsk) / 2;
        let bidQty = 0, askQty = 0;
        for (const [p, q] of j.bids) { const pp = num(p), qq = num(q); if (pp != null && qq != null && pp >= mid * (1 - pct)) bidQty += pp * qq; }
        for (const [p, q] of j.asks) { const pp = num(p), qq = num(q); if (pp != null && qq != null && pp <= mid * (1 + pct)) askQty += pp * qq; }
        out[tk] = {
          spreadPct: (bestAsk - bestBid) / mid * 100,
          bidValue: bidQty, askValue: askQty,
          bandPct: pct * 100,
          imbalance: (bidQty + askQty) > 0 ? (bidQty - askQty) / (bidQty + askQty) : null
        };
      } catch (e) { failures++; }
    }
    if (!Object.keys(out).length) return cset(key, off('order book unavailable for all ' + list.length + ' symbols'));
    return cset(key, on({ books: out, failures }));
  }

  /* ---- LIQUIDATIONS: structurally unavailable, and it says so every time ----
     Kept as a real function with the real envelope so the cascade detector's `measured` branch
     is written, tested and ready — the day a liquidation feed exists, only this function
     changes. Until then it never returns a number, so nothing downstream can quietly invent
     "long liquidations elevated" out of an empty response. */
  async function liquidations() {
    return off('no public REST source: Binance serves force-orders only over the !forceOrder WebSocket stream, which this server does not hold open. ' + UNSUPPORTED);
  }

  /* One-line health summary for the UI's data-quality strip. */
  async function health() {
    const f = await funding();
    return {
      enabled,
      venue: 'binance-futures',
      funding: f.available, fundingReason: f.reason,
      liquidations: false, liquidationsReason: (await liquidations()).reason,
      hosts: envHosts()
    };
  }

  return { funding, fundingHistory, openInterest, depth, liquidations, health, __symbolOf: symbolOf };
};
