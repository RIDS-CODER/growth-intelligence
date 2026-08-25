/* ============================================================
   INTEL — SHARED STATISTICS
   Pure functions, no I/O, no state. Everything the intelligence engines need that isn't
   already in server.js's IND block.

   ONE RULE THROUGHOUT: correlation and beta are measured on RETURNS, never on prices.
   Two coins that both drift upward over a month have a price correlation near 1.0 no matter
   how unrelated their daily moves are — that number would say "the market is moving as one"
   during the calmest week of the year. Returns are what a trader actually experiences.
   ============================================================ */

/* `+ 0` normalises -0 to 0. Without it a ramp that lands exactly on its floor returns -0, which
   survives into JSON as `-0` and fails strict comparisons for no useful reason. */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v) + 0;
const isNum = v => typeof v === 'number' && isFinite(v);

/* Is this series flat to within floating-point noise?
   THIS GUARD IS LOAD-BEARING. A constant series has zero variance in theory, but `sum/n` rarely
   reproduces the constant exactly, so the naive `variance > 0` check passes on a residue around
   1e-19 and Pearson happily returns ±1.0 from pure rounding error. In production that is not
   academic: a halted coin, or a thin INR pair with no trades, holds one price for hours — and a
   spurious 1.0 flows straight into "the board is trading as a single risk asset", which is one of
   the loudest claims this module makes. Variance must be non-trivial RELATIVE to the values
   themselves, not merely non-zero. */
const FLAT_EPS = 1e-12;
function degenerate(ss, arr) {
  if (!(ss > 0)) return true;
  let scale = 0;
  for (const v of arr) scale += v * v;
  return scale <= 0 ? true : (ss / scale) < FLAT_EPS;
}

/* Simple returns from a close series. Length n-1. Non-positive or non-finite closes break the
   chain rather than producing an Infinity that would poison every downstream mean. */
function returns(close) {
  const out = [];
  for (let i = 1; i < (close || []).length; i++) {
    const a = close[i - 1], b = close[i];
    out.push((isNum(a) && isNum(b) && a > 0 && b > 0) ? (b / a - 1) : null);
  }
  return out;
}

/* Pair two return series and drop any index where either is missing, so a coin with a data gap
   shrinks the sample instead of silently correlating against a zero. */
function pairFinite(a, b) {
  const x = [], y = [];
  const n = Math.min((a || []).length, (b || []).length);
  for (let i = 0; i < n; i++) if (isNum(a[i]) && isNum(b[i])) { x.push(a[i]); y.push(b[i]); }
  return { x, y };
}

const mean = arr => {
  const v = (arr || []).filter(isNum);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

function median(arr) {
  const v = (arr || []).filter(isNum).sort((p, q) => p - q);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function stdev(arr) {
  const v = (arr || []).filter(isNum);
  if (v.length < 2) return null;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1));
}

/* Fraction of `arr` at or below `v`, 0..1. Used to ask "is today's reading unusual for THIS
   series" rather than against a constant that means different things for BTC and a micro-cap.

   A SERIES WITH NO DISPERSION HAS NO PERCENTILES. Every value in a flat sample is ≤ the current
   one, so the naive count returns 1.0 — "the highest it has ever been" — from a series that never
   moved. That is the same failure as pearson on a flat input, and it bites hardest on exactly the
   inputs most likely to be stale: a halted instrument, or a feed repeating its last close. A
   percentile term that reads 1.0 for VIX drives the risk-appetite score to maximum fear on no
   evidence at all, so return null and let scoreParts renormalise without it. */
function percentileOf(arr, v) {
  const s = (arr || []).filter(isNum);
  if (s.length < 2 || !isNum(v)) return null;
  const lo = Math.min(...s), hi = Math.max(...s);
  const scale = Math.max(Math.abs(lo), Math.abs(hi));
  if (!(hi - lo > 0) || (scale > 0 && (hi - lo) / scale < 1e-9)) return null;
  let below = 0;
  for (const x of s) if (x <= v) below++;
  return below / s.length;
}

/* Pearson correlation of two RETURN series. minN guards against the classic false positive:
   with 3 samples almost any two series correlate above 0.9 by chance. */
function pearson(a, b, minN) {
  const need = minN || 8;
  const { x, y } = pairFinite(a, b);
  if (x.length < need) return null;
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) {
    const p = x[i] - mx, q = y[i] - my;
    num += p * q; dx += p * p; dy += q * q;
  }
  // A flat series has NO correlation, not a perfect one — see `degenerate`.
  if (degenerate(dx, x) || degenerate(dy, y)) return null;
  return clamp(num / Math.sqrt(dx * dy), -1, 1);
}

/* OLS slope of `y` on `x` — how much this coin moves for a 1% move in the benchmark.
   Returns null rather than 0 when undefined: "no measurable beta" and "beta of zero" are
   different claims and only one of them is honest with a flat benchmark. */
function beta(y, x, minN) {
  const need = minN || 8;
  const p = pairFinite(x, y);
  if (p.x.length < need) return null;
  const mx = mean(p.x), my = mean(p.y);
  let cov = 0, varx = 0;
  for (let i = 0; i < p.x.length; i++) {
    const d = p.x[i] - mx;
    cov += d * (p.y[i] - my); varx += d * d;
  }
  // Same flatness guard as pearson: a benchmark that never moved defines no slope.
  if (degenerate(varx, p.x)) return null;
  return cov / varx;
}

/* Beta measured ONLY on bars where the benchmark fell.
   A coin can track BTC tick for tick on the way up and fall twice as fast on the way down;
   a single symmetric beta averages that asymmetry away, and the asymmetry is the entire risk
   for someone holding leveraged longs. */
function downsideBeta(y, x, minN) {
  const p = pairFinite(x, y);
  const dx = [], dy = [];
  for (let i = 0; i < p.x.length; i++) if (p.x[i] < 0) { dx.push(p.x[i]); dy.push(p.y[i]); }
  return beta(dy, dx, minN || 6);
}

/* Realized amplification over a window: how much this coin actually moved per 1% of benchmark.
   This is the number in "BTC -2%, SUI -5.5% → 2.75x" — a ratio of two totals, NOT a regression.
   Undefined when the benchmark barely moved, because dividing by ~0 manufactures huge ratios
   out of noise. */
function amplification(coinRet, benchRet, minBench) {
  const floor = minBench == null ? 0.005 : minBench;      // benchmark must have moved 0.5%
  if (!isNum(coinRet) || !isNum(benchRet)) return null;
  if (Math.abs(benchRet) < floor) return null;
  return coinRet / benchRet;
}

/* Cumulative return over the last k bars of a close series. */
function retOver(close, k) {
  const c = (close || []).filter(v => isNum(v) && v > 0);
  if (c.length < 2) return null;
  const n = c.length, i = Math.max(0, n - 1 - k);
  if (i === n - 1) return null;
  return c[n - 1] / c[i] - 1;
}

/* Exponential moving average, last value only. Mirrors IND.ema's seeding (SMA of the first
   period) so a coin's "above the 20 EMA" reads the same here as on its card. */
function emaLast(arr, p) {
  const a = (arr || []).filter(isNum);
  if (a.length < p) return null;
  const k = 2 / (p + 1);
  let prev = 0;
  for (let i = 0; i < p; i++) prev += a[i];
  prev /= p;
  for (let i = p; i < a.length; i++) prev = a[i] * k + prev * (1 - k);
  return prev;
}

/* Mean of the last k values. */
function meanLast(arr, k) {
  const a = (arr || []).filter(isNum);
  if (!a.length) return null;
  return mean(a.slice(Math.max(0, a.length - k)));
}

/* Weighted mean; pairs are dropped when either side is unusable so one bad weight can't
   swallow the whole average. */
function weightedMean(vals, weights) {
  let num = 0, den = 0;
  for (let i = 0; i < (vals || []).length; i++) {
    const v = vals[i], w = weights ? weights[i] : 1;
    if (!isNum(v) || !isNum(w) || w < 0) continue;
    num += v * w; den += w;
  }
  return den > 0 ? num / den : null;
}

/* ---- WEIGHTED SCORING OVER PARTIALLY-AVAILABLE EVIDENCE ----
   Every engine here scores something out of 100 from a set of components, and in this platform
   some components are routinely unavailable (no OI feed, no funding feed, too little history).

   The naive approach — treat a missing component as 0 — is the bug this function exists to
   prevent. A cascade with no OI feed would score low not because the evidence is against it but
   because the evidence is ABSENT, and the UI would print a confident "no cascade" built on
   nothing. Instead: renormalise over the weight actually present, and report `coverage` so the
   caller can cap or label a conclusion drawn from a thin base.

   Returns null when nothing at all was available — never a number. */
function scoreParts(parts) {
  let num = 0, wsum = 0, wall = 0;
  const used = [], missing = [];
  for (const p of (parts || [])) {
    if (!p) continue;
    const w = isNum(p.w) ? p.w : 0;
    wall += w;
    if (!isNum(p.v)) { missing.push(p.k); continue; }
    num += clamp(p.v, 0, 1) * w;
    wsum += w;
    used.push(p.k);
  }
  if (!(wsum > 0) || !(wall > 0)) return null;
  return { score: num / wsum, coverage: wsum / wall, used, missing };
}

/* Map a value onto 0..1 between two bounds. Below lo → 0, above hi → 1. `hi` may be below `lo`
   to invert (e.g. "smaller is worse"). */
function ramp(v, lo, hi) {
  if (!isNum(v)) return null;
  if (lo === hi) return null;
  return clamp((v - lo) / (hi - lo), 0, 1);
}

module.exports = {
  clamp, isNum, returns, pearson, beta, downsideBeta, amplification,
  mean, median, stdev, percentileOf, retOver, emaLast, meanLast, weightedMean,
  scoreParts, ramp, pairFinite
};
