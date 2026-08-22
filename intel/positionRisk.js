/* ============================================================
   INTEL — LEVERAGED POSITION RISK ENGINE

   Takes one open futures position and everything the market engines currently know, and answers
   the only four questions that matter while a leveraged trade is under water:

     How close am I to being liquidated?
     Is the market against me, or is it just this coin?
     What price would tell me the thesis is repairing?
     What price would tell me it is over?

   ============================================================
   ON AVERAGING DOWN — READ THIS BEFORE CHANGING THE GATE
   ============================================================
   Adding to a losing leveraged position is the single fastest way to turn a bad trade into a
   liquidated account, because it moves the liquidation price TOWARD the market at the exact
   moment the market is moving toward it. The gate below therefore starts at NO and requires
   evidence to move — never the reverse.

   Any one of the hard blocks (a live cascade, a liquidity vacuum, BTC printing lower lows, or a
   liquidation price inside 15%) forces "no" outright, regardless of how good everything else
   looks. When conditions are merely unproven the answer is "wait", with the specific level that
   would change it — never a soft yes.

   This engine has no `add` recommendation and no position-sizing suggestion. It reports
   conditions and levels; the decision stays with the trader.
   ============================================================ */

const S = require('./stats');
const { structure, fightingStructure } = require('./structure');
const { coinVsMarket } = require('./beta');

const DEFAULT_MMR = 0.005;           // 0.5% maintenance margin — a common isolated-margin default
const HARD_LIQ_DISTANCE = 0.15;      // inside 15% of liquidation, nothing is "defensible"
const SAFE_LIQ_DISTANCE = 0.25;

/* Isolated-margin linear perpetual, ignoring fees and any tiered margin schedule.
   ALWAYS an estimate: every venue uses its own maintenance-margin ladder, and CoinDCX's differs
   from Binance's. When the trader supplies the venue's own figure we use theirs and say so. */
function estimateLiquidation(entry, side, lev, mmr) {
  if (!(entry > 0) || !(lev > 0)) return null;
  const m = S.isNum(mmr) ? mmr : DEFAULT_MMR;
  const px = side > 0 ? entry * (1 - 1 / lev + m) : entry * (1 + 1 / lev - m);
  return px > 0 ? px : null;
}

/* Nearest structural level on the correct side of price, taken from the same pivots the
   structure read uses — so the level quoted here is one the trader can see on their chart. */
function nearestLevels(st, price) {
  if (!st || !st.ok || !(price > 0)) return { support: null, resistance: null };
  const highs = st.pivots.filter(p => p.kind === 'high').map(p => p.px);
  const lows = st.pivots.filter(p => p.kind === 'low').map(p => p.px);
  const below = [].concat(lows, highs).filter(v => S.isNum(v) && v < price);
  const above = [].concat(lows, highs).filter(v => S.isNum(v) && v > price);
  return {
    support: below.length ? Math.max(...below) : null,
    resistance: above.length ? Math.min(...above) : null
  };
}

function fmtPx(v) {
  if (!S.isNum(v)) return '—';
  return v >= 1000 ? v.toFixed(0) : v >= 1 ? v.toFixed(3) : v.toFixed(5);
}

function positionRisk(pos, snap, engines, opts) {
  const o = opts || {};
  const zigzag = o.zigzag || (() => []);
  if (!pos) return { ok: false, reason: 'no position supplied' };

  const tk = pos.tk || (pos.sym || '').replace(/USDT$|INR$/, '');
  const coin = snap && snap.coins && snap.coins[tk];
  const side = pos.side > 0 ? 1 : -1;
  const entry = +pos.entry;
  const lev = +pos.lev > 0 ? +pos.lev : null;

  if (!coin) {
    return { ok: false, reason: `${tk} is not in the tracked universe right now, so market context cannot be attached to this position.`, tk };
  }
  if (!(entry > 0)) return { ok: false, reason: 'position has no valid entry price', tk };

  /* Price in the SAME denomination as the entry the trader typed. Entries are recorded in ₹ by
     the existing position watcher, and coin.price is ₹ — mixing a ₹ entry with a $ last price
     would produce a P&L off by a factor of ~88 and a liquidation distance that is pure fiction. */
  const price = +o.price > 0 ? +o.price : coin.price;
  if (!(price > 0)) return { ok: false, reason: 'no live price for this coin', tk };

  /* UNIT-MISMATCH GUARD.
     Entries are stored in ₹ and a CoinDCX trader thinks in USDT — roughly an 88x difference. That
     confusion has already produced wrong numbers in this platform once. An entry twenty times away
     from the live price is not a trade that went badly; it is almost always a denomination error
     or a typo, and computing a −98% P&L and a confident liquidation distance from it would dress
     a data-entry mistake up as a market emergency. Refuse and say which way the mismatch runs. */
  const ratio = entry / price;
  if (ratio > 20 || ratio < 0.05) {
    return {
      ok: false, tk,
      reason: `Entry ${fmtPx(entry)} is ${ratio > 1 ? (ratio).toFixed(0) + '× above' : (1 / ratio).toFixed(0) + '× below'} the live price ${fmtPx(price)}. That gap is far more likely to be a currency mix-up (entries are stored in ₹, not USDT) or a typo than a real position — so no risk figures are calculated from it. Re-enter the trade using the price in the currency shown beside the entry box.`,
      unitMismatch: true, entry, price
    };
  }

  const movePct = (price / entry - 1) * side;
  const roe = lev ? movePct * lev : null;

  const liqSupplied = +pos.liq > 0 ? +pos.liq : null;
  const liq = liqSupplied || (lev ? estimateLiquidation(entry, side, lev, o.mmr) : null);
  const liqSource = liqSupplied ? 'venue-supplied' : (liq ? 'estimated' : null);

  /* SIGNED, NOT ABSOLUTE.
     An earlier version used Math.abs here, which reported a long trading BELOW its own
     liquidation price as "91.6% away from liquidation" — the most dangerous possible reading of
     the most dangerous possible state. For a long, safety is price ABOVE liq; for a short, price
     BELOW it. A negative distance means the level has already been passed, and the engine says
     so loudly instead of quietly taking the magnitude. */
  const distLiqSigned = liq ? (side > 0 ? (price - liq) / price : (liq - price) / price) : null;
  const pastLiquidation = S.isNum(distLiqSigned) && distLiqSigned <= 0;
  const distLiq = S.isNum(distLiqSigned) ? Math.max(0, distLiqSigned) : null;
  const distBreakeven = Math.abs(price - entry) / price;

  // --- market context ---
  const st = structure(coin.h1 && coin.h1.close, zigzag);
  const btcSt = snap.coins.BTC ? structure(snap.coins.BTC.h1 && snap.coins.BTC.h1.close, zigzag) : null;
  const fight = fightingStructure(st, side);
  const vsMarket = coinVsMarket(tk, snap, engines.beta, engines.correlation);
  const lv = nearestLevels(st, price);
  const breadth = engines.breadth, funding = engines.funding, oi = engines.oi;
  const liquidity = engines.liquidity, cascade = engines.liquidation, recovery = engines.recovery;
  const betaRow = engines.beta && engines.beta.ok && engines.beta.coins[tk];
  const coinVac = liquidity && liquidity.ok && liquidity.coins[tk] && liquidity.coins[tk].vacuum;
  const fundingRow = funding && funding.available ? funding.coins[tk] : null;

  const breadthAdverse = breadth && breadth.ok && S.isNum(breadth.score) ? (side > 0 ? -breadth.score : breadth.score) : null;
  const btcRet4h = breadth && breadth.ok ? breadth.btc.ret4h : null;
  const btcAdverse = S.isNum(btcRet4h) ? (side > 0 ? -btcRet4h : btcRet4h) : null;

  /* ---- POSITION STRESS ----
     Distance to liquidation dominates deliberately. A position 4% from liquidation in a calm
     market is in more trouble than one 40% away during a cascade, and any weighting that says
     otherwise is measuring the wrong thing. */
  const parts = [
    { k: 'distanceToLiquidation', w: 0.30, v: S.isNum(distLiq) ? S.ramp(distLiq, 0.40, 0.03) : null },
    { k: 'unrealisedLoss', w: 0.18, v: S.isNum(roe) ? S.ramp(-roe, 0, 0.5) : S.ramp(-movePct, 0, 0.15) },
    { k: 'marketBreadthAgainst', w: 0.12, v: S.isNum(breadthAdverse) ? S.ramp(breadthAdverse, -10, 70) : null },
    { k: 'btcTrendAgainst', w: 0.10, v: S.isNum(btcAdverse) ? S.ramp(btcAdverse, -0.005, 0.05) : null },
    { k: 'coinUnderperforming', w: 0.10, v: vsMarket.ok ? (vsMarket.klass === (side > 0 ? 'weaker-than-market' : 'stronger-than-market') ? 1 : vsMarket.klass === 'market-driven' ? 0.4 : 0.15) : null },
    { k: 'structureAgainst', w: 0.09, v: fight ? (fight.fighting ? 1 : 0.15) : null },
    { k: 'downsideAmplification', w: 0.06, v: (betaRow && betaRow.ok && side > 0) ? S.ramp(betaRow.downsideBeta, 1.0, 2.5) : null },
    { k: 'liquidityVacuum', w: 0.05, v: liquidity && liquidity.ok ? (coinVac ? 1 : 0) : null }
  ];
  const sp = S.scoreParts(parts);
  /* Past the liquidation level there is nothing left to weigh. Whatever the other components
     say, this position is either already gone or about to be, and a composite score of 46 would
     be actively misleading. */
  const stress = pastLiquidation ? 100 : (sp ? Math.round(sp.score * 100) : null);

  /* ---- THE AVERAGE-DOWN GATE ---- */
  const losing = movePct < 0;
  const checks = [];
  const add = (k, state, text) => checks.push({ k, state, text });   // state: pass | fail | unknown

  add('distanceToLiquidation',
    !S.isNum(distLiq) ? 'unknown' : distLiq >= SAFE_LIQ_DISTANCE ? 'pass' : 'fail',
    !S.isNum(distLiq) ? 'Liquidation price unknown — supply leverage or the venue figure.'
      : `Liquidation is ${(distLiq * 100).toFixed(1)}% away (needs ≥ ${SAFE_LIQ_DISTANCE * 100}%).`);
  add('btcNotMakingLowerLows',
    !btcSt || !btcSt.ok ? 'unknown' : btcSt.lastLowTag === 'LL' ? 'fail' : 'pass',
    !btcSt || !btcSt.ok ? 'BTC structure unreadable.' : btcSt.lastLowTag === 'LL' ? 'BTC is still printing lower lows.' : 'BTC has stopped making lower lows.');
  add('coinReclaimedStructure',
    !st.ok ? 'unknown' : st.verdict === 'bearish' && side > 0 ? 'fail' : 'pass',
    !st.ok ? 'Coin structure unreadable.' : (st.verdict === 'bearish' && side > 0) ? 'The coin is still in a lower-high / lower-low sequence.' : 'Coin structure is not actively against the position.');
  add('breadthImproving',
    !breadth || !breadth.ok || !S.isNum(breadth.score) ? 'unknown' : (side > 0 ? breadth.score > -20 : breadth.score < 20) ? 'pass' : 'fail',
    breadth && breadth.ok && S.isNum(breadth.score) ? `Market breadth ${breadth.score}.` : 'Breadth unavailable.');
  add('noActiveCascade',
    !cascade || !cascade.ok ? 'unknown' : cascade.cascade.detected && cascade.cascade.side === (side > 0 ? 'long' : 'short') ? 'fail' : 'pass',
    cascade && cascade.ok && cascade.cascade.detected ? `A ${cascade.cascade.side} cascade is in progress (${cascade.cascade.confidence}%).` : 'No cascade against this position detected.');
  add('noLiquidityVacuum', !liquidity || !liquidity.ok ? 'unknown' : coinVac || liquidity.marketVacuum ? 'fail' : 'pass',
    coinVac ? 'This coin is showing abnormal price impact — fills will be poor.' : liquidity && liquidity.marketVacuum ? 'Market-wide depth is impaired.' : 'Liquidity looks normal.');
  add('openInterestFlushed',
    !oi || !oi.available ? 'unknown' : oi.market.deleveraging || oi.market.oiChange < 0 ? 'pass' : 'fail',
    !oi || !oi.available ? 'DATA UNAVAILABLE — no open-interest feed, so it is not known whether the leverage has actually been flushed.' : `Open interest ${(oi.market.oiChange * 100).toFixed(1)}%.`);
  add('fundingNotAgainst',
    !fundingRow ? 'unknown' : (side > 0 ? fundingRow.rate < 0.0004 : fundingRow.rate > -0.0004) ? 'pass' : 'fail',
    !fundingRow ? 'DATA UNAVAILABLE — no funding feed for this coin.' : `Funding ${(fundingRow.rate * 100).toFixed(3)}% per 8h.`);

  const hardFail =
    pastLiquidation ||
    (S.isNum(distLiq) && distLiq < HARD_LIQ_DISTANCE) ||
    (cascade && cascade.ok && cascade.cascade.detected && cascade.cascade.side === (side > 0 ? 'long' : 'short')) ||
    (liquidity && liquidity.ok && (coinVac || liquidity.marketVacuum)) ||
    (btcSt && btcSt.ok && btcSt.lastLowTag === 'LL' && side > 0);

  const failed = checks.filter(x => x.state === 'fail');
  const unknown = checks.filter(x => x.state === 'unknown');

  const reclaimBand = st.ok && st.lastHigh
    ? { lo: st.lastHigh * 0.995, hi: st.lastHigh * 1.005 }
    : null;

  let addVerdict, addText;
  if (!losing) {
    addVerdict = 'not-applicable';
    addText = 'Position is not under water — this gate applies to adding into a loss.';
  } else if (hardFail) {
    addVerdict = 'no';
    addText = 'Do NOT average down yet. ' + (failed.length ? failed.map(f => f.text).join(' ') : 'Conditions are actively hostile.');
  } else if (failed.length === 0 && unknown.length <= 2) {
    addVerdict = 'conditions-improving';
    addText = reclaimBand
      ? `Adding exposure is only becoming more defensible after confirmation above ${fmtPx(reclaimBand.lo)}–${fmtPx(reclaimBand.hi)} with a higher low held above it. Nothing here is a recommendation to add.`
      : 'Conditions are no longer actively hostile, but there is no confirmed reclaim level to trade against yet.';
  } else {
    addVerdict = 'wait';
    addText = 'Do NOT average down yet. ' +
      (failed.length ? 'Unmet: ' + failed.map(f => f.text).join(' ') + ' ' : '') +
      (unknown.length ? 'Unknown: ' + unknown.map(f => f.k).join(', ') + '.' : '');
  }

  /* ---- RECOVERY REQUIREMENT ---- */
  let recoveryText;
  if (st.ok && st.lastHigh && side > 0) {
    recoveryText = `${tk} needs to reclaim ${fmtPx(st.lastHigh * 0.99)}–${fmtPx(st.lastHigh * 1.01)} and establish a higher low before the recovery thesis strengthens.`;
  } else if (st.ok && st.lastLow && side < 0) {
    recoveryText = `${tk} needs to lose ${fmtPx(st.lastLow * 0.99)}–${fmtPx(st.lastLow * 1.01)} and print a lower high before the short thesis strengthens.`;
  } else {
    recoveryText = `${tk} has not printed a clean pivot to trade against yet — no reclaim level can be quoted honestly.`;
  }

  const statusLabel = pastLiquidation ? 'PAST LIQUIDATION LEVEL'
    : !S.isNum(stress) ? 'UNKNOWN'
      : stress >= 80 ? 'CRITICAL' : stress >= 60 ? 'HIGH RISK' : stress >= 40 ? 'ELEVATED' : stress >= 20 ? 'MODERATE' : 'LOW';

  return {
    ok: true,
    tk, sym: pos.sym, side, sideLabel: side > 0 ? 'LONG' : 'SHORT',
    lev, entry, price,
    movePct, roe,
    liq, liqSource,
    liqEstimateNote: liqSource === 'estimated'
      ? 'Liquidation price is ESTIMATED from entry, side and leverage assuming isolated margin and a 0.5% maintenance rate. Your venue\'s figure is authoritative — enter it on the position to replace this.'
      : null,
    distanceToLiquidation: distLiq,
    distanceToLiquidationSigned: distLiqSigned,
    pastLiquidation,
    pastLiquidationNote: pastLiquidation
      ? `Price has passed the ${liqSource === 'estimated' ? 'estimated ' : ''}liquidation level for this position. If it is still open, the entry, leverage or liquidation price on record is wrong — check the position on your venue before acting on anything else here.`
      : null,
    distanceToBreakeven: distBreakeven,
    support: lv.support, resistance: lv.resistance,
    distanceToSupport: S.isNum(lv.support) ? (price - lv.support) / price : null,
    distanceToResistance: S.isNum(lv.resistance) ? (lv.resistance - price) / price : null,
    stress, statusLabel,
    stressCoverage: sp ? sp.coverage : null,
    stressInputs: sp ? sp.used : [], stressMissing: sp ? sp.missing : [],
    structure: st.ok ? { verdict: st.verdict, label: st.label, sequence: st.recent, lastHigh: st.lastHigh, lastLow: st.lastLow } : { error: st.reason },
    fighting: fight,
    vsMarket: vsMarket.ok ? { klass: vsMarket.klass, note: vsMarket.note, move4h: vsMarket.move4h, marketMove4h: vsMarket.marketMove4h, alpha: vsMarket.alpha } : { error: vsMarket.reason },
    beta: betaRow && betaRow.ok ? { beta: betaRow.beta, downsideBeta: betaRow.downsideBeta, amplification: betaRow.amplification } : null,
    funding: fundingRow || null,
    fundingAvailable: !!fundingRow,
    oiAvailable: !!(oi && oi.available),
    /* The risk map the brief asks for: CURRENT → SUPPORT → LIQUIDATION, as ordered rungs with
       the distance to each. */
    riskMap: buildRiskMap(price, lv, liq, side),
    averageDown: { verdict: addVerdict, text: addText, checks, hardFail },
    recoveryRequirement: recoveryText,
    marketRegime: engines.regimeInfo ? engines.regimeInfo.label : null,
    recovery: recovery && recovery.ok ? { recoveryProb: recovery.recoveryProb, continuationRisk: recovery.continuationRisk } : null,
    inputs: ['positionEntry', 'livePrice', 'coinStructure', 'breadth', 'betaToMarket']
      .concat(oi && oi.available ? ['openInterest'] : [])
      .concat(fundingRow ? ['funding'] : [])
  };
}

/* The ladder is SORTED BY PRICE, high to low — never hand-ordered.
   Hand-ordering assumed the liquidation level sits below a long and above a short, which is true
   right up until it isn't (a position already past its liquidation price, or a venue figure the
   trader typed the wrong side of). Sorting means the rendered ladder always reads as a price
   axis, so a level in an impossible place is immediately visible instead of silently misplaced. */
function buildRiskMap(price, lv, liq, side) {
  const d = px => S.isNum(px) && price > 0 ? (px - price) / price * 100 : null;
  const rungs = [{ k: 'current', label: 'CURRENT PRICE', px: price, distPct: 0 }];
  if (S.isNum(lv.resistance)) rungs.push({ k: 'resistance', label: 'RESISTANCE', px: lv.resistance, distPct: d(lv.resistance) });
  if (S.isNum(lv.support)) rungs.push({ k: 'support', label: 'SUPPORT', px: lv.support, distPct: d(lv.support) });
  if (S.isNum(liq)) rungs.push({ k: 'liquidation', label: 'LIQUIDATION', px: liq, distPct: d(liq) });
  return rungs.sort((a, b) => b.px - a.px);
}

module.exports = { positionRisk, estimateLiquidation, nearestLevels, buildRiskMap, DEFAULT_MMR, HARD_LIQ_DISTANCE, SAFE_LIQ_DISTANCE };
