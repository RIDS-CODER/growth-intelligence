/* ============================================================
   F&O VOLATILITY ANALYSIS — tests

   The realized-volatility estimators are checked by GENERATION: synthesise a price series with a
   volatility the test chose, then confirm each estimator recovers it. That is a real check —
   a transcription error in the Yang-Zhang constant, or a missing √252, shows up immediately —
   and it works for the range-based estimators too, by building candles whose highs and lows come
   from the same process as their closes.

   The rest of the file is tested for RESTRAINT rather than for accuracy, because restraint is
   what it is for. The single most common piece of options analysis in circulation is "implied
   vol is above realized vol, so options are expensive", and it is nearly worthless: implied
   exceeds realized about four sessions in five, so the observation is usually true and never
   informative. There is therefore a test asserting that a bare positive gap produces NO verdict,
   and that the combined assessment does not count it as evidence. Getting that wrong would make
   the engine recommend selling premium in every market state, including the ones that end
   accounts — which is the specific outcome the user asked this platform to help avoid.
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert');
const V = require('../fno/vol');

const close = (a, b, tol, msg) => assert.ok(
  Math.abs(a - b) <= tol, `${msg || 'differ'}: got ${a}, expected ${b}, |diff| ${Math.abs(a - b)} > ${tol}`);

/* A deterministic normal generator, so a failure is reproducible rather than a flake. */
function makeRng(seed) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return () => {
    const a = u(), b = u();
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
  };
}

/* Build daily candles from a geometric Brownian motion with a known annual volatility.

   The intraday path is simulated in steps so that the high and low are genuine extremes of the
   same process that produced the close — otherwise the range-based estimators would be measured
   against a range that has nothing to do with the volatility being tested.

   `gapShare` splits the day's variance between an overnight jump and the session, which is how
   an Indian index actually behaves: repriced at the open by whatever happened in New York. */
function makeCandles(opts) {
  const o = opts || {};
  const n = o.n || 400;
  const sigma = o.sigma || 0.15;
  const gapShare = o.gapShare == null ? 0 : o.gapShare;
  const steps = o.steps || 80;
  const rnd = makeRng(o.seed || 12345);

  const dt = 1 / 252;
  const sdDay = sigma * Math.sqrt(dt);
  const sdGap = sdDay * Math.sqrt(gapShare);
  const sdSess = sdDay * Math.sqrt(1 - gapShare);

  let px = o.start || 24000;
  const out = [];
  for (let i = 0; i < n; i++) {
    const open = px * Math.exp(sdGap * rnd() - sdGap * sdGap / 2);
    let p = open, hi = open, lo = open;
    const sdStep = sdSess / Math.sqrt(steps);
    for (let s = 0; s < steps; s++) {
      p = p * Math.exp(sdStep * rnd() - sdStep * sdStep / 2);
      if (p > hi) hi = p;
      if (p < lo) lo = p;
    }
    out.push({ o: open, h: hi, l: lo, c: p });
    px = p;
  }
  return out;
}

/* ============================================================
   1. REALIZED VOLATILITY
   ============================================================ */

test('every estimator recovers the volatility it was generated with', () => {
  /* 15% annualised, no overnight gaps, so all four estimators are measuring the same process and
     must land on the same answer. Tolerance is set by sampling error, not by hope: the standard
     error of a variance estimate over 250 days is about 1/sqrt(2n) ≈ 4.5% relative, so ±2 vol
     points on 15 is the honest band. */
  const c = makeCandles({ n: 300, sigma: 0.15, gapShare: 0, seed: 7 });
  const r = V.realizedVol(c, { window: 250 });
  assert.ok(r.ok, r.reason);
  for (const k of ['closeToClose', 'parkinson', 'garmanKlass', 'yangZhang']) {
    assert.ok(Number.isFinite(r[k]), `${k} was not computed`);
    close(r[k], 0.15, 0.02, `${k} should recover the generated volatility`);
  }
  assert.equal(r.annualisation, 252, 'annualised on trading days');
});

test('the √252 annualisation is present and correct', () => {
  /* The most consequential single constant in this file. A missing or wrong annualisation puts
     realized vol on a different scale to implied and makes every cheap/expensive verdict wrong
     by a factor — so it is checked against the daily standard deviation directly rather than
     only through the generator. */
  const c = makeCandles({ n: 251, sigma: 0.2, gapShare: 0, seed: 11 });
  const r = V.realizedVol(c, { window: 250 });          // window covers the whole series exactly
  assert.equal(r.n, 250, 'the reference below must be computed over the same sample');
  const rets = [];
  for (let i = 1; i < c.length; i++) rets.push(Math.log(c[i].c / c[i - 1].c));
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - m) * (x - m), 0) / (rets.length - 1));
  close(r.closeToClose, sd * Math.sqrt(252), 1e-9, 'close-to-close is the daily stdev times √252');
});

test('doubling the volatility doubles every estimate', () => {
  const lo = V.realizedVol(makeCandles({ n: 300, sigma: 0.10, seed: 3 }), { window: 250 });
  const hi = V.realizedVol(makeCandles({ n: 300, sigma: 0.20, seed: 3 }), { window: 250 });
  for (const k of ['closeToClose', 'parkinson', 'garmanKlass', 'yangZhang']) {
    close(hi[k] / lo[k], 2, 0.25, `${k} should scale linearly with volatility`);
  }
});

test('Yang-Zhang catches overnight gaps that close-to-close and Parkinson do not', () => {
  /* The reason Yang-Zhang is carried at all. NIFTY is repriced every morning by whatever happened
     in New York overnight, and an estimator blind to that jump understates the risk a short
     option carries — the move that hurts arrives before the market opens and cannot be stopped
     out of.

     Parkinson only sees the intraday high-low range, so on a series where most of the variance
     arrives as a gap it reports a fraction of the true figure. Yang-Zhang sees all of it. */
  const gappy = makeCandles({ n: 300, sigma: 0.20, gapShare: 0.7, seed: 23 });
  const r = V.realizedVol(gappy, { window: 250 });

  close(r.yangZhang, 0.20, 0.03, 'Yang-Zhang recovers the full volatility of a gappy series');
  assert.ok(r.parkinson < r.yangZhang * 0.75,
    `Parkinson sees only the session range and should badly understate a gappy series: ${r.parkinson.toFixed(3)} vs ${r.yangZhang.toFixed(3)}`);
  assert.ok(r.gapShare > 0.5, `most of the variance should be attributed to the gap, got ${r.gapShare}`);
  assert.ok(/arriving OVERNIGHT/.test(r.gapNote), r.gapNote);

  // And on a series with no gaps at all, no such warning is raised.
  const smooth = V.realizedVol(makeCandles({ n: 300, sigma: 0.20, gapShare: 0, seed: 23 }), { window: 250 });
  assert.ok(smooth.gapShare < 0.2, `a gapless series should show little overnight variance, got ${smooth.gapShare}`);
  assert.equal(smooth.gapNote, null);
});

test('closes without OHLC still produce a figure, and say what is missing', () => {
  const c = makeCandles({ n: 200, sigma: 0.15, seed: 5 }).map(x => ({ c: x.c }));
  const r = V.realizedVol(c, { window: 150 });
  assert.ok(r.ok);
  close(r.closeToClose, 0.15, 0.03);
  assert.equal(r.parkinson, null, 'range estimators need a range');
  assert.equal(r.yangZhang, null);
  assert.ok(/overnight gaps are invisible/.test(r.note), r.note);
});

test('too little data is refused rather than estimated', () => {
  assert.equal(V.realizedVol([], {}).ok, false);
  assert.equal(V.realizedVol([{ c: 1 }, { c: 2 }], {}).ok, false);
  assert.equal(V.realizedVol(null, {}).ok, false);
  const r = V.realizedVol(makeCandles({ n: 4, seed: 1 }), { window: 20 });
  assert.ok(r.ok || /available/.test(r.reason), 'either it works on what it has or it says why not');
});

/* ============================================================
   2. IV PERCENTILE AND RANK
   ============================================================ */

test('percentile and rank are computed, and both are reported', () => {
  const series = [];
  for (let i = 0; i < 200; i++) series.push(0.10 + 0.10 * (i / 199));      // 10% to 20%, uniform
  const p = V.ivPercentile(0.15, series, { source: 'test' });
  assert.ok(p.ok);
  close(p.percentile, 0.5, 0.02, 'the midpoint of a uniform series is the 50th percentile');
  close(p.rank, 0.5, 0.02, 'and the midpoint of its range');
  close(p.min, 0.10, 1e-9);
  close(p.max, 0.20, 1e-9);
  assert.equal(p.n, 200);
});

test('IV rank and IV percentile disagree after a spike — which is why both are shown', () => {
  /* The case that makes rank untrustworthy. A market that has traded quietly between 10% and 14%
     all year, with ONE panic day at 45%, is at a high percentile when it reaches 14% — it has
     rarely been higher — but at a low rank, because a single afternoon set the top of the scale.
     A tool reporting only rank would call this market cheap for months. */
  const series = [];
  for (let i = 0; i < 250; i++) series.push(0.10 + 0.04 * ((i * 37) % 100) / 100);
  series.push(0.45);
  const p = V.ivPercentile(0.138, series, { source: 'test' });
  assert.ok(p.ok);
  assert.ok(p.percentile > 0.85, `should be high by percentile, got ${p.percentile.toFixed(2)}`);
  assert.ok(p.rank < 0.15, `but low by rank because of the one spike, got ${p.rank.toFixed(2)}`);
  assert.ok(p.percentile - p.rank > 0.6, 'the two measures diverge sharply, which is the point');
});

test('a short history produces no percentile at all', () => {
  const p = V.ivPercentile(0.15, [0.1, 0.12, 0.14, 0.16], { source: 'test' });
  assert.equal(p.ok, false);
  assert.equal(p.sufficient, false);
  assert.equal(p.n, 4);
  assert.equal(p.need, V.MIN_SAMPLE);
  assert.ok(/no meaning/.test(p.reason), p.reason);
  assert.equal(V.ivPercentile(null, new Array(200).fill(0.15)).ok, false, 'nothing to place');
});

/* ============================================================
   3. WHICH HISTORY GETS USED
   ============================================================ */

test('the platform\'s own recorded history is preferred over the India VIX substitute', () => {
  const own = new Array(120).fill(0.14);
  const vix = new Array(120).fill(13);
  const r = V.resolveIvHistory('NIFTY', { own, indiaVix: vix });
  assert.equal(r.exact, true);
  assert.match(r.source, /recorded/);
  assert.equal(r.note, null, 'no substitution, no caveat');
});

test('India VIX substitutes for NIFTY on day one, and says that it is substituting', () => {
  /* The one good shortcut available: India VIX IS thirty-day NIFTY implied vol and six months of
     it is already being fetched for the macro panel. Reusing it gives NIFTY a usable percentile
     immediately instead of in a quarter — but it is a stand-in, and the label has to travel with
     the number. */
  const vix = []; for (let i = 0; i < 130; i++) vix.push(11 + 6 * ((i * 17) % 50) / 50);
  const r = V.resolveIvHistory('NIFTY', { own: [], indiaVix: vix });
  assert.equal(r.exact, false, 'a substitute is not the real thing and must not claim to be');
  assert.equal(r.source, 'India VIX');
  assert.ok(/stand-in/.test(r.note), r.note);
  assert.ok(/constant-maturity 30-day/.test(r.note), 'and it explains exactly how the substitute differs');
  assert.equal(r.series.length, 130);
});

test('BANKNIFTY and SENSEX have no VIX, so they report unavailable rather than borrowing NIFTY\'s', () => {
  const vix = new Array(130).fill(13);
  for (const u of ['BANKNIFTY', 'SENSEX', 'FINNIFTY']) {
    const r = V.resolveIvHistory(u, { own: [], indiaVix: vix });
    assert.equal(r.series, null, `${u} must not borrow NIFTY's volatility index`);
    assert.ok(/no equivalent index/.test(r.note), r.note);
    assert.ok(r.note.includes(u), 'the message names the underlying');
  }
});

/* ============================================================
   4. THE IMPLIED-REALIZED GAP — tested for restraint
   ============================================================ */

test('a bare positive IV-RV gap produces NO verdict', () => {
  /* The most important test in this file. "Implied is above realized, therefore options are
     expensive" is true about four sessions in five, because the gap IS the variance risk premium
     — the compensation sellers are paid for carrying gap risk. An engine that treats it as a
     signal recommends selling premium in every market state, including the ones that wipe out
     accounts. So with no history to place it against, there must be no conclusion. */
  const r = V.varianceRiskPremium({ iv: 0.16, rv: 0.11 });
  assert.ok(r.ok);
  close(r.gap, 0.05, 1e-12);
  close(r.ratio, 0.16 / 0.11, 1e-12);
  assert.equal(r.percentile, null, 'no percentile without a history');
  assert.ok(/NORMAL state/.test(r.reading), r.reading);
  assert.ok(/no verdict is offered/.test(r.reading), 'and it explicitly declines to judge');
  assert.ok(r.caveat && /informative almost never/.test(r.caveat), r.caveat);
  assert.ok(!/expensive/.test(r.reading), 'the word "expensive" must not appear on one observation');
});

test('with a history of the gap, a verdict is offered — and only then', () => {
  const hist = []; for (let i = 0; i < 200; i++) hist.push(0.01 + 0.05 * ((i * 23) % 100) / 100);
  const rich = V.varianceRiskPremium({ iv: 0.20, rv: 0.14, gapSeries: hist });      // gap 0.06, top of range
  assert.ok(isFinite(rich.percentile), 'a history yields a percentile');
  assert.ok(rich.percentile > 0.9);
  assert.ok(/unusually rich/.test(rich.reading), rich.reading);
  assert.ok(/tail risk is survivable/.test(rich.reading), 'and it does not forget what selling premium costs when it goes wrong');
  assert.equal(rich.caveat, null);

  const thin = V.varianceRiskPremium({ iv: 0.145, rv: 0.14, gapSeries: hist });     // gap 0.005, bottom
  assert.ok(thin.percentile < 0.1);
  assert.ok(/unusually thin/.test(thin.reading), thin.reading);
});

test('implied below realized is called out as the uncommon case it is', () => {
  const r = V.varianceRiskPremium({ iv: 0.10, rv: 0.16 });
  assert.ok(/BELOW realized/.test(r.reading), r.reading);
  assert.ok(r.ratio < 1);
  assert.equal(V.varianceRiskPremium({ iv: 0.1 }).ok, false, 'needs both sides');
  assert.equal(V.varianceRiskPremium({ iv: 0.1, rv: 0 }).ok, false);
});

/* ============================================================
   5. TERM STRUCTURE — the reading that needs no history
   ============================================================ */

test('contango is recognised as the normal state', () => {
  const t = V.termStructure([{ days: 3, iv: 0.12 }, { days: 10, iv: 0.13 }, { days: 38, iv: 0.145 }]);
  assert.ok(t.ok);
  assert.equal(t.shape, 'contango');
  assert.equal(t.inverted, false);
  assert.ok(/Nothing near-term is being singled out/.test(t.reading), t.reading);
  assert.ok(t.slope > 0);
});

test('backwardation is flagged as a specific near-term risk being priced', () => {
  /* The front expiry richer than the back means the market has identified something — an event,
     a decision, a result. It is the clearest available warning that selling short-dated premium
     is selling insurance against a known upcoming risk. */
  const t = V.termStructure([{ days: 2, iv: 0.24 }, { days: 9, iv: 0.16 }, { days: 37, iv: 0.145 }]);
  assert.equal(t.shape, 'backwardation');
  assert.equal(t.inverted, true);
  assert.ok(t.ratio > 1.5);
  assert.ok(/identified something specific and near/.test(t.reading), t.reading);
  assert.ok(/selling insurance against a known upcoming risk/.test(t.reading));
});

test('a flat curve is neither, and one expiry is not a curve', () => {
  const flat = V.termStructure([{ days: 3, iv: 0.14 }, { days: 30, iv: 0.141 }]);
  assert.equal(flat.shape, 'flat');
  assert.ok(/no cushion/.test(flat.reading), flat.reading);
  assert.equal(V.termStructure([{ days: 3, iv: 0.14 }]).ok, false, 'one point is not a term structure');
  assert.equal(V.termStructure([]).ok, false);
  assert.equal(V.termStructure(null).ok, false);
});

/* ============================================================
   6. THE IMPLIED MOVE VS THE MOVES THAT HAPPENED
   ============================================================ */

test('the implied move is placed against the index\'s own history of moves', () => {
  /* The most intuitive cheap-or-expensive test, and it needs no option history at all — only the
     index's closes. It also answers the question in the units the trade is actually denominated
     in: percent, not vol points. */
  const closes = makeCandles({ n: 600, sigma: 0.15, seed: 99 }).map(c => c.c);

  // 15% annual vol over 5 sessions is about 15% x sqrt(5/252) = 2.1% for one standard deviation,
  // so a 5% implied move is far above what this index normally does.
  const rich = V.impliedVsRealisedMove({ impliedPct: 0.05, closes, horizonDays: 5 });
  assert.ok(rich.ok, rich.reason);
  assert.ok(rich.percentileOfHistory > 0.9, `5% should be rare for this index, got ${rich.percentileOfHistory}`);
  assert.ok(/unusual week just to break even/.test(rich.reading), rich.reading);

  const cheapMove = V.impliedVsRealisedMove({ impliedPct: 0.005, closes, horizonDays: 5 });
  assert.ok(cheapMove.percentileOfHistory < 0.4);
  assert.ok(/Movement is cheap here/.test(cheapMove.reading), cheapMove.reading);

  // The median 5-session move should be near the theoretical one — a check that the distribution
  // is being built from the right horizon rather than off by a factor.
  close(rich.medianMove, 0.15 * Math.sqrt(5 / 252) * 0.6745, 0.006, 'median |move| over 5 sessions');
});

test('the overlapping-window caveat is stated', () => {
  /* Five hundred overlapping windows are nothing like five hundred independent observations —
     consecutive ones share four of their five days. Presenting the count without that would make
     a shape look like a probability. */
  const closes = makeCandles({ n: 400, sigma: 0.15, seed: 4 }).map(c => c.c);
  const r = V.impliedVsRealisedMove({ impliedPct: 0.02, closes, horizonDays: 5 });
  assert.equal(r.overlapping, true);
  assert.ok(/far less independent evidence/.test(r.sampleNote), r.sampleNote);
  assert.ok(/read it as a shape, not as a probability/.test(r.sampleNote));
  close(r.exceededPct, 1 - r.percentileOfHistory, 1e-12);
});

test('too short a price history is refused', () => {
  const r = V.impliedVsRealisedMove({ impliedPct: 0.02, closes: [100, 101, 102], horizonDays: 5 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /need at least/);
  assert.equal(V.impliedVsRealisedMove({ closes: new Array(100).fill(100) }).ok, false, 'no implied move to compare');
});

/* ============================================================
   7. THE COMBINED VERDICT
   ============================================================ */

const fullInputs = (pct) => ({
  ivPercentile: { ok: true, percentile: pct, n: 200, source: 'India VIX', sourceNote: 'stand-in' },
  vrp: { ok: true, percentile: pct, gap: 0.04 },
  moveComparison: { ok: true, percentileOfHistory: pct },
  termStructure: { ok: true, inverted: false, shape: 'contango' }
});

test('the verdict follows the evidence, in both directions', () => {
  const rich = V.assess(fullInputs(0.95));
  assert.equal(rich.verdict, 'expensive');
  assert.ok(rich.score > 0.75);
  assert.equal(rich.confidence, 'good');
  assert.ok(rich.evidence.length >= 4, 'it shows its working');

  const cheapV = V.assess(fullInputs(0.05));
  assert.equal(cheapV.verdict, 'cheap');

  const mid = V.assess(fullInputs(0.5));
  assert.equal(mid.verdict, 'fair');
});

test('a missing input widens the uncertainty instead of scoring zero', () => {
  /* The behaviour the whole platform is built around, reused here rather than reimplemented: an
     absent feed must not read as evidence AGAINST. Without it, an options tab with no IV history
     would score every chain as cheap and recommend buying into anything.

     Tested EXACTLY by making every component agree on the same value — an inverted term
     structure scores 0.85, so all four parts read 0.85 — at which point dropping any of them
     must leave the score untouched. Any drift is renormalisation failing. */
  const uniform = () => ({
    ivPercentile: { ok: true, percentile: 0.85, n: 200, source: 'test' },
    vrp: { ok: true, percentile: 0.85 },
    moveComparison: { ok: true, percentileOfHistory: 0.85 },
    termStructure: { ok: true, inverted: true, shape: 'backwardation' }
  });

  const full = V.assess(uniform());
  close(full.score, 0.85, 1e-12, 'all four components agree');
  assert.equal(full.coverage, 1);

  const partial = V.assess({ ...uniform(), ivPercentile: { ok: false, reason: 'no history yet' }, vrp: { ok: false } });
  assert.ok(partial.ok, 'it still reaches a conclusion from what it has');
  close(partial.score, 0.85, 1e-12, 'the score is renormalised over the evidence present, not diluted');
  assert.equal(partial.verdict, full.verdict, 'and reaches the same verdict');

  /* What a naive "missing counts as zero" implementation would have produced. The gap between
     that and 0.85 is the entire value of renormalising — it is the difference between "expensive"
     and "cheap" on identical evidence. */
  const naive = (0.25 * 0.85 + 0.10 * 0.85) / 1.0;
  close(naive, 0.2975, 1e-9);
  assert.ok(partial.score > naive * 2.5, `naive zero-filling would have scored ${naive.toFixed(3)}, renormalising gives ${partial.score.toFixed(3)}`);

  // Coverage is what actually falls, and it is reported rather than hidden in the score.
  assert.ok(partial.coverage < full.coverage, 'coverage falls');
  close(partial.coverage, 0.35, 1e-12, 'exactly the weight that remained');
  assert.ok(partial.missing.includes('ivPercentile') && partial.missing.includes('ivrvGap'));

  /* And 35% coverage is correctly called THIN. This is the pairing that matters: the score is
     undiluted, so the verdict stays honest — but the confidence label makes clear it was reached
     on a third of the intended evidence. A confident-looking number with no caveat would be
     worse than no number at all. */
  assert.equal(partial.confidence, 'thin');
  assert.ok(/first impression, not a finding/.test(partial.confidenceNote), partial.confidenceNote);

  // Dropping only one component leaves enough to be called partial rather than thin.
  const oneGone = V.assess({ ...uniform(), vrp: { ok: false } });
  close(oneGone.score, 0.85, 1e-12);
  assert.equal(oneGone.confidence, 'partial');
});

test('thin coverage is labelled as a first impression, not a finding', () => {
  const thin = V.assess({
    ivPercentile: { ok: false, reason: 'no history' },
    vrp: { ok: false, caveat: 'no gap history' },
    moveComparison: { ok: false },
    termStructure: { ok: true, inverted: true, shape: 'backwardation' }
  });
  assert.ok(thin.ok);
  assert.equal(thin.confidence, 'thin');
  assert.ok(/first impression, not a finding/.test(thin.confidenceNote), thin.confidenceNote);
  assert.ok(thin.coverage <= 0.4);
});

test('no evidence at all yields no verdict', () => {
  const none = V.assess({
    ivPercentile: { ok: false, reason: 'no history' },
    vrp: { ok: false },
    moveComparison: { ok: false },
    termStructure: { ok: false }
  });
  assert.equal(none.ok, false);
  assert.equal(none.verdict, 'unknown');
  assert.equal(none.score, null, 'no number is invented from nothing');
  assert.ok(/no volatility evidence/.test(none.reason));
});

test('a raw IV-RV gap contributes nothing to the combined score', () => {
  /* Following through on the restraint test above: the assessment must not let a bare positive
     gap in by the back door as if it were evidence. */
  const withRaw = V.assess({
    ...fullInputs(0.5),
    vrp: V.varianceRiskPremium({ iv: 0.20, rv: 0.10 })        // a big gap, but no history
  });
  assert.ok(withRaw.missing.includes('ivrvGap'), 'the gap is recorded as MISSING evidence, not as bullish evidence');
  assert.equal(withRaw.verdict, 'fair', 'a 2x IV/RV ratio with no history does not move the verdict');
});

test('a scheduled event changes what "expensive" means, and says so', () => {
  /* Elevated implied vol before a known release is not a mispricing to sell — it is the market
     charging correctly for a risk everyone can see on a calendar. Reuses the macro calendar
     already built for the crypto side rather than keeping a second list of dates. */
  const r = V.assess({ ...fullInputs(0.92), event: { inWindow: true, label: 'US CPI' } });
  assert.equal(r.verdict, 'expensive');
  assert.ok(r.eventWarning, 'the warning is a first-class field, not buried in prose');
  assert.ok(/US CPI/.test(r.eventWarning));
  assert.ok(/not a mispricing to sell/.test(r.eventWarning), r.eventWarning);
  assert.ok(r.notes.includes(r.eventWarning));

  assert.equal(V.assess(fullInputs(0.92)).eventWarning, null, 'no event, no warning');
});

test('a substituted history carries its caveat all the way to the verdict', () => {
  const r = V.assess(fullInputs(0.9));
  assert.ok(r.notes.some(n => /stand-in/.test(n)), 'the India VIX substitution note reaches the top level: ' + JSON.stringify(r.notes));
});
