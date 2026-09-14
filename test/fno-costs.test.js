/* ============================================================
   F&O COST MODEL — tests

   A cost model cannot be proved the way a pricing formula can: the rates are set by circular,
   not by mathematics, and this sandbox cannot reach a broker to check them. So the tests are
   split accordingly, and the split is the honest part:

   ARITHMETIC tests pin what is checkable — that the charges compose correctly, that GST lands on
   services and not on statutory taxes, that the flat fee behaves like a flat fee, that a round
   trip is the sum of its legs. These would catch every coding error in the file.

   STRUCTURE tests pin the behaviour that must survive a rate change — that a cheaper option
   costs proportionally more, that the expiry comparison prefers whichever route actually nets
   more, that an unverified rate table says so on every single result it produces.

   What is NOT claimed anywhere here is that the shipped rates are current. They carry a date and
   a verified:false flag, and the test suite asserts that the flag propagates rather than
   asserting the numbers are right — because only a real contract note can settle that.
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const createCosts = require('../fno/costs');

const C = createCosts();
const NIFTY_LOT = 75;          // used only as a realistic quantity; nothing reads a lot size here

const close = (a, b, tol, msg) => assert.ok(
  Math.abs(a - b) <= tol, `${msg || 'differ'}: got ${a}, expected ${b}, |diff| ${Math.abs(a - b)} > ${tol}`);

/* ============================================================
   1. THE ARITHMETIC
   ============================================================ */

test('a single leg itemises to exactly the sum of its parts', () => {
  const leg = C.legCost({ side: 'BUY', price: 100, qty: NIFTY_LOT, exchange: 'NSE' });
  assert.ok(leg.ok, leg.reason);
  const sum = Object.values(leg.items).reduce((s, v) => s + v, 0);
  close(sum, leg.total, 0.02, 'items sum to the total');
  close(leg.turnover, 7500, 1e-9, 'turnover is premium x quantity');
});

test('turnover is PREMIUM, not notional — the error that would make every trade look unprofitable', () => {
  /* An option on a 24000 index with a 100-point premium has a notional of 1.8 million rupees and
     a premium turnover of 7500. Charging 0.035% against the wrong one of those is a 240x error.
     The test pins it by construction: doubling the premium doubles the ad-valorem charges, while
     the strike appears nowhere in the calculation at all. */
  const a = C.legCost({ side: 'SELL', price: 100, qty: NIFTY_LOT });
  const b = C.legCost({ side: 'SELL', price: 200, qty: NIFTY_LOT });
  // Tolerance is a paise: the itemised lines are rounded to settlement precision, so doubling a
  // rounded figure is not the same as rounding a doubled one.
  close(b.items.stt, a.items.stt * 2, 0.02, 'STT scales with premium');
  close(b.items.transaction, a.items.transaction * 2, 0.02, 'transaction charges scale with premium');
  assert.ok(a.total < 100, `a 7500-rupee position cannot cost ${a.total} to trade`);
});

test('STT is charged on the sell side only, stamp duty on the buy side only', () => {
  const buy = C.legCost({ side: 'BUY', price: 150, qty: NIFTY_LOT });
  const sell = C.legCost({ side: 'SELL', price: 150, qty: NIFTY_LOT });
  assert.equal(buy.items.stt, 0, 'no STT on a purchase');
  assert.ok(sell.items.stt > 0, 'STT on a sale');
  assert.ok(buy.items.stampDuty > 0, 'stamp duty on a purchase');
  assert.equal(sell.items.stampDuty, 0, 'no stamp duty on a sale');
  // Everything else is symmetric, so the sell leg costs more by exactly STT less stamp duty.
  close(sell.total - buy.total, sell.items.stt - buy.items.stampDuty, 0.02, 'the only asymmetry is STT vs stamp duty');
});

test('GST applies to services, never to STT or stamp duty', () => {
  /* Charging GST on STT is the commonest error in a home-made cost sheet and overstates the
     total by around 1.5%. Reconstructed here from first principles against the rate table. */
  const R = C.rates();
  const leg = C.legCost({ side: 'SELL', price: 100, qty: NIFTY_LOT });
  const taxable = leg.items.brokerage + leg.items.transaction + leg.items.sebiTurnover + leg.items.ipft + leg.items.clearing;
  close(leg.items.gst, R.gst * taxable, 0.02, 'GST is levied on the service charges only');
  // Explicitly: if GST had been applied to STT too, this would be larger by 0.18 x STT.
  assert.ok(leg.items.gst < R.gst * (taxable + leg.items.stt) - 0.01, 'GST must not be reaching STT');
});

test('option brokerage is FLAT all the way down — the charge that makes cheap strikes expensive', () => {
  /* No discount broker offers a percentage alternative on options; the flat fee applies whether
     the order is worth ₹375 or ₹150,000. Modelling it with a "or 0.03%, whichever is lower" leg
     — which IS how futures are priced — would charge 11 paise on a 5-point weekly and make the
     cheapest, worst-value contracts on the board look almost free to trade. */
  const R = C.rates();
  const flat = R.brokerage.options.perOrder;
  for (const price of [5, 20, 100, 500]) {
    const leg = C.legCost({ side: 'BUY', price, qty: NIFTY_LOT });
    close(leg.items.brokerage, flat, 1e-9, `options brokerage at premium ${price}`);
  }
  assert.equal(R.brokerage.options.pctOfTurnover, null, 'options have no percentage leg');

  // Futures DO have one, and there the lower of the two applies.
  const smallFut = C.legCost({ side: 'BUY', price: 5, qty: NIFTY_LOT, kind: 'future' });
  close(smallFut.items.brokerage, R.brokerage.futures.pctOfTurnover * 375, 0.01, 'percentage wins on a tiny futures order');
  const bigFut = C.legCost({ side: 'BUY', price: 24000, qty: NIFTY_LOT, kind: 'future' });
  close(bigFut.items.brokerage, R.brokerage.futures.perOrder, 1e-9, 'the flat fee caps a large futures order');
});

test('a round trip is its two legs plus slippage, and nothing else', () => {
  const rt = C.roundTrip({ entryPrice: 100, exitPrice: 120, qty: NIFTY_LOT, bid: 99.5, ask: 100.5 });
  assert.ok(rt.ok, rt.reason);
  close(rt.charges, rt.entryLeg.total + rt.exitLeg.total, 0.02, 'charges are the two legs');
  close(rt.total, rt.charges + rt.slippage, 0.02, 'total adds slippage');
  assert.equal(rt.entryLeg.side, 'BUY');
  assert.equal(rt.exitLeg.side, 'SELL');
  // A short opens with a sale and closes with a purchase.
  const short = C.roundTrip({ entryPrice: 100, exitPrice: 80, qty: NIFTY_LOT, direction: 'SHORT' });
  assert.equal(short.entryLeg.side, 'SELL');
  assert.equal(short.exitLeg.side, 'BUY');
});

test('breakeven is stated in points, in percent and as a price, all consistent', () => {
  const rt = C.roundTrip({ entryPrice: 100, qty: NIFTY_LOT });
  close(rt.breakevenPoints * NIFTY_LOT, rt.total, 0.02, 'points x quantity is the rupee cost');
  close(rt.breakevenPct, rt.breakevenPoints / 100, 1e-12, 'percent is points over premium');
  close(rt.breakevenPrice, 100 + rt.breakevenPoints, 1e-12, 'a long breaks even above its entry');
  const short = C.roundTrip({ entryPrice: 100, qty: NIFTY_LOT, direction: 'SHORT' });
  close(short.breakevenPrice, 100 - short.breakevenPoints, 1e-12, 'a short breaks even below its entry');
});

test('net P&L is gross less costs, and the sign conventions hold both ways', () => {
  const long = C.netPnl({ entryPrice: 100, exitPrice: 130, qty: NIFTY_LOT });
  close(long.gross, 30 * NIFTY_LOT, 1e-9, 'long gross');
  close(long.net, long.gross - long.costs, 0.02, 'net is gross less costs');
  assert.ok(long.net < long.gross, 'costs are never negative');

  const short = C.netPnl({ entryPrice: 100, exitPrice: 70, qty: NIFTY_LOT, direction: 'SHORT' });
  close(short.gross, 30 * NIFTY_LOT, 1e-9, 'a short profits when the premium falls');
  assert.ok(short.net > 0);

  // A losing trade loses the move AND the costs.
  const bad = C.netPnl({ entryPrice: 100, exitPrice: 90, qty: NIFTY_LOT });
  assert.ok(bad.net < -10 * NIFTY_LOT, 'a loser pays costs on top of the loss');
});

/* ============================================================
   2. THE STRUCTURAL TRUTH — why cheap options are expensive
   ============================================================ */

test('the cheaper the option, the larger the cost as a share of the position', () => {
  /* The headline finding this module exists to surface. Flat brokerage does not shrink with the
     premium, so the lottery-ticket weekly that looks like the cheap way to express a view is the
     most expensive thing on the board in percentage terms. */
  const prices = [10, 20, 50, 100, 200, 400];
  const pcts = prices.map(p => C.roundTrip({ entryPrice: p, qty: NIFTY_LOT }).breakevenPct);
  for (let i = 1; i < pcts.length; i++) {
    assert.ok(pcts[i] < pcts[i - 1],
      `cost share should fall as premium rises: ${prices[i - 1]} → ${(pcts[i - 1] * 100).toFixed(2)}%, ${prices[i]} → ${(pcts[i] * 100).toFixed(2)}%`);
  }
  // And the spread between the extremes is large enough to change a decision, not a rounding note.
  assert.ok(pcts[0] > pcts[pcts.length - 1] * 4,
    `a 10-point option should cost several times more proportionally than a 400-point one: ${(pcts[0] * 100).toFixed(2)}% vs ${(pcts[pcts.length - 1] * 100).toFixed(2)}%`);
  // A 20-point weekly starts more than 2% under water before the market has moved at all.
  const cheap = C.roundTrip({ entryPrice: 20, qty: NIFTY_LOT });
  assert.ok(cheap.breakevenPct > 0.02, `expected a cheap option to start >2% down, got ${(cheap.breakevenPct * 100).toFixed(2)}%`);
});

test('trading more lots amortises the flat fee', () => {
  const one = C.roundTrip({ entryPrice: 50, qty: NIFTY_LOT });
  const ten = C.roundTrip({ entryPrice: 50, qty: NIFTY_LOT * 10 });
  assert.ok(ten.breakevenPct < one.breakevenPct, 'ten lots is proportionally cheaper than one');
  assert.ok(one.flatShare > ten.flatShare, 'the flat share of the total falls with size');
  assert.ok(one.flatShare > 0.5, `on a single cheap lot brokerage should dominate, got ${(one.flatShare * 100).toFixed(0)}%`);
});

test('slippage is charged from live quotes when they exist and flagged when they do not', () => {
  const known = C.slippageCost({ qty: NIFTY_LOT, bid: 18.0, ask: 19.5 });
  assert.equal(known.known, true);
  close(known.halfSpreadPoints, 0.75, 1e-12, 'half of a 1.50 spread');
  close(known.cost, 0.75 * NIFTY_LOT, 0.01, 'half-spread x quantity');
  assert.equal(known.note, null, 'a measured spread needs no caveat');

  const assumed = C.slippageCost({ qty: NIFTY_LOT });
  assert.equal(assumed.known, false);
  assert.ok(assumed.note && /assuming/i.test(assumed.note), 'an assumed spread must say so');

  /* THE POINT OF MEASURING IT: on a wide strike the spread dwarfs every tax and fee combined.
     A model that ignores it would call this trade nearly free. */
  const wide = C.roundTrip({ entryPrice: 18.75, qty: NIFTY_LOT, bid: 18.0, ask: 19.5 });
  assert.ok(wide.slippage > wide.charges,
    `spread (₹${wide.slippage}) should exceed all charges (₹${wide.charges}) on a 1.50-wide quote`);
  assert.equal(wide.slippageKnown, true);

  // And a round trip with no quotes says its slippage was assumed.
  const blind = C.roundTrip({ entryPrice: 18.75, qty: NIFTY_LOT });
  assert.equal(blind.slippageKnown, false);
  assert.ok(blind.slippageNote, 'the round trip carries the caveat up to the caller');
});

/* ============================================================
   3. THE COST GATE
   ============================================================ */

test('the cost gate refuses a target that cannot clear the round trip', () => {
  // Ten points of premium on a 20-point option: plausible-looking, and it loses money.
  const thin = C.costGate({ entryPrice: 20, targetPrice: 20.4, qty: NIFTY_LOT });
  assert.equal(thin.pass, false);
  assert.ok(/priced to lose/.test(thin.reason), thin.reason);
  assert.ok(thin.netAtTarget < 0, 'hitting this target still loses money');

  const fat = C.costGate({ entryPrice: 100, targetPrice: 140, qty: NIFTY_LOT });
  assert.equal(fat.pass, true);
  assert.ok(fat.netAtTarget > 0);

  // No target is "cannot judge", not "fails".
  assert.equal(C.costGate({ entryPrice: 100, qty: NIFTY_LOT }).pass, null);

  // The multiple is the caller's to set and it bites.
  const strict = C.costGate({ entryPrice: 100, targetPrice: 103, qty: NIFTY_LOT, minMultiple: 5 });
  assert.equal(strict.pass, false);
});

/* ============================================================
   4. THE EXPIRY DECISION
   ============================================================ */

test('an out-of-the-money option is left to expire', () => {
  const d = C.expiryDecision({ type: 'CE', strike: 24500, settlement: 24000, qty: NIFTY_LOT });
  assert.ok(d.ok);
  assert.equal(d.itm, false);
  assert.equal(d.recommend, 'let it expire');
  assert.equal(d.expire.net, 0);
  assert.ok(/worthless/.test(d.reason));
});

test('exercise is taxed on intrinsic value, at the higher of the two rates', () => {
  /* The rate asymmetry, stated exactly: 0.125% on intrinsic when exercised against 0.1% on
     premium when sold. Both are read from the config so the relationship survives a rate edit;
     what is asserted is that exercise really is charged on INTRINSIC and really is the dearer
     rate — the two facts the recommendation turns on. */
  const R = C.rates();
  assert.ok(R.options.sttExercise > R.options.sttSell, 'exercise is the more expensive route per rupee');

  const d = C.expiryDecision({ type: 'CE', strike: 24000, settlement: 24300, qty: NIFTY_LOT });
  assert.equal(d.itm, true);
  close(d.intrinsic, 300, 1e-9, 'intrinsic is settlement less strike');
  close(d.expire.proceeds, 300 * NIFTY_LOT, 1e-9, 'settled at intrinsic');
  close(d.expire.costs, R.options.sttExercise * 300 * NIFTY_LOT, 0.02, 'STT on intrinsic value');
  assert.equal(d.expire.basis, 'intrinsic value');

  // A put in the money is the mirror image.
  const p = C.expiryDecision({ type: 'PE', strike: 24000, settlement: 23700, qty: NIFTY_LOT });
  close(p.intrinsic, 300, 1e-9, 'put intrinsic is strike less settlement');
});

test('squaring off wins when it nets more, and expiring wins when it does not', () => {
  /* Not asserted as a rule of thumb — asserted as arithmetic. The recommendation must agree with
     the two net figures it computed, whichever way they fall, so that a rate change or a bigger
     position flips the advice automatically instead of leaving a stale maxim in the code. */
  const cases = [
    { strike: 24000, settlement: 24300, qty: NIFTY_LOT, marketPrice: 302 },
    { strike: 24000, settlement: 24300, qty: NIFTY_LOT * 20, marketPrice: 300.5 },
    { strike: 24000, settlement: 24005, qty: NIFTY_LOT, marketPrice: 5.2 },
    { strike: 24000, settlement: 24800, qty: NIFTY_LOT * 5, marketPrice: 800 }
  ];
  for (const c of cases) {
    const d = C.expiryDecision({ type: 'CE', ...c });
    const better = d.squareOff.net > d.expire.net ? 'square off' : 'let it expire';
    assert.equal(d.recommend, better,
      `recommendation must follow the numbers: expire ₹${d.expire.net} vs square off ₹${d.squareOff.net}`);
    close(d.advantage, Math.abs(d.squareOff.net - d.expire.net), 0.02, 'the advantage is the gap');
  }
});

test('the folk rule "always square off" is wrong with no time value left, and the engine says so', () => {
  /* The received wisdom is that exercise is taxed higher so you should always sell. The
     arithmetic disagrees on a deep in-the-money position with nothing left to capture:

       STT saved by selling   0.025% of ₹15,00,000 = ₹375
       extra charges to sell  exchange + GST + brokerage + spread ≈ ₹729

     Expiring wins by around ₹354. Asserting this pins the engine to its own arithmetic rather
     than to a maxim, so a rate change flips the advice instead of leaving a stale rule in the
     code. */
  const deep = C.expiryDecision({ type: 'CE', strike: 24000, settlement: 25000, qty: NIFTY_LOT * 20, marketPrice: 1000 });
  assert.equal(deep.extrinsic, 0, 'no time value remains in this quote');
  assert.equal(deep.recommend, 'let it expire');
  assert.ok(deep.advantage > 100, `expected a material advantage, got ₹${deep.advantage}`);
  assert.ok(/extra leg of exchange charges/.test(deep.reason), deep.reason);

  // With enough time value still in the premium it flips, and the engine flips with it.
  const withTime = C.expiryDecision({ type: 'CE', strike: 24000, settlement: 25000, qty: NIFTY_LOT * 20, marketPrice: 1005 });
  assert.equal(withTime.recommend, 'square off');
});

test('the crossover — how much time value justifies selling — is reported and is correct', () => {
  /* The genuinely useful output: not a verdict but the threshold, so the same answer works for
     the next position too. Verified by construction — priced a hair either side of the reported
     crossover, the recommendation must change there and only there. */
  const base = { type: 'CE', strike: 24000, settlement: 25000, qty: NIFTY_LOT * 20 };
  const d = C.expiryDecision({ ...base, marketPrice: 1000 });
  const x = d.breakevenExtrinsicPoints;
  assert.ok(x > 0 && x < 5, `crossover should be a fraction of a point on this position, got ${x}`);

  const below = C.expiryDecision({ ...base, marketPrice: 1000 + x * 0.9 });
  const above = C.expiryDecision({ ...base, marketPrice: 1000 + x * 1.1 });
  assert.equal(below.recommend, 'let it expire', `at ${(x * 0.9).toFixed(3)} points of time value, expiring should still win`);
  assert.equal(above.recommend, 'square off', `at ${(x * 1.1).toFixed(3)} points of time value, selling should win`);

  /* And on a SMALL position the crossover is much larger in points, because the flat ₹20 and the
     spread are spread over far fewer contracts. This is why "square off" is right for a big book
     and often wrong for one lot. */
  const oneLot = C.expiryDecision({ type: 'CE', strike: 24000, settlement: 25000, qty: NIFTY_LOT, marketPrice: 1000 });
  assert.ok(oneLot.breakevenExtrinsicPoints > x,
    `one lot should need more points of time value (${oneLot.breakevenExtrinsicPoints.toFixed(3)}) than twenty (${x.toFixed(3)})`);
});

test('the market price is assumed conservatively when it is not supplied', () => {
  /* If the engine guessed a generous exit price it could talk the user into squaring off on
     optimism. Assuming the option fetches only its intrinsic value understates route B, so a
     recommendation to square off is never manufactured by a flattering assumption. */
  const d = C.expiryDecision({ type: 'CE', strike: 24000, settlement: 24300, qty: NIFTY_LOT });
  assert.equal(d.squareOff.priceAssumed, true);
  close(d.squareOff.assumedPrice, d.intrinsic, 1e-9, 'assumed to fetch intrinsic only');
  assert.equal(d.extrinsic, 0, 'no time value is assumed into existence');

  const told = C.expiryDecision({ type: 'CE', strike: 24000, settlement: 24300, qty: NIFTY_LOT, marketPrice: 305 });
  assert.equal(told.squareOff.priceAssumed, false);
  close(told.extrinsic, 5, 1e-9, 'time value comes from the quote, not from a guess');
});

test('physical settlement carries a warning that cash settlement does not', () => {
  /* Index options are cash settled and this build only trades indices. But a stock option left
     to expire in the money obliges delivery of the full share value, which for one lot can be
     many multiples of the premium. The flag exists so that pointing this engine at stock options
     later cannot silently inherit a model that assumes cash settlement. */
  const idx = C.expiryDecision({ type: 'CE', strike: 24000, settlement: 24300, qty: NIFTY_LOT });
  assert.equal(idx.cashSettled, true);
  assert.equal(idx.settlementWarning, null);

  const stock = C.expiryDecision({ type: 'CE', strike: 2400, settlement: 2430, qty: 250, cashSettled: false });
  assert.equal(stock.cashSettled, false);
  assert.ok(stock.settlementWarning && /PHYSICALLY SETTLED/.test(stock.settlementWarning), 'the warning must be unmissable');
  assert.ok(/delivery of the full underlying/.test(stock.settlementWarning));
});

/* ============================================================
   5. THE RATE TABLE, AND SAYING SO
   ============================================================ */

test('every result carries the rate vintage and its unverified status', () => {
  /* The rates are set by circular and this build cannot reach a broker to check them. The
     honesty requirement is therefore not "be right" — it is "never let a number leave this
     module without the caveat attached", so the UI cannot render a confident total from a table
     nobody has confirmed. */
  const leg = C.legCost({ side: 'BUY', price: 100, qty: NIFTY_LOT });
  const rt = C.roundTrip({ entryPrice: 100, qty: NIFTY_LOT });
  const ex = C.expiryDecision({ type: 'CE', strike: 24000, settlement: 24300, qty: NIFTY_LOT });
  for (const r of [leg, rt, ex]) {
    assert.ok(r.ratesAsOf, 'a result states which vintage of rates produced it');
    assert.equal(typeof r.ratesVerified, 'boolean', 'and whether anyone has checked them');
  }
  assert.equal(leg.ratesVerified, false, 'shipped rates are unverified until a contract note confirms them');
});

test('the shipped config is valid, complete, and matches the built-in fallback', () => {
  const file = path.join(__dirname, '..', 'fno-costs.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(j._README) && j._README.length > 5, 'the config explains itself to whoever edits it');
  assert.equal(j.verified, false, 'shipped as unverified');
  assert.ok(j.asOf, 'shipped with a date');
  assert.ok(/contract note/i.test(j._README.join(' ')), 'it tells the user how to verify');

  // Every rate the module reads must exist in the file, or a partial config would silently
  // fall through to a default the user cannot see.
  for (const k of ['sttSell', 'sttExercise', 'stampDutyBuy', 'sebiTurnover']) {
    assert.equal(typeof j.options[k], 'number', `options.${k} missing from the config`);
  }
  for (const ex of ['NSE', 'BSE']) {
    assert.equal(typeof j.options[ex].transaction, 'number', `options.${ex}.transaction missing`);
  }
  // The file and the in-code fallback must not drift apart.
  assert.deepEqual(j.options.NSE, createCosts.DEFAULTS.options.NSE, 'config and fallback NSE rates have diverged');
  assert.equal(j.options.sttSell, createCosts.DEFAULTS.options.sttSell, 'config and fallback STT have diverged');
  assert.deepEqual(j.brokerage.options, createCosts.DEFAULTS.brokerage.options, 'config and fallback option brokerage have diverged');
});

test('a broken or missing config degrades to defaults instead of taking the platform down', () => {
  /* A user editing rates at 9:10am must not lose the dashboard at 9:15. */
  const missing = createCosts({ file: '/nonexistent/fno-costs.json' });
  const leg = missing.legCost({ side: 'BUY', price: 100, qty: NIFTY_LOT });
  assert.ok(leg.ok, 'still prices with no config at all');
  assert.match(leg.ratesSource, /built-in defaults/);
  assert.ok(leg.configError, 'and says why');

  const tmp = path.join(__dirname, '..', '.tmp-broken-costs.json');
  fs.writeFileSync(tmp, '{ this is not json');
  try {
    const broken = createCosts({ file: tmp });
    const l2 = broken.legCost({ side: 'BUY', price: 100, qty: NIFTY_LOT });
    assert.ok(l2.ok, 'survives a malformed edit');
    assert.match(l2.ratesSource, /not valid JSON/);
    assert.ok(/not valid JSON/.test(l2.configError));
  } finally { fs.unlinkSync(tmp); }
});

test('injected rates override the file, so a user on a different broker plan is priced correctly', () => {
  const free = createCosts({ rates: { brokerage: { options: { perOrder: 0, pctOfTurnover: null } }, verified: true } });
  const leg = free.legCost({ side: 'BUY', price: 100, qty: NIFTY_LOT });
  assert.equal(leg.items.brokerage, 0, 'a zero-brokerage plan pays no brokerage');
  assert.equal(leg.ratesVerified, true);
  // Statutory charges do not disappear with the brokerage.
  assert.ok(leg.items.stampDuty > 0 && leg.items.transaction > 0, 'taxes and exchange charges remain');
  assert.ok(leg.total > 0);
});

test('bad inputs are refused with a reason, never priced as zero', () => {
  for (const bad of [
    { side: 'BUY', price: -1, qty: 75 },
    { side: 'BUY', price: 100, qty: 0 },
    { side: 'BUY', price: 100, qty: -75 },
    { side: 'HOLD', price: 100, qty: 75 },
    { side: 'BUY', price: null, qty: 75 }
  ]) {
    const r = C.legCost(bad);
    assert.equal(r.ok, false, `should refuse ${JSON.stringify(bad)}`);
    assert.ok(r.reason && r.reason.length > 10, 'and explain why');
  }
  assert.equal(C.expiryDecision({ type: 'CE', strike: 24000, qty: 75 }).ok, false, 'no settlement price, no decision');
  assert.equal(C.netPnl({ entryPrice: 100, qty: 75 }).ok, false, 'no exit price, no P&L');
});

/* ============================================================
   6. A WORKED TRADE, END TO END
   ============================================================ */

test('a realistic weekly trade prices out to a sane, checkable number', () => {
  /* One lot of a near-the-money NIFTY weekly, bought at 100 and sold at 130. The absolute
     magnitude is asserted loosely — the rates may move — but it is asserted, because a model
     that returned ₹6 or ₹600 for this trade would be wrong in a way no relative test catches. */
  const r = C.netPnl({ entryPrice: 100, exitPrice: 130, qty: NIFTY_LOT, bid: 99.75, ask: 100.25 });
  assert.ok(r.ok);
  close(r.gross, 2250, 1e-9, 'thirty points on seventy-five');
  assert.ok(r.costs > 40 && r.costs < 120, `round trip on a ₹7500 position should be tens of rupees, got ₹${r.costs}`);
  assert.ok(r.net > 2100 && r.net < 2225, `net should be a little under gross, got ₹${r.net}`);
  assert.ok(r.costAsPctOfGross < 0.06, 'costs are a small share of a 30% winner');
  assert.ok(r.returnOnPremium > 0.27, 'the return on the premium laid out is close to the gross move');

  /* The same trade as a scalp: two points instead of thirty. The costs do not shrink, so what
     looked like a 2% gain is most of the way to nothing. This is the comparison the Quick Trades
     panel needs to make before it proposes an option scalp. */
  const scalp = C.netPnl({ entryPrice: 100, exitPrice: 102, qty: NIFTY_LOT, bid: 99.75, ask: 100.25 });
  close(scalp.gross, 150, 1e-9);
  assert.ok(scalp.costAsPctOfGross > 0.3,
    `a 2-point scalp should surrender a large share of its gross to costs, got ${(scalp.costAsPctOfGross * 100).toFixed(0)}%`);
  assert.ok(scalp.net > 0, 'it still clears, but only just');
});
