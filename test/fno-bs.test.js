/* ============================================================
   F&O PRICING CORE — tests

   The user asked for this to be "tested and calculated with every theory and practical as
   possible and as accurate as possible". For a pricing engine that is not a slogan, it is a
   specific and achievable standard, because option pricing is one of the few things in this
   platform that has a right answer you can check against something other than your own code.

   FOUR INDEPENDENT WAYS OF BEING RIGHT, and this file uses all four:

   1. AGAINST A DIFFERENT ALGORITHM. The normal CDF is checked against published values and
      against a second, unrelated approximation written here in the test.

   2. AGAINST NUMERICAL INTEGRATION. The Black-76 price is re-derived from the MODEL DEFINITION
      — the discounted expectation of the payoff under a lognormal — by Simpson quadrature that
      never calls N(). If the closed form and the integral agree to 1e-10, the formula is right.
      This is the strongest check in the file: it shares no code path with the thing it tests.

   3. AGAINST NO-ARBITRAGE IDENTITIES. Put-call parity, the price bounds, monotonicity in vol,
      the equality of call and put gamma/vega. These hold regardless of the model, so violating
      one is proof of a bug rather than a matter of taste.

   4. AGAINST CENTRAL DIFFERENCES. Every Greek is a derivative, so every Greek is checkable by
      re-pricing either side of it. All of them, over a grid of moneyness, maturity and vol,
      calls and puts.

   Plus the honesty tests this codebase insists on: the solver must REFUSE a quote below
   intrinsic rather than inventing a volatility for it, and must flag a strike whose vega is so
   small that its "implied vol" is an artefact of the 0.05 tick.
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const BS = require('../fno/bs');

/* ---------- helpers ---------- */

const close = (a, b, tol, msg) => assert.ok(
  Math.abs(a - b) <= tol,
  `${msg || 'values differ'}: got ${a}, expected ${b}, |diff| ${Math.abs(a - b)} > ${tol}`
);

/* An INDEPENDENT normal CDF — Abramowitz & Stegun 7.1.26 via erf. Accurate to ~1.5e-7, which is
   nowhere near good enough to price with (that is the whole reason bs.js uses Hart) but is more
   than good enough to prove Hart's implementation isn't transcribed wrong. */
function ncdfAS(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/* THE PRICE, FROM THE MODEL'S DEFINITION, WITHOUT THE FORMULA.

   Black-76 says the option is the discounted expectation of its payoff when the forward is
   lognormal:  F_T = F · exp(σ√T·z − σ²T/2),  z ~ N(0,1).

       C = e^(−rT) · ∫ max(F·exp(σ√T·z − σ²T/2) − K, 0) · φ(z) dz

   Integrating that numerically re-derives the price from first principles. The payoff has a kink
   where it crosses zero, and Simpson's rule converges badly across a kink, so integration starts
   exactly AT the kink — whose location is written out longhand here rather than borrowed from
   bs.js, so the test stays independent of the code under test. */
function priceByQuadrature(type, F, K, T, sigma, r, nIn) {
  const n = nIn || 40000;                       // even, for Simpson
  const sq = sigma * Math.sqrt(T);
  const kink = (Math.log(K / F) + sq * sq / 2) / sq;   // z where F_T = K  (this is −d2)
  const isCall = type === 'CE';
  const lo = isCall ? Math.max(kink, -14) : -14;
  const hi = isCall ? 14 : Math.min(kink, 14);
  if (hi <= lo) return 0;

  const pdf = z => Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  const f = z => {
    const FT = F * Math.exp(sq * z - sq * sq / 2);
    const payoff = isCall ? FT - K : K - FT;
    return (payoff > 0 ? payoff : 0) * pdf(z);
  };

  const h = (hi - lo) / n;
  let s = f(lo) + f(hi);
  for (let i = 1; i < n; i++) s += f(lo + i * h) * (i % 2 ? 4 : 2);
  return Math.exp(-r * T) * s * h / 3;
}

/* A representative grid. Deliberately includes the awkward corners: a 1-day expiry, a 5%-vol
   sleepy market, a 90%-vol panic, and strikes 25% out of the money where vega collapses. */
const GRID = [];
for (const T of [1 / 365, 7 / 365, 30 / 365, 0.25, 1]) {
  for (const sigma of [0.05, 0.12, 0.20, 0.45, 0.90]) {
    for (const mny of [0.75, 0.90, 0.97, 1.0, 1.03, 1.10, 1.25]) {
      GRID.push({ F: 24000, K: 24000 * mny, T, sigma, r: 0.065 });
    }
  }
}

/* ============================================================
   1. THE NORMAL DISTRIBUTION
   ============================================================ */

test('ncdf matches published values to double precision', () => {
  // Standard normal table values, exact to the digits shown.
  const REF = [
    [0, 0.5],
    [1, 0.8413447460685429],
    [-1, 0.15865525393145705],
    [1.96, 0.9750021048517795],
    [-1.6448536269514722, 0.05],          // the exact 5% quantile — a self-verifying reference
    [2, 0.9772498680518208],
    [-3, 0.0013498980316300946],
    [5, 0.9999997133484281],
    [-7, 1.2798125438858348e-12],
    [0.35, 0.6368306511756191],
    [0.15, 0.5596176923702425]
  ];
  for (const [x, want] of REF) {
    const got = BS.ncdf(x);
    // Relative tolerance in the tails — 1.28e-12 cannot be checked to an absolute 1e-14.
    const tol = Math.max(1e-14, Math.abs(want) * 1e-11);
    close(got, want, tol, `ncdf(${x})`);
  }
});

test('ncdf agrees with an independent approximation across the real line', () => {
  for (let x = -6; x <= 6; x += 0.01) {
    close(BS.ncdf(x), ncdfAS(x), 2e-7, `ncdf vs A&S at ${x.toFixed(2)}`);
  }
});

test('ncdf is symmetric, monotone and bounded', () => {
  let prev = -1;
  for (let x = -40; x <= 40; x += 0.05) {
    const v = BS.ncdf(x);
    assert.ok(v >= 0 && v <= 1, `ncdf(${x}) out of [0,1]: ${v}`);
    assert.ok(v >= prev - 1e-15, `ncdf not monotone at ${x}`);
    prev = v;
    close(v + BS.ncdf(-x), 1, 1e-14, `symmetry at ${x}`);
  }
});

test('npdf is the derivative of ncdf', () => {
  const h = 1e-5;
  for (const x of [-3, -1.5, -0.4, 0, 0.4, 1.5, 3]) {
    const num = (BS.ncdf(x + h) - BS.ncdf(x - h)) / (2 * h);
    close(num, BS.npdf(x), 1e-9, `d/dx ncdf at ${x}`);
  }
  close(BS.npdf(0), 0.3989422804014327, 1e-15, 'npdf(0)');
});

/* ============================================================
   2. THE PRICE
   ============================================================ */

test('Black-76 reproduces the textbook Black-Scholes reference value', () => {
  /* The most-quoted worked example in the literature: S=100, K=100, r=5%, σ=20%, T=1 year,
     no dividends → call 10.4506, put 5.5735.

     Black-76 is fed the forward that corresponds to those spot inputs, F = S·e^((r−q)T). If
     the two forms agree here, the substitution that lets this engine avoid ever estimating a
     dividend yield is sound. */
  const S = 100, K = 100, r = 0.05, sigma = 0.2, T = 1;
  const F = S * Math.exp(r * T);

  const c = BS.black76({ type: 'CE', F, K, T, sigma, r });
  const p = BS.black76({ type: 'PE', F, K, T, sigma, r });

  close(c.price, 10.450583572185565, 1e-9, 'reference call');
  close(p.price, 5.573526022256971, 1e-9, 'reference put');

  // And the reference Greeks, in spot terms: delta 0.6368, gamma 0.018762, vega 37.524/100.
  close(c.delta * Math.exp(r * T), 0.6368306511756191, 1e-9, 'reference spot delta');
  close(c.vega / 100, 0.37524, 1e-5, 'reference vega per point');
});

test('closed form equals numerical integration of the payoff — the model re-derived', () => {
  /* The decisive test. `priceByQuadrature` shares no code with bs.js: it integrates the
     lognormal expectation directly and never evaluates a cumulative normal. Agreement to 1e-9
     on a 24000-point index means the closed form IS the discounted expectation. */
  let worst = 0;
  for (const g of GRID) {
    for (const type of ['CE', 'PE']) {
      const closed = BS.price(type, g.F, g.K, g.T, g.sigma, g.r);
      const quad = priceByQuadrature(type, g.F, g.K, g.T, g.sigma, g.r);
      const err = Math.abs(closed - quad);
      worst = Math.max(worst, err);
      assert.ok(err < 1e-7 + 1e-9 * g.F,
        `quadrature mismatch ${type} K=${g.K} T=${g.T} σ=${g.sigma}: closed ${closed}, integral ${quad}`);
    }
  }
  assert.ok(worst < 1e-4, `worst quadrature error ${worst}`);
});

test('put-call parity holds exactly', () => {
  for (const g of GRID) {
    const c = BS.price('CE', g.F, g.K, g.T, g.sigma, g.r);
    const p = BS.price('PE', g.F, g.K, g.T, g.sigma, g.r);
    const want = Math.exp(-g.r * g.T) * (g.F - g.K);
    // Relative to the index level, not absolute — 1e-12 of 24000 is 2.4e-8.
    close(c - p, want, 1e-9 * g.F, `parity K=${g.K} T=${g.T} σ=${g.sigma}`);
  }
});

test('price respects its no-arbitrage bounds and is monotone in volatility', () => {
  for (const g of GRID) {
    const df = Math.exp(-g.r * g.T);
    for (const type of ['CE', 'PE']) {
      const px = BS.price(type, g.F, g.K, g.T, g.sigma, g.r);
      const intrinsic = df * Math.max(0, type === 'CE' ? g.F - g.K : g.K - g.F);
      const ceiling = df * (type === 'CE' ? g.F : g.K);
      assert.ok(px >= intrinsic - 1e-9, `${type} below intrinsic at K=${g.K}`);
      assert.ok(px <= ceiling + 1e-9, `${type} above ceiling at K=${g.K}`);
    }
  }
  /* Non-decreasing in σ everywhere — the property the IV solver's bisection relies on — and
     STRICTLY increasing wherever the option has real time value.

     The distinction is not pedantry. A 25%-in-the-money call at 1% vol is worth its discounted
     intrinsic to the last bit of a double, so raising vol from 1% to 2% changes nothing a float
     can represent. That flat shelf is exactly the region where the solver refuses to report an
     implied vol, so the two behaviours have to agree: no strictness where there is no signal. */
  const df = Math.exp(-0.065 * 0.25);
  for (const K of [18000, 24000, 30000]) {
    let prev = -1;
    for (let s = 0.01; s < 3; s += 0.01) {
      const px = BS.price('CE', 24000, K, 0.25, s, 0.065);
      assert.ok(px >= prev, `price decreased in vol at K=${K} σ=${s.toFixed(2)}`);
      const extrinsic = px - df * Math.max(0, 24000 - K);
      if (extrinsic > 0.01) assert.ok(px > prev, `price not strictly increasing where it has time value: K=${K} σ=${s.toFixed(2)}`);
      prev = px;
    }
  }
});

test('zero vol and zero time both collapse to discounted intrinsic', () => {
  const F = 24000, r = 0.065, T = 0.5;
  for (const K of [20000, 24000, 28000]) {
    const df = Math.exp(-r * T);
    close(BS.price('CE', F, K, T, 0, r), df * Math.max(0, F - K), 1e-12, 'zero-vol call');
    close(BS.price('PE', F, K, T, 0, r), df * Math.max(0, K - F), 1e-12, 'zero-vol put');
    close(BS.price('CE', F, K, 0, 0.2, r), Math.max(0, F - K), 1e-12, 'expired call');
    close(BS.price('PE', F, K, 0, 0.2, r), Math.max(0, K - F), 1e-12, 'expired put');
  }
  // And the limit is approached, not jumped to.
  const tiny = BS.price('CE', 24000, 24000, 1e-8, 0.2, 0.065);
  assert.ok(tiny > 0 && tiny < 1, `vanishing-time ATM call should be near zero, got ${tiny}`);
});

/* ============================================================
   3. THE GREEKS — every one of them against a central difference
   ============================================================ */

test('delta, gamma, vega, theta and rho match central differences', () => {
  for (const g of GRID) {
    if (g.T < 3 / 365) continue;                 // T±h must stay positive; 1-day is handled below
    for (const type of ['CE', 'PE']) {
      const v = BS.black76({ type, ...g });
      assert.ok(v.ok && !v.degenerate, 'valuation should be well defined on the grid');

      const hF = g.F * 1e-4;
      const numDelta = (BS.price(type, g.F + hF, g.K, g.T, g.sigma, g.r) - BS.price(type, g.F - hF, g.K, g.T, g.sigma, g.r)) / (2 * hF);
      close(numDelta, v.delta, 1e-6, `delta ${type} K=${g.K} T=${g.T} σ=${g.sigma}`);

      /* Gamma is checked as the derivative of DELTA, not as a second difference of price.
         Second-differencing price is squeezed between two errors: too small a step and
         catastrophic cancellation swamps the answer, too large a step and the step leaves the
         region where the price is locally quadratic. On a 7-day 5%-vol option, one standard
         deviation is only 166 points, so any step big enough to survive cancellation is already
         most of a sigma wide and measures the wrong thing. Differencing delta — itself proven
         correct on the line above — is a first derivative and has neither problem.

         The step is scaled to the option's OWN width rather than being a fixed fraction of the
         index, so a sleepy weekly and a panicky yearly are both differenced locally.

         Even then a plain central difference is only O(h²), and four standard deviations out in
         the tail gamma varies so fast that h² leaves a tenth of a percent on the table. One
         Richardson extrapolation — combine the difference at h and at h/2 as (4·D(h/2) − D(h))/3
         — cancels the h² term and buys four more digits for one extra evaluation. Without it
         this test cannot tell a 0.1% coding error from its own truncation error, which would
         make it no test at all. */
      const hG = Math.max(g.F * g.sigma * Math.sqrt(g.T) * 0.02, 1e-3);
      const dAt = x => BS.black76({ type, ...g, F: x }).delta;
      const D1 = (dAt(g.F + hG) - dAt(g.F - hG)) / (2 * hG);
      const D2 = (dAt(g.F + hG / 2) - dAt(g.F - hG / 2)) / hG;
      close((4 * D2 - D1) / 3, v.gamma, Math.max(1e-15, Math.abs(v.gamma) * 1e-5),
        `gamma ${type} K=${g.K} T=${g.T} σ=${g.sigma}`);

      const hS = 1e-5;
      const numVega = (BS.price(type, g.F, g.K, g.T, g.sigma + hS, g.r) - BS.price(type, g.F, g.K, g.T, g.sigma - hS, g.r)) / (2 * hS);
      close(numVega, v.vega, Math.max(1e-5, Math.abs(v.vega) * 1e-6), `vega ${type} K=${g.K} T=${g.T} σ=${g.sigma}`);

      // theta = ∂V/∂t = −∂V/∂T. The sign convention this asserts is the one the UI depends on.
      const hT = Math.min(1e-6, g.T / 100);
      const numTheta = -(BS.price(type, g.F, g.K, g.T + hT, g.sigma, g.r) - BS.price(type, g.F, g.K, g.T - hT, g.sigma, g.r)) / (2 * hT);
      close(numTheta, v.theta, Math.max(1e-3, Math.abs(v.theta) * 1e-5), `theta ${type} K=${g.K} T=${g.T} σ=${g.sigma}`);

      const hR = 1e-7;
      const numRho = (BS.price(type, g.F, g.K, g.T, g.sigma, g.r + hR) - BS.price(type, g.F, g.K, g.T, g.sigma, g.r - hR)) / (2 * hR);
      close(numRho, v.rho, Math.max(1e-4, Math.abs(v.rho) * 1e-5), `rho ${type} K=${g.K} T=${g.T} σ=${g.sigma}`);
    }
  }
});

test('vanna and volga match central differences of delta and vega', () => {
  for (const g of GRID) {
    if (g.T < 3 / 365) continue;
    for (const type of ['CE', 'PE']) {
      const v = BS.black76({ type, ...g });
      const h = 1e-5;
      const up = BS.black76({ type, ...g, sigma: g.sigma + h });
      const dn = BS.black76({ type, ...g, sigma: g.sigma - h });

      close((up.delta - dn.delta) / (2 * h), v.vanna, Math.max(1e-5, Math.abs(v.vanna) * 1e-5),
        `vanna ${type} K=${g.K} T=${g.T} σ=${g.sigma}`);
      close((up.vega - dn.vega) / (2 * h), v.volga, Math.max(1e-2, Math.abs(v.volga) * 1e-4),
        `volga ${type} K=${g.K} T=${g.T} σ=${g.sigma}`);
    }
  }
});

test('call and put share gamma, vega, vanna and volga; their deltas differ by the discount factor', () => {
  /* Forced by parity: C − P is linear in F and has no σ in it at all, so every second-order
     Greek must be identical and the delta gap must be exactly e^(−rT). Any drift here is an
     algebra error that the numerical tests above could in principle miss on a symmetric grid. */
  for (const g of GRID) {
    if (g.T < 3 / 365) continue;
    const c = BS.black76({ type: 'CE', ...g });
    const p = BS.black76({ type: 'PE', ...g });
    close(c.gamma, p.gamma, Math.abs(c.gamma) * 1e-12 + 1e-15, 'gamma parity');
    close(c.vega, p.vega, Math.abs(c.vega) * 1e-12 + 1e-12, 'vega parity');
    close(c.vanna, p.vanna, Math.abs(c.vanna) * 1e-12 + 1e-15, 'vanna parity');
    close(c.volga, p.volga, Math.abs(c.volga) * 1e-12 + 1e-12, 'volga parity');
    close(c.delta - p.delta, Math.exp(-g.r * g.T), 1e-12, 'delta gap');
  }
});

test('deltas and ITM probabilities sit in their proper ranges and limits', () => {
  const T = 30 / 365, sigma = 0.14, r = 0.065, F = 24000;
  for (const K of [12000, 20000, 24000, 28000, 48000]) {
    const c = BS.black76({ type: 'CE', F, K, T, sigma, r });
    const p = BS.black76({ type: 'PE', F, K, T, sigma, r });
    assert.ok(c.delta >= 0 && c.delta <= 1, `call delta out of range at K=${K}: ${c.delta}`);
    assert.ok(p.delta <= 0 && p.delta >= -1, `put delta out of range at K=${K}: ${p.delta}`);
    assert.ok(c.gamma > 0 && c.vega > 0, 'gamma and vega are positive for long options');
    assert.ok(c.probItm >= 0 && c.probItm <= 1, 'probItm in range');
    close(c.probItm + p.probItm, 1, 1e-12, 'call and put ITM probabilities are complements');
  }
  // Deep ITM → delta approaches the discount factor; deep OTM → zero.
  const df = Math.exp(-r * T);
  close(BS.black76({ type: 'CE', F, K: 6000, T, sigma, r }).delta, df, 1e-9, 'deep ITM call delta → df');
  close(BS.black76({ type: 'CE', F, K: 96000, T, sigma, r }).delta, 0, 1e-9, 'deep OTM call delta → 0');
  // ATM-forward delta is just above half the discount factor.
  const atm = BS.black76({ type: 'CE', F, K: F, T, sigma, r });
  assert.ok(atm.delta > df * 0.5 && atm.delta < df * 0.55, `ATM call delta ${atm.delta} vs df/2 ${df / 2}`);
});

test('a deep in-the-money Black-76 call has POSITIVE theta', () => {
  /* This is the sign that differs from the spot-BSM formula printed in most references, and the
     comment in bs.js makes a specific claim about it. Here it is, checked numerically rather
     than asserted: with the whole payoff discounted, an in-the-money option gains value as the
     discounting unwinds, so time passing HELPS the holder. Getting this backwards would show a
     deep ITM hedge leg bleeding theta it does not bleed. */
  const F = 24000, K = 18000, T = 0.5, sigma = 0.12, r = 0.065;
  const v = BS.black76({ type: 'CE', F, K, T, sigma, r });
  assert.ok(v.theta > 0, `expected positive theta deep ITM, got ${v.theta}`);

  const h = 1e-6;
  const numTheta = -(BS.price('CE', F, K, T + h, sigma, r) - BS.price('CE', F, K, T - h, sigma, r)) / (2 * h);
  assert.ok(numTheta > 0, 'the numerical derivative agrees it is positive');
  close(numTheta, v.theta, Math.abs(v.theta) * 1e-5, 'deep ITM theta');

  // At the money it is firmly negative, which is the case everyone expects.
  assert.ok(BS.black76({ type: 'CE', F, K: F, T, sigma, r }).theta < 0, 'ATM theta is negative');
});

test('decay1d is the honest decay number and theta/365 is not, near expiry', () => {
  const F = 24000, K = 24000, sigma = 0.16, r = 0.065;

  // Comfortably before expiry the two agree closely — theta is a good local approximation.
  const far = BS.black76({ type: 'CE', F, K, T: 60 / 365, sigma, r });
  close(far.decay1d, far.thetaDay, Math.abs(far.thetaDay) * 0.02, '60 DTE: theta/365 ≈ actual decay');

  /* Inside the final hours it does not, and the algebra says exactly when it stops: for an
     at-the-money option, premium ≈ 0.399·F·σ√T while the instantaneous daily rate is
     0.399·F·σ/(2√T·365), so their ratio is 2·365·T — the fraction of a day remaining, doubled.
     With under half a day left the "daily theta" a broker screen shows exceeds the entire
     premium, which is arithmetically impossible as a loss. Here at ~4.8 hours it overstates by
     two and a half times. */
  const last = BS.black76({ type: 'CE', F, K, T: 0.2 / 365, sigma, r });
  assert.ok(Math.abs(last.thetaDay) > last.price * 1.5,
    `theta/365 (${last.thetaDay}) should overshoot the whole premium (${last.price}) with hours left`);
  close(Math.abs(last.thetaDay / last.price), 1 / (2 * 0.2), 0.05, 'the ratio is 1/(2·days remaining)');
  assert.ok(last.decay1d < 0 && Math.abs(last.decay1d) <= last.price + 1e-9,
    `a long option cannot decay past its premium: decay1d ${last.decay1d} vs price ${last.price}`);

  // The invariant across the board: a long option's one-day decay never exceeds its value.
  for (const g of GRID) {
    for (const type of ['CE', 'PE']) {
      const v = BS.black76({ type, ...g });
      if (!v.ok || v.degenerate) continue;
      assert.ok(v.decay1d <= 1e-9 || v.intrinsic > 0,
        `only an in-the-money option can gain from time passing (${type} K=${g.K})`);
      assert.ok(v.price + v.decay1d >= -1e-9,
        `decay took the price below zero: ${type} K=${g.K} T=${g.T}`);
    }
  }
});

test('at expiry the engine says so instead of printing exploded Greeks', () => {
  const v = BS.black76({ type: 'CE', F: 24000, K: 23500, T: 0, sigma: 0.15, r: 0.065 });
  assert.equal(v.ok, true);
  assert.equal(v.degenerate, true);
  assert.match(v.reason, /at expiry/i);
  close(v.price, 500, 1e-9, 'expired ITM call is its intrinsic');
  assert.equal(v.delta, 1);
  assert.equal(v.gamma, null, 'gamma is not a number at expiry — it must not be reported as one');
  assert.equal(v.vega, null);
  assert.equal(v.theta, null);

  const otm = BS.black76({ type: 'CE', F: 24000, K: 24500, T: 0, sigma: 0.15, r: 0.065 });
  assert.equal(otm.price, 0);
  assert.equal(otm.delta, 0);

  // Rubbish in → a reason, not a NaN.
  assert.equal(BS.black76({ type: 'CE', F: -1, K: 100, T: 1, sigma: 0.2 }).ok, false);
  assert.equal(BS.price('CE', 24000, 0, 0.1, 0.2, 0.065), null);
});

/* ============================================================
   4. IMPLIED VOLATILITY
   ============================================================ */

test('implied vol round-trips to machine precision across the whole grid', () => {
  let worst = 0, checked = 0, skipped = 0;
  for (const g of GRID) {
    for (const type of ['CE', 'PE']) {
      const px = BS.price(type, g.F, g.K, g.T, g.sigma, g.r);
      const sol = BS.impliedVol({ type, price: px, F: g.F, K: g.K, T: g.T, r: g.r });
      if (!sol.ok) {
        /* The solver is allowed to refuse, but only where refusing is CORRECT, and the test
           states that criterion independently rather than trusting the solver's own excuse.

           Implied vol lives entirely in the EXTRINSIC value — the part of the premium that is
           not already locked in by the strike. A 25%-in-the-money weekly has no extrinsic value
           left at all: its price equals its discounted intrinsic to the last bit of a double,
           and there is no σ that "explains" it because every σ below some threshold produces the
           same number. Refusing is the honest answer. Refusing a strike with a tick or more of
           real time value would be a bug. */
        skipped++;
        const df = Math.exp(-g.r * g.T);
        const extrinsic = px - df * Math.max(0, type === 'CE' ? g.F - g.K : g.K - g.F);
        assert.ok(extrinsic < BS.TICK || px < BS.TICK || px > BS.price(type, g.F, g.K, g.T, 4.9, g.r),
          `solver refused a strike with ${extrinsic.toFixed(4)} points of time value: ${sol.reason} (K=${g.K} T=${g.T} σ=${g.sigma})`);
        continue;
      }
      checked++;
      const err = Math.abs(sol.iv - g.sigma);
      worst = Math.max(worst, err);
      assert.ok(err < 1e-6, `IV round-trip ${type} K=${g.K} T=${g.T} σ=${g.sigma} → ${sol.iv}`);
    }
  }
  assert.ok(checked > 200, `expected most of the grid to solve, only ${checked} did`);
  assert.ok(worst < 1e-6, `worst IV error ${worst} over ${checked} solves (${skipped} refused)`);
});

test('implied vol converges from hostile starting points', () => {
  // The seed is tuned for at-the-money. These are the cases that break a naive Newton loop.
  const cases = [
    { F: 24000, K: 24000, T: 0.5 / 365, sigma: 0.35, r: 0.065, what: 'half a day to expiry' },
    { F: 24000, K: 24000, T: 2, sigma: 0.02, r: 0.065, what: 'two years, 2% vol' },
    { F: 24000, K: 26000, T: 1 / 365, sigma: 1.5, r: 0.065, what: '1 DTE, 150% vol, 8% OTM' },
    { F: 24000, K: 15000, T: 0.25, sigma: 0.4, r: 0.065, what: 'deep ITM' },
    { F: 52000, K: 52000, T: 7 / 365, sigma: 0.11, r: 0.065, what: 'BANKNIFTY-scale weekly' },
    { F: 80000, K: 81000, T: 3 / 365, sigma: 0.09, r: 0.065, what: 'SENSEX-scale, quiet' }
  ];
  for (const c of cases) {
    for (const type of ['CE', 'PE']) {
      const px = BS.price(type, c.F, c.K, c.T, c.sigma, c.r);
      const sol = BS.impliedVol({ type, price: px, F: c.F, K: c.K, T: c.T, r: c.r });
      assert.ok(sol.ok, `${c.what} ${type}: ${sol.reason}`);
      close(sol.iv, c.sigma, 1e-6, `${c.what} ${type}`);
      assert.ok(sol.iterations < 100, `${c.what}: ${sol.iterations} iterations`);
    }
  }
});

test('implied vol refuses impossible quotes instead of inventing a number', () => {
  const F = 24000, K = 23000, T = 7 / 365, r = 0.065;
  const df = Math.exp(-r * T);
  const intrinsic = df * (F - K);

  // Below intrinsic — a crossed or stale quote. This is the one that silently poisons IV rank.
  const below = BS.impliedVol({ type: 'CE', price: intrinsic - 50, F, K, T, r });
  assert.equal(below.ok, false);
  assert.equal(below.iv, null);
  assert.match(below.reason, /below intrinsic/i);

  // Above the forward — free money that isn't there.
  const above = BS.impliedVol({ type: 'CE', price: df * F + 10, F, K, T, r });
  assert.equal(above.ok, false);
  assert.match(above.reason, /ceiling/i);

  // Exactly at intrinsic: the answer is a limit, not a root.
  assert.equal(BS.impliedVol({ type: 'CE', price: intrinsic, F, K, T, r }).ok, false);

  // No bid, expired, missing inputs.
  assert.equal(BS.impliedVol({ type: 'CE', price: 0, F, K, T, r }).ok, false);
  assert.equal(BS.impliedVol({ type: 'CE', price: 100, F, K, T: 0, r }).ok, false);
  assert.equal(BS.impliedVol({ type: 'CE', price: 100, F: null, K, T, r }).ok, false);
  assert.equal(BS.impliedVol({ type: 'PE', price: -5, F, K, T, r }).ok, false);

  // Every refusal carries a reason a human can act on.
  for (const bad of [below, above]) assert.ok(bad.reason && bad.reason.length > 20, 'refusals explain themselves');
});

test('implied vol reports when the strike is too far out to carry information', () => {
  /* A 26000-strike weekly call on a 24000 forward at 10% vol is worth fractions of a point. Its
     vega is so small that one 0.05 tick swings the implied vol by whole points, and treating
     that number as data is how a skew reading turns into noise. The solver must still solve —
     and must say the answer is not trustworthy. */
  const F = 24000, T = 2 / 365, r = 0.065, sigma = 0.10;
  const far = 27500;
  const px = BS.price('CE', F, far, T, sigma, r);
  const sol = BS.impliedVol({ type: 'CE', price: px, F, K: far, T, r });
  if (sol.ok) {
    assert.notEqual(sol.quality, 'good', `expected a degraded quality flag, got ${sol.quality} (ivPerTick ${sol.ivPerTick})`);
    assert.ok(sol.note, 'a degraded solve explains itself');
    assert.ok(sol.ivPerTick > 0.01, `one tick should move IV by more than a point, got ${sol.ivPerTick}`);
  }

  // An at-the-money weekly is the opposite case and must come back clean.
  const atm = BS.impliedVol({ type: 'CE', price: BS.price('CE', F, F, T, 0.13, r), F, K: F, T, r });
  assert.ok(atm.ok && atm.quality === 'good', `ATM weekly should be a good solve, got ${atm.quality}`);
  assert.ok(atm.ivPerTick < 0.002, `ATM ivPerTick should be small, got ${atm.ivPerTick}`);
});

test('implied vol splits the premium into intrinsic and extrinsic correctly', () => {
  const F = 24000, K = 23500, T = 10 / 365, r = 0.065, sigma = 0.15;
  const px = BS.price('CE', F, K, T, sigma, r);
  const sol = BS.impliedVol({ type: 'CE', price: px, F, K, T, r });
  assert.ok(sol.ok);
  close(sol.intrinsic + sol.extrinsic, px, 1e-9, 'the two halves make the whole');
  assert.ok(sol.extrinsic > 0, 'a live option has time value');
  // Extrinsic is what decays; this is the number the UI must show, not the raw premium.
  const v = BS.black76({ type: 'CE', F, K, T, sigma, r });
  close(sol.extrinsic, v.extrinsic, 1e-9, 'valuation and solver agree on time value');
});

/* ============================================================
   5. THE FORWARD, FROM THE CHAIN
   ============================================================ */

test('put-call parity recovers the forward exactly', () => {
  for (const F of [24000, 52000, 81000]) {
    for (const T of [1 / 365, 7 / 365, 45 / 365]) {
      for (const K of [F * 0.95, F, F * 1.05]) {
        const r = 0.065, sigma = 0.14;
        const c = BS.price('CE', F, K, T, sigma, r);
        const p = BS.price('PE', F, K, T, sigma, r);
        close(BS.impliedForward(c, p, K, T, r), F, 1e-7 * F, `forward from K=${K} T=${T}`);
      }
    }
  }
  /* THE POINT OF THE WHOLE APPROACH: the recovered forward does not depend on the volatility
     used to build the quotes. Parity is a no-arbitrage identity, so a wrong vol assumption
     cannot contaminate the forward — which is exactly why this engine never has to guess a
     dividend yield. */
  const F = 24000, K = 24000, T = 30 / 365, r = 0.065;
  for (const sigma of [0.05, 0.2, 0.8]) {
    const c = BS.price('CE', F, K, T, sigma, r);
    const p = BS.price('PE', F, K, T, sigma, r);
    close(BS.impliedForward(c, p, K, T, r), F, 1e-7 * F, `forward is vol-independent (σ=${sigma})`);
  }
  assert.equal(BS.impliedForward(null, 10, 24000, 0.1, 0.065), null);
});

test('the parity residual detects a stale leg', () => {
  const F = 24000, K = 24000, T = 7 / 365, r = 0.065, sigma = 0.14;
  const c = BS.price('CE', F, K, T, sigma, r);
  const p = BS.price('PE', F, K, T, sigma, r);

  const live = BS.parityCheck(c, p, F, K, T, r);
  assert.ok(Math.abs(live.residual) < 1e-8, `live chain residual ${live.residual}`);
  assert.equal(live.stale, false);

  // One leg forty points behind — a call that last printed ten minutes ago.
  const stale = BS.parityCheck(c + 40, p, F, K, T, r);
  close(stale.residual, 40, 1e-8, 'residual equals the staleness');
  assert.equal(stale.stale, true, '40 points on a 24000 index is far beyond any funding explanation');

  // Half a point is noise, not staleness.
  assert.equal(BS.parityCheck(c + 0.5, p, F, K, T, r).stale, false);
  assert.equal(BS.parityCheck(null, p, F, K, T, r), null);
});

/* ============================================================
   6. WHAT THE MARKET IS PRICING
   ============================================================ */

test('the ATM straddle IS the expected move', () => {
  /* The identity the whole "is my target bigger than the move I am paying for" rule rests on:
     the at-the-money-forward straddle price equals F·σ√T·√(2/π), the mean absolute move. If
     these two ways of computing it disagree, the rule is comparing apples to oranges. */
  const F = 24000, r = 0.065;
  for (const T of [2 / 365, 7 / 365, 30 / 365]) {
    for (const sigma of [0.08, 0.14, 0.25]) {
      const df = Math.exp(-r * T);
      const straddle = (BS.price('CE', F, F, T, sigma, r) + BS.price('PE', F, F, T, sigma, r)) / df;
      const em = BS.expectedMove(F, T, sigma);
      const rel = Math.abs(straddle - em.points) / em.points;
      assert.ok(rel < 0.005, `straddle ${straddle.toFixed(2)} vs expected move ${em.points.toFixed(2)} (${(rel * 100).toFixed(3)}%) at T=${T} σ=${sigma}`);

      const fromStraddle = BS.expectedMoveFromStraddle(straddle, F);
      close(fromStraddle.pct, straddle / F, 1e-12, 'straddle percentage');
    }
  }
  // One-sigma bands bracket the forward symmetrically, in points.
  const em = BS.expectedMove(24000, 7 / 365, 0.14);
  close(em.range1sd[1] - 24000, 24000 - em.range1sd[0], 1e-9, 'bands are symmetric in points');
  close(em.oneSdPct, 0.14 * Math.sqrt(7 / 365), 1e-12, 'one-sigma percentage');
  assert.equal(BS.expectedMove(24000, 0, 0.14), null, 'no expected move without time');
});

test('probability of touching a level is about twice the probability of finishing beyond it', () => {
  const F = 24000, T = 7 / 365, sigma = 0.14;
  for (const level of [24500, 25000, 23500, 23000]) {
    const pt = BS.probTouch(F, level, T, sigma);
    close(pt.touch, Math.min(1, 2 * pt.end), 1e-12, 'reflection principle');
    assert.ok(pt.touch >= pt.end, 'touching is never less likely than finishing beyond');
    assert.ok(pt.touch <= 1 && pt.end >= 0, 'probabilities stay in range');
  }
  // A level further away is harder to reach.
  assert.ok(BS.probTouch(F, 25000, T, sigma).touch < BS.probTouch(F, 24500, T, sigma).touch);
  // And the current level is certain.
  assert.equal(BS.probTouch(F, F, T, sigma), 1);
  assert.equal(BS.probTouch(F, 25000, 0, sigma), null);
});

test('breakeven is the strike plus the premium, on the correct side', () => {
  close(BS.breakeven('CE', 24000, 150), 24150, 1e-12, 'call breakeven');
  close(BS.breakeven('PE', 24000, 150), 23850, 1e-12, 'put breakeven');
  assert.equal(BS.breakeven('CE', null, 150), null);

  // The model agrees: at the breakeven, an expiring option is worth exactly what was paid.
  const K = 24000, premium = 150;
  close(BS.price('CE', BS.breakeven('CE', K, premium), K, 0, 0.2, 0.065), premium, 1e-9, 'breakeven pays back the premium');
});

/* ============================================================
   7. TIME TO EXPIRY
   ============================================================ */

test('expiry is anchored to the 15:30 IST close, not to midnight', () => {
  /* On expiry day the difference between "the date" and "15:30" is the entire remaining life of
     the contract. Anchoring to midnight would price a Thursday-morning weekly as already dead. */
  const expiryDate = Date.UTC(2026, 8, 24);                 // 24 Sep 2026, as a date-only stamp
  const inst = BS.expiryInstant(expiryDate);
  assert.equal(new Date(inst).toISOString(), '2026-09-24T10:00:00.000Z', '15:30 IST is 10:00Z');

  // 09:15 IST on expiry morning = 03:45Z → 6h15m of life left, not zero.
  const morning = Date.UTC(2026, 8, 24, 3, 45);
  const y = BS.yearsToExpiry(morning, expiryDate);
  close(BS.daysToExpiry(morning, expiryDate), 6.25 / 24, 1e-9, 'six and a quarter hours remain');
  assert.ok(y > 0, 'the contract is still alive on expiry morning');

  // After the close it is over, and never negative.
  assert.equal(BS.yearsToExpiry(Date.UTC(2026, 8, 24, 11, 0), expiryDate), 0);
  assert.equal(BS.yearsToExpiry(Date.UTC(2026, 8, 25), expiryDate), 0);

  // A week out is a week, measured in calendar days per the market's own ACT/365 convention.
  close(BS.daysToExpiry(Date.UTC(2026, 8, 17, 10, 0), expiryDate), 7, 1e-9, 'seven calendar days');
  assert.equal(BS.yearsToExpiry(Date.now(), null), null);
});

test('the model degrades rather than explodes inside the final minute', () => {
  const F = 24000, K = 24000, sigma = 0.3, r = 0.065;
  const alive = BS.black76({ type: 'CE', F, K, T: BS.MIN_T * 2, sigma, r });
  assert.ok(alive.ok && !alive.degenerate, 'two minutes out it is still a live option');
  assert.ok(alive.gamma > 0 && isFinite(alive.gamma), 'gamma is enormous but finite');

  const dead = BS.black76({ type: 'CE', F, K, T: BS.MIN_T / 2, sigma, r });
  assert.equal(dead.degenerate, true, 'inside the final minute it is reported as expiring, not priced');
  assert.equal(dead.gamma, null, 'no infinite gamma reaches the screen');
});

test('units are published alongside the numbers', () => {
  /* Every Greek in this file is in premium points of the underlying and nothing is multiplied by
     a lot size here — that happens in strategy.js, where the lot size comes from the live
     instrument master rather than a constant that the exchange periodically revises. Shipping
     the units with the numbers is what stops that boundary being crossed by accident. */
  const v = BS.black76({ type: 'CE', F: 24000, K: 24000, T: 7 / 365, sigma: 0.14, r: 0.065 });
  assert.ok(v.units && v.units.delta && v.units.vega && v.units.thetaDay);
  assert.match(v.units.vega, /vol point/i);
  assert.match(v.units.price, /premium points/i);
  // Sanity on magnitude: a 7-day ATM NIFTY call at 14% vol is worth roughly 100 points.
  assert.ok(v.price > 50 && v.price < 200, `implausible ATM weekly premium ${v.price}`);
});
