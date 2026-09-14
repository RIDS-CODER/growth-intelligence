/* ============================================================
   F&O — PRICING CORE (Black-76 on a forward)

   This is the only file in the F&O stack that can be made PROVABLY correct, so it is the one
   that carries the weight. Everything above it — chain analytics, vol ranking, strategy
   selection — is judgement layered on top of these numbers, and judgement built on a wrong
   delta is worse than no judgement at all.

   WHY BLACK-76 AND NOT TEXTBOOK BLACK-SCHOLES
   The textbook spot form needs two inputs nobody can observe: the risk-free rate r and the
   dividend yield q. For NIFTY that q is the blended dividend of fifty companies over the
   contract's life, and getting it wrong by 1% moves every delta and every "is this option
   cheap" verdict. Black-76 prices off the FORWARD instead, and the forward is not a guess —
   put-call parity reads it straight off the option chain:

       F = K + e^(rT) · (Call − Put)

   The market has already priced r and q into that call-put spread. Taking the forward from the
   chain means this engine inherits the market's own carry assumptions rather than imposing its
   own, and r survives only as a discount factor where a 2% error moves a weekly premium by
   about 0.04%. See `impliedForward`.

   WHY THE MATH IS EXACT HERE, NOT AN APPROXIMATION
   NIFTY, BANKNIFTY and SENSEX options are EUROPEAN — no early exercise. Black-76 is then the
   exact closed-form solution under its own assumptions, not a numerical approximation of an
   American price. (The lognormal assumption is still an assumption about the world; the skew
   handling in vol.js is where that gets confronted. What is exact is the map between price and
   implied vol, which is all this file claims.)

   UNITS, STATED EXPLICITLY
   Everything is in PREMIUM POINTS of the underlying — the units NIFTY options actually quote
   in. Nothing here multiplies by a lot size; that conversion belongs in strategy.js where the
   lot size is read from the live instrument master rather than hardcoded, because the exchange
   revises it.

   HONESTY ENVELOPE, same as the intel/ modules: a number that cannot be computed comes back
   null with a reason, never as a zero. A zero vega and an unmeasurable vega lead to opposite
   trades.
   ============================================================ */

'use strict';

/* ---------- constants ---------- */

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const INV_SQRT_2PI = 1 / SQRT_2PI;

/* Below this many years to expiry the lognormal model stops describing anything: gamma goes to
   infinity, vega goes to zero, and an implied vol solved from a 0.05 tick is noise. One minute.
   Callers get `degenerate:true` rather than a confident set of exploded Greeks. */
const MIN_T = 1 / (365 * 24 * 60);

/* Vol search bracket. 500% annualised is already absurd for an index; anything solving above it
   is a stale quote or a mispriced far-OTM strike, and saying so is more useful than returning
   a number. */
const VOL_LO = 1e-4;
const VOL_HI = 5;

/* Indian index options tick in 0.05 premium points. Used to judge whether a solved IV means
   anything — see `identifiability` in impliedVol. */
const TICK = 0.05;

const isNum = v => typeof v === 'number' && isFinite(v);

/* ============================================================
   NORMAL DISTRIBUTION

   Hart's double-precision algorithm (as tabulated by West, "Better Approximations to Cumulative
   Normal Functions"). Accurate to roughly 1e-15 across the whole real line.

   THE CHOICE OF ALGORITHM IS NOT COSMETIC. The Abramowitz-Stegun 7.1.26 polynomial that most
   quick implementations use is accurate to about 7.5e-8. That is fine for a price. It is NOT
   fine inside an implied-vol solver, where the residual is differenced against a 0.05 tick:
   the approximation error shows up as a false vol surface with 1e-4-scale ripples in it, and
   the IV-rank and skew logic downstream would read those ripples as signal.
   ============================================================ */

function ncdf(x) {
  if (!isNum(x)) return null;
  const a = Math.abs(x);
  let cum;
  if (a > 37) {
    cum = 0;                                  // underflows double precision anyway
  } else {
    const e = Math.exp(-a * a / 2);
    if (a < 7.07106781186547) {
      let b = 3.52624965998911e-02 * a + 0.700383064443688;
      b = b * a + 6.37396220353165;
      b = b * a + 33.912866078383;
      b = b * a + 112.079291497871;
      b = b * a + 221.213596169931;
      b = b * a + 220.206867912376;
      let c = 8.83883476483184e-02 * a + 1.75566716318264;
      c = c * a + 16.064177579207;
      c = c * a + 86.7807322029461;
      c = c * a + 296.564248779674;
      c = c * a + 637.333633378831;
      c = c * a + 793.826512519948;
      c = c * a + 440.413735824752;
      cum = e * b / c;
    } else {
      // Continued fraction in the far tail, where the rational form loses precision.
      let b = a + 0.65;
      b = a + 4 / b;
      b = a + 3 / b;
      b = a + 2 / b;
      b = a + 1 / b;
      cum = e / (b * SQRT_2PI);
    }
  }
  return x > 0 ? 1 - cum : cum;
}

function npdf(x) {
  if (!isNum(x)) return null;
  return INV_SQRT_2PI * Math.exp(-x * x / 2);
}

/* ============================================================
   TIME

   ACT/365 on calendar days, because that is the convention the Indian market quotes vol in —
   an IV printed on a broker terminal is an ACT/365 calendar number, and using a trading-day
   clock here would put this engine's IV on a different scale to every other screen the user
   looks at.

   THE WEEKEND IS REAL AND THIS DOES NOT MODEL IT. A Friday-to-Monday hold decays three calendar
   days of premium while the market is open for none of them. Calendar time over-charges the
   weekend in the sense that realised vol over a weekend is far below three days' worth; the
   market compensates by marking IV UP into Friday's close and letting it fall Monday morning.
   That shows up here as a vol move, not a time move, so `thetaDay` across a weekend is a
   systematic overestimate of what a long option actually loses. strategy.js flags weekend holds
   for this reason.
   ============================================================ */

/* Expiry instant for an Indian index option: 15:30 IST on expiry day = 10:00:00Z. */
const IST_CLOSE_UTC_MS = (10 * 60 + 0) * 60 * 1000;

function expiryInstant(expiryMs) {
  if (!isNum(expiryMs)) return null;
  const d = new Date(expiryMs);
  // Instrument masters give expiry as a date (often midnight UTC or midnight IST). Anchor it to
  // the actual 15:30 IST close, because on expiry day the difference between "midnight" and
  // "15:30" is the entire remaining life of the contract.
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + IST_CLOSE_UTC_MS;
}

function yearsToExpiry(nowMs, expiryMs) {
  const exp = expiryInstant(expiryMs);
  if (!isNum(exp) || !isNum(nowMs)) return null;
  const ms = exp - nowMs;
  if (ms <= 0) return 0;
  return ms / (365 * 24 * 60 * 60 * 1000);
}

const daysToExpiry = (nowMs, expiryMs) => {
  const y = yearsToExpiry(nowMs, expiryMs);
  return y == null ? null : y * 365;
};

/* ============================================================
   BLACK-76
   ============================================================ */

function dOf(F, K, T, sigma) {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + v * v / 2) / v;
  return { d1, d2: d1 - v, v };
}

/* Price only — the inner loop of the IV solver, so it stays free of the Greek algebra.
   Returns null (not 0) for inputs the model cannot price. */
function price(type, F, K, T, sigma, r) {
  if (!isNum(F) || !isNum(K) || !isNum(T) || !isNum(sigma) || F <= 0 || K <= 0 || T < 0) return null;
  const isCall = type === 'CE' || type === 'call' || type === 'C';
  const rr = isNum(r) ? r : 0;
  const df = Math.exp(-rr * T);

  // At or past expiry, and in the zero-vol limit, the option IS its discounted intrinsic. These
  // are the boundary conditions every test below pins against.
  if (T <= 0 || sigma <= 0) return df * Math.max(0, isCall ? F - K : K - F);

  const { d1, d2 } = dOf(F, K, T, sigma);
  return isCall
    ? df * (F * ncdf(d1) - K * ncdf(d2))
    : df * (K * ncdf(-d2) - F * ncdf(-d1));
}

/* Full valuation: price plus every Greek a trader acts on, in stated units.

   RETURNS AN OBJECT WITH `degenerate` RATHER THAN THROWING. At T→0 the Greeks are genuinely
   undefined-or-infinite, and a UI that renders "Γ = 4.1e+7" has told the user nothing. The
   caller is expected to branch on `degenerate` and say "at expiry" instead. */
function black76(opts) {
  const o = opts || {};
  const isCall = o.type === 'CE' || o.type === 'call' || o.type === 'C';
  const F = o.F, K = o.K, T = o.T, sigma = o.sigma;
  const r = isNum(o.r) ? o.r : 0;

  if (!isNum(F) || !isNum(K) || F <= 0 || K <= 0 || !isNum(T) || T < 0) {
    return { ok: false, reason: 'forward, strike and time must be positive finite numbers' };
  }
  const df = Math.exp(-r * T);
  const intrinsic = Math.max(0, isCall ? F - K : K - F);

  if (T < MIN_T || !isNum(sigma) || sigma <= 0) {
    return {
      ok: true, degenerate: true,
      reason: T < MIN_T ? 'at expiry — the option is worth its intrinsic value' : 'zero volatility',
      type: isCall ? 'CE' : 'PE', F, K, T, sigma: isNum(sigma) ? sigma : null, r, df,
      price: df * intrinsic, intrinsic, extrinsic: 0,
      // At expiry delta is a step function: 1 (or -1) in the money, 0 out. Everything else dies.
      delta: intrinsic > 0 ? (isCall ? 1 : -1) : 0,
      gamma: null, vega: null, vegaPt: null, theta: null, thetaDay: null, decay1d: null,
      rho: null, vanna: null, volga: null,
      d1: null, d2: null, probItm: intrinsic > 0 ? 1 : 0,
      units: UNITS
    };
  }

  const { d1, d2, v } = dOf(F, K, T, sigma);
  const Nd1 = ncdf(d1), Nd2 = ncdf(d2), pd1 = npdf(d1);
  const px = isCall ? df * (F * Nd1 - K * Nd2) : df * (K * ncdf(-d2) - F * ncdf(-d1));

  /* Delta here is ∂V/∂F — the sensitivity to the FORWARD, discounted. For a weekly index option
     the forward and the spot move essentially one-for-one (they differ by e^((r−q)T), which over
     seven days is within a rounding error of 1), so this is the number to hedge with. It is
     NOT the textbook e^(−qT)N(d1) spot delta, and for a far-dated contract the two separate. */
  const delta = isCall ? df * Nd1 : -df * ncdf(-d1);

  /* Gamma, vega, vanna and volga are identical for a call and a put at the same strike — they
     have to be, because parity says C − P is linear in F and independent of σ. The tests assert
     exactly that, which is a free check on the algebra. */
  const gamma = df * pd1 / (F * v);
  const vega = df * F * pd1 * Math.sqrt(T);          // per 1.00 of vol, i.e. per 100 vol points

  /* Theta, per YEAR, as ∂V/∂t (calendar time moving forward), so a long option gives a negative
     number.

     NOTE THE SIGN OF THE CARRY TERM — it differs from the spot-BSM formula most references
     print. In Black-76 the ENTIRE payoff is discounted, so as expiry approaches the discount
     unwinds and pushes value UP; a deep in-the-money Black-76 call has POSITIVE theta. The
     textbook BSM call, where the spot leg is undiscounted, has negative theta there. Both are
     right for their own model. The numerical-derivative test is what proves this one. */
  const theta = r * px - df * F * pd1 * sigma / (2 * Math.sqrt(T));

  /* In forward space rho collapses to pure discounting: the d-terms contain no r at all, so
     ∂V/∂r = −T·V. This is why mis-specifying the rate barely matters once the forward comes
     from parity — the whole rate exposure is one discount factor. */
  const rho = -T * px;

  const vanna = -df * pd1 * d2 / sigma;               // ∂delta/∂σ  ==  ∂vega/∂F
  const volga = vega * d1 * d2 / sigma;               // ∂vega/∂σ — how fast vega dies in a crush

  /* THETA/365 IS A LIE ON EXPIRY DAY and this is where most retail P&L expectations break.
     Theta is the instantaneous rate; premium decay accelerates hyperbolically into expiry, so
     on the last day the true overnight loss is far larger than the derivative suggests. The
     honest number is a re-price one day forward, which is what `decay1d` is. Both are returned
     so the UI can show the real one and the familiar one. */
  const T1 = T - 1 / 365;
  const decay1d = T1 > 0 ? (price(isCall ? 'CE' : 'PE', F, K, T1, sigma, r) - px) : (df * intrinsic - px);

  return {
    ok: true, degenerate: false, reason: null,
    type: isCall ? 'CE' : 'PE', F, K, T, sigma, r, df,
    price: px,
    intrinsic, extrinsic: px - df * intrinsic,
    delta, gamma, vega, vegaPt: vega / 100,
    theta, thetaDay: theta / 365, decay1d,
    rho, vanna, volga,
    d1, d2,
    /* RISK-NEUTRAL probability of finishing in the money. Worth one warning: this is N(d2)
       under the pricing measure, which is not the real-world odds — it embeds the risk premium
       the market charges. It is the right number for "what is the market pricing", the wrong
       number for "what will happen". */
    probItm: isCall ? Nd2 : ncdf(-d2),
    units: UNITS
  };
}

const UNITS = Object.freeze({
  price: 'premium points of the underlying',
  delta: 'premium points per 1 point of forward',
  gamma: 'delta per 1 point of forward',
  vega: 'premium points per 1.00 of vol (= 100 vol points)',
  vegaPt: 'premium points per 1 vol point',
  theta: 'premium points per year',
  thetaDay: 'premium points per calendar day (instantaneous rate — see decay1d)',
  decay1d: 'actual premium change if one calendar day passes and nothing else moves',
  rho: 'premium points per 1.00 of interest rate',
  vanna: 'delta change per 1.00 of vol',
  volga: 'vega change per 1.00 of vol'
});

/* ============================================================
   IMPLIED VOLATILITY

   Safeguarded Newton: take the Newton step when it lands inside the live bracket, bisect when
   it does not. Pure Newton is the standard implementation and it is the standard failure —
   far-OTM options have vega near zero, so `diff/vega` throws the iterate to 400% vol or to a
   negative number and the loop either diverges or silently returns junk. Bisection alone always
   converges because price is strictly increasing in σ, but needs ~50 iterations for 1e-12.
   Combining them gives Newton's speed with bisection's guarantee.
   ============================================================ */

function impliedVol(opts) {
  const o = opts || {};
  const isCall = o.type === 'CE' || o.type === 'call' || o.type === 'C';
  const tp = isCall ? 'CE' : 'PE';
  const { F, K, T } = o;
  const mkt = o.price;
  const r = isNum(o.r) ? o.r : 0;

  const bad = reason => ({ ok: false, iv: null, reason });

  if (!isNum(F) || !isNum(K) || !isNum(mkt) || F <= 0 || K <= 0) return bad('missing or non-positive forward, strike or price');
  if (!isNum(T) || T < MIN_T) return bad('at or past expiry — implied vol is undefined');
  if (mkt <= 0) return bad('no bid — a zero or negative premium carries no volatility information');

  const df = Math.exp(-r * T);
  /* NO-ARBITRAGE BOX. Outside it there is no σ that reproduces the price, and the honest answer
     is to name the violation. In practice these fire on stale quotes and on illiquid deep-ITM
     strikes where the "last traded price" is from an hour ago — exactly the rows that would
     otherwise poison an IV-rank or skew calculation with a fabricated number. */
  const floor = df * Math.max(0, isCall ? F - K : K - F);
  const ceil = df * (isCall ? F : K);
  const eps = Math.max(1e-10, 1e-9 * ceil);
  if (mkt < floor - eps) {
    return bad(`price ${mkt.toFixed(2)} is below intrinsic ${floor.toFixed(2)} — stale or crossed quote, not a volatility`);
  }
  if (mkt > ceil + eps) {
    return bad(`price ${mkt.toFixed(2)} exceeds the no-arbitrage ceiling ${ceil.toFixed(2)}`);
  }

  // Sitting exactly on a boundary is not solvable either: σ→0 and σ→∞ are both limits, not roots.
  if (mkt <= floor + eps) return bad('priced at intrinsic — implied vol is zero in the limit, not measurable');
  if (mkt >= ceil - eps) return bad('priced at the no-arbitrage ceiling — implied vol is unbounded');

  let lo = VOL_LO, hi = VOL_HI;
  if (price(tp, F, K, T, hi, r) < mkt) {
    // Above 500% vol. Expand once so the answer is "solved but absurd" rather than a hard fail,
    // and let the caller judge — a genuine panic print can sit above the default bracket.
    hi = 10;
    if (price(tp, F, K, T, hi, r) < mkt) return bad('price implies volatility above 1000% — treat the quote as broken');
  }

  /* Brenner-Subrahmanyam seed: for an at-the-money-forward option the price is almost exactly
     0.3989·F·σ√T, so inverting that gives a starting point within a few percent for the strikes
     that matter most. Clamped into the bracket so a wild seed cannot escape the safeguard. */
  let s = Math.min(hi * 0.99, Math.max(lo * 1.01, (mkt / df) / F * Math.sqrt(2 * Math.PI / T)));

  /* CONVERGE IN VOLATILITY SPACE, NOT ON THE PRICE RESIDUAL.

     Stopping when |modelPrice − marketPrice| is small is the obvious criterion and it is wrong
     here, because the thing being solved for is the vol, and the exchange rate between the two
     is vega. A 4-sigma in-the-money weekly has a vega around 8e-5 premium points per vol point,
     so a price residual of 1e-6 — utterly converged by any price standard — still leaves the
     implied vol wrong by 0.01 in absolute terms. The solver would report success and hand back
     a number three basis points off, and every IV-rank comparison built on it would inherit
     that. Terminating on the vol STEP and the vol BRACKET instead makes the precision of the
     answer independent of how steep the price happens to be at that strike.

     (When vega really is negligible the vol is not identifiable at any tolerance — that is what
     the `quality` flag below exists to say. The point of converging properly is that the
     inaccuracy is then reported honestly rather than being baked silently into the number.) */
  let iters = 0, converged = false;
  const volTol = 1e-10;

  for (; iters < 200; iters++) {
    const px = price(tp, F, K, T, s, r);
    const diff = px - mkt;

    // Price is non-decreasing in σ, so the sign of the residual says which side of the root we
    // are on and lets the bracket tighten on every single iteration.
    if (diff > 0) hi = s; else lo = s;
    if (hi - lo < Math.max(volTol, s * 1e-12)) { converged = true; s = (lo + hi) / 2; break; }

    const { d1 } = dOf(F, K, T, s);
    const vega = df * F * npdf(d1) * Math.sqrt(T);
    let next = vega > 0 ? s - diff / vega : NaN;
    if (!isFinite(next) || next <= lo || next >= hi) next = (lo + hi) / 2;   // the safeguard
    const step = Math.abs(next - s);
    s = next;
    if (step < Math.max(volTol, s * 1e-12)) { converged = true; break; }
  }

  if (!converged) return bad('volatility solver did not converge in 200 iterations');

  /* IDENTIFIABILITY — the part most implementations omit, and the reason a far-OTM weekly can
     show "IV 142%" with a straight face.

     The exchange ticks in 0.05 points. If an option's vega is 0.4 points per vol point, one
     tick of price moves the implied vol by 0.05/0.4 = 0.125 vol points and the number is solid.
     If vega is 0.01, one tick moves IV by 5 vol points and the "142%" is a rounding artefact of
     a ₹0.05 quote. Same solver, same convergence, completely different trustworthiness — so the
     number is returned WITH the sensitivity that qualifies it. */
  const { d1 } = dOf(F, K, T, s);
  const vegaPt = df * F * npdf(d1) * Math.sqrt(T) / 100;
  const ivPerTick = vegaPt > 0 ? (TICK / vegaPt) / 100 : null;      // in vol terms (0.01 = 1 point)

  let quality = 'good', note = null;
  if (ivPerTick == null || ivPerTick > 0.05) {
    quality = 'unusable';
    note = 'one 0.05 tick moves this implied vol by more than 5 points — the strike is too far out to carry information';
  } else if (ivPerTick > 0.01) {
    quality = 'coarse';
    note = 'one 0.05 tick moves this implied vol by more than 1 point — treat it as indicative only';
  }

  return {
    ok: true, iv: s, reason: null,
    iterations: iters, vegaPt,
    ivPerTick, quality, note,
    intrinsic: floor, extrinsic: mkt - floor
  };
}

/* ============================================================
   PUT-CALL PARITY — the forward, and the arbitrage check

   C − P = e^(−rT)(F − K)   ⟹   F = K + e^(rT)(C − P)

   This is a no-arbitrage identity, not a model: it holds whatever the volatility surface looks
   like, whatever the dividends are, and whatever anyone thinks the index will do. That makes it
   the single most reliable thing that can be extracted from an option chain.
   ============================================================ */

function impliedForward(call, put, K, T, r) {
  if (!isNum(call) || !isNum(put) || !isNum(K) || !isNum(T) || K <= 0 || T < 0) return null;
  const rr = isNum(r) ? r : 0;
  return K + Math.exp(rr * T) * (call - put);
}

/* How far a chain's quoted prices sit from parity, in premium points.

   A large residual is not an arbitrage opportunity for a retail account — it is almost always a
   stale leg, one side not having traded in the last ten minutes. Which is precisely why it is
   worth measuring: it is the cheapest available test of whether the chain data is live. */
function parityCheck(call, put, F, K, T, r) {
  if (!isNum(call) || !isNum(put) || !isNum(F) || !isNum(K) || !isNum(T)) return null;
  const rr = isNum(r) ? r : 0;
  const theoretical = Math.exp(-rr * T) * (F - K);
  const observed = call - put;
  const residual = observed - theoretical;
  return {
    residual,
    residualPct: F > 0 ? residual / F : null,
    // A tenth of a percent of the index — about 25 NIFTY points — is far beyond any plausible
    // funding or fee explanation and means a leg is not live.
    stale: F > 0 && Math.abs(residual) / F > 0.001
  };
}

/* ============================================================
   WHAT THE MARKET IS PRICING — expected move, touch odds, breakeven

   These exist so the platform can answer the one question that decides whether a long option is
   a good idea: IS MY TARGET BIGGER THAN THE MOVE I AM PAYING FOR? If it is not, the trade loses
   money even when the direction is right, which is how most retail option buyers lose.
   ============================================================ */

/* Under the lognormal model the expected ABSOLUTE move to expiry is F·σ√T·√(2/π) ≈ 0.798·F·σ√T,
   and the at-the-money-forward straddle is worth very nearly the same thing. So the straddle
   price IS the market's expected move — no model needed, just read it off the chain. */
function expectedMoveFromStraddle(straddlePrice, F) {
  if (!isNum(straddlePrice) || !isNum(F) || F <= 0 || straddlePrice <= 0) return null;
  return { points: straddlePrice, pct: straddlePrice / F, source: 'ATM straddle price' };
}

function expectedMove(F, T, sigma) {
  if (!isNum(F) || !isNum(T) || !isNum(sigma) || F <= 0 || T <= 0 || sigma <= 0) return null;
  const oneSd = F * sigma * Math.sqrt(T);
  return {
    points: oneSd * Math.sqrt(2 / Math.PI),      // mean absolute move
    pct: sigma * Math.sqrt(T) * Math.sqrt(2 / Math.PI),
    oneSd, oneSdPct: sigma * Math.sqrt(T),
    // ~68% of outcomes inside ±1sd, ~95% inside ±2sd, under the model's own assumptions.
    range1sd: [F - oneSd, F + oneSd],
    range2sd: [F - 2 * oneSd, F + 2 * oneSd],
    source: 'implied volatility'
  };
}

/* Probability of TOUCHING a level before expiry, as opposed to finishing beyond it.

   For a driftless process the reflection principle gives P(touch) = 2·P(finish beyond) — a level
   is roughly twice as likely to be tagged at some point as it is to be tagged at the bell. This
   is the number that matters for a stop-loss, and the one traders most often substitute
   probItm for. Capped at 1 and flagged as an approximation, because the forward drift and the
   discrete 15:30 close both bend it. */
function probTouch(F, level, T, sigma) {
  if (!isNum(F) || !isNum(level) || !isNum(T) || !isNum(sigma) || F <= 0 || level <= 0 || T <= 0 || sigma <= 0) return null;
  if (level === F) return 1;
  const up = level > F;
  const { d2 } = dOf(F, level, T, sigma);
  const pEnd = up ? ncdf(d2) : ncdf(-d2);
  return {
    end: pEnd,
    touch: Math.min(1, 2 * pEnd),
    approx: 'reflection principle, driftless — an approximation, not a closed form under drift'
  };
}

/* Breakeven at expiry, before costs. costs.js adds brokerage, STT and the expiry trap on top;
   this is the raw model number so the two can be shown side by side and the gap between them
   is visible rather than buried. */
function breakeven(type, K, premium) {
  if (!isNum(K) || !isNum(premium)) return null;
  const isCall = type === 'CE' || type === 'call' || type === 'C';
  return isCall ? K + premium : K - premium;
}

module.exports = {
  ncdf, npdf,
  MIN_T, VOL_LO, VOL_HI, TICK, UNITS,
  expiryInstant, yearsToExpiry, daysToExpiry,
  price, black76, impliedVol,
  impliedForward, parityCheck,
  expectedMove, expectedMoveFromStraddle, probTouch, breakeven,
  __dOf: dOf
};
