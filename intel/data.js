/* ============================================================
   INTEL — MARKET SNAPSHOT (the shared data layer)

   NO NEW PRICE PIPELINE. Every candle here comes from server.js's existing `loadCrypto`, which
   is the same function the scanner, movers, research and paper bot use. That matters for more
   than tidiness: if this module fetched its own candles, the Market Health panel could disagree
   with the card sitting right next to it about what a coin just did, and there would be no way
   to tell which one was wrong. One loader, one truth.

   Two series per coin, fetched once and shared by every engine:
     • FINE  — 15m bars (CoinDCX serves up to 1000 → ~10 days). Resampled up for the 1h and 4h
               windows, so three correlation windows cost one fetch instead of three.
     • DAILY — for the 24h correlation window and 30-day liquidity baselines, which 10 days of
               15m bars cannot reach. Cached far longer because a daily bar barely moves.

   Prices arrive ₹-denominated (loadCoinDCX multiplies the USDT book by one current rate). Every
   number this module produces is a RETURN or a ratio, and a constant multiplier cancels out of
   both — so the ₹/$ question that caused so much trouble elsewhere cannot reach these engines.
   ============================================================ */

const S = require('./stats');

const FINE_TF = '15m';
const FINE_TTL = 60 * 1000;
const DAILY_TTL = 10 * 60 * 1000;
const FETCH_CONCURRENCY = 8;

/* Correlation / return windows. `step` is in FINE bars; `n` is how many samples we want.
   32 samples is the floor for a correlation anyone should act on — below ~20 the confidence
   interval is so wide that 0.9 and 0.4 are not distinguishable. */
const WINDOWS = {
  '15m': { step: 1, n: 32, src: 'fine', mins: 15 },
  '1h': { step: 4, n: 32, src: 'fine', mins: 60 },
  '4h': { step: 16, n: 32, src: 'fine', mins: 240 },
  '24h': { step: 1, n: 30, src: 'daily', mins: 1440 }
};
const WINDOW_KEYS = Object.keys(WINDOWS);

module.exports = function createData(deps) {
  const { loadCrypto, ensureCryptoUniverse, getCRYPTO, ticker24, resampleSeries } = deps;

  let fineCache = null, fineAt = 0, fineInflight = null;
  let dailyCache = null, dailyAt = 0, dailyInflight = null;

  /* Pull one timeframe for the whole universe. A coin that fails is recorded and dropped — it
     must not become a zero-return row, which would drag every breadth and correlation figure
     toward "calm" precisely when an exchange is struggling. */
  async function fetchAll(uni, tf) {
    const out = {}, errors = [];
    const jobs = uni.map(asset => async () => {
      try {
        const d = await loadCrypto(asset, tf);
        if (!d || !Array.isArray(d.close) || d.close.length < 5) throw new Error('short series');
        out[asset.tk] = {
          tk: asset.tk, sym: asset.sym, name: asset.name || asset.tk,
          close: d.close, high: d.high, low: d.low, vol: d.vol || [], times: d.times || [],
          priceUsd: d.priceUsd || 0, price: d.price || d.close[d.close.length - 1],
          pairUsed: d.pairUsed || null
        };
      } catch (e) {
        errors.push({ tk: asset.tk, err: String((e && e.message) || e).slice(0, 80) });
      }
    });
    // Bounded concurrency — 40 coins at once trips CoinDCX's rate limiter, and a 429 here would
    // blank the whole panel rather than one row.
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, jobs.length) }, async () => {
      while (i < jobs.length) await jobs[i++]();
    }));
    return { series: out, errors };
  }

  async function getFine() {
    if (fineCache && Date.now() - fineAt < FINE_TTL) return fineCache;
    if (fineInflight) return fineInflight;
    fineInflight = (async () => {
      try {
        try { await ensureCryptoUniverse(); } catch (e) { /* keep whatever universe we have */ }
        const uni = getCRYPTO() || [];
        const r = await fetchAll(uni, FINE_TF);
        if (Object.keys(r.series).length) { fineCache = r; fineAt = Date.now(); }
        return fineCache || r;
      } finally { fineInflight = null; }
    })();
    return fineInflight;
  }

  async function getDaily() {
    if (dailyCache && Date.now() - dailyAt < DAILY_TTL) return dailyCache;
    if (dailyInflight) return dailyInflight;
    dailyInflight = (async () => {
      try {
        const uni = getCRYPTO() || [];
        const r = await fetchAll(uni, 'daily');
        if (Object.keys(r.series).length) { dailyCache = r; dailyAt = Date.now(); }
        return dailyCache || r;
      } finally { dailyInflight = null; }
    })();
    return dailyInflight;
  }

  /* Resample a fine series to a window's bar size and keep the last n+1 closes — n+1 because
     n returns need n+1 prices. */
  function seriesFor(coin, winKey, daily) {
    const w = WINDOWS[winKey];
    if (!w) return null;
    const base = w.src === 'daily' ? (daily && daily[coin.tk]) : coin;
    if (!base || !base.close || base.close.length < 3) return null;
    let s = base;
    if (w.step > 1) {
      s = resampleSeries({ close: base.close, high: base.high, low: base.low, vol: base.vol, times: base.times }, w.step);
    }
    const keep = w.n + 1;
    const cut = a => (a || []).slice(Math.max(0, (a || []).length - keep));
    return { close: cut(s.close), high: cut(s.high), low: cut(s.low), vol: cut(s.vol), times: cut(s.times) };
  }

  /* THE SNAPSHOT every engine reads.
     `coins` is keyed by ticker; each carries its fine series, its daily series, per-window
     return series, and the exchange's own 24h stats. Built once per call and passed by
     reference — no engine re-derives it, so no two engines can disagree. */
  async function snapshot() {
    const [fine, daily] = await Promise.all([getFine(), getDaily()]);
    let t24 = {};
    try { t24 = (await ticker24()) || {}; } catch (e) { t24 = {}; }

    const coins = {};
    const dailySeries = daily ? daily.series : {};
    for (const tk of Object.keys(fine.series || {})) {
      const c = fine.series[tk];
      const st = t24[tk] || {};
      const win = {};
      for (const k of WINDOW_KEYS) {
        const s = seriesFor(c, k, dailySeries);
        if (!s || s.close.length < 3) continue;
        win[k] = { close: s.close, high: s.high, low: s.low, vol: s.vol, times: s.times, ret: S.returns(s.close) };
      }
      /* Full-length 1h bars, not the 33 the correlation windows keep.
         "Above the 50 EMA" needs at least 50 bars behind it, and a swing-structure read needs
         enough pivots to see a sequence rather than a single leg. Both come off the same fine
         series, so this costs a resample and not a fetch. */
      const h1 = resampleSeries({ close: c.close, high: c.high, low: c.low, vol: c.vol, times: c.times }, 4);

      coins[tk] = {
        tk, sym: c.sym, name: c.name,
        price: c.price, priceUsd: c.priceUsd, pairUsed: c.pairUsed,
        fine: c,
        h1,
        daily: dailySeries[tk] || null,
        win,
        chg24: S.isNum(st.chg) ? st.chg : null,             // exchange's own 24h %, when it gives one
        qv: S.isNum(st.qv) ? st.qv : 0                       // 24h traded value (₹) — our market-cap proxy
      };
    }

    const tks = Object.keys(coins);
    return {
      ts: Date.now(),
      coins,
      tickers: tks,
      btc: coins.BTC || null,
      eth: coins.ETH || null,
      alts: tks.filter(t => t !== 'BTC' && t !== 'ETH'),
      errors: [].concat(fine.errors || [], (daily && daily.errors) || []),
      fineAt, dailyAt,
      windows: WINDOW_KEYS,
      /* How much of the intended universe actually loaded. Every engine downstream refuses to
         publish market-wide conclusions below MIN_COVERAGE — eight coins is not "the market". */
      coverage: tks.length
    };
  }

  return { snapshot, WINDOWS, WINDOW_KEYS, FINE_TF, __invalidate: () => { fineCache = null; dailyCache = null; } };
};

module.exports.WINDOWS = WINDOWS;
module.exports.WINDOW_KEYS = WINDOW_KEYS;
