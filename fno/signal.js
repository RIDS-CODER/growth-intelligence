/* ============================================================
   F&O — THE TRADE PLAN

   The user's request was "tell me when to buy the option, when to sell, everything". This is the
   everything: an entry with a limit, a stop expressed in the thing the thesis actually depends
   on, targets that are checked against what the market thinks is possible, and — the part almost
   every options plan omits — a DATE by which the trade is over whether or not it has worked.

   THE THREE MISTAKES THIS FILE IS ARRANGED AROUND.

   1. A PERCENTAGE STOP ON A PREMIUM IS NOT A STOP. "Exit at minus 30%" sounds like risk control
      and is mostly a decay detector: a long weekly option can lose 30% of its value over a
      weekend with the index unchanged, and the position gets closed for a reason that has
      nothing to do with the thesis being wrong. The stop belongs on the INDEX LEVEL — the thing
      the trade is actually a view about — and is then converted into the premium it implies, so
      the user can place an order and still know what they are really stopping out of.

   2. TIME IS THE POSITION'S LARGEST ENEMY AND IS USUALLY UNMANAGED. A stock position can be
      wrong for a month and recover. An option cannot. If the thesis has not started working by a
      specific date, the remaining extrinsic value is what is left to salvage and it shrinks
      hyperbolically from there. So every plan carries a time stop with a date on it.

   3. THE TARGET IS COMPARED TO THE MOVE THE MARKET IS PRICING. If the target needs a move larger
      than the straddle implies, the trade needs the market to be wrong about volatility as well
      as about direction — two bets, priced as one. The plan says so out loud before the position
      is opened rather than after it has failed.
   ============================================================ */

'use strict';

const BS = require('./bs');

const isNum = v => typeof v === 'number' && isFinite(v);
const r2 = v => Math.round(v * 100) / 100;
const rp = v => Math.round(v);

/* ============================================================
   REPRICING A STRUCTURE AT A FUTURE STATE

   What is this worth if the index is at L, d days from now? Every stop, target and time stop
   below is an application of this.

   STICKY STRIKE vs STICKY DELTA, AND WHY BOTH ARE RETURNED.
   When the index moves, does an option keep its own implied volatility (sticky strike), or does
   the whole smile slide along with the market so the option inherits the vol belonging to its
   new moneyness (sticky delta)? Real markets sit between the two and move between them by
   regime. Rather than pick one and present a single confident number, this reprices under both
   and returns the range — the gap between them IS the honest error bar, and on a steep skew it
   is not small.

   ONE LIMITATION STATED RATHER THAN MODELLED: in a sharp selloff, fixed-strike volatilities on
   an equity index typically RISE, above what either assumption predicts. Neither scenario here
   captures that, so a long put's value at a downside stop is, if anything, understated and a
   short put's loss is understated too. Modelling it properly needs a vol-of-vol estimate this
   platform has no history to fit, and inventing one would be worse than naming the gap.
   ============================================================ */

function repriceStructure(legs, o) {
  const F0 = o.forward, T0 = o.T, r = isNum(o.r) ? o.r : 0.065;
  const level = o.level;
  const days = isNum(o.daysLater) ? o.daysLater : 0;
  const skewSlope = isNum(o.skewSlope) ? o.skewSlope : 0;     // d(iv)/d(ln K), from the chain
  const T1 = Math.max(BS.MIN_T, T0 - days / 365);
  if (!isNum(F0) || !isNum(level) || level <= 0) return null;

  const shift = Math.log(level / F0);
  let sticky = 0, slide = 0, ok = true;

  for (const l of legs) {
    if (!isNum(l.iv) || !isNum(l.strike) || !isNum(l.price)) { ok = false; break; }
    const w = (l.side === 'SELL' ? -1 : 1) * (l.ratio || 1);

    // Sticky strike: the option keeps the vol it has.
    const a = BS.price(l.type, level, l.strike, T1, l.iv, r);

    /* Sticky delta: the smile travels with the index, so this strike now sits at a different
       moneyness and picks up the vol that belongs there. `skewSlope` is d(iv)/d(ln K) measured
       from the chain, so a move of `shift` in the index re-prices this strike's vol by
       −skewSlope·shift. Floored at 1% because a negative volatility is not a scenario. */
    const iv2 = Math.max(0.01, l.iv - skewSlope * shift);
    const b = BS.price(l.type, level, l.strike, T1, iv2, r);

    if (!isNum(a) || !isNum(b)) { ok = false; break; }
    sticky += w * a; slide += w * b;
  }
  if (!ok) return null;

  let paid = 0;
  for (const l of legs) paid += (l.side === 'SELL' ? -1 : 1) * (l.ratio || 1) * l.price;

  const lo = Math.min(sticky, slide), hi = Math.max(sticky, slide);
  return {
    level, daysLater: days, T: T1,
    valueStickyStrike: sticky, valueStickyDelta: slide,
    value: (sticky + slide) / 2, valueLow: lo, valueHigh: hi,
    pnl: (sticky + slide) / 2 - paid,
    pnlLow: lo - paid, pnlHigh: hi - paid,
    uncertainty: hi - lo
  };
}

/* ============================================================
   THE PLAN
   ============================================================ */

function plan(o) {
  const cand = o.candidate;
  const a = o.analysis;
  const vol = o.vol || {};
  const costs = o.costs;
  const now = isNum(o.now) ? o.now : Date.now();

  if (!cand || !Array.isArray(cand.legs) || !cand.legs.length) return { ok: false, reason: 'no structure to plan' };
  if (!a || !a.ok) return { ok: false, reason: 'no chain analysis' };

  const lotSize = a.lotSize;
  const lots = (cand.sizing && cand.sizing.lots) || 0;
  const qty = lots * lotSize;
  const long = !cand.isCredit;
  const ctx = { forward: a.forward, T: a.T, r: a.r, skewSlope: smileSlope(a) };

  /* ---- ENTRY ----
     A limit, always. Options move in ticks against a thin book and a market order on a
     four-legged structure is how a good idea becomes a bad fill. The limit is the mid plus a
     fraction of the spread — enough to get filled, not enough to pay the whole spread away. */
  const entryLegs = cand.legs.map(l => {
    const q = { bid: l.bid, ask: l.ask, spreadPct: l.spreadPct };
    const buying = l.side === 'BUY';
    const limit = isNum(l.bid) && isNum(l.ask) && l.ask >= l.bid
      ? (buying ? l.price + (l.ask - l.bid) * 0.25 : l.price - (l.ask - l.bid) * 0.25)
      : l.price;
    return {
      ...l,
      limitPrice: r2(Math.max(0.05, limit)),
      doNotPayBeyond: buying ? r2(l.ask) : null,
      doNotSellBelow: buying ? null : r2(l.bid),
      note: isNum(l.spreadPct) && l.spreadPct > 0.05
        ? `this leg's spread is ${(l.spreadPct * 100).toFixed(0)}% of its price — work the order, do not cross it`
        : null
    };
  });

  const entryConditions = [];
  if (a.quality && !a.quality.usable) entryConditions.push('DO NOT ENTER: the chain data is not currently reliable — ' + (a.quality.warnings[0] || 'see data quality'));
  if (a.quality && a.quality.midShare < 0.5) entryConditions.push('most strikes are quoting off last-traded prices rather than live bids and offers; wait for a two-sided market before working an order');
  if (vol.eventWarning) entryConditions.push(vol.eventWarning);
  if (o.eventBlocked) entryConditions.push('BLOCKED: a high-impact scheduled event falls inside the entry window');

  /* ---- WHAT THE INDEX HAS TO DO ----
     The number a retail option buyer most needs and least often sees: how far the underlying must
     travel before this position makes money, after costs. */
  const costTotal = (cand.costs && cand.costs.total) || 0;
  const costPoints = qty > 0 ? costTotal / qty : 0;
  const beAfterCosts = (cand.breakevens || []).map(b => ({
    level: r2(b),
    movePoints: r2(b - a.forward),
    movePct: (b - a.forward) / a.forward
  }));

  /* ---- STOP: on the INDEX, then converted to a premium ---- */
  const stopLevel = isNum(o.stopLevel) ? o.stopLevel : defaultStopLevel(a, cand, long);
  const stopIn1d = repriceStructure(cand.legs, { ...ctx, level: stopLevel, daysLater: 1 });
  const stopNow = repriceStructure(cand.legs, { ...ctx, level: stopLevel, daysLater: 0 });

  const stop = {
    underlyingLevel: r2(stopLevel),
    moveFromHere: r2(stopLevel - a.forward),
    movePct: (stopLevel - a.forward) / a.forward,
    premiumIfHitToday: stopNow ? r2(stopNow.value) : null,
    premiumIfHitTomorrow: stopIn1d ? r2(stopIn1d.value) : null,
    lossAtStop: stopIn1d ? rp(stopIn1d.pnl * qty) : null,
    lossRange: stopIn1d ? [rp(stopIn1d.pnlLow * qty), rp(stopIn1d.pnlHigh * qty)] : null,
    /* THE POINT OF EXPRESSING IT THIS WAY. A broker order is placed on a premium, but a premium
       stop fires on time decay and volatility alone. Both numbers are given so the order can be
       placed and the user still knows what they are actually stopping out of. */
    howToPlace: stopIn1d
      ? `place the stop on the PREMIUM at about ${r2(stopIn1d.value)} — but understand it represents the index reaching ${rp(stopLevel)}. If the premium reaches that level WITHOUT the index moving there, time and volatility took it, not your thesis.`
      : 'the premium equivalent of this stop could not be modelled — at least one leg has no solvable implied volatility',
    modelUncertainty: stopIn1d ? r2(stopIn1d.uncertainty) : null,
    uncertaintyNote: stopIn1d && stopIn1d.uncertainty > Math.abs(stopIn1d.value) * 0.08
      ? `the premium at that level could be anywhere between ${r2(stopIn1d.valueLow)} and ${r2(stopIn1d.valueHigh)} depending on how the volatility smile behaves on the way there — this skew is steep enough for that to matter`
      : null
  };

  /* ---- TARGETS, checked against what the market is pricing ---- */
  const em = a.expectedMove;
  const targets = [];
  const dir = long ? (netDirection(cand) >= 0 ? 1 : -1) : (netDirection(cand) >= 0 ? 1 : -1);

  if (em && isNum(em.points)) {
    for (const [label, mult] of [['half the implied move', 0.5], ['the full implied move', 1.0], ['1.5x the implied move', 1.5]]) {
      const level = a.forward + dir * em.points * mult;
      const at = repriceStructure(cand.legs, { ...ctx, level, daysLater: Math.min(2, a.daysLeft * 0.4) });
      if (!at) continue;
      targets.push({
        label, level: r2(level),
        movePoints: r2(level - a.forward), movePct: (level - a.forward) / a.forward,
        premium: r2(at.value), premiumRange: [r2(at.valueLow), r2(at.valueHigh)],
        grossPnl: rp(at.pnl * qty),
        netPnl: rp(at.pnl * qty - costTotal),
        multipleOfImpliedMove: mult
      });
    }
  }

  /* THE CENTRAL SANITY CHECK. If the target needs a move larger than the market's own implied
     move, the trade requires the market to be wrong about volatility AND about direction. That is
     two bets sold as one, and it is the most common reason a directionally-correct option trade
     still loses money. */
  const userTarget = isNum(o.targetLevel) ? o.targetLevel : null;
  let targetVerdict = null;
  if (userTarget && em && isNum(em.points)) {
    const need = Math.abs(userTarget - a.forward);
    const ratio = need / em.points;
    const at = repriceStructure(cand.legs, { ...ctx, level: userTarget, daysLater: Math.min(2, a.daysLeft * 0.4) });
    targetVerdict = {
      level: r2(userTarget), needPoints: r2(need), impliedMove: r2(em.points), ratio,
      premium: at ? r2(at.value) : null,
      netPnl: at ? rp(at.pnl * qty - costTotal) : null,
      inside: ratio <= 1,
      reading: ratio <= 0.6
        ? `your target is well inside the ${rp(em.points)}-point move the market is already pricing, so you are not relying on a volatility surprise. That is the comfortable case.`
        : ratio <= 1
          ? `your target needs ${(ratio * 100).toFixed(0)}% of the ${rp(em.points)}-point move the market is pricing — achievable, but you are paying for most of the move you expect to capture.`
          : `your target needs ${ratio.toFixed(1)}x the ${rp(em.points)}-point move the market is pricing. You are betting the market is wrong about direction AND about how far it can travel. Those are two bets and you are being charged for both.`
    };
  }

  /* ---- THE TIME STOP ----
     The part almost every options plan leaves out. An option has a date, and past a certain point
     what remains is not a position but a lottery ticket with a fee attached. */
  const timeStop = buildTimeStop(cand, a, ctx, now, qty, costTotal);

  /* ---- EXIT RULES, in the order they should be checked ---- */
  const exits = [];
  if (targets.length) exits.push({ trigger: 'target reached', action: `take it. At ${targets[0].label} this position is worth about ₹${targets[0].netPnl.toLocaleString('en-IN')} net`, priority: 1 });
  exits.push({ trigger: `the index reaches ${rp(stopLevel)}`, action: 'close. The view that justified this trade is no longer supported', priority: 2 });
  if (timeStop.ok) exits.push({ trigger: `${timeStop.date} with the thesis not working`, action: timeStop.action, priority: 3 });
  if (vol.eventWarning || o.eventInWindow) {
    exits.push({
      trigger: 'immediately after the scheduled event',
      action: long
        ? 'close regardless of direction. Implied vol collapses the moment the uncertainty resolves, and a long option can lose money on a move that went its way — being right about the event is not enough if you paid for the uncertainty around it.'
        : 'the crush is what you were paid for. Take it rather than holding for the last few points.',
      priority: 2
    });
  }
  exits.push({
    trigger: 'expiry approaching while in the money',
    action: 'square off rather than letting it settle, once the remaining time value covers the extra leg of charges. The cost model reports that crossover for this exact position size — it is usually a fraction of a point.',
    priority: 4
  });

  /* ---- WHAT KILLS THE TRADE ---- */
  const invalidation = [];
  invalidation.push(`the index closes beyond ${rp(stopLevel)}`);
  if (a.skew) invalidation.push('the skew inverts sharply against the position — the market repricing which tail it fears is information, whatever the index has done');
  if (long) invalidation.push('implied vol falls materially while the index goes nowhere: the premium bleeds from two directions at once and the position rarely recovers');
  else invalidation.push('implied vol expands while the position is short premium — this is the state that turns a small loss into a large one, and it arrives with a margin call attached');
  if (cand.unbounded && cand.unbounded.anyLoss) {
    invalidation.push('ANY gap through the short strike. This structure has no floor, and an overnight gap is not something a stop can protect against — the market reopens past your level, not at it.');
  }

  return {
    ok: true,
    structure: cand.name, underlying: a.underlying,
    expiryDate: a.expiryDate, daysLeft: r2(a.daysLeft),
    lots, contracts: qty, lotSize,
    entry: {
      legs: entryLegs,
      netDebit: cand.netDebit,
      netDebitRupees: qty > 0 ? rp(cand.netDebit * qty) : null,
      conditions: entryConditions,
      blocked: entryConditions.some(c => /^(DO NOT ENTER|BLOCKED)/.test(c)),
      orderNote: cand.legs.length > 1
        ? `${cand.legs.length} legs — place them as a single basket or spread order if your broker supports it. Legging in one at a time on a moving market is how a defined-risk structure becomes an accidental naked short.`
        : 'work the order at the limit; do not cross the spread on a thin book'
    },
    breakevens: beAfterCosts,
    costPoints: r2(costPoints),
    costNote: qty > 0
      ? `costs are ₹${rp(costTotal).toLocaleString('en-IN')}, which is ${r2(costPoints)} premium points across ${cand.costs.ordersPerRoundTrip} orders. The position starts that far down.`
      : null,
    stop, targets, targetVerdict, timeStop, exits, invalidation,
    maxLossRupees: cand.sizing && isNum(cand.sizing.maxLossTotal) ? cand.sizing.maxLossTotal : null,
    summary: summarise(cand, a, stop, targets, timeStop, qty, costTotal, long)
  };
}

/* The smile's slope in d(iv)/d(ln K), measured between the 25-delta wings. Used to reprice under
   the sticky-delta assumption. Zero when there is no measurable skew, which collapses both
   scenarios onto the same number — correctly, since with a flat smile they ARE the same. */
function smileSlope(a) {
  if (!a.skew || !isNum(a.skew.put25.iv) || !isNum(a.skew.call25.iv)) return 0;
  const dk = Math.log(a.skew.call25.strike / a.skew.put25.strike);
  if (!isNum(dk) || Math.abs(dk) < 1e-9) return 0;
  return (a.skew.call25.iv - a.skew.put25.iv) / dk;
}

/* Net directional exposure of a structure, from its legs' deltas. */
function netDirection(cand) {
  let d = 0;
  for (const l of cand.legs) if (isNum(l.delta)) d += (l.side === 'SELL' ? -1 : 1) * l.delta;
  return d;
}

/* A default stop at one standard deviation against the position — far enough not to be noise,
   near enough to matter. Overridable, because a stop is ultimately a statement about the thesis
   and only the person holding it knows where that breaks. */
function defaultStopLevel(a, cand, long) {
  const dir = netDirection(cand) >= 0 ? 1 : -1;
  const em = a.expectedMove;
  const oneSd = em && isNum(em.oneSd) ? em.oneSd : (isNum(a.atmIv) ? a.forward * a.atmIv * Math.sqrt(a.T) : a.forward * 0.01);
  return a.forward - dir * oneSd * (long ? 1 : 1.5);
}

/* THE TIME STOP.

   Set at the point where the decay curve turns vertical. For a long position that is roughly
   half the remaining life, or three days before expiry, whichever comes first — past that the
   remaining extrinsic value is small and falling hyperbolically, and holding on is no longer a
   trade. */
function buildTimeStop(cand, a, ctx, now, qty, costTotal) {
  const days = a.daysLeft;
  if (!isNum(days) || days <= 0) return { ok: false, reason: 'this expiry has passed' };
  const long = !cand.isCredit;

  const holdDays = long ? Math.max(0.5, Math.min(days * 0.5, days - 3)) : Math.max(0.5, days - 1);
  const when = now + holdDays * 86400000;
  const flat = repriceStructure(cand.legs, { ...ctx, level: a.forward, daysLater: holdDays });

  return {
    ok: true,
    inDays: r2(holdDays),
    date: new Date(when).toISOString().slice(0, 10),
    valueIfNothingHappens: flat ? r2(flat.value) : null,
    pnlIfNothingHappens: flat ? rp(flat.pnl * qty - costTotal) : null,
    decayShare: flat && cand.netDebit > 0 ? 1 - flat.value / cand.netDebit : null,
    action: long
      ? `close it. If the index has not moved by then this position has already surrendered ${flat && cand.netDebit > 0 ? ((1 - flat.value / cand.netDebit) * 100).toFixed(0) + '% of' : 'much of'} its premium to time, and what remains decays faster every day. Waiting for it to "come back" is paying rent on a view that has not happened.`
      : 'close it and take what the decay has given. The last days before expiry are where a short position\'s remaining profit is smallest and its gamma risk is largest — the worst trade-off on the board.',
    reason: long
      ? 'time decay accelerates hyperbolically into expiry; theta/365 understates the real loss by more each day. The extrinsic value left is what there is to salvage.'
      : 'gamma rises without limit into expiry, so a short position\'s exposure to a single move grows fastest exactly when the remaining premium is smallest.'
  };
}

function summarise(cand, a, stop, targets, timeStop, qty, costTotal, long) {
  const t0 = targets[0];
  const parts = [];
  parts.push(`${cand.name} on ${a.underlying}, ${cand.sizing.lots} lot${cand.sizing.lots === 1 ? '' : 's'} (${qty} contracts), expiring ${a.expiryDate}.`);
  parts.push(cand.isCredit
    ? `Collect ${Math.abs(cand.netDebit).toFixed(2)} points (₹${rp(Math.abs(cand.netDebit) * qty).toLocaleString('en-IN')}).`
    : `Pay ${cand.netDebit.toFixed(2)} points (₹${rp(cand.netDebit * qty).toLocaleString('en-IN')}).`);
  if (isNum(cand.sizing.maxLossTotal)) {
    const pct = isNum(cand.sizing.capital) && cand.sizing.capital > 0
      ? ` (${((cand.sizing.maxLossTotal / cand.sizing.capital) * 100).toFixed(1)}% of capital)` : '';
    parts.push(`Worst case ₹${rp(cand.sizing.maxLossTotal).toLocaleString('en-IN')}${pct}.`);
  }
  else parts.push('Worst case is UNBOUNDED — this position can lose more than the account holds.');
  parts.push(`Costs ₹${rp(costTotal).toLocaleString('en-IN')} round trip.`);
  if (t0) parts.push(`At ${t0.label} (index ${rp(t0.level)}) it nets about ₹${t0.netPnl.toLocaleString('en-IN')}.`);
  parts.push(`Out if the index reaches ${rp(stop.underlyingLevel)}${timeStop.ok ? `, or on ${timeStop.date} if nothing has happened` : ''}.`);
  return parts.join(' ');
}

module.exports = { plan, repriceStructure, smileSlope, netDirection, defaultStopLevel, buildTimeStop };
