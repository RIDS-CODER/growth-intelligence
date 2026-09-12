/* ============================================================
   F&O STRATEGY SELECTION AND TRADE PLANNING — tests

   The payoff engine is checked against payoffs worked out by hand, because that is the one part
   here with unarguable right answers: a 24000/24200 bull call spread bought for 60 points can
   make 140 and lose 60, and if the engine says anything else it is broken. Every named structure
   in the catalogue is run through the same checks — maximum loss, maximum profit, breakevens,
   and whether the loss is bounded — since the whole design rests on not special-casing them.

   THE UNBOUNDED-LOSS DETECTION GETS ITS OWN TESTS. Nothing is labelled defined-risk because of
   its name; the engine reads the tail slopes off the payoff. A test therefore builds an iron
   condor missing one of its protective wings — which still LOOKS like a condor — and requires
   the engine to notice that it now has no floor.

   THE SIZING TESTS ARE ABOUT SMALL ACCOUNTS, because that is where this advice is most often
   wrong and most expensive. One lot of NIFTY is seventy-five contracts whether the account holds
   fifty thousand rupees or fifty lakh. There is a test that a ₹50,000 account is told, in
   rupees and percentages, that a perfectly ordinary option is too big for it — rather than being
   handed the trade and left to work that out afterwards.
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const BS = require('../fno/bs');
const CH = require('../fno/chain');
const ST = require('../fno/strategy');
const SIG = require('../fno/signal');
const createCosts = require('../fno/costs');

const close = (a, b, tol, msg) => assert.ok(
  Math.abs(a - b) <= tol, `${msg || 'differ'}: got ${a}, expected ${b}, |diff| ${Math.abs(a - b)} > ${tol}`);

const NOW = Date.UTC(2026, 8, 15, 6, 0);
const EXPIRY = Date.UTC(2026, 8, 22);
const LOT = 75;
const costs = createCosts();

/* A realistic NIFTY board, priced off a known forward and smile — the same construction the
   chain tests use, so the analytics feeding strategy.js are the ones already proven correct. */
function board(opts) {
  const o = opts || {};
  const F = o.F || 24000;
  const expiry = o.expiry || EXPIRY;
  const now = o.now || NOW;
  const r = 0.065, step = 50, n = o.n || 40;
  const smile = o.smile || (K => 0.13 - 0.5 * Math.log(K / F) + 2 * Math.pow(Math.log(K / F), 2));
  const T = BS.yearsToExpiry(now, expiry);
  const strikes = [];
  const centre = Math.round(F / step) * step;
  for (let i = -n; i <= n; i++) strikes.push(centre + i * step);

  const byStrike = {}, quotes = {};
  for (const K of strikes) {
    byStrike[K] = { strike: K, CE: null, PE: null };
    for (const type of ['CE', 'PE']) {
      const key = `NSE_FO|${K}${type}`;
      byStrike[K][type] = { key, tradingSymbol: `NIFTY${K}${type}`, lotSize: LOT, strike: K, type, expiry };
      const px = BS.price(type, F, K, T, smile(K), r);
      quotes[key] = { ltp: px, bid: px * 0.995, ask: px * 1.005, oi: 1000, volume: 500 };
    }
  }
  const chain = {
    underlying: 'NIFTY', name: 'NIFTY 50', exchange: 'NSE',
    expiry, lotSize: LOT, strikes, byStrike, strikeStep: step,
    strikeCount: strikes.length, pairedStrikes: strikes.length
  };
  return CH.analyse({ chain, quotes, now, r });
}

const leg = (type, strike, side, price, iv) => ({ type, strike, side, ratio: 1, price, iv: iv || 0.13 });
const ctx = { forward: 24000, T: 7 / 365, r: 0.065, atmIv: 0.13 };

/* ============================================================
   1. THE PAYOFF ENGINE, AGAINST HAND-WORKED ANSWERS
   ============================================================ */

test('a long call: loss capped at the premium, profit unbounded, breakeven at strike plus premium', () => {
  const ev = ST.evaluate([leg('CE', 24000, 'BUY', 100)], ctx);
  assert.ok(ev.ok);
  close(ev.netDebit, 100, 1e-9, 'you pay the premium');
  close(ev.maxLoss, 100, 1e-6, 'and that is the whole risk');
  assert.equal(ev.maxProfit, Infinity, 'upside is unbounded');
  assert.equal(ev.unbounded.profitUp, true);
  assert.equal(ev.unbounded.anyLoss, false, 'a long option cannot lose more than it cost');
  assert.equal(ev.breakevens.length, 1);
  close(ev.breakevens[0], 24100, 0.5, 'breakeven is strike plus premium');
  close(ev.payoffAt(24300), 200, 1e-6, 'at 24300 it is worth 300, less the 100 paid');
  close(ev.payoffAt(23000), -100, 1e-6, 'below the strike it is the premium, all of it');
});

test('a short call: profit capped at the premium and loss with no floor at all', () => {
  const ev = ST.evaluate([leg('CE', 24000, 'SELL', 100)], ctx);
  close(ev.netDebit, -100, 1e-9, 'a credit');
  assert.equal(ev.isCredit, true);
  close(ev.maxProfit, 100, 1e-6, 'the premium is the ceiling');
  assert.equal(ev.maxLoss, Infinity, 'and there is no floor');
  assert.equal(ev.unbounded.lossUp, true);
  assert.equal(ev.unbounded.anyLoss, true);
  close(ev.payoffAt(25000), -900, 1e-6, 'at 25000 the loss is 1000 less the 100 collected');
});

test('a bull call spread: both ends capped, worked out by hand', () => {
  /* Buy 24000 at 150, sell 24200 at 70. Net debit 80.
     Below 24000 both expire worthless: lose the 80.
     Above 24200 the spread is worth its full 200 width: make 200 − 80 = 120.
     Breakeven at 24000 + 80 = 24080. */
  const ev = ST.evaluate([leg('CE', 24000, 'BUY', 150), leg('CE', 24200, 'SELL', 70)], ctx);
  close(ev.netDebit, 80, 1e-9);
  close(ev.maxLoss, 80, 1e-6);
  close(ev.maxProfit, 120, 1e-6);
  assert.equal(ev.unbounded.anyLoss, false, 'the sold strike is covered by the bought one');
  assert.equal(ev.unbounded.profitUp, false, 'and caps the upside');
  close(ev.breakevens[0], 24080, 0.5);
  close(ev.payoffAt(23500), -80, 1e-6);
  close(ev.payoffAt(24500), 120, 1e-6);
  close(ev.payoffAt(24100), 20, 1e-6, 'halfway up the spread');
});

test('a bull put spread: a credit, with the loss capped by the width less the credit', () => {
  /* Sell 23900 put at 60, buy 23700 put at 25. Credit 35, width 200.
     Above 23900 both expire worthless: keep the 35.
     Below 23700 the spread is worth 200 against you: lose 200 − 35 = 165. */
  const ev = ST.evaluate([leg('PE', 23900, 'SELL', 60), leg('PE', 23700, 'BUY', 25)], ctx);
  close(ev.netDebit, -35, 1e-9, 'a net credit of 35');
  close(ev.maxProfit, 35, 1e-6, 'the credit is the most you can make');
  close(ev.maxLoss, 165, 1e-6, 'width less credit is the most you can lose');
  assert.equal(ev.unbounded.anyLoss, false);
  close(ev.breakevens[0], 23865, 0.5, 'short strike less the credit');
  close(ev.payoffAt(24500), 35, 1e-6);
  close(ev.payoffAt(23000), -165, 1e-6);
});

test('a long straddle: two breakevens, loss worst exactly at the strike', () => {
  const ev = ST.evaluate([leg('CE', 24000, 'BUY', 140), leg('PE', 24000, 'BUY', 130)], ctx);
  close(ev.netDebit, 270, 1e-9);
  close(ev.maxLoss, 270, 1e-6, 'the whole premium, and only if it pins the strike');
  close(ev.maxLossAt, 24000, 15, 'the worst case is the strike itself');
  assert.equal(ev.maxProfit, Infinity);
  assert.equal(ev.breakevens.length, 2);
  close(ev.breakevens[0], 23730, 0.5);
  close(ev.breakevens[1], 24270, 0.5);
  assert.equal(ev.unbounded.profitUp && ev.unbounded.profitDown, true, 'it profits from a move either way');
});

test('an iron condor: capped on both sides, worked out by hand', () => {
  /* Sell 23800P/24200C, buy 23600P/24400C. Credits 45+50, debits 20+22 → net credit 53.
     Between the short strikes everything expires worthless: keep 53.
     Beyond either long strike the near spread is worth its 200 width: lose 200 − 53 = 147. */
  const ev = ST.evaluate([
    leg('PE', 23800, 'SELL', 45), leg('PE', 23600, 'BUY', 20),
    leg('CE', 24200, 'SELL', 50), leg('CE', 24400, 'BUY', 22)
  ], ctx);
  close(ev.netDebit, -53, 1e-9);
  close(ev.maxProfit, 53, 1e-6);
  close(ev.maxLoss, 147, 1e-6);
  assert.equal(ev.unbounded.anyLoss, false, 'both wings are bought back');
  assert.equal(ev.breakevens.length, 2);
  close(ev.breakevens[0], 23747, 0.5);
  close(ev.breakevens[1], 24253, 0.5);
  close(ev.payoffAt(24000), 53, 1e-6, 'it keeps the credit in the middle');
  close(ev.payoffAt(23000), -147, 1e-6);
  close(ev.payoffAt(25000), -147, 1e-6);
});

test('unbounded loss is detected from the payoff, not inferred from the name', () => {
  /* A condor missing one protective wing still looks like a condor in a leg list and on a
     screen, and it is not one — the upside has no floor under it. The engine reads the tail
     slope rather than trusting the shape, which is the entire reason it is built generically. */
  const broken = ST.evaluate([
    leg('PE', 23800, 'SELL', 45), leg('PE', 23600, 'BUY', 20),
    leg('CE', 24200, 'SELL', 50)                                  // the 24400 hedge is missing
  ], ctx);
  assert.equal(broken.unbounded.anyLoss, true, 'an unhedged short call has no ceiling on its loss');
  assert.equal(broken.unbounded.lossUp, true);
  assert.equal(broken.maxLoss, Infinity);
  // The downside is still covered, and the engine distinguishes the two sides.
  assert.equal(broken.unbounded.lossDown, false);

  const whole = ST.evaluate([
    leg('PE', 23800, 'SELL', 45), leg('PE', 23600, 'BUY', 20),
    leg('CE', 24200, 'SELL', 50), leg('CE', 24400, 'BUY', 22)
  ], ctx);
  assert.equal(whole.unbounded.anyLoss, false, 'and the complete structure is correctly bounded');
});

test('net Greeks are the signed sum of the legs, and are refused when a leg has no vol', () => {
  const ev = ST.evaluate([leg('CE', 24000, 'BUY', 140, 0.13), leg('CE', 24200, 'SELL', 60, 0.125)], ctx);
  const a = BS.black76({ type: 'CE', F: 24000, K: 24000, T: 7 / 365, sigma: 0.13, r: 0.065 });
  const b = BS.black76({ type: 'CE', F: 24000, K: 24200, T: 7 / 365, sigma: 0.125, r: 0.065 });
  close(ev.greeks.delta, a.delta - b.delta, 1e-9, 'long delta less short delta');
  close(ev.greeks.vega, a.vega - b.vega, 1e-6);
  assert.ok(ev.greeks.delta > 0, 'a bull spread is long delta');
  assert.ok(ev.greeks.vega > 0, 'and long vega, since the bought strike has more');

  const noVol = ST.evaluate([{ type: 'CE', strike: 24000, side: 'BUY', price: 140, iv: null }], ctx);
  assert.equal(noVol.greeks, null, 'no vol, no Greeks — not zero Greeks');
  assert.ok(/no solvable implied volatility/.test(noVol.greeksNote));
});

test('a malformed structure is refused', () => {
  assert.equal(ST.evaluate([], ctx).ok, false);
  assert.equal(ST.evaluate(null, ctx).ok, false);
  assert.equal(ST.evaluate([{ type: 'XX', strike: 1, price: 1, side: 'BUY' }], ctx).ok, false);
  assert.equal(ST.evaluate([{ type: 'CE', strike: null, price: 1, side: 'BUY' }], ctx).ok, false);
});

/* ============================================================
   2. CAPITAL AND SIZING
   ============================================================ */

test('capital required is exact for a debit, near-exact for a spread, an estimate for a naked short', () => {
  /* Three tiers of certainty, never blended — because the difference between "you pay this" and
     "the exchange might ask for this" is the difference between a plan and a hope. */
  const debit = ST.capitalRequired(ST.evaluate([leg('CE', 24000, 'BUY', 100)], ctx), LOT, null);
  assert.equal(debit.certainty, 'exact');
  close(debit.perLot, 7500, 1e-9, 'the premium times the lot');

  const spread = ST.capitalRequired(ST.evaluate([leg('PE', 23900, 'SELL', 60), leg('PE', 23700, 'BUY', 25)], ctx), LOT, null);
  assert.equal(spread.certainty, 'near-exact');
  close(spread.perLot, 165 * LOT, 1e-6, 'the maximum loss is what the exchange blocks');
  assert.ok(/recognises the hedge/.test(spread.basis));

  const naked = ST.capitalRequired(ST.evaluate([leg('CE', 24200, 'SELL', 50)], ctx), LOT, { margin: { shortOptionPctOfNotional: 0.12, bufferMultiple: 1.5 } });
  assert.equal(naked.certainty, 'estimate');
  close(naked.perLot, 24200 * LOT * 0.12, 1, '12% of the short notional');
  assert.ok(/ESTIMATE ONLY/.test(naked.note), naked.note);
  assert.ok(/RISES when volatility rises/.test(naked.note), 'and says when it will hurt');
});

test('a small account is told plainly that one lot is too big for it', () => {
  /* The case this whole file exists for. ₹50,000 of capital, a 2% risk budget of ₹1,000, and a
     perfectly ordinary 120-point NIFTY option that costs ₹9,000 a lot. Options do not come in
     fractions, so the honest answer is not "buy one anyway" and not silence. */
  const ev = ST.evaluate([leg('CE', 24000, 'BUY', 120)], ctx);
  const sz = ST.size(ev, { capital: 50000, lotSize: LOT, riskPct: 0.02 });
  assert.equal(sz.lots, 0);
  assert.equal(sz.blocked, true);
  assert.equal(sz.limitedBy, 'risk budget');
  assert.ok(/one lot risks ₹9,000/.test(sz.reason), sz.reason);
  assert.ok(/18\.0% of your capital/.test(sz.reason), 'stated as a share of capital');
  assert.ok(/9\.0x your stated 2% risk budget/.test(sz.reason), 'and as a multiple of the budget');
  assert.ok(/cannot be bought in fractions/.test(sz.reason), 'and explains why rounding down is not available');
  close(sz.oneLotRiskPct, 0.18, 1e-9);
});

test('a large account sizes to the risk budget, not to what it can afford', () => {
  /* The distinction that matters: ₹10,00,000 could buy 111 lots of a ₹9,000 option. The risk
     budget says 2 lots. Confusing "can afford" with "should risk" is the most expensive habit in
     retail trading, so the engine reports which of the two bound the size. */
  const ev = ST.evaluate([leg('CE', 24000, 'BUY', 120)], ctx);
  const sz = ST.size(ev, { capital: 1000000, lotSize: LOT, riskPct: 0.02 });
  close(sz.riskBudget, 20000, 1e-9);
  assert.equal(sz.lots, 2, '₹20,000 budget over ₹9,000 a lot');
  assert.equal(sz.limitedBy, 'risk budget');
  close(sz.maxLossTotal, 18000, 1e-9);
  assert.ok(sz.capitalTotal < 1000000 * 0.05, 'it uses a small fraction of the account');
});

test('a defined-risk spread lets a small account trade where an outright option cannot', () => {
  /* The practical consequence of sizing off maximum loss: the same ₹50,000 account that cannot
     afford one outright call can trade the spread, because the spread's worst case is a fraction
     of the premium. This is the single most useful thing the engine can tell a small account. */
  const outright = ST.size(ST.evaluate([leg('CE', 24000, 'BUY', 120)], ctx), { capital: 50000, lotSize: LOT, riskPct: 0.04 });
  assert.equal(outright.blocked, true);

  const spread = ST.size(ST.evaluate([leg('CE', 24000, 'BUY', 120), leg('CE', 24100, 'SELL', 95)], ctx), { capital: 50000, lotSize: LOT, riskPct: 0.04 });
  assert.ok(spread.lots >= 1, `the spread should fit where the outright does not: ${spread.reason || spread.lots + ' lots'}`);
  close(spread.maxLossPerLot, 25 * LOT, 1e-6, 'only the net debit is at risk');
});

test('an undefined-risk short is blocked unless the account clears the margin buffer', () => {
  const ev = ST.evaluate([leg('CE', 24200, 'SELL', 50)], ctx);
  const cfg = { margin: { shortOptionPctOfNotional: 0.12, bufferMultiple: 1.5 } };
  const needed = 24200 * LOT * 0.12 * 1.5;          // about ₹3.27 lakh

  const small = ST.size(ev, { capital: 200000, lotSize: LOT, riskPct: 0.02, costConfig: cfg });
  assert.equal(small.blocked, true);
  assert.equal(small.lots, 0);
  assert.ok(/lose without limit/.test(small.reason), small.reason);
  assert.ok(/margin buffer/.test(small.reason));

  const big = ST.size(ev, { capital: needed * 3, lotSize: LOT, riskPct: 0.02, costConfig: cfg });
  assert.equal(big.blocked, false);
  assert.ok(big.lots >= 1);
  assert.equal(big.maxLossPerLot, null, 'there is no maximum loss to report, and none is invented');
  assert.equal(big.limitedBy, 'undefined risk');
  assert.ok(/no ceiling/.test(big.reason), big.reason);
});

test('sizing refuses without capital or a lot size', () => {
  const ev = ST.evaluate([leg('CE', 24000, 'BUY', 100)], ctx);
  assert.equal(ST.size(ev, { lotSize: LOT }).ok, false);
  assert.equal(ST.size(ev, { capital: 0, lotSize: LOT }).ok, false);
  assert.equal(ST.size(ev, { capital: 100000 }).ok, false);
  assert.match(ST.size(ev, { capital: 100000, lotSize: 0 }).reason, /lot size/);
});

/* ============================================================
   3. PROPOSING FROM A LIVE CHAIN
   ============================================================ */

test('an up view proposes only bullish structures, and says what it rejected', () => {
  const a = board();
  const p = ST.propose({ analysis: a, capital: 500000, view: 'up', riskPct: 0.02, costs, vol: { verdict: 'fair' } });
  assert.ok(p.ok, p.reason);
  assert.ok(p.candidates.length >= 3, 'several ways to express an up view');
  for (const c of p.candidates) assert.equal(c.view, 'up', `${c.name} is not a bullish structure`);
  const names = p.candidates.map(c => c.name);
  assert.ok(names.includes('Long Call') && names.includes('Bull Call Spread') && names.includes('Bull Put Spread'), names.join(', '));
  assert.ok(p.best, 'one of them is recommended');
  assert.ok(p.best.legs.length >= 1 && p.best.sizing.lots >= 1);
});

test('the volatility read decides between buying and selling premium', () => {
  const a = board();
  const cheap = ST.propose({ analysis: a, capital: 500000, view: 'up', costs, vol: { verdict: 'cheap', confidence: 'good' } });
  const rich = ST.propose({ analysis: a, capital: 500000, view: 'up', costs, vol: { verdict: 'expensive', confidence: 'good' } });

  const rank = (p, n) => p.candidates.findIndex(c => c.name === n);
  assert.ok(rank(cheap, 'Long Call') < rank(cheap, 'Bull Put Spread'),
    'with cheap vol, buying the option should outrank selling premium');
  assert.ok(rank(rich, 'Bull Put Spread') < rank(rich, 'Long Call'),
    'with expensive vol, selling premium should outrank buying the option');

  // And the structure working against the pricing is told so rather than quietly demoted.
  const lc = rich.candidates.find(c => c.name === 'Long Call');
  assert.ok(lc.notes.some(n => /working against the pricing/.test(n)), JSON.stringify(lc.notes));
});

test('undefined-risk structures are off by default and must be enabled deliberately', () => {
  const a = board();
  const off = ST.propose({ analysis: a, capital: 5000000, view: 'range', costs, vol: { verdict: 'expensive' } });
  assert.ok(!off.candidates.some(c => c.name === 'Short Strangle'), 'not proposed by default');
  const why = off.rejected.find(r => r.name === 'Short Strangle');
  assert.ok(why && /off by default/.test(why.reason), 'and the omission is explained, not silent');
  assert.ok(/more than the account holds/.test(why.reason));

  const on = ST.propose({ analysis: a, capital: 5000000, view: 'range', costs, allowUndefinedRisk: true, vol: { verdict: 'expensive' } });
  assert.ok(on.candidates.some(c => c.name === 'Short Strangle'), 'available when asked for');
  // Even enabled, defined risk still outranks it.
  assert.notEqual(on.best.name, 'Short Strangle', 'defined risk still wins the ranking');
});

test('an unsure view proposes only non-directional structures', () => {
  /* A directional structure with no direction is a coin flip that pays costs either way. */
  const a = board();
  const p = ST.propose({ analysis: a, capital: 500000, view: 'unsure', costs, vol: { verdict: 'fair' } });
  for (const c of p.candidates) {
    assert.ok(c.view === 'range' || c.view === 'move', `${c.name} (${c.view}) is directional and should not be proposed without a view`);
  }
});

test('a small account gets told nothing is tradeable rather than being handed a trade it cannot hold', () => {
  const a = board();
  const p = ST.propose({ analysis: a, capital: 30000, view: 'up', riskPct: 0.02, costs, vol: { verdict: 'fair' } });
  assert.ok(p.ok, 'it still analyses');
  assert.equal(p.best, null, 'a ₹30,000 account cannot hold one lot of NIFTY at 2% risk');
  assert.ok(/no position/.test(p.note), p.note);
  assert.ok(p.blocked.length > 0, 'and each blocked structure explains itself');
  for (const b of p.blocked) assert.ok(b.reason && b.reason.length > 30, b.reason);
});

test('when nothing fits, the engine quantifies BOTH levers instead of stopping at "no"', () => {
  /* "Nothing is tradeable" is true and nearly useless on its own, and it is the answer most
     Indian retail accounts will get — one lot of NIFTY is seventy-five contracts. The user is
     then left to work out whether they are ten percent short of the capital or ten times short,
     which is the arithmetic they came here to avoid. */
  const a = board();
  const p = ST.propose({ analysis: a, capital: 300000, view: 'up', riskPct: 0.02, costs, vol: { verdict: 'fair' } });
  assert.equal(p.best, null);
  assert.ok(p.requirement, 'a requirement block is produced');

  const rq = p.requirement;
  // The cheapest structure on the board is the one identified — not the first or the best-ranked.
  const cheapestLoss = Math.min(...p.candidates.filter(c => Number.isFinite(c.sizing.maxLossPerLot)).map(c => c.sizing.maxLossPerLot));
  close(rq.maxLossPerLot, cheapestLoss, 1e-9, 'it finds the genuinely cheapest structure');

  // Lever one: the capital that would permit it at the stated risk.
  close(rq.capitalNeededAtThisRisk, Math.ceil(cheapestLoss / 0.02), 1, 'capital needed at 2% risk');
  close(rq.shortfall, rq.capitalNeededAtThisRisk - 300000, 1, 'and how far short the account is');

  // Lever two: the risk that would permit it at the stated capital.
  close(rq.riskPctNeededAtThisCapital, cheapestLoss / 300000, 1e-12);
  assert.ok(rq.riskPctNeededAtThisCapital > 0.02, 'which is more than the budget, or it would not be blocked');

  assert.ok(/more than you have/.test(rq.message), rq.message);
  assert.ok(/would mean risking/.test(rq.message), 'and names the risk of taking it anyway');
  assert.ok(p.note.includes(rq.message), 'the requirement reaches the headline note');
});

test('naming the larger risk setting is not the same as recommending it', () => {
  /* The number is given because hiding it does not make the decision go away, it makes it
     uninformed. But where the gap is large the engine says so in plain terms rather than leaving
     "just use 6% risk" hanging as though it were free. */
  const a = board();
  const tiny = ST.propose({ analysis: a, capital: 60000, view: 'up', riskPct: 0.02, costs, vol: { verdict: 'fair' } });
  assert.ok(tiny.requirement.caution, 'a large gap draws a caution');
  assert.ok(/x the risk per trade you said you wanted/.test(tiny.requirement.caution), tiny.requirement.caution);
  assert.ok(/more capital or no position/.test(tiny.requirement.caution), 'and it does not offer a third way that does not exist');

  // A near miss does not get the lecture.
  const near = ST.propose({ analysis: a, capital: 350000, view: 'up', riskPct: 0.02, costs, vol: { verdict: 'fair' } });
  if (near.requirement && near.requirement.riskPctNeededAtThisCapital < 0.04) {
    assert.equal(near.requirement.caution, null, 'a small shortfall is stated without the sermon');
  }
});

test('with enough capital the same chain produces a real position', () => {
  const a = board();
  const p = ST.propose({ analysis: a, capital: 1500000, view: 'up', riskPct: 0.02, costs, vol: { verdict: 'fair' } });
  assert.ok(p.best, 'at ₹15 lakh something fits');
  assert.equal(p.requirement, null, 'and no requirement block is needed');
  assert.ok(p.best.sizing.maxLossTotal <= p.best.sizing.riskBudget * 1.001, 'anything proposed respects the budget');
  assert.ok(p.best.sizing.lots >= 1);
});

test('costs are charged on every leg, both ways', () => {
  /* A four-legged iron condor pays eight orders of brokerage on a round trip. On a small
     position that is most of the credit, and the engine has to say so before the trade. */
  const a = board();
  const p = ST.propose({ analysis: a, capital: 800000, view: 'range', costs, vol: { verdict: 'expensive' } });
  const condor = p.candidates.find(c => c.name === 'Iron Condor');
  assert.ok(condor, 'an iron condor was proposed');
  assert.equal(condor.costs.legs, 4);
  assert.equal(condor.costs.ordersPerRoundTrip, 8);
  assert.ok(condor.costs.total > 0);

  const spread = p.candidates.find(c => c.legs.length === 2);
  if (spread) assert.ok(condor.costs.total > spread.costs.total, 'four legs cost more than two');
  if (condor.costAsShareOfMaxProfit > 0.2) {
    assert.ok(condor.notes.some(n => /orders of brokerage/.test(n)), JSON.stringify(condor.notes));
  }
});

test('propose refuses without capital, because every number scales off it', () => {
  const a = board();
  const p = ST.propose({ analysis: a, view: 'up', costs });
  assert.equal(p.ok, false);
  assert.ok(/capital is required/.test(p.reason), p.reason);
  assert.equal(ST.propose({ analysis: { ok: false, reason: 'bad chain' }, capital: 100000 }).ok, false);
});

/* ============================================================
   4. THE TRADE PLAN
   ============================================================ */

function planFor(view, capital, opts) {
  const a = board(opts && opts.board);
  const p = ST.propose({ analysis: a, capital: capital || 500000, view, riskPct: 0.02, costs, vol: (opts && opts.vol) || { verdict: 'fair' }, ...(opts && opts.propose || {}) });
  return { a, p, plan: SIG.plan({ candidate: p.best, analysis: a, vol: (opts && opts.vol) || {}, costs, now: NOW, ...(opts && opts.plan || {}) }) };
}

test('the plan gives an entry limit that does not cross the spread', () => {
  const { plan } = planFor('up');
  assert.ok(plan.ok, plan.reason);
  for (const l of plan.entry.legs) {
    if (l.side === 'BUY' && Number.isFinite(l.doNotPayBeyond)) {
      assert.ok(l.limitPrice <= l.doNotPayBeyond, 'never pay beyond the offer');
      assert.ok(l.limitPrice >= l.price, 'but enough above the mid to get filled');
    }
  }
  assert.ok(plan.entry.orderNote, 'and says how to place it');
});

test('a multi-leg plan warns against legging in', () => {
  const { plan } = planFor('range', 800000, { vol: { verdict: 'expensive' } });
  if (plan.entry.legs.length > 1) {
    assert.ok(/single basket or spread order/.test(plan.entry.orderNote), plan.entry.orderNote);
    assert.ok(/accidental naked short/.test(plan.entry.orderNote), 'and says exactly what goes wrong');
  }
});

test('the stop is set on the INDEX and converted to a premium, with the distinction stated', () => {
  /* The core idea of this file. A percentage stop on a premium is mostly a decay detector: a long
     weekly can lose 30% over a weekend with the index unchanged. The stop belongs on the thing
     the thesis is about. */
  const { a, plan } = planFor('up');
  assert.ok(Number.isFinite(plan.stop.underlyingLevel));
  assert.ok(plan.stop.underlyingLevel < a.forward, 'a bullish position stops out below the market');
  assert.ok(Number.isFinite(plan.stop.premiumIfHitTomorrow));
  assert.ok(plan.stop.premiumIfHitTomorrow < plan.entry.netDebit, 'the premium at the stop is below what was paid');
  assert.ok(/represents the index reaching/.test(plan.stop.howToPlace), plan.stop.howToPlace);
  assert.ok(/time and volatility took it, not your thesis/.test(plan.stop.howToPlace),
    'the distinction between a decay stop and a thesis stop must be explicit');
  assert.ok(plan.stop.lossAtStop < 0, 'stopping out is a loss');
});

test('the stop accounts for a day of decay as well as the move', () => {
  /* Repricing at the stop level with a day gone gives a lower premium than repricing there
     instantly — and it is the lower number the user will actually see on screen. */
  const { plan } = planFor('up');
  assert.ok(plan.stop.premiumIfHitTomorrow < plan.stop.premiumIfHitToday,
    `a day of decay must be included: today ${plan.stop.premiumIfHitToday}, tomorrow ${plan.stop.premiumIfHitTomorrow}`);
});

test('repricing brackets the answer under both volatility regimes', () => {
  /* Sticky strike and sticky delta disagree about what an option is worth after the index moves,
     and the gap between them is the honest error bar. A single confident number would be a
     stronger claim than the model supports. */
  const a = board();
  const legs = [{ type: 'CE', strike: 24000, side: 'BUY', ratio: 1, price: 150, iv: 0.13 }];
  const r = SIG.repriceStructure(legs, { forward: 24000, T: 7 / 365, r: 0.065, level: 23700, daysLater: 1, skewSlope: SIG.smileSlope(a) });
  assert.ok(r, 'it reprices');
  assert.ok(r.valueLow <= r.value && r.value <= r.valueHigh, 'the midpoint sits inside the range');
  assert.ok(r.uncertainty > 0, 'a real skew produces a real spread between the two assumptions');
  assert.ok(r.value < 150, 'a call is worth less after a 300-point fall and a day gone');

  // With no skew the two assumptions coincide, and the engine reports zero uncertainty rather
  // than a manufactured band.
  const flat = SIG.repriceStructure(legs, { forward: 24000, T: 7 / 365, r: 0.065, level: 23700, daysLater: 1, skewSlope: 0 });
  close(flat.uncertainty, 0, 1e-12, 'no smile, no disagreement');
});

test('targets are measured against the move the market is already pricing', () => {
  const { a, plan } = planFor('up');
  assert.ok(plan.targets.length >= 2);
  for (const t of plan.targets) {
    assert.ok(Number.isFinite(t.netPnl));
    assert.ok(t.netPnl < t.grossPnl, 'costs come off every target');
  }
  // A bigger move is worth more.
  assert.ok(plan.targets[1].netPnl > plan.targets[0].netPnl);
  close(plan.targets[1].movePoints, a.expectedMove.points, 1, 'the second target is one full implied move');
});

test('a target beyond the implied move is called out as two bets sold as one', () => {
  /* The most common reason a directionally-correct option trade still loses money: the target
     needed the market to be wrong about volatility as well as direction. */
  const a = board();
  const p = ST.propose({ analysis: a, capital: 500000, view: 'up', costs, vol: { verdict: 'fair' } });
  const far = SIG.plan({ candidate: p.best, analysis: a, costs, now: NOW, targetLevel: a.forward + a.expectedMove.points * 2.5 });
  assert.equal(far.targetVerdict.inside, false);
  assert.ok(far.targetVerdict.ratio > 2);
  assert.ok(/two bets and you are being charged for both/.test(far.targetVerdict.reading), far.targetVerdict.reading);

  const near = SIG.plan({ candidate: p.best, analysis: a, costs, now: NOW, targetLevel: a.forward + a.expectedMove.points * 0.4 });
  assert.equal(near.targetVerdict.inside, true);
  assert.ok(/comfortable case/.test(near.targetVerdict.reading), near.targetVerdict.reading);
});

test('every plan carries a time stop with a date on it', () => {
  /* The part almost every options plan omits. A stock position can be wrong for a month and
     recover; an option cannot. */
  const { plan } = planFor('up');
  assert.ok(plan.timeStop.ok);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(plan.timeStop.date), 'an actual date, not a vague instruction');
  assert.ok(plan.timeStop.inDays > 0 && plan.timeStop.inDays < plan.daysLeft, 'before expiry, not at it');
  assert.ok(Number.isFinite(plan.timeStop.pnlIfNothingHappens));
  assert.ok(plan.timeStop.pnlIfNothingHappens < 0, 'doing nothing costs money');
  assert.ok(/paying rent on a view that has not happened/.test(plan.timeStop.action), plan.timeStop.action);
  assert.ok(plan.timeStop.decayShare > 0, 'and quantifies how much premium is gone by then');
});

test('a short position gets a gamma-based time stop, not a decay one', () => {
  const { plan } = planFor('range', 900000, { vol: { verdict: 'expensive' } });
  if (plan.structure && /Condor|Put Spread|Call Spread/.test(plan.structure)) {
    assert.ok(/gamma/.test(plan.timeStop.reason), plan.timeStop.reason);
    assert.ok(/smallest/.test(plan.timeStop.action), plan.timeStop.action);
  }
});

test('exit rules are ordered and cover the event crush and the expiry decision', () => {
  const { plan } = planFor('up', 500000, { vol: { eventWarning: 'US CPI falls before this expiry' } });
  const triggers = plan.exits.map(e => e.trigger);
  assert.ok(plan.exits.length >= 4, triggers.join(' | '));
  assert.ok(plan.exits.every(e => Number.isFinite(e.priority)), 'each exit is ranked');

  const crush = plan.exits.find(e => /after the scheduled event/.test(e.trigger));
  assert.ok(crush, 'the event crush is an exit rule: ' + triggers.join(' | '));
  assert.ok(/being right about the event is not enough/.test(crush.action), crush.action);

  const exp = plan.exits.find(e => /expiry approaching/.test(e.trigger));
  assert.ok(exp && /square off rather than letting it settle/.test(exp.action), 'the expiry decision is carried into the plan');
});

test('invalidation is explicit, and names the gap risk on an unbounded structure', () => {
  const { plan } = planFor('up');
  assert.ok(plan.invalidation.length >= 3);
  assert.ok(plan.invalidation.some(i => /implied vol falls/.test(i)), 'a long position dies to a vol crush as well as to direction');

  const a = board();
  const p = ST.propose({ analysis: a, capital: 8000000, view: 'range', costs, allowUndefinedRisk: true, vol: { verdict: 'expensive' } });
  const naked = p.candidates.find(c => c.name === 'Short Strangle');
  if (naked && naked.sizing.lots > 0) {
    const np = SIG.plan({ candidate: naked, analysis: a, costs, now: NOW });
    assert.ok(np.invalidation.some(i => /gap through the short strike/.test(i)), JSON.stringify(np.invalidation));
    assert.ok(np.invalidation.some(i => /reopens past your level, not at it/.test(i)),
      'a stop does not protect against a gap, and the plan must say so');
  }
});

test('entry is blocked when the chain data is not trustworthy', () => {
  const a = board();
  const p = ST.propose({ analysis: a, capital: 500000, view: 'up', costs, vol: { verdict: 'fair' } });
  const bad = { ...a, quality: { ...a.quality, usable: false, warnings: ['near-the-money strikes disagree about the forward'] } };
  const pl = SIG.plan({ candidate: p.best, analysis: bad, costs, now: NOW });
  assert.equal(pl.entry.blocked, true);
  assert.ok(pl.entry.conditions.some(c => /^DO NOT ENTER/.test(c)), JSON.stringify(pl.entry.conditions));
});

test('the summary states size, cost, worst case and both exits in one sentence each', () => {
  const { plan } = planFor('up');
  const s = plan.summary;
  assert.ok(/NIFTY/.test(s), s);
  assert.ok(/lot/.test(s));
  assert.ok(/Worst case/.test(s), 'the worst case is never left out');
  assert.ok(/Costs ₹/.test(s));
  assert.ok(/Out if the index reaches/.test(s), 'and the exit is in the summary, not buried');
  assert.ok(/% of capital/.test(s), 'the worst case is expressed against capital');
});

test('the plan refuses without a structure or a chain', () => {
  const a = board();
  assert.equal(SIG.plan({ analysis: a }).ok, false);
  assert.equal(SIG.plan({ candidate: { legs: [] }, analysis: a }).ok, false);
  assert.equal(SIG.plan({ candidate: { legs: [leg('CE', 24000, 'BUY', 100)] }, analysis: { ok: false } }).ok, false);
});
