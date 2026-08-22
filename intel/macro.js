/* ============================================================
   INTEL — MACRO REGIME + TECHNICAL-RELIABILITY ENGINE

   This engine exists because of a specific, common and expensive failure: a technically perfect
   setup on a coin, taken with leverage, destroyed by something that was never on the coin's chart.
   Every other indicator in this platform is ENDOGENOUS — derived from the asset's own history — so
   the whole system was structurally blind to the most frequent cause of a leveraged loss.

   THE HEADLINE OUTPUT IS NOT THE RISK-APPETITE SCORE. It is TECHNICAL RELIABILITY: an estimate of
   how much crypto is currently being driven by macro rather than by its own structure. When BTC's
   correlation to the Nasdaq is 0.8 and VIX is spiking, a textbook support bounce is not a support
   bounce — it is whatever the dollar does next. That is precisely the condition under which a
   chart-only trader keeps taking clean-looking setups and keeps losing, because the chart is no
   longer the thing in charge, and nothing on the chart says so.

   ============================================================
   FAIL-OPEN, BUT LOUDLY — and the important consequence
   ============================================================
   If the macro feed is unreachable, this engine does NOT silently keep degrading confidence
   (which would make the platform unusable every time Yahoo hiccups) and does NOT silently stop
   protecting you (which would remove the guard at the worst possible moment). It reports
   `available:false`, leaves the confidence multiplier at 1.0, and raises a visible warning that
   technical signals are currently UNCHECKED against macro conditions.

   The event-risk gate is deliberately independent of all of this: it reads a local file, so
   "do not open leverage into CPI" keeps working even with no network at all. The single most
   valuable protection here is the one that cannot be knocked out by a failing API.
   ============================================================ */

const S = require('./stats');

const CORR_DAYS = 30;                // rolling window for BTC↔macro correlation
const MIN_PAIRS = 12;                // below this the correlation is noise
const VIX_CALM = 14, VIX_STRESS = 28;

/* Align two date-keyed close maps and return their paired daily returns.
   THIS IS THE LOAD-BEARING PART. Crypto trades 7 days a week; DXY does not. Pairing the two
   positionally would silently match Monday's BTC against the previous Thursday's dollar and
   produce a confident, meaningless correlation. Intersecting on date is the only correct way. */
function alignedReturns(mapA, mapB, maxDays) {
  const dates = Object.keys(mapA).filter(d => mapB[d] > 0 && mapA[d] > 0).sort();
  const use = dates.slice(Math.max(0, dates.length - (maxDays || CORR_DAYS) - 1));
  const ra = [], rb = [];
  for (let i = 1; i < use.length; i++) {
    const d0 = use[i - 1], d1 = use[i];
    ra.push(mapA[d1] / mapA[d0] - 1);
    rb.push(mapB[d1] / mapB[d0] - 1);
  }
  return { a: ra, b: rb, n: ra.length, from: use[0], to: use[use.length - 1] };
}

/* Daily close map for a coin out of the intel snapshot, keyed the same way as macro. */
function coinDailyMap(coin) {
  const d = coin && coin.daily;
  if (!d || !d.close || !d.times || d.times.length !== d.close.length) return null;
  const out = {};
  for (let i = 0; i < d.close.length; i++) {
    const c = +d.close[i];
    if (!(c > 0) || !d.times[i]) continue;
    out[new Date(+d.times[i]).toISOString().slice(0, 10)] = c;
  }
  return Object.keys(out).length >= MIN_PAIRS ? out : null;
}

function changeOver(series, days) {
  const ds = series.dates;
  if (!ds || ds.length < 2) return null;
  const last = series.closes[ds[ds.length - 1]];
  const i = Math.max(0, ds.length - 1 - days);
  const prev = series.closes[ds[i]];
  return (last > 0 && prev > 0 && i !== ds.length - 1) ? last / prev - 1 : null;
}

function readInstrument(series) {
  const vals = series.dates.map(d => series.closes[d]).filter(v => v > 0);
  const chg1d = changeOver(series, 1), chg5d = changeOver(series, 5), chg20d = changeOver(series, 20);
  return {
    key: series.key, name: series.name, group: series.group, why: series.why, source: series.source,
    level: series.last, asOfDate: series.lastDate,
    chg1d, chg5d, chg20d,
    pctile: S.percentileOf(vals.slice(0, -1), series.last),
    trend: !S.isNum(chg20d) ? 'unknown' : chg20d > 0.02 ? 'rising' : chg20d < -0.02 ? 'falling' : 'flat',
    /* Signed contribution to RISK APPETITE, not to price. A rising dollar is a falling risk
       appetite, and folding that inversion in here keeps every consumer from having to remember
       which way each instrument points. */
    riskSign: S.isNum(chg5d) ? (series.invert ? -Math.sign(chg5d) : Math.sign(chg5d)) : 0
  };
}

function macroEngine(macroRaw, snap, eventRisk, ctx) {
  const ev = eventRisk || { ok: false, inWindow: false };

  if (!macroRaw || !macroRaw.available) {
    /* No macro feed. Say so loudly, gate nothing on market data — but keep the calendar gate,
       because it needs no network and it is the highest-value protection here. */
    return {
      ok: false, available: false,
      reason: (macroRaw && macroRaw.reason) || 'macro adapter not configured',
      warning: 'MACRO UNCHECKED — technical setups on this screen have not been checked against dollar, rates, volatility or equity conditions. That is the exact blind spot that turns a clean-looking chart into a losing leveraged trade. Treat every confidence number as unverified.',
      instruments: {},
      eventRisk: ev,
      gate: buildGate(null, ev, null)
    };
  }

  const series = macroRaw.data.series || {};
  const instruments = {};
  for (const k of Object.keys(series)) instruments[k] = readInstrument(series[k]);

  /* ---- RISK APPETITE, −100…+100 ----
     Weighted over whatever actually loaded (scoreParts renormalises), so losing one instrument
     shifts the emphasis rather than dragging the score toward zero. */
  const g = k => instruments[k] || null;
  const sig = (k, full) => {
    const inst = g(k);
    if (!inst || !S.isNum(inst.chg5d)) return null;
    const v = inst.chg5d / full;                                  // move as a fraction of "a big move"
    return S.clamp((series[k].invert ? -v : v), -1, 1);
  };
  const parts = [
    { k: 'dollar', w: 0.25, v: sig('DXY', 0.02) },
    { k: 'rates', w: 0.15, v: sig('US10Y', 0.08) },
    { k: 'equityVol', w: 0.25, v: (() => { const v = g('VIX'); return v && S.isNum(v.pctile) ? S.clamp(1 - 2 * v.pctile, -1, 1) : null; })() },
    { k: 'sp500', w: 0.15, v: sig('SPX', 0.03) },
    { k: 'nasdaq', w: 0.20, v: sig('NDX', 0.04) }
  ];
  const shifted = parts.map(p => ({ ...p, v: S.isNum(p.v) ? (p.v + 1) / 2 : null }));
  const sp = S.scoreParts(shifted);
  const riskAppetite = sp ? Math.round((sp.score * 2 - 1) * 100) : null;

  /* ---- HOW MUCH IS CRYPTO A MACRO ASSET RIGHT NOW? ---- */
  const btc = snap && snap.coins && snap.coins.BTC;
  const btcMap = coinDailyMap(btc);
  const corr = {};
  let pairs = 0;
  if (btcMap) {
    for (const k of ['NDX', 'SPX', 'DXY', 'GOLD', 'US10Y']) {
      if (!series[k]) continue;
      const al = alignedReturns(btcMap, series[k].closes, CORR_DAYS);
      if (al.n < MIN_PAIRS) { corr[k] = null; continue; }
      corr[k] = S.pearson(al.a, al.b, MIN_PAIRS);
      pairs = Math.max(pairs, al.n);
    }
  }

  const vix = g('VIX');

  /* ---- THE MACRO LINKAGES ARE SUBSTITUTES, NOT COMPLEMENTS ----
     This is the one piece of modelling here worth arguing about, so: averaging these terms is
     wrong. If BTC is moving one-for-one with the Nasdaq, its chart is being overridden — and it
     makes no difference whether it also happens to track the dollar that week. An average lets
     the two quiet terms drag a maximal equity linkage down to a middling score, which is exactly
     backwards: ANY ONE strong tether is sufficient evidence that something outside the chart is
     in charge. So take the STRONGEST linkage, and let the volatility regime modulate it — high
     VIX collapses cross-asset dispersion and turns everything into a single trade. */
  const linkParts = [
    // Equity beta is the clearest tell: when BTC trades as a Nasdaq proxy, its own chart is noise.
    { k: 'btcNasdaqCorrelation', v: S.isNum(corr.NDX) ? S.ramp(Math.abs(corr.NDX), 0.20, 0.75) : null },
    { k: 'btcDollarCorrelation', v: S.isNum(corr.DXY) ? S.ramp(Math.abs(corr.DXY), 0.15, 0.60) : null },
    { k: 'rateSensitivity', v: S.isNum(corr.US10Y) ? S.ramp(Math.abs(corr.US10Y), 0.15, 0.55) : null }
  ];
  const measuredLinks = linkParts.filter(p => S.isNum(p.v));
  const linkage = measuredLinks.length ? Math.max(...measuredLinks.map(p => p.v)) : null;
  const strongestLink = measuredLinks.length
    ? measuredLinks.reduce((a, b) => (b.v > a.v ? b : a)).k : null;

  const domParts = [
    { k: 'strongestMacroLinkage', w: 0.60, v: linkage },
    { k: 'volatilityRegime', w: 0.40, v: vix && S.isNum(vix.level) ? S.ramp(vix.level, VIX_CALM, VIX_STRESS) : null }
  ];
  const dsp = S.scoreParts(domParts);
  let dominance = dsp ? Math.round(dsp.score * 100) : null;

  /* An imminent scheduled release makes the next move exogenous by definition, whatever the
     correlations have been doing. Floor rather than override, so a genuinely macro-dominated
     tape still reads higher than a quiet one. */
  if (ev.inWindow && S.isNum(dominance)) dominance = Math.max(dominance, 80);
  else if (ev.inWindow) dominance = 80;

  const taReliability = S.isNum(dominance) ? 100 - dominance : null;

  const regime = classifyMacro(instruments, riskAppetite, ev);
  const gate = buildGate({ riskAppetite, dominance, taReliability, regime }, ev, instruments);

  return {
    ok: true, available: true,
    asOf: macroRaw.asOf,
    covered: macroRaw.data.covered, total: macroRaw.data.total,
    failed: macroRaw.data.failed,
    instruments,
    riskAppetite,
    riskAppetiteLabel: appetiteLabel(riskAppetite),
    riskAppetiteCoverage: sp ? sp.coverage : null,
    riskInputs: sp ? sp.used : [], riskMissing: sp ? sp.missing : [],
    regime,
    cryptoMacro: {
      correlations: corr,
      sampleDays: pairs,
      dominance, taReliability,
      band: reliabilityBand(taReliability),
      /* Which tether is doing the work, so the screen can say "BTC↔Nasdaq" rather than leaving
         the trader to guess which of three linkages triggered the warning. */
      strongestLink, linkage,
      linkDetail: linkParts.reduce((o, p) => { o[p.k] = p.v; return o; }, {}),
      coverage: dsp ? dsp.coverage : null,
      inputs: dsp ? dsp.used : [], missing: dsp ? dsp.missing : [],
      message: reliabilityMessage(taReliability, corr, vix, ev)
    },
    eventRisk: ev,
    gate,
    inputs: ['macroDailyCloses', 'btcDailyCloses'].concat(ev.configured ? ['eventCalendar'] : []),
    caveat: 'Macro levels are end-of-day closes from a free public feed and can lag intraday by hours. Correlations are 30 calendar-day windows on aligned dates.'
  };
}

/* ---- THE GATE: what actually changes on screen ----
   Two separate mechanisms, deliberately:
     • confidenceMultiplier degrades every technical confidence score, with the reason attached.
     • blockNewLeverage is a hard stop used by the paper bot and the position panel.
   The multiplier never reaches zero — a degraded signal is still information, and hiding it would
   remove the trader's ability to disagree. */
function buildGate(macro, ev, instruments) {
  const reasons = [];
  let mult = 1;
  let block = false;

  if (ev && ev.inWindow) {
    block = true;
    mult = Math.min(mult, 0.4);
    reasons.push(ev.message);
  }
  if (macro && S.isNum(macro.taReliability)) {
    // reliability 100 → ×1.0, reliability 0 → ×0.5. Linear, and stated on screen.
    const m = 0.5 + 0.5 * (macro.taReliability / 100);
    if (m < mult) mult = m;
    if (macro.taReliability < 50) {
      reasons.push(`Technical reliability ${macro.taReliability}/100 — crypto is trading mainly on macro right now, so chart levels are carrying less of the outcome than usual.`);
    }
  }
  if (macro && S.isNum(macro.riskAppetite) && macro.riskAppetite <= -50) {
    block = true;
    reasons.push(`Macro risk appetite ${macro.riskAppetite} (${appetiteLabel(macro.riskAppetite)}) — new leveraged longs are blocked while the macro tape is this hostile.`);
  }
  if (!macro) {
    reasons.push('Macro data unavailable — technical signals are UNCHECKED against dollar, rate and volatility conditions.');
  }

  return {
    blockNewLeverage: block,
    blockLongs: !!(macro && S.isNum(macro.riskAppetite) && macro.riskAppetite <= -50) || (ev && ev.inWindow),
    blockShorts: !!(macro && S.isNum(macro.riskAppetite) && macro.riskAppetite >= 60) || (ev && ev.inWindow),
    confidenceMultiplier: +mult.toFixed(3),
    degraded: mult < 1,
    reasons
  };
}

function classifyMacro(inst, appetite, ev) {
  const why = [];
  const v = inst.VIX, d = inst.DXY, y = inst.US10Y;
  const pick = (key, label, tone) => ({ regime: key, label, tone, why });

  if (ev && ev.inWindow) {
    why.push(ev.window ? `${ev.window.label} ${ev.window.phase === 'before' ? 'in ' + ev.window.hoursAway + 'h' : 'just released'}` : 'scheduled event window');
    return pick('event-window', 'SCHEDULED EVENT WINDOW', 'amber');
  }
  if (v && S.isNum(v.level) && v.level >= VIX_STRESS && S.isNum(v.chg5d) && v.chg5d > 0.15) {
    why.push(`VIX ${v.level.toFixed(1)}, up ${(v.chg5d * 100).toFixed(0)}% in 5d`);
    return pick('vol-spike', 'VOLATILITY SHOCK', 'red');
  }
  if (d && S.isNum(d.chg5d) && d.chg5d >= 0.015) {
    why.push(`dollar +${(d.chg5d * 100).toFixed(1)}% in 5d`);
    return pick('dollar-squeeze', 'DOLLAR SQUEEZE', 'red');
  }
  if (y && S.isNum(y.chg5d) && y.chg5d >= 0.08) {
    why.push(`US 10-year yield +${(y.chg5d * 100).toFixed(0)}% in 5d to ${y.level.toFixed(2)}%`);
    return pick('yield-shock', 'RATE SHOCK', 'red');
  }
  if (S.isNum(appetite) && appetite <= -40) { why.push(`risk appetite ${appetite}`); return pick('risk-off', 'MACRO RISK-OFF', 'red'); }
  if (S.isNum(appetite) && appetite >= 40) { why.push(`risk appetite ${appetite}`); return pick('risk-on', 'MACRO RISK-ON', 'green'); }
  why.push(S.isNum(appetite) ? `risk appetite ${appetite} — no strong macro impulse` : 'insufficient macro data for a regime call');
  return pick('neutral', 'MACRO NEUTRAL', 'neutral');
}

function appetiteLabel(v) {
  if (!S.isNum(v)) return 'Unknown';
  if (v >= 50) return 'Strong risk-on';
  if (v >= 20) return 'Risk-on';
  if (v > -20) return 'Neutral';
  if (v > -50) return 'Risk-off';
  return 'Severe risk-off';
}
function reliabilityBand(v) {
  if (!S.isNum(v)) return 'Unknown';
  if (v >= 70) return 'High — the chart is mostly in charge';
  if (v >= 50) return 'Moderate';
  if (v >= 30) return 'Low — macro is doing much of the driving';
  return 'Very low — this is a macro tape, not a technical one';
}
function reliabilityMessage(rel, corr, vix, ev) {
  if (!S.isNum(rel)) return 'Not enough aligned history to judge how much macro is driving crypto right now.';
  const bits = [];
  if (S.isNum(corr.NDX)) bits.push(`BTC↔Nasdaq ${corr.NDX.toFixed(2)}`);
  if (S.isNum(corr.DXY)) bits.push(`BTC↔dollar ${corr.DXY.toFixed(2)}`);
  if (vix && S.isNum(vix.level)) bits.push(`VIX ${vix.level.toFixed(1)}`);
  const ctx = bits.length ? ' (' + bits.join(' · ') + ')' : '';
  if (ev && ev.inWindow) return `A scheduled release is inside its window${ctx}. The next move is exogenous — no chart level prices a number nobody has seen yet.`;
  if (rel < 30) return `Crypto is trading as a macro asset${ctx}. Technical setups are being overridden: a textbook support bounce here resolves on what the dollar and equities do, not on the level. This is the condition in which chart-only trading quietly stops working.`;
  if (rel < 50) return `Macro is doing a meaningful share of the driving${ctx}. Size technical setups smaller than usual and expect levels to fail more often than the chart implies.`;
  if (rel < 70) return `Mixed${ctx}. Technicals are working, but macro can still overrule them on any given session.`;
  return `Crypto is trading largely on its own structure${ctx} — technical levels are carrying most of the outcome, which is when chart-based setups are at their most dependable.`;
}

module.exports = { macroEngine, alignedReturns, coinDailyMap, readInstrument, buildGate, classifyMacro, appetiteLabel, reliabilityBand, CORR_DAYS, MIN_PAIRS, VIX_CALM, VIX_STRESS };
