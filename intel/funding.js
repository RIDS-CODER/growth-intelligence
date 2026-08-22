/* ============================================================
   INTEL — FUNDING / CROWDING DETECTOR

   Funding is the market telling you which side is paying to stay in. Heavily positive funding
   means longs are paying shorts — the crowd is long, and a crowd that is long is fuel for a
   downside cascade. The single most useful sentence this engine produces is the uncomfortable
   one:

     "Funding remains heavily positive despite falling price — downside liquidation risk
      remains elevated."

   That combination is a market where price has already broken but the crowd has not yet capitulated.
   The people who are going to be liquidated still hold their positions. It is the opposite of a
   bottom, and it looks identical on a price chart to a market where funding has already reset.

   RATES ARE PER FUNDING INTERVAL (8h on the venues read here), not annualised. The engine keeps
   the raw rate and states the interval rather than converting, because an "annualised 54%" is
   impressive-sounding and useless for judging whether a 4-hour position is expensive.
   ============================================================ */

const S = require('./stats');

/* Per-8h thresholds. Baseline funding on a healthy perp is ~0.01% (0.0001). */
const EXTREME = 0.0005;              // 0.05% per 8h — a genuinely crowded book
const ELEVATED = 0.0002;             // 0.02%
const NEUTRAL_HI = 0.00015;

function levelOf(r) {
  if (!S.isNum(r)) return null;
  if (r >= EXTREME) return 'extreme-positive';
  if (r >= ELEVATED) return 'elevated-positive';
  if (r <= -EXTREME) return 'extreme-negative';
  if (r <= -ELEVATED) return 'elevated-negative';
  return 'neutral';
}

function fundingEngine(snap, fundingResult, histResult, ctx) {
  if (!fundingResult || !fundingResult.available) {
    return {
      ok: false, available: false,
      reason: (fundingResult && fundingResult.reason) || 'funding adapter not configured',
      note: 'Without funding this platform cannot tell whether a decline is happening into a crowded long book (high cascade risk) or into one that has already reset.',
      coins: {}
    };
  }
  const rates = fundingResult.data || {};
  const tracked = (snap && snap.tickers) || Object.keys(rates);
  const coins = {};
  for (const tk of tracked) {
    const f = rates[tk];
    if (!f || !S.isNum(f.rate)) continue;
    coins[tk] = { rate: f.rate, ratePct: f.rate * 100, level: levelOf(f.rate), nextFundingTime: f.nextFundingTime || null };
  }
  const tks = Object.keys(coins);
  if (!tks.length) return { ok: false, available: false, reason: 'funding returned no rows matching the tracked universe', coins: {} };

  const btc = coins.BTC ? coins.BTC.rate : null;
  const altRates = tks.filter(t => t !== 'BTC' && t !== 'ETH').map(t => coins[t].rate);
  const medAlt = S.median(altRates);
  const medAll = S.median(tks.map(t => coins[t].rate));

  /* ---- REVERSAL / NORMALISATION ----
     Compares the latest print against the mean of the prints before it. Falling magnitude is
     the single most encouraging thing that can happen during a flush: it means the crowd is
     actually leaving rather than doubling down, so the fuel for further liquidation is burning off. */
  let reversal = { available: false, reason: (histResult && histResult.reason) || 'funding history not fetched' };
  if (histResult && histResult.available) {
    const h = histResult.data.rates || {};
    const deltas = [], normalising = [];
    for (const tk of Object.keys(h)) {
      const arr = h[tk];
      if (!arr || arr.length < 3) continue;
      const last = arr[arr.length - 1];
      const prior = S.mean(arr.slice(0, -1));
      if (!S.isNum(last) || !S.isNum(prior)) continue;
      deltas.push(last - prior);
      if (Math.abs(last) < Math.abs(prior) * 0.6) normalising.push(tk);
      else if (S.isNum(prior) && Math.sign(last) !== Math.sign(prior) && Math.abs(prior) > NEUTRAL_HI) normalising.push(tk);
    }
    if (deltas.length) {
      const md = S.median(deltas);
      reversal = {
        available: true,
        medianDelta: md,
        normalisingCount: normalising.length,
        sampled: deltas.length,
        normalising: normalising.length >= Math.max(2, Math.ceil(deltas.length * 0.5)),
        direction: md > 0.00005 ? 'rising' : md < -0.00005 ? 'falling' : 'flat'
      };
    }
  }

  const crowding = !S.isNum(medAll) ? 'unknown'
    : medAll >= EXTREME ? 'longs-heavily-crowded'
      : medAll >= ELEVATED ? 'longs-crowded'
        : medAll <= -EXTREME ? 'shorts-heavily-crowded'
          : medAll <= -ELEVATED ? 'shorts-crowded'
            : 'balanced';

  /* BTC vs alt divergence — alts paying far more than BTC means the leverage is concentrated in
     the thin end of the market, which is where cascades do the most damage. */
  const divergence = (S.isNum(btc) && S.isNum(medAlt)) ? medAlt - btc : null;

  const extremes = tks.filter(t => coins[t].level === 'extreme-positive' || coins[t].level === 'extreme-negative')
    .map(t => ({ tk: t, rate: coins[t].rate, level: coins[t].level }))
    .sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate)).slice(0, 8);

  /* The warning sentence. Requires price context, so it only fires when the caller supplied it. */
  const priceFalling = ctx && S.isNum(ctx.btcRet4h) && ctx.btcRet4h < -0.01;
  const stillCrowded = S.isNum(medAll) && medAll >= ELEVATED;
  const messages = [];
  if (priceFalling && stillCrowded && !(reversal.available && reversal.normalising)) {
    messages.push('Funding remains positive despite falling price — the long book has not capitulated yet, so downside liquidation risk remains elevated.');
  } else if (reversal.available && reversal.normalising) {
    messages.push('Funding is becoming less extreme, which reduces the fuel available for further forced selling.');
  } else if (crowding === 'longs-heavily-crowded') messages.push('Longs are heavily crowded — this is the positioning that cascades feed on.');
  else if (crowding === 'shorts-heavily-crowded') messages.push('Shorts are heavily crowded — squeeze risk is elevated to the upside.');
  else if (crowding === 'balanced') messages.push('Funding is close to neutral — no crowded side to squeeze.');

  return {
    ok: true, available: true,
    venue: fundingResult.venue, asOf: fundingResult.asOf,
    interval: '8h',
    coins, covered: tks.length,
    btcRate: btc, medianAltRate: medAlt, medianRate: medAll,
    crowding, extreme: crowding.indexOf('heavily') >= 0,
    divergence,
    divergenceNote: S.isNum(divergence) && Math.abs(divergence) >= ELEVATED
      ? (divergence > 0 ? 'Altcoin funding is materially above BTC — leverage is concentrated in the thin end of the market.'
        : 'BTC funding is materially above altcoin funding — the crowding is in BTC, not the alts.')
      : null,
    reversal,
    extremes,
    messages,
    inputs: ['fundingRates'].concat(reversal.available ? ['fundingHistory'] : []),
    caveat: 'Funding is read from a perpetual-futures venue that may differ from the one you trade on. Rates are per 8h interval, not annualised.'
  };
}

module.exports = { fundingEngine, levelOf, EXTREME, ELEVATED };
