/* ============================================================
   INTEL — MARKET BREADTH ENGINE

   Answers "how much of the market is participating, and in which direction" — the question a
   single BTC chart cannot answer. BTC can be flat while three quarters of the board bleeds; that
   is a different market from BTC flat with the board flat, and only breadth tells them apart.

   TWO SCORES, DELIBERATELY DIFFERENT SHAPES:
     • BREADTH SCORE   −100 … +100 — signed, symmetric. Direction and conviction.
     • ALTCOIN STRESS     0 … 100  — unsigned, one-sided. It measures synchronised DOWNSIDE only.
       There is no such thing as negative stress, and an "alt stress −40" during a rally would be
       a category error dressed up as a number.

   Nothing here is scored against a component that could not be measured — see stats.scoreParts.
   ============================================================ */

const S = require('./stats');
const { structure } = require('./structure');

const MIN_COINS = 8;               // below this it is a handful of coins, not "the market"
const VW_FULL = 0.06;                // ±6% volume-weighted 24h move saturates the magnitude term
const ALT_DROP_FULL = 0.08;          // 8% median alt decline saturates the stress magnitude term

/* Bars of the 15m fine series that make up each horizon. */
const BARS = { '1h': 4, '4h': 16, '24h': 96 };

const pct = (a, b) => b > 0 ? a / b * 100 : null;

/* One coin's return over a horizon. Prefers the exchange's own 24h figure — it is what the
   trader sees in their app — and falls back to the candle series when the venue gives none. */
function coinRet(coin, horizon) {
  if (horizon === '24h' && S.isNum(coin.chg24)) return coin.chg24 / 100;
  const bars = BARS[horizon];
  return bars ? S.retOver(coin.fine && coin.fine.close, bars) : null;
}

/* Swing structure in one number per coin: +1 bullish sequence, −1 bearish, 0 unreadable/mixed.
   DELEGATES to structure.js rather than re-deriving pivots. An earlier draft inlined its own
   zigzag threshold here, which meant a coin could count as "higher high" on the breadth tile and
   read "bearish structure" on its own card — the same two-rules-for-one-decision bug that has
   already cost this codebase three rounds. One implementation, one answer. */
function legOf(coin, zigzag) {
  const st = structure(coin.h1 && coin.h1.close, zigzag);
  if (!st.ok) return 0;
  if (st.verdict === 'bullish') return 1;
  if (st.verdict === 'bearish') return -1;
  return 0;
}

function breadth(snap, ctx) {
  const c = ctx || {};
  const zigzag = c.zigzag || (() => []);
  const tks = (snap && snap.tickers) || [];
  if (tks.length < MIN_COINS) {
    return { ok: false, reason: `only ${tks.length} of the tracked universe loaded — below the ${MIN_COINS}-coin floor for a market-wide read`, coins: tks.length };
  }

  const rows = tks.map(tk => {
    const coin = snap.coins[tk];
    const h1c = coin.h1 && coin.h1.close;
    return {
      tk,
      qv: +coin.qv || 0,
      r1h: coinRet(coin, '1h'),
      r4h: coinRet(coin, '4h'),
      r24h: coinRet(coin, '24h'),
      ema20: S.emaLast(h1c, 20),
      ema50: S.emaLast(h1c, 50),
      px: h1c && h1c.length ? h1c[h1c.length - 1] : null,
      leg: legOf(coin, zigzag),
      isAlt: tk !== 'BTC' && tk !== 'ETH'
    };
  });

  const share = (list, test) => {
    const usable = list.filter(r => test(r) !== null);
    if (!usable.length) return null;
    return pct(usable.filter(r => test(r) === true).length, usable.length);
  };
  const greenTest = r => S.isNum(r.r24h) ? r.r24h > 0 : null;
  const aboveEma = p => r => (S.isNum(r.px) && S.isNum(r[p])) ? r.px > r[p] : null;

  const pctGreen = share(rows, greenTest);
  const pctAbove20 = share(rows, aboveEma('ema20'));
  const pctAbove50 = share(rows, aboveEma('ema50'));
  const legRows = rows.filter(r => r.leg !== 0);
  const pctHH = legRows.length ? pct(legRows.filter(r => r.leg > 0).length, rows.length) : null;
  const pctLL = legRows.length ? pct(legRows.filter(r => r.leg < 0).length, rows.length) : null;

  const alts = rows.filter(r => r.isAlt);
  const vwRet24h = S.weightedMean(rows.map(r => r.r24h), rows.map(r => r.qv));

  /* ---- BREADTH SCORE ----
     Participation dominates (how many are moving), magnitude and structure temper it. Each term
     is mapped to −1…+1 first so the weights mean what they look like. */
  const sgn = p => S.isNum(p) ? (p / 50 - 1) : null;      // 0%→−1, 50%→0, 100%→+1
  const parts = [
    { k: 'pctGreen', w: 0.30, v: sgn(pctGreen) },
    { k: 'pctAbove20EMA', w: 0.20, v: sgn(pctAbove20) },
    { k: 'pctAbove50EMA', w: 0.15, v: sgn(pctAbove50) },
    { k: 'volumeWeightedReturn24h', w: 0.20, v: S.isNum(vwRet24h) ? S.clamp(vwRet24h / VW_FULL, -1, 1) : null },
    { k: 'swingStructure', w: 0.15, v: (S.isNum(pctHH) && S.isNum(pctLL)) ? S.clamp((pctHH - pctLL) / 100, -1, 1) : null }
  ];
  // scoreParts clamps to 0..1, so shift into that range, score, then shift back to −1…+1.
  const shifted = parts.map(p => ({ ...p, v: S.isNum(p.v) ? (p.v + 1) / 2 : null }));
  const sp = S.scoreParts(shifted);
  const score = sp ? Math.round((sp.score * 2 - 1) * 100) : null;

  /* ---- ALTCOIN STRESS ----
     Synchronised alt selling. Correlation is supplied by the correlation engine when it has run;
     when it has not, that term is absent rather than assumed — the score renormalises. */
  const altRed = share(alts, r => S.isNum(r.r24h) ? r.r24h < 0 : null);
  const medAlt4h = S.median(alts.map(r => r.r4h));
  const medAlt24h = S.median(alts.map(r => r.r24h));
  const stressParts = [
    { k: 'pctAltsRed', w: 0.30, v: S.isNum(altRed) ? altRed / 100 : null },
    { k: 'medianAltDecline4h', w: 0.25, v: S.isNum(medAlt4h) ? S.clamp(-medAlt4h / ALT_DROP_FULL, 0, 1) : null },
    { k: 'altBtcCorrelation', w: 0.20, v: S.isNum(c.avgCorrBtc) ? S.ramp(c.avgCorrBtc, 0.3, 0.9) : null },
    { k: 'altDownsideAmplification', w: 0.15, v: S.isNum(c.altDownsideBeta) ? S.ramp(c.altDownsideBeta, 1.0, 2.5) : null },
    { k: 'altsBelow20EMA', w: 0.10, v: (() => { const a = share(alts, aboveEma('ema20')); return S.isNum(a) ? (100 - a) / 100 : null; })() }
  ];
  const ssp = S.scoreParts(stressParts);
  const altStress = ssp ? Math.round(ssp.score * 100) : null;

  const btcR = rows.find(r => r.tk === 'BTC') || {};
  const ethR = rows.find(r => r.tk === 'ETH') || {};
  const diff = (a, b) => (S.isNum(a) && S.isNum(b)) ? a - b : null;

  return {
    ok: true,
    coins: rows.length,
    pctGreen, pctRed: S.isNum(pctGreen) ? 100 - pctGreen : null,
    pctAbove20, pctAbove50, pctHH, pctLL,
    avgRet1h: S.mean(rows.map(r => r.r1h)),
    avgRet4h: S.mean(rows.map(r => r.r4h)),
    avgRet24h: S.mean(rows.map(r => r.r24h)),
    medianRet24h: S.median(rows.map(r => r.r24h)),
    vwRet24h,
    alt: {
      count: alts.length,
      pctRed: altRed,
      pctGreen: S.isNum(altRed) ? 100 - altRed : null,
      medianRet4h: medAlt4h,
      medianRet24h: medAlt24h
    },
    btc: { ret1h: btcR.r1h ?? null, ret4h: btcR.r4h ?? null, ret24h: btcR.r24h ?? null },
    eth: { ret1h: ethR.r1h ?? null, ret4h: ethR.r4h ?? null, ret24h: ethR.r24h ?? null },
    /* ETH/BTC strength as a spread, not a ratio — "ETH is 1.4% weaker than BTC over 4h" is
       readable; "ETH/BTC = 0.9861" needs a chart to mean anything. */
    ethVsBtc: { h1: diff(ethR.r1h, btcR.r1h), h4: diff(ethR.r4h, btcR.r4h), h24: diff(ethR.r24h, btcR.r24h) },
    score, label: labelFor(score),
    scoreCoverage: sp ? sp.coverage : null,
    altStress, altStressLabel: stressLabel(altStress),
    altStressCoverage: ssp ? ssp.coverage : null,
    inputs: sp ? sp.used : [],
    missing: sp ? sp.missing : [],
    stressInputs: ssp ? ssp.used : [],
    stressMissing: ssp ? ssp.missing : [],
    rows
  };
}

function labelFor(s) {
  if (!S.isNum(s)) return 'Unknown';
  if (s >= 60) return 'Extremely broad risk-on';
  if (s >= 25) return 'Bullish';
  if (s > -25) return 'Neutral';
  if (s > -60) return 'Bearish';
  return 'Extreme risk-off';
}
function stressLabel(v) {
  if (!S.isNum(v)) return 'Unknown';
  if (v >= 80) return 'Extreme';
  if (v >= 60) return 'High';
  if (v >= 40) return 'Elevated';
  if (v >= 20) return 'Moderate';
  return 'Low';
}

module.exports = { breadth, labelFor, stressLabel, MIN_COINS };
