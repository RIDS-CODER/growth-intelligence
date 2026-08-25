/* ============================================================
   INTEL — OPEN INTEREST INTERPRETATION

   Price alone cannot tell you whether a decline is people SELLING or people BEING SOLD. Open
   interest can, because it counts contracts rather than trades:

     PRICE ↑  OI ↑   new money entering long — trend expansion, the healthiest kind of rally
     PRICE ↑  OI ↓   shorts covering — a squeeze, and squeezes end when the shorts run out
     PRICE ↓  OI ↑   new shorts pressing — genuine bearish conviction being expressed
     PRICE ↓  OI ↓   DELEVERAGING — longs being closed or liquidated, not new sellers arriving

   That last cell is the one that matters most and is the one most often misread. A 5% drop with
   OI down 6% is a crowd being forcibly removed from its positions; the selling stops when the
   leverage is gone, and it frequently stops abruptly. The same 5% drop with OI UP 6% is a market
   where new sellers keep arriving, and there is no reason for it to stop. Identical candles,
   opposite trades.

   NO OI FEED, NO QUADRANT. When derivs.js reports unavailable this engine returns
   available:false and every consumer degrades — nothing here invents a direction of flow.
   ============================================================ */

const S = require('./stats');

const FLAT_BAND = 0.003;             // ±0.3% — smaller than this is noise, not a direction
const BARS_PRICE = 8;                // 8 × 15m = 2h of price change, matched to the OI window below

const MEANING = {
  'up-up': { key: 'trend-expansion', text: 'New positions entering — trend expansion. Fresh money is backing this move.' },
  'up-down': { key: 'short-covering', text: 'Short covering rather than new buying — a squeeze. It ends when the trapped shorts are out.' },
  'down-up': { key: 'new-shorts', text: 'New shorts entering — this is bearish positioning being expressed, not forced selling.' },
  'down-down': { key: 'deleveraging', text: 'DELEVERAGING — longs are being closed or liquidated rather than new shorts arriving. Selling pressure fades as the leverage is removed.' },
  'flat': { key: 'flat', text: 'No meaningful change in either price or positioning.' }
};

function quadrantOf(dPrice, dOi) {
  if (!S.isNum(dPrice) || !S.isNum(dOi)) return null;
  const p = Math.abs(dPrice) < FLAT_BAND ? 0 : (dPrice > 0 ? 1 : -1);
  const o = Math.abs(dOi) < FLAT_BAND ? 0 : (dOi > 0 ? 1 : -1);
  if (p === 0 || o === 0) return 'flat';
  return (p > 0 ? 'up' : 'down') + '-' + (o > 0 ? 'up' : 'down');
}

function openInterestEngine(snap, oiResult, ctx) {
  if (!oiResult || !oiResult.available) {
    return {
      ok: false, available: false,
      reason: (oiResult && oiResult.reason) || 'open interest adapter not configured',
      note: 'Without open interest this platform cannot distinguish forced long liquidation from fresh short selling. Both look like a red candle.',
      coins: {}
    };
  }
  const series = oiResult.data.series || {};
  const coins = {};
  let oiNow = 0, oiThen = 0;

  for (const tk of Object.keys(series)) {
    const s = series[tk];
    if (!s || s.length < 2) continue;
    const last = s[s.length - 1];
    // Match the OI lookback to the price lookback so the two changes describe the same interval.
    const backIdx = Math.max(0, s.length - 1 - BARS_PRICE);
    const prev = s[backIdx];
    if (!(prev.oi > 0) || !(last.oi > 0)) continue;
    const dOi = last.oi / prev.oi - 1;

    const coin = snap && snap.coins && snap.coins[tk];
    const dPrice = coin ? S.retOver(coin.fine && coin.fine.close, BARS_PRICE) : null;
    const q = quadrantOf(dPrice, dOi);

    coins[tk] = {
      oiChange: dOi, priceChange: dPrice,
      oi: last.oi, oiValue: last.val,
      quadrant: q,
      meaning: q ? MEANING[q].text : null,
      key: q ? MEANING[q].key : null
    };
    // Aggregate weighted by notional value where the venue gives it, else by raw contracts.
    const w = S.isNum(last.val) && last.val > 0 ? last.val : last.oi;
    const wPrev = S.isNum(prev.val) && prev.val > 0 ? prev.val : prev.oi;
    if (w > 0 && wPrev > 0) { oiNow += w; oiThen += wPrev; }
  }

  const tks = Object.keys(coins);
  if (!tks.length) {
    return { ok: false, available: false, reason: 'open interest returned no usable series', coins: {} };
  }

  const marketOi = oiThen > 0 ? oiNow / oiThen - 1 : null;
  const btcPrice = snap && snap.coins && snap.coins.BTC ? S.retOver(snap.coins.BTC.fine.close, BARS_PRICE) : null;
  const marketQ = quadrantOf(btcPrice, marketOi);

  return {
    ok: true, available: true,
    venue: oiResult.venue, asOf: oiResult.asOf,
    period: oiResult.data.period,
    lookbackBars: BARS_PRICE,
    coins,
    covered: tks.length,
    market: {
      oiChange: marketOi,
      priceChange: btcPrice,
      quadrant: marketQ,
      meaning: marketQ ? MEANING[marketQ].text : null,
      key: marketQ ? MEANING[marketQ].key : null,
      deleveraging: marketQ === 'down-down',
      freshShorts: marketQ === 'down-up'
    },
    inputs: ['openInterestHistory', 'priceSeries'],
    caveat: 'Open interest is read from a perpetual-futures venue, which may not be the venue you trade on. Treat it as a read on market-wide leverage, not on your own book.'
  };
}

module.exports = { openInterestEngine, quadrantOf, MEANING, FLAT_BAND };
