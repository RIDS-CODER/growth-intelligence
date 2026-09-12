/* ============================================================
   F&O — TRANSACTION COSTS

   The user's brief for this build was "as accurate as possible". For an Indian retail options
   account, the largest single source of inaccuracy in any P&L projection is not the pricing
   model — it is pretending the trade is free. So this file is deliberately exhaustive, and it
   itemises rather than returning one blended number, because the composition is the insight.

   THE INSIGHT THE ITEMISATION EXISTS TO SURFACE
   Brokerage is a FLAT ₹20 per order at a discount broker. Everything else scales with turnover.
   That single fact means cost as a percentage of the position is not a constant — it explodes as
   the option gets cheaper:

     1 lot NIFTY (75), premium 200 → round trip ≈ ₹70   ≈ 0.47% of the position
     1 lot NIFTY (75), premium  20 → round trip ≈ ₹50   ≈ 3.3%  of the position

   The cheap far-out-of-the-money weekly — the one that looks like a lottery ticket and is the
   most common retail buy — starts more than three percent in the hole, and needs a 3% move in
   the premium before it has broken even. The engine has to know that before it recommends one.

   AND THE COST THAT IS NOT ON THE CONTRACT NOTE
   Every line below appears on a broker's contract note except the biggest one: the BID-ASK
   SPREAD. Buying at the ask and selling at the bid on a strike quoted 18.00 / 19.50 costs 1.50
   points a side — more than every tax and fee combined, and invisible in any statement. When
   chain.js supplies live quotes this module charges the real half-spread. When it cannot, it
   says so and falls back to an assumption, because an unstated assumption is how a backtest
   becomes a fantasy.

   RATES LIVE IN fno-costs.json, NOT IN THIS FILE. They are set by circular and have changed
   repeatedly; hardcoding them would bake in a wrong number that nobody can find later. The
   defaults here are a fallback if the config is missing, they carry the date they were written,
   and every estimate is marked unverified until the user has checked one real contract note.
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');

/* Fallback rates, as of the date below. Present so the module works with no config file at all;
   the config file is the authority whenever it exists. */
const DEFAULTS = {
  asOf: '2024-10-01',
  verified: false,
  gst: 0.18,
  /* Options are a FLAT fee per order at every discount broker — there is no percentage
     alternative on them, unlike futures and equity intraday. Modelling options with a 0.03%
     alternative makes a cheap weekly look nearly free to trade, when the flat ₹20 is in fact the
     largest single charge on it. That inversion would have the engine recommending exactly the
     contracts it should be warning about. */
  brokerage: {
    options: { perOrder: 20, pctOfTurnover: null },
    futures: { perOrder: 20, pctOfTurnover: 0.0003 }
  },
  options: {
    sttSell: 0.001, sttExercise: 0.00125, stampDutyBuy: 0.00003, sebiTurnover: 0.000001,
    NSE: { transaction: 0.0003503, ipft: 0.000005, clearing: 0 },
    BSE: { transaction: 0.000325, ipft: 0.000005, clearing: 0 }
  },
  futures: {
    sttSell: 0.0000125, stampDutyBuy: 0.00002, sebiTurnover: 0.000001,
    NSE: { transaction: 0.0000173, ipft: 0.0000005, clearing: 0 },
    BSE: { transaction: 0.0000173, ipft: 0.0000005, clearing: 0 }
  },
  /* Margin is an ESTIMATE and is labelled as one wherever it surfaces — SPAN is a portfolio risk
     model run by the exchange over its own scenario file, not a formula anyone can reproduce. */
  margin: { shortOptionPctOfNotional: 0.12, bufferMultiple: 1.5 },
  slippage: { assumedHalfSpreadTicks: 1, tickSize: 0.05 }
};

const isNum = v => typeof v === 'number' && isFinite(v);
const r2 = v => Math.round(v * 100) / 100;          // exchanges settle in paise

/* ============================================================
   CONFIG LOADING

   Same contract as intel/calendar.js: re-read on mtime change, never crash on a malformed edit,
   and report what actually got used. A user who breaks the JSON at 9:10am must not lose the
   platform at 9:15 — they fall back to the built-in rates and are told so.
   ============================================================ */

function createCosts(opts) {
  const cfg = opts || {};
  const file = cfg.file || path.join(__dirname, '..', 'fno-costs.json');
  let cached = null, cachedMtime = 0, loadErr = null;

  function rates() {
    if (cfg.rates) return { ...DEFAULTS, ...cfg.rates, source: 'injected' };   // tests
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = 0; }
    if (cached && mtime === cachedMtime) return cached;
    if (!mtime) {
      cached = { ...DEFAULTS, source: 'built-in defaults (fno-costs.json not found)' };
      cachedMtime = 0; loadErr = 'config file not found';
      return cached;
    }
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Shallow-merge over the defaults so a partial edit cannot delete a whole rate family.
      cached = {
        ...DEFAULTS, ...j,
        brokerage: {
          options: { ...DEFAULTS.brokerage.options, ...((j.brokerage || {}).options || {}) },
          futures: { ...DEFAULTS.brokerage.futures, ...((j.brokerage || {}).futures || {}) }
        },
        options: { ...DEFAULTS.options, ...(j.options || {}) },
        futures: { ...DEFAULTS.futures, ...(j.futures || {}) },
        margin: { ...DEFAULTS.margin, ...(j.margin || {}) },
        slippage: { ...DEFAULTS.slippage, ...(j.slippage || {}) },
        source: path.basename(file)
      };
      cachedMtime = mtime; loadErr = null;
    } catch (e) {
      cached = { ...DEFAULTS, source: 'built-in defaults (fno-costs.json is not valid JSON)' };
      cachedMtime = mtime;
      loadErr = 'config file is not valid JSON: ' + String(e.message).slice(0, 80);
    }
    return cached;
  }

  /* ============================================================
     ONE LEG

     `qty` is CONTRACTS, not lots — 2 lots of NIFTY is qty 150. Every caller converts through the
     lot size from the live instrument master, so no lot size is ever written down in this file.

     Returns every line separately. The UI shows the breakdown because "₹62 of costs" invites
     an argument and "₹40 of it is flat brokerage on two orders" ends one.
     ============================================================ */
  function legCost(o) {
    const R = rates();
    const side = String(o.side || '').toUpperCase();
    const kind = o.kind === 'future' ? 'futures' : 'options';
    const exch = o.exchange === 'BSE' ? 'BSE' : 'NSE';
    const price = o.price, qty = o.qty;

    if (!isNum(price) || !isNum(qty) || price < 0 || qty <= 0) {
      return { ok: false, reason: 'price and quantity must be positive finite numbers' };
    }
    if (side !== 'BUY' && side !== 'SELL') {
      return { ok: false, reason: 'side must be BUY or SELL' };
    }

    const fam = R[kind], ex = fam[exch] || fam.NSE;

    /* TURNOVER IS PREMIUM, NOT NOTIONAL — for options, every ad-valorem charge below is levied
       on premium turnover (price x qty), not on strike x qty. Getting this wrong inflates the
       estimate by two orders of magnitude and would make every trade look unprofitable. For
       futures the turnover IS the contract value, because that is the traded price. */
    const turnover = price * qty;

    /* Whichever of the two the plan defines, and the lower of them when it defines both — which
       is how "₹20 or 0.03%, whichever is lower" is actually written for futures. Options have no
       percentage leg at a discount broker, so this resolves to the flat fee and stays flat all
       the way down to a 5-point strike. That flatness is the whole story of option scalping
       costs. */
    const bk = (R.brokerage && R.brokerage[kind]) || {};
    const perOrder = isNum(bk.perOrder) ? bk.perOrder : null;
    const pctBrok = isNum(bk.pctOfTurnover) ? bk.pctOfTurnover * turnover : null;
    const brokerage = perOrder != null && pctBrok != null ? Math.min(perOrder, pctBrok)
      : perOrder != null ? perOrder
        : pctBrok != null ? pctBrok : 0;

    const stt = side === 'SELL' ? (fam.sttSell || 0) * turnover : 0;
    const stamp = side === 'BUY' ? (fam.stampDutyBuy || 0) * turnover : 0;
    const transaction = (ex.transaction || 0) * turnover;
    const sebi = (fam.sebiTurnover || 0) * turnover;
    const ipft = (ex.ipft || 0) * turnover;
    const clearing = (ex.clearing || 0) * turnover;

    /* GST applies to services — brokerage, exchange transaction charges, SEBI and IPFT levies,
       clearing. It does NOT apply to STT or to stamp duty, which are taxes in their own right
       and not consideration for a service. Charging GST on STT is the most common error in
       home-made cost calculators and overstates costs by about 1.5%. */
    const gstBase = brokerage + transaction + sebi + ipft + clearing;
    const gst = (R.gst || 0) * gstBase;

    const total = brokerage + stt + stamp + transaction + sebi + ipft + clearing + gst;

    return {
      ok: true, side, kind, exchange: exch,
      price, qty, turnover: r2(turnover),
      items: {
        brokerage: r2(brokerage), stt: r2(stt), stampDuty: r2(stamp),
        transaction: r2(transaction), sebiTurnover: r2(sebi), ipft: r2(ipft),
        clearing: r2(clearing), gst: r2(gst)
      },
      total: r2(total),
      // What this leg costs expressed as premium points, so it can be compared against a target
      // without leaving the units the chain is quoted in.
      points: total / qty,
      pctOfTurnover: turnover > 0 ? total / turnover : null,
      // Flat brokerage is the part that does not scale — the single most useful diagnostic for
      // "why is this cheap option so expensive to trade".
      flatShare: total > 0 ? (brokerage + (R.gst || 0) * brokerage) / total : null,
      ratesAsOf: R.asOf, ratesVerified: R.verified === true, ratesSource: R.source,
      configError: loadErr
    };
  }

  /* ============================================================
     SLIPPAGE — the cost nobody's statement shows

     Charged as the half-spread on each side, because a marketable order lifts the offer going in
     and hits the bid coming out. If the caller has live bid/ask it is exact; if not, the
     fallback is flagged, never silently applied.
     ============================================================ */
  function slippageCost(o) {
    const R = rates();
    const qty = o.qty;
    if (!isNum(qty) || qty <= 0) return { ok: false, reason: 'quantity required' };

    if (isNum(o.bid) && isNum(o.ask) && o.ask > o.bid && o.bid > 0) {
      const half = (o.ask - o.bid) / 2;
      const mid = (o.ask + o.bid) / 2;
      return {
        ok: true, known: true,
        halfSpreadPoints: half, spreadPoints: o.ask - o.bid,
        spreadPctOfMid: mid > 0 ? (o.ask - o.bid) / mid : null,
        cost: r2(half * qty), points: half,
        note: null
      };
    }

    const ticks = isNum(R.slippage.assumedHalfSpreadTicks) ? R.slippage.assumedHalfSpreadTicks : 1;
    const tick = isNum(R.slippage.tickSize) ? R.slippage.tickSize : 0.05;
    const half = ticks * tick;
    return {
      ok: true, known: false,
      halfSpreadPoints: half, spreadPoints: half * 2, spreadPctOfMid: null,
      cost: r2(half * qty), points: half,
      /* THE HONEST LABEL. A one-tick assumption is roughly right for a near-the-money weekly
         index option in the middle of the session and badly wrong for anything else. Whoever
         reads this number has to know it was assumed rather than measured. */
      note: `no live bid/ask — assuming ${ticks} tick (${half.toFixed(2)} pts) of half-spread per side. Real spreads on far strikes and in the last minutes run many times this.`
    };
  }

  /* ============================================================
     THE ROUND TRIP — what the position must actually earn

     Everything downstream gates on this: if the expected move is smaller than the round trip,
     the trade loses money even when the direction is right. That is the single most common way
     a retail option buyer is wrong while being right.
     ============================================================ */
  function roundTrip(o) {
    const entryPrice = o.entryPrice, qty = o.qty;
    const long = o.direction !== 'SHORT';
    const exitPrice = isNum(o.exitPrice) ? o.exitPrice : entryPrice;   // cost at flat, for a gate

    const inLeg = legCost({ side: long ? 'BUY' : 'SELL', price: entryPrice, qty, kind: o.kind, exchange: o.exchange });
    if (!inLeg.ok) return inLeg;
    const outLeg = legCost({ side: long ? 'SELL' : 'BUY', price: exitPrice, qty, kind: o.kind, exchange: o.exchange });
    if (!outLeg.ok) return outLeg;

    const slipIn = slippageCost({ qty, bid: o.bid, ask: o.ask });
    const slipOut = slippageCost({ qty, bid: isNum(o.exitBid) ? o.exitBid : o.bid, ask: isNum(o.exitAsk) ? o.exitAsk : o.ask });

    const charges = inLeg.total + outLeg.total;
    const slippage = slipIn.cost + slipOut.cost;
    const total = charges + slippage;

    /* Breakeven is quoted three ways because three different questions get asked of it:
       how many POINTS the premium must move, what PERCENTAGE of the premium that is, and —
       once strategy.js supplies a delta — how far the INDEX must move to produce it. */
    const points = total / qty;
    return {
      ok: true,
      qty, entryPrice, direction: long ? 'LONG' : 'SHORT',
      charges: r2(charges), slippage: r2(slippage), total: r2(total),
      entryLeg: inLeg, exitLeg: outLeg,
      slippageKnown: slipIn.known && slipOut.known,
      slippageNote: slipIn.known ? null : slipIn.note,
      breakevenPoints: points,
      breakevenPct: entryPrice > 0 ? points / entryPrice : null,
      breakevenPrice: long ? entryPrice + points : entryPrice - points,
      flatShare: total > 0 ? (inLeg.items.brokerage + outLeg.items.brokerage) * (1 + (rates().gst || 0)) / total : null,
      ratesAsOf: inLeg.ratesAsOf, ratesVerified: inLeg.ratesVerified,
      ratesSource: inLeg.ratesSource, configError: loadErr
    };
  }

  /* Net P&L on a completed (or hypothetical) round trip, in rupees. */
  function netPnl(o) {
    const { entryPrice, exitPrice, qty } = o;
    if (!isNum(entryPrice) || !isNum(exitPrice) || !isNum(qty) || qty <= 0) {
      return { ok: false, reason: 'entry price, exit price and quantity are required' };
    }
    const long = o.direction !== 'SHORT';
    const rt = roundTrip({ ...o, exitPrice });
    if (!rt.ok) return rt;
    const gross = (long ? exitPrice - entryPrice : entryPrice - exitPrice) * qty;
    const net = gross - rt.total;
    return {
      ok: true,
      gross: r2(gross), costs: rt.total, net: r2(net),
      costAsPctOfGross: gross !== 0 ? rt.total / Math.abs(gross) : null,
      // Return on the premium actually laid out. For a short this is not the capital at risk —
      // that is margin, and margin is estimated in strategy.js and labelled as an estimate.
      returnOnPremium: entryPrice > 0 ? net / (entryPrice * qty) : null,
      roundTrip: rt
    };
  }

  /* ============================================================
     THE EXPIRY DECISION

     An in-the-money option left to expire is settled by the exchange; squared off, it is sold.
     These are taxed differently and they pay differently, and the gap is real money.

     WHAT THE INTERNET WILL TELL YOU IS OUT OF DATE. Before September 2019, STT on an exercised
     option was charged on the FULL SETTLEMENT VALUE — strike times quantity — which on a NIFTY
     contract meant thousands of rupees on an option worth a few hundred, and produced the
     well-known stories of accounts wiped out by letting a profitable option expire. That was
     amended: the charge is now on INTRINSIC VALUE. So the catastrophe is gone.

     AND THE SURVIVING FOLK RULE — "always square off, exercise is taxed higher" — IS ALSO WRONG,
     which is why this computes both routes instead of asserting one. Per rupee of value:

       square off :  0.100% STT + 0.035% exchange + GST on the exchange leg  ≈ 0.142%
                     ... plus another ₹20 of brokerage, plus the bid-ask spread
       let expire :  0.125% STT on intrinsic, and nothing else

     Selling saves 0.025% of intrinsic in STT and then hands most of it straight back in exchange
     charges, GST and spread. On a 20-lot deep in-the-money NIFTY position that is a ₹375 saving
     against ₹729 of extra charges: expiring is ₹354 BETTER. The rule only flips once the option
     still carries enough EXTRINSIC value to cover the gap — so the useful output is not a verdict
     but the CROSSOVER: how many points of time value have to be left on the table before selling
     is worth it. That is `breakevenExtrinsicPoints` below, and on expiry afternoon it is usually
     a fraction of a point, which is why squaring off is normally right and occasionally is not.

     THE TRAP THAT IS STILL CATASTROPHIC, AND WHY IT DOES NOT APPLY HERE: single-stock options
     in India are PHYSICALLY settled. Letting one expire in the money obliges you to take or
     give delivery of the full share value, which for one lot can be many times the premium, and
     brokers levy punitive penalties when the account cannot fund it. NIFTY, BANKNIFTY and
     SENSEX options are CASH settled, so this build is not exposed to it — but the distinction
     is flagged below so that extending this engine to stock options cannot silently inherit a
     model that assumes cash settlement.
     ============================================================ */
  function expiryDecision(o) {
    const R = rates();
    const type = o.type === 'PE' || o.type === 'put' ? 'PE' : 'CE';
    const { strike, settlement, qty } = o;
    const exch = o.exchange === 'BSE' ? 'BSE' : 'NSE';
    const cashSettled = o.cashSettled !== false;

    if (!isNum(strike) || !isNum(settlement) || !isNum(qty) || qty <= 0) {
      return { ok: false, reason: 'strike, settlement price and quantity are required' };
    }

    const intrinsic = Math.max(0, type === 'CE' ? settlement - strike : strike - settlement);
    const itm = intrinsic > 0;

    if (!itm) {
      return {
        ok: true, itm: false, intrinsic: 0,
        recommend: 'let it expire',
        reason: 'out of the money — it expires worthless and no exercise charges arise. Squaring off would only pay another round of brokerage for whatever scrap value remains.',
        expire: { proceeds: 0, costs: 0, net: 0 },
        squareOff: null, advantage: null,
        cashSettled, ratesAsOf: R.asOf, ratesVerified: R.verified === true
      };
    }

    /* ROUTE A — let it expire. Settled at intrinsic, STT at the exercise rate on intrinsic.
       Exchange transaction charges on exercised contracts vary by exchange and by whether the
       contract is squared off or settled, so they are excluded here and the result is marked
       approximate rather than being filled in with a guess. They are small next to the STT
       difference and do not change which route wins. */
    const exerciseValue = intrinsic * qty;
    const sttExercise = (R.options.sttExercise || 0) * exerciseValue;
    const expireNet = exerciseValue - sttExercise;

    /* ROUTE B — sell it in the market. Full sell-leg costs plus the spread. If the caller has
       not supplied a live price, the option is assumed to fetch its intrinsic value, which is
       the conservative assumption: it understates route B, so a recommendation to square off is
       never produced by optimism about the exit price. */
    const mktPrice = isNum(o.marketPrice) ? o.marketPrice : intrinsic;
    const sell = legCost({ side: 'SELL', price: mktPrice, qty, kind: 'option', exchange: exch });
    const slip = slippageCost({ qty, bid: o.bid, ask: o.ask });
    const squareOffNet = mktPrice * qty - sell.total - slip.cost;

    const advantage = squareOffNet - expireNet;
    const better = advantage > 0 ? 'square off' : 'let it expire';

    /* THE CROSSOVER — the number that actually settles the question for the next position too.
       Re-price the sale at bare intrinsic (no time value at all) and see how far behind it
       falls; that deficit, spread over the quantity, is how many points of extrinsic value the
       option must still carry for selling to be the better route. Computed rather than derived
       algebraically so it keeps working when a rate in the config changes. */
    const atIntrinsic = legCost({ side: 'SELL', price: intrinsic, qty, kind: 'option', exchange: exch });
    const sellNetAtIntrinsic = intrinsic * qty - atIntrinsic.total - slip.cost;
    const gap = expireNet - sellNetAtIntrinsic;                  // > 0 ⇒ expiring is ahead at zero time value
    const breakevenExtrinsicPoints = gap > 0 ? gap / qty : 0;

    return {
      ok: true, itm: true, type, strike, settlement, qty,
      intrinsic,
      extrinsic: mktPrice - intrinsic,
      expire: {
        proceeds: r2(exerciseValue),
        costs: r2(sttExercise),
        net: r2(expireNet),
        sttRate: R.options.sttExercise,
        basis: 'intrinsic value',
        approximate: true,
        note: 'exchange charges on settled contracts are excluded — they are small beside the STT difference and vary by exchange'
      },
      squareOff: {
        assumedPrice: mktPrice,
        priceAssumed: !isNum(o.marketPrice),
        proceeds: r2(mktPrice * qty),
        costs: r2(sell.total + slip.cost),
        net: r2(squareOffNet),
        sttRate: R.options.sttSell,
        slippageKnown: slip.known
      },
      recommend: better,
      advantage: r2(Math.abs(advantage)),
      advantagePoints: Math.abs(advantage) / qty,
      /* How much time value must remain for selling to beat expiring. Below this, exercise is
         the cheaper exit even though its tax rate is higher. */
      breakevenExtrinsicPoints,
      reason: advantage > 0
        ? `squaring off nets ₹${r2(Math.abs(advantage))} more: it captures the ${(mktPrice - intrinsic).toFixed(2)} points of time value still in the premium, which more than covers the extra leg of exchange charges and spread. Below ${breakevenExtrinsicPoints.toFixed(2)} points of time value this would reverse.`
        : `letting it expire nets ₹${r2(Math.abs(advantage))} more. Selling saves ${((R.options.sttExercise - R.options.sttSell) * 100).toFixed(3)}% of intrinsic in STT, but pays a whole extra leg of exchange charges, GST and spread on top — and with only ${(mktPrice - intrinsic).toFixed(2)} points of time value left there is nothing to capture. It would need ${breakevenExtrinsicPoints.toFixed(2)} points to be worth selling.`,
      cashSettled,
      /* The one warning that must never be dropped when this engine is pointed at anything other
         than an index. */
      settlementWarning: cashSettled ? null
        : 'PHYSICALLY SETTLED CONTRACT. Letting this expire in the money obliges delivery of the full underlying value, not a cash difference — many times the premium for one lot, with broker penalties if the account cannot fund it. Square off.',
      ratesAsOf: R.asOf, ratesVerified: R.verified === true, configError: loadErr
    };
  }

  /* ============================================================
     THE COST GATE

     The crypto side of this platform already refuses a setup whose first target does not clear
     round-trip friction by a margin. The same discipline belongs here, and it matters more,
     because an option's cost as a percentage of the position varies by an order of magnitude
     across the chain while a spot trade's does not.
     ============================================================ */
  function costGate(o) {
    const rt = roundTrip(o);
    if (!rt.ok) return rt;
    const target = o.targetPrice;
    const multiple = isNum(o.minMultiple) ? o.minMultiple : 1.5;

    if (!isNum(target)) {
      return { ...rt, pass: null, reason: 'no target supplied — cannot judge whether the move covers the costs' };
    }
    const long = o.direction !== 'SHORT';
    const grossMove = (long ? target - o.entryPrice : o.entryPrice - target);
    const required = rt.breakevenPoints * multiple;
    const pass = grossMove >= required;

    return {
      ...rt,
      pass,
      targetPrice: target,
      grossMovePoints: grossMove,
      requiredPoints: required,
      minMultiple: multiple,
      netAtTarget: r2(grossMove * o.qty - rt.total),
      reason: pass
        ? `target clears round-trip costs ${(grossMove / rt.breakevenPoints).toFixed(1)}x`
        : `target moves ${grossMove.toFixed(2)} points but ${required.toFixed(2)} are needed to clear costs ${multiple}x — this trade is priced to lose even if the direction is right`
    };
  }

  return { rates, legCost, slippageCost, roundTrip, netPnl, expiryDecision, costGate, DEFAULTS };
}

module.exports = createCosts;
module.exports.DEFAULTS = DEFAULTS;
