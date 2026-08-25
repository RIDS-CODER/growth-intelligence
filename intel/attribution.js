/* ============================================================
   INTEL — MACRO ATTRIBUTION: which factor is moving crypto right now

   "Macro is risk-off" is a mood. "The dollar is up 1.4% this week, and with BTC's −0.8 beta that
   alone accounts for −1.1 of BTC's −1.9%" is a diagnosis — it names the thing, sizes it, and tells
   you what to watch to know when it stops.

   It also answers the question that matters most on a green day: is this rally CRYPTO demand, or
   is it just the Nasdaq? A move that is entirely explained by equity beta will reverse the moment
   equities do, no matter how good the chart looks.

   METHOD
     contribution_i = beta_i × move_i
   where beta_i is the OLS slope of BTC's daily returns on factor i's returns (30 aligned days)
   and move_i is that factor's move over the attribution window. Ranked by |contribution|.

   ============================================================
   WHY UNIVARIATE, DELIBERATELY
   ============================================================
   The statistically tidy answer is a multiple regression across all factors at once. It is the
   wrong tool here. DXY, the Nasdaq and 10-year yields are strongly collinear — in a joint fit
   their coefficients become unstable and routinely flip sign between one refresh and the next.
   A panel that says "the dollar is dragging you" on one pass and "the dollar is supporting you"
   twenty minutes later, from the same data, is worse than useless.

   Univariate betas are stable, and the RANK ORDER — which is the actionable part, and all the
   highlight needs — is robust. The cost is that the factors overlap, so shares do not sum to 100%
   and cannot be read as a partition. That caveat travels with the numbers everywhere they appear
   rather than being quietly dropped.

   NO LINK, NO CLAIM. A factor whose correlation to BTC is below the floor gets no attribution at
   all, however large its own move. A beta fitted through noise will happily "explain" a move it
   has nothing to do with, and that is exactly the confident-sounding nonsense this file must not
   produce.
   ============================================================ */

const S = require('./stats');
const { alignedReturns, coinDailyMap } = require('./macro');

const CORR_FLOOR = 0.25;             // below this there is no measurable link to attribute through
const MIN_PAIRS = 12;
const FIT_DAYS = 30;                 // beta is fitted over this many aligned days
const WINDOW_DAYS = 5;               // …and applied to the factor's move over this many
const MATERIAL_MOVE = 0.005;         // BTC must have moved 0.5% for shares to mean anything

/* Cumulative return of a date-keyed close map over its last `days` shared entries. */
function moveOver(closes, dates, days) {
  if (!dates || dates.length < 2) return null;
  const last = closes[dates[dates.length - 1]];
  const i = Math.max(0, dates.length - 1 - days);
  const prev = closes[dates[i]];
  return (last > 0 && prev > 0 && i !== dates.length - 1) ? last / prev - 1 : null;
}

function attribution(macroRaw, snap, opts) {
  const o = opts || {};
  if (!macroRaw || !macroRaw.available) {
    return { ok: false, available: false, reason: (macroRaw && macroRaw.reason) || 'macro data unavailable', drivers: [], dominant: null };
  }
  const btc = snap && snap.coins && snap.coins.BTC;
  const btcMap = btc ? coinDailyMap(btc) : null;
  if (!btcMap) {
    return { ok: false, available: false, reason: 'no aligned BTC daily history to attribute against', drivers: [], dominant: null };
  }

  const btcDates = Object.keys(btcMap).sort();
  const actualMove = moveOver(btcMap, btcDates, o.windowDays || WINDOW_DAYS);

  const series = macroRaw.data.series || {};
  const drivers = [];
  for (const key of Object.keys(series)) {
    const s = series[key];
    const al = alignedReturns(btcMap, s.closes, o.fitDays || FIT_DAYS);
    if (al.n < MIN_PAIRS) { drivers.push({ key, name: s.name, linked: false, reason: `only ${al.n} aligned days` }); continue; }
    const corr = S.pearson(al.a, al.b, MIN_PAIRS);
    const beta = S.beta(al.a, al.b, MIN_PAIRS);          // BTC returns regressed ON the factor
    if (!S.isNum(corr) || !S.isNum(beta) || Math.abs(corr) < CORR_FLOOR) {
      drivers.push({ key, name: s.name, linked: false, corr: S.isNum(corr) ? +corr.toFixed(2) : null, reason: 'no measurable link to crypto over this window' });
      continue;
    }
    // Restrict the factor's move to dates BTC also has, so the window is genuinely shared.
    const shared = Object.keys(s.closes).filter(d => btcMap[d] > 0).sort();
    const move = moveOver(s.closes, shared, o.windowDays || WINDOW_DAYS);
    if (!S.isNum(move)) { drivers.push({ key, name: s.name, linked: false, reason: 'no usable move over the window' }); continue; }

    const contribution = beta * move;
    drivers.push({
      key, name: s.name, why: s.why, group: s.group, linked: true,
      corr: +corr.toFixed(2), beta: +beta.toFixed(2),
      move, contribution,
      /* Sign is relative to CRYPTO, not to the factor. A dollar that rises is "dragging" even
         though the dollar itself went up — which is the only framing that is useful to someone
         holding coins. */
      direction: contribution > 0 ? 'boosting' : 'dragging',
      share: (S.isNum(actualMove) && Math.abs(actualMove) >= MATERIAL_MOVE) ? contribution / actualMove : null,
      strength: Math.abs(contribution)
    });
  }

  const linked = drivers.filter(d => d.linked).sort((a, b) => b.strength - a.strength);
  const dominant = linked.length ? linked[0] : null;
  const boosting = linked.filter(d => d.direction === 'boosting');
  const dragging = linked.filter(d => d.direction === 'dragging');

  /* Is this move explained from OUTSIDE crypto?
     Compares the strongest single macro contribution against what BTC actually did. Above ~60%
     the honest read is that the move is not crypto's own — it is being imported. */
  const explainedShare = (dominant && S.isNum(dominant.share)) ? dominant.share : null;
  const externallyDriven = S.isNum(explainedShare) && explainedShare > 0.6;

  return {
    ok: true, available: true,
    windowDays: o.windowDays || WINDOW_DAYS,
    fitDays: o.fitDays || FIT_DAYS,
    actualMove,
    material: S.isNum(actualMove) && Math.abs(actualMove) >= MATERIAL_MOVE,
    drivers: linked,
    unlinked: drivers.filter(d => !d.linked),
    dominant, boosting, dragging,
    explainedShare, externallyDriven,
    headline: headlineFor(dominant, actualMove, explainedShare, externallyDriven),
    caveat: 'Betas are univariate, so factors overlap and shares do not sum to 100%. Read the ranking, not the arithmetic. A factor with no measurable correlation to crypto is excluded rather than attributed through noise.',
    inputs: ['macroDailyCloses', 'btcDailyCloses', 'dateAlignedBetas']
  };
}

const pct = v => S.isNum(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '—';

function headlineFor(d, actual, share, external) {
  if (!d) return 'No macro factor currently has a measurable link to crypto — this move is crypto\'s own.';
  if (!S.isNum(actual) || Math.abs(actual) < MATERIAL_MOVE) {
    return `${d.name} moved ${pct(d.move)} over the window. BTC has barely moved, so there is nothing meaningful to attribute yet — but the ${d.beta > 0 ? 'positive' : 'negative'} beta of ${d.beta} is the link to watch.`;
  }
  const verb = d.direction === 'boosting' ? 'supporting' : 'dragging on';
  const base = `${d.name} is ${pct(d.move)} over the window. With BTC's ${d.beta} beta to it, that alone accounts for about ${pct(d.contribution)} of BTC's ${pct(actual)} — ${d.name} is the main thing ${verb} crypto right now.`;
  if (!external) return base;
  return base + ` That is roughly ${Math.round(Math.abs(share) * 100)}% of the whole move, so this is being imported from outside crypto rather than driven by crypto demand — it will turn when ${d.name} turns, whatever the chart is doing.`;
}

module.exports = { attribution, moveOver, headlineFor, CORR_FLOOR, MIN_PAIRS, FIT_DAYS, WINDOW_DAYS, MATERIAL_MOVE };
