/* ============================================================
   INTEL — MARKET STRUCTURE (HH / HL / LH / LL)

   The oldest read in trading and still the one that decides whether a position is swimming with
   the tide or against it. A long in a coin printing LL → LH → LL is not "early"; it is fighting
   the structure, and the engine says so in those words rather than burying it in a score.

   Built on server.js's `zigzag`, injected — the same pivot detector the Dump & Bounce panel
   already uses, so a "higher low" means the identical thing on both screens. Two definitions of
   a swing low in one app is how two panels end up disagreeing about the same chart.

   THE THRESHOLD ADAPTS TO THE COIN. A fixed 10% swing filter finds no pivots at all on BTC over
   a few days and a pivot every other bar on a micro-cap. Scaling it to the coin's own typical
   bar move makes "a swing" mean the same thing relative to how that coin actually trades.
   ============================================================ */

const S = require('./stats');

const MIN_BARS = 20;

function swingThreshold(close) {
  const rets = S.returns(close).filter(S.isNum).map(Math.abs);
  const typical = S.median(rets) || 0.004;
  return S.clamp(typical * 100 * 5, 0.6, 12);      // ~5 typical bars of movement defines one swing
}

/* Label each pivot against the previous pivot of the SAME kind:
   highs become HH or LH, lows become HL or LL. */
function labelPivots(piv) {
  const out = [];
  let lastHigh = null, lastLow = null;
  for (const p of piv) {
    if (p.k === 1) {
      out.push({ ...p, tag: lastHigh == null ? null : (p.px > lastHigh ? 'HH' : 'LH') });
      lastHigh = p.px;
    } else {
      out.push({ ...p, tag: lastLow == null ? null : (p.px > lastLow ? 'HL' : 'LL') });
      lastLow = p.px;
    }
  }
  return out;
}

function structure(close, zigzag, opts) {
  const o = opts || {};
  const cl = (close || []).filter(v => S.isNum(v) && v > 0);
  if (cl.length < MIN_BARS) return { ok: false, reason: `under ${MIN_BARS} bars — not enough to read a swing sequence` };
  /* TRY HARDER BEFORE GIVING UP.
     A clean one-way trend genuinely contains few counter-swings, so the first threshold can come
     back with two pivots and no readable sequence — during exactly the move a trader most needs a
     structure read for. Halving the threshold twice finds the smaller pivots that a strong trend
     still prints, and only then does the engine report the sequence as unreadable. Returning
     "unknown" here is not free: the average-down gate treats it as an unmet condition. */
  let thr = o.threshold || swingThreshold(cl);
  let piv = zigzag(cl, thr);
  for (let attempt = 0; attempt < 2 && (!piv || piv.length < 3); attempt++) {
    thr = thr / 2;
    if (thr < 0.15) break;                         // below this it tracks noise, not structure
    piv = zigzag(cl, thr);
  }
  if (!piv || piv.length < 3) {
    return { ok: false, reason: 'no clear swing sequence at this timeframe (price has not made distinct pivots)', threshold: thr, pivots: piv ? piv.length : 0 };
  }
  const tagged = labelPivots(piv);
  const sequence = tagged.map(p => p.tag).filter(Boolean);
  const last4 = sequence.slice(-4);

  const highs = tagged.filter(p => p.k === 1);
  const lows = tagged.filter(p => p.k === -1);
  const lastHighTag = highs.length && highs[highs.length - 1].tag;
  const lastLowTag = lows.length && lows[lows.length - 1].tag;

  let verdict, label;
  if (lastHighTag === 'HH' && lastLowTag === 'HL') { verdict = 'bullish'; label = 'Bullish structure — higher highs and higher lows'; }
  else if (lastHighTag === 'LH' && lastLowTag === 'LL') { verdict = 'bearish'; label = 'Bearish structure — lower highs and lower lows'; }
  else if (lastHighTag === 'HH' && lastLowTag === 'LL') { verdict = 'expanding'; label = 'Expanding range — both extremes widening, direction unresolved'; }
  else if (lastHighTag === 'LH' && lastLowTag === 'HL') { verdict = 'contracting'; label = 'Contracting range — coiling toward a break'; }
  else if (!lastHighTag || !lastLowTag) { verdict = 'forming'; label = 'Structure still forming — only one side has a confirmed sequence'; }
  else { verdict = 'transition'; label = 'Structure in transition'; }

  const px = cl[cl.length - 1];
  const lastHigh = highs.length ? highs[highs.length - 1].px : null;
  const lastLow = lows.length ? lows[lows.length - 1].px : null;

  return {
    ok: true, verdict, label, sequence, recent: last4,
    lastHighTag: lastHighTag || null, lastLowTag: lastLowTag || null,
    lastHigh, lastLow, price: px,
    threshold: +thr.toFixed(2),
    pivots: tagged.slice(-6).map(p => ({ px: p.px, kind: p.k === 1 ? 'high' : 'low', tag: p.tag })),
    /* The level that would change the read. For a bearish sequence it is the last lower high —
       reclaiming it is the first thing that stops the bleeding, and it is exactly what the
       recovery-requirement text quotes back to the trader. */
    invalidationLevel: verdict === 'bearish' ? lastHigh : verdict === 'bullish' ? lastLow : null,
    inputs: ['closeSeries', 'zigzagPivots']
  };
}

/* Is a position fighting the structure it sits in?
   `dir` is +1 long / −1 short. Returns null when structure could not be read — silence, not a
   reassuring "no". */
function fightingStructure(st, dir) {
  if (!st || !st.ok) return null;
  if (dir > 0 && st.verdict === 'bearish') {
    return { fighting: true, text: 'Your long is currently fighting bearish market structure (lower highs and lower lows).' };
  }
  if (dir < 0 && st.verdict === 'bullish') {
    return { fighting: true, text: 'Your short is currently fighting bullish market structure (higher highs and higher lows).' };
  }
  return { fighting: false, text: dir > 0 ? 'Structure is not against your long.' : 'Structure is not against your short.' };
}

module.exports = { structure, fightingStructure, swingThreshold, labelPivots };
