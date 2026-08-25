/* ============================================================
   INTEL — FRAGILE MOVE DETECTOR ("this rally is not supported")

   ============================================================
   WHAT THIS IS NOT
   ============================================================
   It is NOT a crash predictor. Nothing here forecasts a fall, and no honest system built on this
   data could. Saying "BTC will crash" would be the same false authority this whole module exists
   to remove — it would just be wrong in a more exciting direction.

   WHAT IT IS: a measure of how much of a move is UNSUPPORTED by its own internals. A rally can be
   carried by broad participation, rising volume and improving macro — or it can be four coins, a
   thinning book, a crowded long position and an equity market that is already rolling over. Both
   print the same green candle. The second one resolves badly far more often, and every one of its
   tells is measurable *before* the reversal rather than after it.

   The output is therefore a FRAGILITY score with the specific unsupported legs named, plus the
   condition that would repair it. "This rally is resting on fewer legs than the price implies" is
   a claim the data can support. "It will crash" is not.

   DIRECTION-AWARE. The same arithmetic detects an exhausted DECLINE — price making new lows while
   breadth, volume and macro all improve underneath it. That is the mirror image and is usually
   the better entry of the two.
   ============================================================ */

const S = require('./stats');

const WINDOW = 24;                   // 24 × 1h ≈ one day of the move being judged
const RECENT = 6;
const MIN_MOVE = 0.015;              // below 1.5% there is no "move" to call fragile
const RSI_PERIOD = 14;

/* Volume trend across the move: recent third versus the first third. */
function volumeTrend(close, vol) {
  if (!close || !vol || vol.length !== close.length || close.length < WINDOW) return null;
  const qv = close.map((c, i) => (+vol[i] || 0) * c).slice(-WINDOW);
  if (qv.some(v => !(v >= 0))) return null;
  const third = Math.max(2, Math.floor(qv.length / 3));
  const early = S.mean(qv.slice(0, third));
  const late = S.mean(qv.slice(-third));
  if (!(early > 0) || !S.isNum(late)) return null;
  return { ratio: late / early, fading: late < early * 0.75 };
}

/* Classic momentum divergence: price makes a higher high while RSI makes a lower high (or the
   mirror at lows). Uses the SAME zigzag pivots as the structure engine, so "a swing high" means
   one thing across the app. */
function momentumDivergence(close, zigzag, IND, dir) {
  if (!close || close.length < 40 || !IND) return null;
  const rets = S.returns(close).filter(S.isNum).map(Math.abs);
  const typical = S.median(rets) || 0.004;
  let thr = S.clamp(typical * 100 * 5, 0.6, 12);
  let piv = zigzag(close, thr);
  for (let a = 0; a < 2 && (!piv || piv.length < 3); a++) { thr /= 2; if (thr < 0.15) break; piv = zigzag(close, thr); }
  if (!piv || piv.length < 3) return null;

  const rsi = IND.rsi(close, RSI_PERIOD);
  const want = dir > 0 ? 1 : -1;
  const pts = piv.filter(p => p.k === want).slice(-2);
  if (pts.length < 2) return null;
  const [a, b] = pts;
  const ra = rsi[a.i], rb = rsi[b.i];
  if (!S.isNum(ra) || !S.isNum(rb)) return null;

  if (dir > 0) {
    // Higher high in price, lower high in momentum → the push is weakening.
    const diverging = b.px > a.px && rb < ra;
    return { diverging, priceFrom: a.px, priceTo: b.px, rsiFrom: +ra.toFixed(1), rsiTo: +rb.toFixed(1) };
  }
  const diverging = b.px < a.px && rb > ra;
  return { diverging, priceFrom: a.px, priceTo: b.px, rsiFrom: +ra.toFixed(1), rsiTo: +rb.toFixed(1) };
}

/* How far price has stretched from its own mean, in ATR units — extension is not a reversal
   signal on its own, but it sets how much room a reversal has to run. */
function extension(close, high, low, IND) {
  if (!close || close.length < 60 || !IND) return null;
  const ema = IND.ema(close, 20);
  const atr = IND.atr(close, high, low, 14);
  const i = close.length - 1;
  if (!S.isNum(ema[i]) || !S.isNum(atr[i]) || !(atr[i] > 0)) return null;
  return (close[i] - ema[i]) / atr[i];
}

function fragility(snap, ctx) {
  const c = ctx || {};
  const zigzag = c.zigzag || (() => []);
  const IND = c.IND;
  const btc = snap && snap.coins && snap.coins.BTC;
  if (!btc || !btc.h1 || !btc.h1.close || btc.h1.close.length < 40) {
    return { ok: false, reason: 'not enough BTC hourly history to judge whether a move is supported' };
  }

  const cl = btc.h1.close, hi = btc.h1.high, lo = btc.h1.low, vl = btc.h1.vol;
  const move = S.retOver(cl, WINDOW);
  const recentMove = S.retOver(cl, RECENT);
  if (!S.isNum(move)) return { ok: false, reason: 'no usable BTC move over the window' };

  const dir = move > 0 ? 1 : -1;
  const magnitude = Math.abs(move);
  if (magnitude < MIN_MOVE) {
    return {
      ok: true, active: false, direction: 'flat', move,
      reason: `BTC has moved ${(move * 100).toFixed(1)}% over ${WINDOW}h — too little to call a move fragile.`,
      score: null, signals: []
    };
  }

  const breadth = c.breadth, macro = c.macro, attrib = c.attribution;
  const funding = c.funding, oi = c.oi;

  const vt = volumeTrend(cl, vl);
  const md = momentumDivergence(cl, zigzag, IND, dir);
  const ext = extension(cl, hi, lo, IND);

  /* ---- PARTICIPATION ----
     A rally the whole board joins is a different animal from a rally in four names. Compared
     against the same breadth figures every other panel uses, so the two can never disagree. */
  const pctWith = breadth && breadth.ok
    ? (dir > 0 ? breadth.pctGreen : breadth.pctRed)
    : null;
  const pctAbove20 = breadth && breadth.ok ? breadth.pctAbove20 : null;
  const participation = S.isNum(pctWith)
    ? (dir > 0 ? pctWith : pctWith)     // share of the board moving WITH the move
    : null;

  /* ---- MACRO DIVERGENCE — the signal this feature was asked for ----
     Crypto rising while the macro backdrop deteriorates is a move with no external support. It is
     precisely the configuration in which a clean-looking chart keeps printing higher highs right
     up until the dollar or equities force the issue. */
  const macroOk = macro && macro.available && S.isNum(macro.riskAppetite);
  const macroAgainst = macroOk ? (dir > 0 ? -macro.riskAppetite : macro.riskAppetite) : null;
  const equityLink = (attrib && attrib.ok) ? attrib.drivers.find(d => d.key === 'NDX' || d.key === 'SPX') : null;
  /* Crypto up while its own equity benchmark is down (or vice versa) — an upside decoupling that
     historically does not last, because the beta reasserts itself. */
  const equityDecoupling = (equityLink && S.isNum(equityLink.move) && equityLink.beta > 0)
    ? (dir > 0 ? equityLink.move < -0.005 : equityLink.move > 0.005) : null;

  const fundingCrowded = (funding && funding.available && S.isNum(funding.medianRate))
    ? (dir > 0 ? S.ramp(funding.medianRate, 0.0001, 0.0006) : S.ramp(-funding.medianRate, 0.0001, 0.0006))
    : null;
  const leveragedChase = (oi && oi.available && S.isNum(oi.market.oiChange))
    ? S.ramp(oi.market.oiChange, 0.005, 0.05)             // price up on rapidly rising OI = chased
    : null;

  const parts = [
    { k: 'narrowParticipation', w: 0.20, v: S.isNum(participation) ? S.ramp(participation, 75, 35) : null },
    { k: 'weakeningTrendQuality', w: 0.12, v: S.isNum(pctAbove20) ? (dir > 0 ? S.ramp(pctAbove20, 70, 30) : S.ramp(100 - pctAbove20, 70, 30)) : null },
    { k: 'volumeFading', w: 0.16, v: vt ? S.ramp(vt.ratio, 1.1, 0.5) : null },
    { k: 'momentumDivergence', w: 0.16, v: md ? (md.diverging ? 1 : 0) : null },
    { k: 'macroAgainstTheMove', w: 0.20, v: S.isNum(macroAgainst) ? S.ramp(macroAgainst, -20, 60) : null },
    { k: 'equityDecoupling', w: 0.08, v: equityDecoupling == null ? null : (equityDecoupling ? 1 : 0) },
    { k: 'crowdedPositioning', w: 0.05, v: fundingCrowded },
    { k: 'leveragedChase', w: 0.03, v: leveragedChase }
  ];
  const sp = S.scoreParts(parts);
  const score = sp ? Math.round(sp.score * 100) : null;

  /* ---- NAMED LEGS, WITH THREE STATES AND NOT TWO ----
     `missing` (a support that is absent), `ok` (a support that is confirmed), and `unknown` (a
     support that could not be MEASURED). The third state is not decoration: an earlier two-state
     version rendered "macro unavailable — UNCHECKED" with a green tick beside it, because
     "didn't fire" and "passed" were the same value. A green tick on an unmeasured leg is the
     precise failure this module exists to prevent, sitting inside the module itself. */
  const signals = [];
  const add = (k, state, detail) => signals.push({ k, state, fired: state === 'missing', detail });
  const tri = (measurable, isMissing) => !measurable ? 'unknown' : (isMissing ? 'missing' : 'ok');

  add('participation', tri(S.isNum(participation), S.isNum(participation) && participation < 50),
    S.isNum(participation) ? `${Math.round(participation)}% of tracked coins are moving with BTC${participation < 50 ? ' — narrow leadership' : ''}` : 'breadth unavailable — participation UNCHECKED');
  add('volume', tri(!!vt, vt && vt.fading),
    vt ? `volume in the latest third of the move is ${(vt.ratio * 100).toFixed(0)}% of the first third${vt.fading ? ' — fading' : ''}` : 'no volume on this feed — volume support UNCHECKED');
  add('momentum', tri(!!md, md && md.diverging), md ? (md.diverging
    ? `price made a ${dir > 0 ? 'higher high' : 'lower low'} while RSI made a ${dir > 0 ? 'lower high' : 'higher low'} (${md.rsiFrom} → ${md.rsiTo}) — the push is weakening`
    : 'momentum is confirming the move') : 'no clean pivot pair yet — momentum UNCHECKED');
  add('macro', tri(macroOk, S.isNum(macroAgainst) && macroAgainst > 10), macroOk
    ? `macro risk appetite ${macro.riskAppetite} (${macro.riskAppetiteLabel})${macroAgainst > 10 ? ` — pointing against a ${dir > 0 ? 'rally' : 'decline'}` : ' — not against the move'}`
    : 'macro unavailable — the external support for this move is UNCHECKED');
  add('equities', tri(equityDecoupling != null, equityDecoupling),
    equityDecoupling != null
      ? `${equityLink.name} ${(equityLink.move * 100).toFixed(1)}% over the window${equityDecoupling ? ` while crypto moved the other way — an upside decoupling from a benchmark it has a ${equityLink.beta} beta to` : ''}`
      : 'no measurable equity link — equity support UNCHECKED');
  add('positioning', tri(!!(funding && funding.available), S.isNum(fundingCrowded) && fundingCrowded > 0.5),
    (funding && funding.available)
      ? `funding ${(funding.medianRate * 100).toFixed(3)}% per 8h — ${funding.crowding.replace(/-/g, ' ')}`
      : 'no funding feed — positioning UNCHECKED');
  add('leverage', tri(!!(oi && oi.available), S.isNum(leveragedChase) && leveragedChase > 0.5),
    (oi && oi.available)
      ? `open interest ${(oi.market.oiChange * 100).toFixed(1)}% — ${oi.market.oiChange > 0.01 ? 'the move is being chased with fresh leverage' : 'no leveraged chase'}`
      : 'no open-interest feed — leverage UNCHECKED');
  add('extension', tri(S.isNum(ext), S.isNum(ext) && Math.abs(ext) > 2.5),
    S.isNum(ext) ? `price is ${ext.toFixed(1)} ATR from its 20-period mean${Math.abs(ext) > 2.5 ? ' — stretched, so a reversion has room' : ''}` : 'not enough history to measure extension');

  const fired = signals.filter(s => s.state === 'missing');
  const measured = signals.filter(s => s.state !== 'unknown');
  const unchecked = signals.filter(s => s.state === 'unknown');
  /* Adjectival, all of them — these get dropped straight into "This rally is ___ by its
     internals", and a noun phrase there produced "this rally is mixed support by its internals". */
  const label = !S.isNum(score) ? 'Unknown'
    : score >= 70 ? 'Largely unsupported'
      : score >= 50 ? 'Weakly supported'
        : score >= 30 ? 'Only partly supported'
          : 'Well supported';

  const dirWord = dir > 0 ? 'rally' : 'decline';
  const missingTxt = `${fired.length} of the ${measured.length} internal supports that could be checked ${fired.length === 1 ? 'is' : 'are'} missing`;
  const headline = !S.isNum(score) ? null
    : score >= 50
      ? `This ${dirWord} is ${label.toLowerCase()}: ${missingTxt}. It is resting on fewer legs than the price implies — that is not a forecast of a reversal, it is a statement that less is holding it up than usual.`
      : score >= 30
        ? `This ${dirWord} is ${label.toLowerCase()}: ${missingTxt}, but the majority still confirm it.`
        /* Even the reassuring branch names the denominator. "Well supported" over two measured
           legs and over seven are very different statements, and the reader deserves to know
           which one they are being given. */
        : `This ${dirWord} is ${label.toLowerCase()} — ${measured.length - fired.length} of the ${measured.length} internal supports that could be checked ${measured.length - fired.length === 1 ? 'is' : 'are'} confirming it.`;

  return {
    ok: true, active: true,
    direction: dir > 0 ? 'up' : 'down',
    move, recentMove, magnitude,
    score, label,
    coverage: sp ? sp.coverage : null,
    inputs: sp ? sp.used : [], missing: sp ? sp.missing : [],
    signals, firedCount: fired.length, totalSignals: signals.length,
    measuredCount: measured.length, uncheckedCount: unchecked.length,
    uncheckedNote: unchecked.length
      ? `${unchecked.length} support(s) could not be measured (${unchecked.map(u => u.k).join(', ')}) — this reading is based on the ${measured.length} that could.`
      : null,
    extension: ext,
    headline,
    /* What would repair it — the counterpart to the warning, so the trader has something to
       watch rather than only something to worry about. */
    repairedBy: dir > 0
      ? 'Broadening participation, volume expanding rather than fading, and macro turning supportive would restore this rally\'s footing.'
      : 'Breadth improving, volume drying up and macro stabilising would mark this decline as exhausted rather than continuing.',
    disclaimer: 'Fragility measures how much of this move its own internals support. It does NOT predict a reversal, and a well-supported move can still fail.'
  };
}

module.exports = { fragility, volumeTrend, momentumDivergence, extension, WINDOW, MIN_MOVE };
