/* ============================================================
   INTEL — GLOBAL MARKET STATS (BTC dominance)

   Same honesty envelope as derivs.js: `available:false` is a result, never a zero.

   TWO DIFFERENT NUMBERS, NEVER CONFLATED:
     • dominance      — BTC's share of TOTAL crypto market cap, from CoinGecko's /global.
                        The real thing, but it needs an outbound call that may fail.
     • volumeShare    — BTC's share of the traded value of THIS platform's tracked universe.
                        Always computable from the snapshot, needs no network, and is a
                        genuinely useful "where is the money going" read — but it is NOT
                        dominance, and is labelled as volume share everywhere it surfaces.

   Calling the second one "dominance" because the first was unavailable is precisely the kind of
   quiet substitution section 19 of the brief forbids.
   ============================================================ */

const REQ_TIMEOUT = 6000;
const off = reason => ({ available: false, reason, asOf: null, value: null });

module.exports = function createGlobal(opts) {
  const cfg = opts || {};
  const key = cfg.coingeckoKey || '';
  let cache = null, cacheAt = 0;

  async function dominance() {
    if (cache && Date.now() - cacheAt < 5 * 60 * 1000) return cache;
    try {
      const headers = key ? { 'x-cg-demo-api-key': key } : {};
      const r = await fetch('https://api.coingecko.com/api/v3/global', { headers, signal: AbortSignal.timeout(REQ_TIMEOUT) });
      if (!r.ok) return off('HTTP ' + r.status + ' from CoinGecko /global');
      const j = await r.json();
      const pct = j && j.data && j.data.market_cap_percentage && +j.data.market_cap_percentage.btc;
      if (!isFinite(pct) || pct <= 0) return off('CoinGecko /global returned no BTC market-cap share');
      cache = { available: true, reason: null, asOf: Date.now(), value: pct, venue: 'coingecko' };
      cacheAt = Date.now();
      return cache;
    } catch (e) { return off('CoinGecko /global unreachable: ' + String((e && e.message) || e).slice(0, 70)); }
  }

  /* BTC's share of tracked traded value. Network-free, so this is what the panel falls back to —
     under its own name. */
  function volumeShare(snap) {
    if (!snap || !snap.coins) return null;
    let total = 0, btc = 0;
    for (const tk of Object.keys(snap.coins)) {
      const qv = +snap.coins[tk].qv || 0;
      total += qv;
      if (tk === 'BTC') btc = qv;
    }
    return total > 0 ? btc / total * 100 : null;
  }

  return { dominance, volumeShare };
};
