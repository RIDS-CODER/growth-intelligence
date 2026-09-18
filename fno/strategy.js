/* ============================================================
   F&O — STRATEGY SELECTION AND POSITION SIZING

   The layer that turns "the chain says X" into "buy this, this many, and here is what it costs
   you if you are wrong".

   CAPITAL IS AN INPUT, NOT AN ASSUMPTION. Everything here is computed against a number the user
   supplies, because the same chain produces completely different advice at ₹50,000 and at
   ₹5,00,000 — and most options content is written as though lot sizes did not exist. One lot of
   NIFTY is seventy-five contracts. A 100-point premium is ₹7,500 whether the account holds fifty
   thousand rupees or fifty lakh, so on a small account a single lot of a perfectly sensible
   option can be fifteen percent of everything. The engine says that in those words rather than
   proposing the trade and leaving the arithmetic to the user.

   THE GENERIC PAYOFF ENGINE. Rather than special-casing eight named strategies, every structure
   is a list of legs and the same code computes its payoff, its breakevens, its maximum loss and
   its net Greeks. That matters because the named strategies are not the point — the payoff is —
   and because a bug in a special case for iron condors is a bug nobody finds until an iron
   condor loses money.

   UNBOUNDED LOSS IS DETECTED, NOT ASSUMED. The engine works out from the payoff itself whether
   a structure's loss is capped, by looking at the slope in both tails. Nothing is labelled
   "defined risk" because of its name.

   ON SELLING PREMIUM. Short structures are included, because refusing to model them would not
   stop anyone trading them. They are gated hard: an undefined-risk short is only proposed when
   the account holds a multiple of the estimated margin, the estimate is labelled as an estimate,
   and the risk statement is not softened. Margin RISES when volatility rises — precisely when a
   short is already losing — which is how a manageable loss becomes a forced square-off at the
   worst available price.
   ============================================================ */

'use strict';

const BS = require('./bs');
const S = require('../intel/stats');

const isNum = v => typeof v === 'number' && isFinite(v);
const r2 = v => Math.round(v * 100) / 100;

/* ============================================================
   THE PAYOFF ENGINE
   ============================================================ */

/* Value of one leg at expiry, per contract, in premium points. */
function legIntrinsic(leg, level) {
  return leg.type === 'CE' ? Math.max(0, level - leg.strike) : Math.max(0, leg.strike - level);
}

const sideSign = leg => (leg.side === 'SELL' ? -1 : 1);

/* Evaluate a structure: net cost, payoff profile, breakevens, extremes and net Greeks.

   `legs` each carry { type, strike, side, ratio, price, iv } — the price and iv come from the
   chain, so nothing here invents a quote. */
function evaluate(legs, ctx) {
  const c = ctx || {};
  const F = c.forward, T = c.T, r = isNum(c.r) ? c.r : 0.065;
  if (!Array.isArray(legs) || !legs.length) return { ok: false, reason: 'a structure needs at least one leg' };
  for (const l of legs) {
    if (!isNum(l.strike) || !isNum(l.price) || (l.type !== 'CE' && l.type !== 'PE')) {
      return { ok: false, reason: 'every leg needs a strike, a price and a call/put type' };
    }
  }

  /* Net debit in premium points. Positive = you pay, negative = you receive.
     A credit is NOT free money — it is the ceiling on the profit and usually nowhere near the
     floor on the loss. */
  let netDebit = 0;
  for (const l of legs) netDebit += sideSign(l) * (l.ratio || 1) * l.price;

  const payoffAt = level => {
    let v = 0;
    for (const l of legs) v += sideSign(l) * (l.ratio || 1) * legIntrinsic(l, level);
    return v - netDebit;
  };

  /* Scan a wide grid to find the extremes and the breakevens. The grid spans ±40% of the forward,
     which comfortably brackets every listed strike on an index chain.

     EVERY STRIKE IS ADDED TO THE GRID EXPLICITLY. An option payoff is piecewise linear with its
     kinks at the strikes, so its maximum and minimum always occur AT a strike or out in the tails
     — never between them. A uniform grid steps about 30 points on SENSEX and can miss a strike by
     15, which quietly understates the worst case: a long straddle reported ₹17,858 of risk when
     the true figure was the full ₹18,065 premium. Small in percentage terms and exactly the wrong
     direction, since the one number that must never be flattering is maximum loss. */
  const lo = F * 0.6, hi = F * 1.4;
  const steps = 2000;
  const levels = [];
  for (let i = 0; i <= steps; i++) levels.push(lo + (hi - lo) * i / steps);
  for (const l of legs) if (l.strike > lo && l.strike < hi) levels.push(l.strike);
  levels.sort((a, b) => a - b);

  const grid = [];
  let maxP = -Infinity, minP = Infinity, maxAt = null, minAt = null;
  for (const level of levels) {
    const p = payoffAt(level);
    grid.push({ level, payoff: p });
    if (p > maxP) { maxP = p; maxAt = level; }
    if (p < minP) { minP = p; minAt = level; }
  }

  /* UNBOUNDED-ness is read off the tail slopes rather than from the structure's name. Compare the
     payoff at two points far out on each side: a non-zero slope there means the profile keeps
     going, and that is what "unlimited" actually means. */
  const slopeUp = (payoffAt(hi) - payoffAt(hi * 0.98)) / (hi * 0.02);
  const slopeDown = (payoffAt(lo * 1.02) - payoffAt(lo)) / (lo * 0.02);
  const unboundedProfitUp = slopeUp > 1e-9;
  const unboundedLossUp = slopeUp < -1e-9;
  const unboundedProfitDown = slopeDown < -1e-9;
  const unboundedLossDown = slopeDown > 1e-9;

  const maxLoss = (unboundedLossUp || unboundedLossDown) ? Infinity : -minP;
  const maxProfit = (unboundedProfitUp || unboundedProfitDown) ? Infinity : maxP;

  // Breakevens: sign changes on the grid, refined by bisection.
  const breakevens = [];
  for (let i = 1; i < grid.length; i++) {
    const a = grid[i - 1], b = grid[i];
    if ((a.payoff <= 0 && b.payoff > 0) || (a.payoff >= 0 && b.payoff < 0)) {
      let x0 = a.level, x1 = b.level;
      for (let k = 0; k < 60; k++) {
        const m = (x0 + x1) / 2;
        (payoffAt(x0) <= 0) === (payoffAt(m) <= 0) ? x0 = m : x1 = m;
      }
      breakevens.push((x0 + x1) / 2);
    }
  }

  /* Net Greeks, each leg priced at its own implied vol from the chain. Position delta in points
     of index per unit; the rupee conversion happens in `size` where the lot size is known. */
  const greeks = { delta: 0, gamma: 0, vega: 0, theta: 0, thetaDay: 0, decay1d: 0 };
  let greeksOk = isNum(F) && isNum(T);
  for (const l of legs) {
    if (!isNum(l.iv) || !greeksOk) { greeksOk = false; continue; }
    const v = BS.black76({ type: l.type, F, K: l.strike, T, sigma: l.iv, r });
    if (!v.ok || v.degenerate) { greeksOk = false; continue; }
    const w = sideSign(l) * (l.ratio || 1);
    greeks.delta += w * v.delta; greeks.gamma += w * v.gamma; greeks.vega += w * v.vega;
    greeks.theta += w * v.theta; greeks.thetaDay += w * v.thetaDay; greeks.decay1d += w * v.decay1d;
  }

  return {
    ok: true,
    legs, netDebit, isCredit: netDebit < 0,
    maxLoss, maxProfit,
    maxLossAt: maxLoss === Infinity ? null : minAt,
    maxProfitAt: maxProfit === Infinity ? null : maxAt,
    breakevens: breakevens.sort((a, b) => a - b),
    unbounded: {
      lossUp: unboundedLossUp, lossDown: unboundedLossDown,
      profitUp: unboundedProfitUp, profitDown: unboundedProfitDown,
      anyLoss: unboundedLossUp || unboundedLossDown
    },
    greeks: greeksOk ? greeks : null,
    greeksNote: greeksOk ? null : 'net Greeks unavailable — at least one leg had no solvable implied volatility',
    payoffAt,
    /* Risk-neutral odds of finishing beyond each breakeven. Useful, and NOT real-world
       probability — it embeds the risk premium the market charges. Labelled at the point of use. */
    riskNeutral: (isNum(F) && isNum(T) && isNum(c.atmIv))
      ? breakevens.map(b => ({ level: b, probBeyond: BS.probTouch(F, b, T, c.atmIv) ? BS.probTouch(F, b, T, c.atmIv).end : null }))
      : null
  };
}

/* ============================================================
   CAPITAL: WHAT THIS COSTS TO HOLD

   Three tiers of certainty, and they are not blended:

     EXACT       a net debit. You pay it, it is the most you can lose, there is nothing to model.
     NEAR-EXACT  a defined-risk spread. The exchange recognises the hedge, so margin is close to
                 (width x lot) less the credit — computable to within rounding.
     ESTIMATE    an undefined-risk short. SPAN is a portfolio risk model, not a formula. This is
                 a percentage of notional with wide error bars and it says so.
   ============================================================ */

function capitalRequired(ev, lotSize, cfg) {
  const m = (cfg && cfg.margin) || { shortOptionPctOfNotional: 0.12, bufferMultiple: 1.5 };

  if (ev.netDebit > 0 && !ev.unbounded.anyLoss) {
    return {
      perLot: ev.netDebit * lotSize,
      basis: 'net debit paid', certainty: 'exact',
      note: 'you pay this once; it is also the most you can lose'
    };
  }

  if (!ev.unbounded.anyLoss && isFinite(ev.maxLoss)) {
    /* A defined-risk spread. The exchange blocks the worst case, less whatever credit came in. */
    return {
      perLot: ev.maxLoss * lotSize,
      basis: 'maximum loss blocked as margin (the exchange recognises the hedge)',
      certainty: 'near-exact',
      note: 'verify against your broker\'s calculator, but a defined-risk spread margins close to its own worst case'
    };
  }

  /* Undefined risk. Estimate from notional across every short leg. */
  let notional = 0;
  for (const l of ev.legs) if (l.side === 'SELL') notional += l.strike * (l.ratio || 1) * lotSize;
  const est = notional * (m.shortOptionPctOfNotional || 0.12);
  return {
    perLot: est, basis: 'estimated SPAN + exposure margin', certainty: 'estimate',
    bufferMultiple: m.bufferMultiple || 1.5,
    note: `ESTIMATE ONLY — ${((m.shortOptionPctOfNotional || 0.12) * 100).toFixed(0)}% of ₹${Math.round(notional).toLocaleString('en-IN')} of short notional. SPAN is a risk model the exchange re-runs several times a day, not a formula, and it RISES when volatility rises — which is exactly when this position is already losing. Check your broker's margin calculator before placing.`
  };
}

/* ============================================================
   SIZING

   Position size comes from what the trade can LOSE, not from what the account can afford to buy.
   Those are different numbers and confusing them is the most expensive habit in retail trading.

   THE LOT GRANULARITY PROBLEM IS STATED, NOT ROUNDED AWAY. Options cannot be bought in
   fractions: one lot of NIFTY is seventy-five contracts. When a single lot exceeds the risk
   budget, the honest output is not "buy one lot anyway" and not silence — it is the sentence
   "one lot of this risks 15% of your capital, which is 7.5x your stated budget".
   ============================================================ */

function size(ev, o) {
  const capital = o.capital, lotSize = o.lotSize;
  const riskPct = isNum(o.riskPct) ? o.riskPct : 0.02;
  const cfg = o.costConfig;

  if (!isNum(capital) || capital <= 0) return { ok: false, reason: 'capital is required and must be positive' };
  if (!isNum(lotSize) || lotSize <= 0) return { ok: false, reason: 'no lot size — position sizing is meaningless without it' };

  const cap = capitalRequired(ev, lotSize, cfg);
  const budget = capital * riskPct;

  /* Worst case per lot, in rupees. For an unbounded structure there is no such number, and the
     engine says so rather than substituting the margin — margin is what you must post, not what
     you can lose, and on a naked short the second is larger without limit. */
  const lossPerLot = isFinite(ev.maxLoss) ? ev.maxLoss * lotSize : Infinity;

  const lots = isFinite(lossPerLot) && lossPerLot > 0 ? Math.floor(budget / lossPerLot) : 0;
  const affordableLots = cap.perLot > 0 ? Math.floor(capital / (cap.perLot * (cap.certainty === 'estimate' ? (cap.bufferMultiple || 1.5) : 1))) : 0;
  const finalLots = Math.max(0, Math.min(lots, affordableLots));

  const oneLotRiskPct = isFinite(lossPerLot) ? lossPerLot / capital : null;

  const out = {
    ok: true, capital,
    lots: finalLots, contracts: finalLots * lotSize, lotSize,
    capitalPerLot: r2(cap.perLot), capitalTotal: r2(cap.perLot * finalLots),
    capitalBasis: cap.basis, capitalCertainty: cap.certainty, capitalNote: cap.note,
    riskBudget: r2(budget), riskPct,
    maxLossPerLot: isFinite(lossPerLot) ? r2(lossPerLot) : null,
    maxLossTotal: isFinite(lossPerLot) ? r2(lossPerLot * finalLots) : null,
    oneLotRiskPct,
    limitedBy: null, blocked: false, reason: null
  };

  if (!isFinite(lossPerLot)) {
    out.blocked = affordableLots < 1;
    out.limitedBy = 'undefined risk';
    out.lots = out.blocked ? 0 : Math.min(affordableLots, Math.max(1, Math.floor(budget / Math.max(1, cap.perLot * 0.5))));
    out.contracts = out.lots * lotSize;
    out.capitalTotal = r2(cap.perLot * out.lots);
    out.reason = out.blocked
      ? `this structure can lose without limit and the account cannot fund even one lot with the ${cap.bufferMultiple || 1.5}x margin buffer required (estimated ₹${Math.round(cap.perLot * (cap.bufferMultiple || 1.5)).toLocaleString('en-IN')} needed against ₹${Math.round(capital).toLocaleString('en-IN')} available)`
      : 'sized against margin because there is no maximum loss to size against. A percentage-of-capital risk budget cannot be applied to a position whose loss has no ceiling.';
    return out;
  }

  if (finalLots < 1) {
    out.blocked = true;
    out.limitedBy = lots < 1 ? 'risk budget' : 'capital';
    out.reason = lots < 1
      ? `one lot risks ₹${Math.round(lossPerLot).toLocaleString('en-IN')}, which is ${(oneLotRiskPct * 100).toFixed(1)}% of your capital — ${(lossPerLot / budget).toFixed(1)}x your stated ${(riskPct * 100).toFixed(0)}% risk budget. Options cannot be bought in fractions, so at this capital this trade is not available at this risk setting.`
      : `one lot needs ₹${Math.round(cap.perLot).toLocaleString('en-IN')} against ₹${Math.round(capital).toLocaleString('en-IN')} of capital.`;
    return out;
  }

  if (lots < affordableLots) out.limitedBy = 'risk budget';
  else if (affordableLots < lots) out.limitedBy = 'capital';
  return out;
}

/* ============================================================
   BUILDING THE CANDIDATES

   Structures are built from the chain by DELTA rather than by a fixed number of strikes out,
   because "one strike out of the money" means a different thing on a weekly and a monthly, and a
   different thing again on BANKNIFTY than on NIFTY. Delta is the common language.
   ============================================================ */

function pickByDelta(analysis, type, targetDelta) {
  const want = Math.abs(targetDelta);
  let best = null, bestD = Infinity;
  for (const row of analysis.rows) {
    const leg = row[type];
    if (!leg || !leg.q || !isNum(leg.delta) || !isNum(leg.iv)) continue;
    if (leg.q.src === 'no-bid') continue;
    if (leg.tradeable === false) continue;              // wide quotes are excluded from proposals
    const d = Math.abs(Math.abs(leg.delta) - want);
    if (d < bestD) { bestD = d; best = { row, leg, type, strike: row.strike }; }
  }
  return best;
}

const mk = (pick, side) => pick && ({
  type: pick.type, strike: pick.strike, side, ratio: 1,
  price: pick.leg.q.px, iv: pick.leg.iv, delta: pick.leg.delta,
  key: pick.leg.key, tradingSymbol: pick.leg.tradingSymbol,
  bid: pick.leg.q.bid, ask: pick.leg.q.ask, spreadPct: pick.leg.q.spreadPct
});

/* The catalogue. Each entry says which market view it expresses and what it needs from the
   volatility read, so the selection below is a match rather than a ranking of unrelated things. */
const CATALOGUE = [
  {
    name: 'Long Call', view: 'up', volWant: 'cheap', risk: 'defined',
    build: a => { const p = pickByDelta(a, 'CE', 0.45); return p && [mk(p, 'BUY')]; },
    why: 'the simplest expression of an up view. All the upside, and the premium is the whole risk — which is also the whole problem: it decays every day you are right but early.'
  },
  {
    name: 'Long Put', view: 'down', volWant: 'cheap', risk: 'defined',
    build: a => { const p = pickByDelta(a, 'PE', 0.45); return p && [mk(p, 'BUY')]; },
    why: 'the direct expression of a down view, with the premium as the entire risk.'
  },
  {
    name: 'Bull Call Spread', view: 'up', volWant: 'any', risk: 'defined',
    build: a => {
      const lo = pickByDelta(a, 'CE', 0.45), hi = pickByDelta(a, 'CE', 0.22);
      return (lo && hi && hi.strike > lo.strike) ? [mk(lo, 'BUY'), mk(hi, 'SELL')] : null;
    },
    why: 'an up view at roughly half the premium of the outright call, because the strike you sell pays for part of the one you buy. The cost is a ceiling on the profit — which matters far less than it sounds when the alternative is paying for upside you did not expect anyway.'
  },
  {
    name: 'Bear Put Spread', view: 'down', volWant: 'any', risk: 'defined',
    build: a => {
      const hi = pickByDelta(a, 'PE', 0.45), lo = pickByDelta(a, 'PE', 0.22);
      return (hi && lo && lo.strike < hi.strike) ? [mk(hi, 'BUY'), mk(lo, 'SELL')] : null;
    },
    why: 'a down view financed by selling a further strike. Cheaper than the outright put and much less exposed to a volatility crush.'
  },
  {
    name: 'Bull Put Spread', view: 'up', volWant: 'expensive', risk: 'defined', credit: true,
    build: a => {
      const sell = pickByDelta(a, 'PE', 0.30), buy = pickByDelta(a, 'PE', 0.14);
      return (sell && buy && buy.strike < sell.strike) ? [mk(sell, 'SELL'), mk(buy, 'BUY')] : null;
    },
    why: 'collects premium on an up-or-sideways view with the loss capped by the strike you buy. Profits from time passing rather than from being right quickly.'
  },
  {
    name: 'Bear Call Spread', view: 'down', volWant: 'expensive', risk: 'defined', credit: true,
    build: a => {
      const sell = pickByDelta(a, 'CE', 0.30), buy = pickByDelta(a, 'CE', 0.14);
      return (sell && buy && buy.strike > sell.strike) ? [mk(sell, 'SELL'), mk(buy, 'BUY')] : null;
    },
    why: 'collects premium on a down-or-sideways view, capped by the strike you buy.'
  },
  {
    name: 'Long Straddle', view: 'move', volWant: 'cheap', risk: 'defined',
    build: a => {
      const c = pickByDelta(a, 'CE', 0.5), p = pickByDelta(a, 'PE', 0.5);
      return (c && p) ? [mk(c, 'BUY'), mk(p, 'BUY')] : null;
    },
    why: 'a bet on movement in either direction, and therefore a bet that the market has underpriced how far it will travel. Needs the move to beat the straddle price, which is the market\'s own estimate of it — so it only makes sense when you have a reason to think that estimate is low.'
  },
  {
    name: 'Long Strangle', view: 'move', volWant: 'cheap', risk: 'defined',
    build: a => {
      const c = pickByDelta(a, 'CE', 0.25), p = pickByDelta(a, 'PE', 0.25);
      return (c && p && c.strike > p.strike) ? [mk(c, 'BUY'), mk(p, 'BUY')] : null;
    },
    why: 'cheaper than the straddle and needs a bigger move. The most common way to be right about volatility and still lose.'
  },
  {
    name: 'Iron Condor', view: 'range', volWant: 'expensive', risk: 'defined', credit: true,
    build: a => {
      const sc = pickByDelta(a, 'CE', 0.20), bc = pickByDelta(a, 'CE', 0.09);
      const sp = pickByDelta(a, 'PE', 0.20), bp = pickByDelta(a, 'PE', 0.09);
      return (sc && bc && sp && bp && bc.strike > sc.strike && bp.strike < sp.strike)
        ? [mk(sp, 'SELL'), mk(bp, 'BUY'), mk(sc, 'SELL'), mk(bc, 'BUY')] : null;
    },
    why: 'sells both wings with the tails bought back, so the loss is capped on each side. The defined-risk way to be paid for a market that stays put.'
  },
  {
    name: 'Short Strangle', view: 'range', volWant: 'expensive', risk: 'undefined', credit: true,
    build: a => {
      const c = pickByDelta(a, 'CE', 0.16), p = pickByDelta(a, 'PE', 0.16);
      return (c && p && c.strike > p.strike) ? [mk(c, 'SELL'), mk(p, 'SELL')] : null;
    },
    why: 'the highest-probability, highest-consequence trade on the board. It wins most weeks and the losses have no ceiling. Included because refusing to model it would not stop anyone trading it — and gated hard for the same reason.'
  }
];

/* Which structures match the view. 'unsure' deliberately returns only the non-directional ones:
   a directional structure without a direction is a coin flip that pays costs either way. */
const VIEW_MAP = {
  up: ['up'], down: ['down'],
  neutral: ['range'], range: ['range'],
  move: ['move'], volatile: ['move'],
  unsure: ['range', 'move']
};

function propose(o) {
  const a = o.analysis;
  const vol = o.vol || {};
  const capital = o.capital;
  const view = String(o.view || 'unsure').toLowerCase();
  const riskPct = isNum(o.riskPct) ? o.riskPct : 0.02;
  const costs = o.costs;
  const allowUndefined = o.allowUndefinedRisk === true;

  if (!a || !a.ok) return { ok: false, reason: (a && a.reason) || 'no usable chain analysis' };
  if (!isNum(capital) || capital <= 0) {
    return { ok: false, reason: 'capital is required — every number below scales off it, and guessing one would be worse than asking' };
  }
  const wantViews = VIEW_MAP[view] || VIEW_MAP.unsure;
  const cfg = costs ? costs.rates() : null;

  const ctx = { forward: a.forward, T: a.T, r: a.r, atmIv: a.atmIv };
  const candidates = [], rejected = [];

  for (const spec of CATALOGUE) {
    if (!wantViews.includes(spec.view)) continue;

    if (spec.risk === 'undefined' && !allowUndefined) {
      rejected.push({
        name: spec.name, reason: 'undefined-risk structures are off by default. This one can lose more than the account holds; enable it deliberately if that is what you intend.'
      });
      continue;
    }

    const legs = spec.build(a);
    if (!legs || legs.some(l => !l)) {
      rejected.push({ name: spec.name, reason: 'the chain does not offer tradeable strikes at the deltas this structure needs — the wings are too wide or not quoted' });
      continue;
    }

    const ev = evaluate(legs, ctx);
    if (!ev.ok) { rejected.push({ name: spec.name, reason: ev.reason }); continue; }

    /* A NON-DIRECTIONAL STRUCTURE MUST ACTUALLY BE NON-DIRECTIONAL.

       Legs are chosen by delta from the strikes that are tradeable, and when the near-the-money
       strikes are quoting too wide — after hours, or on a thin board — the nearest tradeable pair
       can sit well away from the money. Build a "straddle" out of those and you get a structure
       whose name says volatility and whose net delta says direction. Observed live on SENSEX: a
       Long Straddle at a strike 0.8% above the forward, net delta −0.454. That is a bearish
       position, and a beginner reading the label would have had no way to know.

       So a 'move' or 'range' structure is checked against what it claims to be and rejected with
       a reason when it does not hold up. Rejecting is right rather than harsh: if the market will
       not quote the money, there is no neutral trade to be had on that board. */
    if ((spec.view === 'move' || spec.view === 'range') && ev.greeks && isNum(ev.greeks.delta)) {
      const cap = isNum(spec.maxNetDelta) ? spec.maxNetDelta : 0.20;
      if (Math.abs(ev.greeks.delta) > cap) {
        rejected.push({
          name: spec.name,
          reason: `this would have a net delta of ${ev.greeks.delta.toFixed(2)}, which is a directional bet rather than the neutral structure the name implies. The tradeable strikes nearest the money are too far from it — usually a sign the board is thin or the session is closed.`
        });
        continue;
      }
    }

    const sz = size(ev, { capital, lotSize: a.lotSize, riskPct, costConfig: cfg });
    if (!sz.ok) { rejected.push({ name: spec.name, reason: sz.reason }); continue; }

    /* Costs across every leg, both ways. A four-legged iron condor pays eight orders of
       brokerage on a round trip, which on a small position is most of the credit. */
    let costTotal = 0, costKnownSpread = true;
    if (costs && sz.lots > 0) {
      for (const l of legs) {
        const rt = costs.roundTrip({
          entryPrice: l.price, qty: sz.lots * a.lotSize,
          direction: l.side === 'SELL' ? 'SHORT' : 'LONG',
          bid: l.bid, ask: l.ask, exchange: a.exchange
        });
        if (rt.ok) { costTotal += rt.total; if (!rt.slippageKnown) costKnownSpread = false; }
      }
    }

    const grossMax = isFinite(ev.maxProfit) ? ev.maxProfit * a.lotSize * sz.lots : null;
    const netMax = grossMax != null ? grossMax - costTotal : null;

    candidates.push({
      name: spec.name, view: spec.view, risk: spec.risk, credit: !!spec.credit,
      why: spec.why, volWant: spec.volWant,
      legs: legs.map(l => ({
        side: l.side, type: l.type, strike: l.strike, price: l.price,
        iv: l.iv, delta: l.delta, tradingSymbol: l.tradingSymbol, key: l.key, spreadPct: l.spreadPct
      })),
      netDebit: r2(ev.netDebit), netDebitRupees: r2(ev.netDebit * a.lotSize * Math.max(1, sz.lots)),
      isCredit: ev.isCredit,
      maxLoss: isFinite(ev.maxLoss) ? r2(ev.maxLoss) : null,
      maxProfit: isFinite(ev.maxProfit) ? r2(ev.maxProfit) : null,
      unbounded: ev.unbounded,
      breakevens: ev.breakevens.map(b => r2(b)),
      greeks: ev.greeks, greeksNote: ev.greeksNote,
      sizing: sz,
      costs: { total: r2(costTotal), spreadKnown: costKnownSpread, legs: legs.length, ordersPerRoundTrip: legs.length * 2 },
      netMaxProfit: netMax != null ? r2(netMax) : null,
      costAsShareOfMaxProfit: grossMax > 0 ? costTotal / grossMax : null,
      score: null, notes: []
    });
  }

  /* ---- rank ----
     The volatility read decides whether buying or selling premium is favoured, and a structure
     whose volWant contradicts it is penalised rather than hidden — the user should see that a
     long straddle was considered and why it lost. */
  const volVerdict = vol.verdict || null;
  for (const c of candidates) {
    const parts = [];
    // Does the structure agree with the volatility read?
    if (volVerdict) {
      const good = (c.volWant === 'cheap' && /cheap/.test(volVerdict)) ||
        (c.volWant === 'expensive' && /expensive/.test(volVerdict)) ||
        c.volWant === 'any';
      const bad = (c.volWant === 'cheap' && /expensive/.test(volVerdict)) ||
        (c.volWant === 'expensive' && /cheap/.test(volVerdict));
      parts.push({ k: 'volFit', w: 0.35, v: good ? 0.9 : bad ? 0.1 : 0.5 });
      if (bad) c.notes.push(`this structure wants ${c.volWant} volatility and the read is "${volVerdict}" — it is working against the pricing`);
    } else {
      parts.push({ k: 'volFit', w: 0.35, v: null });
    }

    // Can it actually be traded at this capital?
    parts.push({ k: 'sizable', w: 0.30, v: c.sizing.blocked ? 0 : (c.sizing.lots >= 2 ? 1 : 0.6) });
    if (c.sizing.blocked) c.notes.push(c.sizing.reason);
    else if (c.sizing.lots === 1) c.notes.push('only one lot fits — there is no way to scale out of this position in pieces');

    // How much of the upside do costs take?
    const cs = c.costAsShareOfMaxProfit;
    parts.push({ k: 'costDrag', w: 0.20, v: isNum(cs) ? S.clamp(1 - cs * 3, 0, 1) : null });
    if (isNum(cs) && cs > 0.2) c.notes.push(`costs are ${(cs * 100).toFixed(0)}% of the best case — ${c.costs.ordersPerRoundTrip} orders of brokerage on a position this size`);

    // Defined risk is preferred, explicitly and by default.
    parts.push({ k: 'definedRisk', w: 0.15, v: c.risk === 'defined' ? 1 : 0.2 });

    const sc = S.scoreParts(parts);
    c.score = sc ? sc.score : null;
    c.scoreCoverage = sc ? sc.coverage : 0;
  }

  candidates.sort((x, y) => (y.score || 0) - (x.score || 0));
  const tradeable = candidates.filter(c => !c.sizing.blocked);

  /* WHEN NOTHING FITS, SAY WHAT WOULD.

     "Nothing is tradeable" is true and nearly useless on its own — and it is the answer most
     Indian retail accounts will get, because one lot of NIFTY is seventy-five contracts and a 2%
     risk budget on a small account is a few thousand rupees. The user is then left to work out
     whether they are ten percent short of the capital or ten times short, which is exactly the
     arithmetic they came here to avoid.

     So the cheapest structure on the board is identified, and both levers are quantified: the
     capital that would permit it at the current risk setting, and the risk setting that would
     permit it at the current capital. Naming the second is not a recommendation to take it — a
     6% risk budget is a real decision with real consequences — but hiding the number does not
     make the decision go away, it just makes it uninformed. */
  let requirement = null;
  if (!tradeable.length && candidates.length) {
    const withLoss = candidates.filter(c => isNum(c.sizing.maxLossPerLot) && c.sizing.maxLossPerLot > 0);
    if (withLoss.length) {
      const cheapest = withLoss.reduce((a2, b) => (b.sizing.maxLossPerLot < a2.sizing.maxLossPerLot ? b : a2));
      const perLot = cheapest.sizing.maxLossPerLot;
      requirement = {
        cheapest: cheapest.name,
        maxLossPerLot: perLot,
        capitalNeededAtThisRisk: Math.ceil(perLot / riskPct),
        shortfall: Math.max(0, Math.ceil(perLot / riskPct) - capital),
        riskPctNeededAtThisCapital: perLot / capital,
        message: `the smallest position available here is one lot of a ${cheapest.name}, risking ₹${Math.round(perLot).toLocaleString('en-IN')}. At a ${(riskPct * 100).toFixed(0)}% risk budget that needs ₹${Math.ceil(perLot / riskPct).toLocaleString('en-IN')} of capital — ₹${Math.max(0, Math.ceil(perLot / riskPct) - capital).toLocaleString('en-IN')} more than you have. Taking it at ₹${Math.round(capital).toLocaleString('en-IN')} would mean risking ${((perLot / capital) * 100).toFixed(1)}% on one trade.`,
        caution: perLot / capital > riskPct * 2
          ? `that is ${(perLot / capital / riskPct).toFixed(1)}x the risk per trade you said you wanted, and index options are not divisible below one lot. The two honest options are more capital or no position — not a quietly larger bet.`
          : null
      };
    }
  }

  return {
    ok: true, requirement,
    underlying: a.underlying, expiry: a.expiry, expiryDate: a.expiryDate,
    daysLeft: a.daysLeft, forward: a.forward, lotSize: a.lotSize,
    capital, riskPct, view,
    volVerdict, volConfidence: vol.confidence || null,
    candidates, best: tradeable[0] || null, rejected,
    blocked: candidates.filter(c => c.sizing.blocked).map(c => ({ name: c.name, reason: c.sizing.reason })),
    note: tradeable.length ? null
      : ('nothing on this chain can be traded within the given capital and risk budget. That is a finding, not a failure — the honest answer at this account size is often no position.'
        + (requirement ? ' ' + requirement.message : ''))
  };
}

module.exports = { propose, evaluate, size, capitalRequired, pickByDelta, CATALOGUE, VIEW_MAP };
