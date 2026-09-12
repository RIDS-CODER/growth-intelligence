/* ============================================================
   F&O — VOLATILITY ANALYSIS

   Every option decision reduces to one question that the price on the screen cannot answer:
   is this volatility cheap or expensive? A 14% implied vol is a bargain in one market and a
   robbery in another, and nothing about the number itself says which.

   THE THING THIS FILE REFUSES TO SAY.
   "Implied vol is above realized vol, therefore options are expensive" is the single most common
   piece of options analysis on the internet and it is close to meaningless. Implied vol exceeds
   subsequent realized vol roughly four times in five — that gap is the VARIANCE RISK PREMIUM,
   the compensation option sellers are paid for carrying gap risk, and it is a structural feature
   of the market, not an anomaly to trade. Comparing IV to RV and concluding "expensive" is
   therefore right about eighty percent of the time and useless every time, because it says sell
   premium in every market state including the ones that destroy accounts.

   What matters is whether the gap is unusual FOR THIS INSTRUMENT, which requires a history of
   the gap and not a single observation of it. So:

     - Where there is history, this reports a percentile and says how many observations it rests
       on.
     - Where there is not, it says so and offers the readings that need no history at all — the
       term structure, and the implied move measured against the moves the index has actually
       been making.
     - It never converts one observation into a verdict.

   THE HISTORY PROBLEM, AND THE ONE GOOD SHORTCUT.
   This platform has never stored option data, so an IV percentile for NIFTY would normally be
   months away. But India VIX IS thirty-day NIFTY implied volatility, and intel/macroData.js
   already fetches six months of it for the macro panel. So NIFTY gets a usable IV percentile on
   day one by reusing a feed that is already running — no new pipeline, no new failure mode. The
   substitution is real but imperfect (VIX is constant-maturity thirty-day; the weekly you are
   trading is not) and it is labelled wherever it is used. BANKNIFTY and SENSEX have no such
   index, so they wait for the platform's own recorded history and say so meanwhile.
   ============================================================ */

'use strict';

const S = require('../intel/stats');

/* Daily-return standard deviation times √252 gives volatility per CALENDAR year, because 252
   trading days span one. That is the same scale Black-76 prices on, so implied and realized are
   directly comparable and no conversion factor belongs anywhere in this file.

   (The weekend does introduce a real distortion, but it is a timing artefact within the week,
   not a scale mismatch: calendar-time pricing charges about two trading days of variance across
   a Friday-to-Monday hold when only one will occur. The market answers that by marking vol down
   into the weekend, so it shows up as a vol move rather than a broken comparison. bs.js carries
   the same note where theta is computed.) */
const TRADING_DAYS = 252;

/* Below this many observations a percentile is a number with no meaning. Sixty daily readings is
   about a quarter — thin, but enough to distinguish a calm tape from a panicked one. Anything
   less is reported as insufficient rather than rounded into a verdict. */
const MIN_SAMPLE = 60;

const isNum = v => typeof v === 'number' && isFinite(v);
const ln = Math.log;

/* ============================================================
   REALIZED VOLATILITY

   Four estimators, because they answer subtly different questions and disagreeing with each
   other is informative in itself.

   CLOSE-TO-CLOSE is the convention implied vol is quoted against, so it is what the headline
   comparison uses. It is also the least efficient of the four — it throws away everything that
   happened between the closes — so a day that travelled 2% and came back flat contributes zero.

   YANG-ZHANG is the most accurate and it is the right default for an Indian index specifically,
   because it is the only one of the four that handles OVERNIGHT GAPS. NIFTY is repriced every
   morning by whatever happened in New York while Mumbai slept, and an estimator that ignores the
   open-to-previous-close jump systematically understates how much this index actually moves.

   When Yang-Zhang runs materially above close-to-close, the index is doing its moving in gaps —
   which is precisely the risk a long option is paid for and a short option is destroyed by.
   ============================================================ */

function realizedVol(candles, opts) {
  const o = opts || {};
  const want = isNum(o.window) ? Math.floor(o.window) : 20;
  const rows = (candles || []).filter(c => c && isNum(c.c) && c.c > 0);
  if (rows.length < 3) return { ok: false, reason: 'need at least three candles to measure volatility' };

  const use = rows.slice(Math.max(0, rows.length - want - 1));
  const n = use.length - 1;
  if (n < 2) return { ok: false, reason: `only ${use.length} candles available for a ${want}-day window` };

  const ann = Math.sqrt(TRADING_DAYS);
  const haveOhlc = use.every(c => isNum(c.o) && isNum(c.h) && isNum(c.l) && c.o > 0 && c.h > 0 && c.l > 0);

  /* ---- close to close ---- */
  const rets = [];
  for (let i = 1; i < use.length; i++) rets.push(ln(use[i].c / use[i - 1].c));
  const sd = S.stdev(rets);
  const cc = isNum(sd) ? sd * ann : null;

  if (!haveOhlc) {
    return {
      ok: true, n, window: want, annualisation: TRADING_DAYS,
      closeToClose: cc, parkinson: null, garmanKlass: null, yangZhang: null,
      recommended: cc, recommendedSource: 'close-to-close',
      note: 'only closing prices were available — the range-based estimators need OHLC and overnight gaps are invisible to this figure'
    };
  }

  /* ---- Parkinson: the high-low range ---- */
  let pSum = 0;
  for (let i = 1; i < use.length; i++) pSum += Math.pow(ln(use[i].h / use[i].l), 2);
  const parkinson = Math.sqrt(pSum / (4 * n * Math.LN2)) * ann;

  /* ---- Garman-Klass: range plus the open-to-close body ---- */
  let gk = 0;
  for (let i = 1; i < use.length; i++) {
    gk += 0.5 * Math.pow(ln(use[i].h / use[i].l), 2) - (2 * Math.LN2 - 1) * Math.pow(ln(use[i].c / use[i].o), 2);
  }
  const garmanKlass = gk > 0 ? Math.sqrt(gk / n) * ann : null;

  /* ---- Yang-Zhang: overnight gap + intraday drift + Rogers-Satchell ---- */
  const on = [], oc = [];
  let rs = 0;
  for (let i = 1; i < use.length; i++) {
    const p = use[i - 1], c = use[i];
    on.push(ln(c.o / p.c));                       // the gap nobody else measures
    oc.push(ln(c.c / c.o));
    rs += ln(c.h / c.c) * ln(c.h / c.o) + ln(c.l / c.c) * ln(c.l / c.o);
  }
  const vOn = variance(on), vOc = variance(oc), vRs = rs / n;
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  const yzVar = vOn + k * vOc + (1 - k) * vRs;
  const yangZhang = yzVar > 0 ? Math.sqrt(yzVar) * ann : null;

  const gapShare = isNum(vOn) && yzVar > 0 ? vOn / yzVar : null;

  return {
    ok: true, n, window: want, annualisation: TRADING_DAYS,
    closeToClose: cc, parkinson, garmanKlass, yangZhang,
    /* Close-to-close is the headline because it is the convention implied vol is quoted against.
       Yang-Zhang is carried alongside it precisely so the two can be compared. */
    recommended: cc, recommendedSource: 'close-to-close (the convention implied vol is quoted against)',
    gapShare,
    gapNote: isNum(gapShare) && gapShare > 0.5
      ? `over half this index's variance is arriving OVERNIGHT rather than during the session. Close-to-close vol understates the risk a short option is carrying, because the move that hurts happens before the market opens and cannot be stopped out.`
      : null,
    spreadNote: isNum(cc) && isNum(yangZhang) && cc > 0 && yangZhang / cc > 1.25
      ? `Yang-Zhang is ${((yangZhang / cc - 1) * 100).toFixed(0)}% above close-to-close — the index is travelling much further than its closes suggest`
      : null
  };
}

function variance(arr) {
  const v = arr.filter(isNum);
  if (v.length < 2) return null;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1);
}

/* ============================================================
   WHERE DOES TODAY'S VOL SIT IN ITS OWN HISTORY

   IV RANK vs IV PERCENTILE, and why both are reported.

   IV Rank is (today − lowest) / (highest − lowest) over the lookback. It is the more popular of
   the two and the more fragile: one panic day sets the high for a year, after which every
   subsequent reading is measured against a spike that lasted an afternoon. A market can sit at
   "IV Rank 20" for eight months without ever being cheap.

   IV Percentile is the fraction of days that were lower than today. It ignores the extremes and
   answers the question actually being asked — how unusual is this? — so it is what the
   assessment below leans on. Rank is reported too because it is what most other tools show, and
   a number that disagrees with the user's broker platform needs to be visible, not hidden.
   ============================================================ */

function ivPercentile(current, series, opts) {
  const o = opts || {};
  const vals = (series || []).map(x => (isNum(x) ? x : (x && isNum(x.iv) ? x.iv : (x && isNum(x.value) ? x.value : null)))).filter(isNum);
  const source = o.source || 'unknown';

  if (!isNum(current)) return { ok: false, reason: 'no current implied volatility to place', source };
  if (vals.length < MIN_SAMPLE) {
    return {
      ok: false, sufficient: false, n: vals.length, need: MIN_SAMPLE, source,
      reason: `${vals.length} historical observations, ${MIN_SAMPLE} needed. A percentile from fewer is a number with no meaning, so none is reported.`
    };
  }
  const sorted = vals.slice().sort((a, b) => a - b);
  const lo = sorted[0], hi = sorted[sorted.length - 1];
  let below = 0;
  for (const v of vals) if (v < current) below++;

  return {
    ok: true, sufficient: true,
    percentile: below / vals.length,
    rank: hi > lo ? S.clamp((current - lo) / (hi - lo), 0, 1) : null,
    n: vals.length, min: lo, max: hi, median: S.median(vals), current,
    source, sourceNote: o.sourceNote || null,
    /* The divergence between the two is itself worth surfacing: when rank is far below
       percentile, one old spike is holding the scale open. */
    rankVsPercentileNote: null
  };
}

/* Pick the best available history for an underlying, and be explicit about the substitution.

   Order of preference:
     1. The platform's own recorded at-the-money IV for this exact underlying. Correct by
        construction, and empty until it has been running for a quarter.
     2. India VIX, for NIFTY only. It IS thirty-day NIFTY implied vol, it is already being
        fetched for the macro panel, and six months of it arrives free. A real but imperfect
        substitute for a weekly's vol — labelled everywhere it is used.
     3. Nothing. Which is stated. */
function resolveIvHistory(underlying, sources) {
  const s = sources || {};
  const own = (s.own && s.own.length >= MIN_SAMPLE) ? s.own : null;
  if (own) {
    return { series: own, source: 'recorded ATM implied vol for this underlying', exact: true, note: null };
  }
  if (String(underlying).toUpperCase() === 'NIFTY' && s.indiaVix && s.indiaVix.length >= MIN_SAMPLE) {
    return {
      series: s.indiaVix, source: 'India VIX', exact: false,
      note: 'India VIX is used as a stand-in until this platform has recorded enough of its own option data. It is constant-maturity 30-day NIFTY implied vol, so it tracks the general level well but not the front weekly\'s own spikes into an expiry.'
    };
  }
  return {
    series: null, source: null, exact: false,
    note: `no implied-volatility history for ${underlying} yet. The platform records one reading per session; a percentile becomes available after about ${MIN_SAMPLE} sessions. India VIX can substitute for NIFTY but there is no equivalent index for this underlying.`
  };
}

/* ============================================================
   THE IMPLIED-REALIZED GAP
   ============================================================ */

function varianceRiskPremium(o) {
  const iv = o.iv, rv = o.rv;
  if (!isNum(iv) || !isNum(rv) || rv <= 0) {
    return { ok: false, reason: 'need both an implied and a realized volatility' };
  }
  const gap = iv - rv;
  const ratio = iv / rv;
  const hist = (o.gapSeries || []).filter(isNum);
  const pct = hist.length >= MIN_SAMPLE ? ivPercentile(gap, hist, { source: 'recorded IV−RV gap' }) : null;

  return {
    ok: true, iv, rv, gap, ratio,
    percentile: pct && pct.ok ? pct.percentile : null,
    n: hist.length,
    /* THE READING IS DELIBERATELY NON-COMMITTAL WITHOUT A HISTORY. A positive gap is the normal
       state of the world; saying "options are expensive" on the strength of one is advice that
       fires in every market including the ones that end accounts. */
    reading: pct && pct.ok
      ? (pct.percentile > 0.8 ? 'the premium over realized volatility is unusually rich for this instrument — conditions that favour selling, if the tail risk is survivable'
        : pct.percentile < 0.2 ? 'the premium over realized volatility is unusually thin — options are closer to fairly priced than usual, which is when buying them is least punished'
          : 'the premium over realized volatility is within its normal range')
      : (ratio > 1
        ? `implied is ${((ratio - 1) * 100).toFixed(0)}% above realized, which is the NORMAL state — option sellers are paid a premium for carrying gap risk roughly four sessions in five. Without a history of this gap there is no way to tell whether today's is rich or routine, so no verdict is offered.`
        : 'implied is BELOW realized, which is uncommon and means the market is pricing less movement than the index has actually been making — usually seen after a shock has passed but before vol has re-rated.'),
    caveat: pct && pct.ok ? null : 'no verdict without a history of this gap — a single IV-above-RV reading is true most of the time and informative almost never.'
  };
}

/* ============================================================
   TERM STRUCTURE — the reading that needs no history at all

   Comparing the front expiry's implied vol against a later one is computable from today's board
   alone, which makes it the most useful thing in this file on day one.

   Normal state is CONTANGO: further-dated options carry higher implied vol, because more can go
   wrong in more time. BACKWARDATION — the front richer than the back — means the market has
   identified something specific and near: an event, a policy decision, a result. It is a
   reliable signal precisely because it is a price rather than an opinion, and it is the clearest
   warning available that a calendar spread or a short-dated short is about to be run over.
   ============================================================ */

function termStructure(points) {
  const pts = (points || [])
    .filter(p => p && isNum(p.iv) && isNum(p.days) && p.days > 0)
    .sort((a, b) => a.days - b.days);
  if (pts.length < 2) return { ok: false, reason: 'need at least two expiries with a readable implied volatility' };

  const front = pts[0], back = pts[pts.length - 1];
  const slope = (back.iv - front.iv) / Math.max(1e-9, Math.log(back.days / front.days));
  const ratio = front.iv / back.iv;
  const inverted = front.iv > back.iv * 1.02;

  return {
    ok: true,
    points: pts.map(p => ({ days: p.days, iv: p.iv, expiry: p.expiry, label: p.label || null })),
    front: { days: front.days, iv: front.iv },
    back: { days: back.days, iv: back.iv },
    slope, ratio, inverted,
    shape: inverted ? 'backwardation' : (front.iv < back.iv * 0.98 ? 'contango' : 'flat'),
    reading: inverted
      ? `the front expiry is pricing ${((ratio - 1) * 100).toFixed(0)}% more volatility than the back. The market has identified something specific and near — an event, a decision, a result. Short-dated premium is expensive for a reason, and selling it here is selling insurance against a known upcoming risk.`
      : (front.iv < back.iv * 0.98
        ? 'normal upward-sloping term structure: more time, more implied movement. Nothing near-term is being singled out.'
        : 'the curve is flat — no particular near-term event is being priced, but no cushion either.')
  };
}

/* ============================================================
   THE IMPLIED MOVE AGAINST THE MOVES THAT ACTUALLY HAPPENED

   The most intuitive cheap-or-expensive test available, and — like the term structure — it needs
   no option history whatsoever, only the index's own closes. The option market says NIFTY will
   move 1.4% by Friday. Over the last two years, how often did it actually move that much in the
   same number of sessions?

   This is the number that answers a retail trader's real question, because it is denominated in
   the thing they are actually betting on rather than in volatility points.

   HONEST ABOUT ITS SAMPLE: the windows overlap, so five hundred observations are nothing like
   five hundred independent ones — consecutive windows share most of their days. The count is
   reported as the raw window count and flagged as overlapping, so nobody reads a tight-looking
   percentile as more evidence than it is.
   ============================================================ */

function impliedVsRealisedMove(o) {
  const impliedPct = o.impliedPct;
  const closes = (o.closes || []).filter(v => isNum(v) && v > 0);
  const h = Math.max(1, Math.round(o.horizonDays || 5));

  if (!isNum(impliedPct) || impliedPct <= 0) return { ok: false, reason: 'no implied move to compare' };
  if (closes.length < h + 30) {
    return { ok: false, reason: `need at least ${h + 30} closes to build a distribution of ${h}-session moves, have ${closes.length}` };
  }

  const moves = [];
  for (let i = h; i < closes.length; i++) moves.push(Math.abs(closes[i] / closes[i - h] - 1));
  const sorted = moves.slice().sort((a, b) => a - b);
  let below = 0;
  for (const m of moves) if (m < impliedPct) below++;

  const pct = below / moves.length;
  return {
    ok: true,
    impliedPct, horizonDays: h,
    percentileOfHistory: pct,
    medianMove: S.median(moves),
    p75: sorted[Math.floor(sorted.length * 0.75)],
    p90: sorted[Math.floor(sorted.length * 0.90)],
    exceededPct: 1 - pct,
    windows: moves.length,
    overlapping: true,
    sampleNote: `${moves.length} overlapping ${h}-session windows. Consecutive windows share most of their days, so this is far less independent evidence than the count suggests — read it as a shape, not as a probability.`,
    reading: pct > 0.85
      ? `the option market is pricing a ${(impliedPct * 100).toFixed(2)}% move, larger than ${(pct * 100).toFixed(0)}% of the ${h}-session moves this index has actually made. A buyer needs an unusual week just to break even.`
      : pct < 0.4
        ? `the option market is pricing a ${(impliedPct * 100).toFixed(2)}% move, which this index exceeds in ${((1 - pct) * 100).toFixed(0)}% of ${h}-session windows. Movement is cheap here relative to what normally happens.`
        : `the implied move of ${(impliedPct * 100).toFixed(2)}% is close to this index's typical ${h}-session move of ${(S.median(moves) * 100).toFixed(2)}%.`
  };
}

/* ============================================================
   THE COMBINED VERDICT

   Scored through intel/stats' scoreParts, which is the same weighting machinery the market
   health engine uses — so a missing input WIDENS THE UNCERTAINTY rather than scoring as zero,
   and `coverage` says how much of the evidence was actually present. That behaviour is the
   reason this platform's conclusions can be trusted when half its feeds are down, and there was
   no reason to write a second one for options.
   ============================================================ */

function assess(o) {
  const parts = [];
  const evidence = [];
  const notes = [];

  /* IV percentile against its own history — the strongest single input where it exists. */
  const ivp = o.ivPercentile;
  if (ivp && ivp.ok) {
    parts.push({ k: 'ivPercentile', w: 0.40, v: ivp.percentile });
    evidence.push(`implied vol is at the ${(ivp.percentile * 100).toFixed(0)}th percentile of ${ivp.n} observations (${ivp.source})`);
    if (ivp.sourceNote) notes.push(ivp.sourceNote);
  } else {
    parts.push({ k: 'ivPercentile', w: 0.40, v: null });
    if (ivp && ivp.reason) notes.push(ivp.reason);
  }

  /* The variance risk premium, but only when there is a history to place it against. A raw
     positive gap contributes NOTHING here, deliberately — see the header. */
  const vrp = o.vrp;
  if (vrp && vrp.ok && isNum(vrp.percentile)) {
    parts.push({ k: 'ivrvGap', w: 0.25, v: vrp.percentile });
    evidence.push(`the premium over realized vol is at its ${(vrp.percentile * 100).toFixed(0)}th percentile`);
  } else {
    parts.push({ k: 'ivrvGap', w: 0.25, v: null });
    if (vrp && vrp.caveat) notes.push(vrp.caveat);
  }

  /* The implied move against actual moves — needs no option history, so it is usually the input
     carrying the load early in this platform's life. */
  const mv = o.moveComparison;
  if (mv && mv.ok) {
    parts.push({ k: 'impliedVsRealisedMove', w: 0.25, v: mv.percentileOfHistory });
    evidence.push(`the implied move sits above ${(mv.percentileOfHistory * 100).toFixed(0)}% of this index's actual moves over the same horizon`);
  } else {
    parts.push({ k: 'impliedVsRealisedMove', w: 0.25, v: null });
  }

  /* Term structure inversion is a small weight on the expensive side, because backwardation
     means the front is rich — but rich for a stated reason, which is a different thing from
     rich by accident. */
  const ts = o.termStructure;
  if (ts && ts.ok) {
    parts.push({ k: 'termStructure', w: 0.10, v: ts.inverted ? 0.85 : (ts.shape === 'contango' ? 0.4 : 0.55) });
    evidence.push(`term structure is in ${ts.shape}`);
  } else {
    parts.push({ k: 'termStructure', w: 0.10, v: null });
  }

  const scored = S.scoreParts(parts);
  if (!scored) {
    return {
      ok: false, verdict: 'unknown', score: null, coverage: 0,
      reason: 'no volatility evidence was available at all — no history, no comparable move distribution, no second expiry to build a term structure from',
      notes
    };
  }

  const score = scored.score;
  const verdict = score > 0.75 ? 'expensive' : score > 0.6 ? 'leaning expensive'
    : score < 0.25 ? 'cheap' : score < 0.4 ? 'leaning cheap' : 'fair';

  /* AN EVENT WINDOW CHANGES WHAT "EXPENSIVE" MEANS. Elevated implied vol before a scheduled
     release is not a mispricing, it is the market correctly charging for a known risk — and the
     crush afterwards is equally not a gift. Reuses the macro calendar already built for the
     crypto side rather than keeping a second list of dates. */
  let eventWarning = null;
  if (o.event && o.event.inWindow) {
    eventWarning = `${o.event.label || 'a scheduled high-impact event'} falls before this expiry. Implied vol is SUPPOSED to be elevated into it, so "expensive" here is not a mispricing to sell — it is the market charging correctly for a known risk, and the collapse afterwards is the price of having carried it.`;
    notes.push(eventWarning);
  }

  return {
    ok: true,
    verdict, score,
    coverage: scored.coverage,
    used: scored.used, missing: scored.missing,
    evidence, notes, eventWarning,
    /* Low coverage is not a footnote — it is the difference between a conclusion and a guess,
       so it is returned as a first-class field and the UI is expected to show it. */
    confidence: scored.coverage > 0.75 ? 'good' : scored.coverage > 0.4 ? 'partial' : 'thin',
    confidenceNote: scored.coverage <= 0.4
      ? `this verdict rests on ${(scored.coverage * 100).toFixed(0)}% of the evidence it is designed to use (missing: ${scored.missing.join(', ')}). Treat it as a first impression, not a finding.`
      : null
  };
}

module.exports = {
  realizedVol, ivPercentile, resolveIvHistory, varianceRiskPremium,
  termStructure, impliedVsRealisedMove, assess,
  TRADING_DAYS, MIN_SAMPLE
};
