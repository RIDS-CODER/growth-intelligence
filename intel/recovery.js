/* ============================================================
   INTEL — RECOVERY vs CONTINUATION

   After a violent market-wide drop there are exactly two questions worth answering: is the
   selling finished, or is this the first leg? Everything else — where to enter, whether to add,
   whether to cut — follows from that.

   The engine scores both cases from their own evidence lists and reports them as competing
   probabilities. It does NOT pick a side and defend it: a 55/45 split is a genuinely undecided
   market, and saying so is more useful than manufacturing a verdict.

   THESE ARE HEURISTIC WEIGHTS, NOT MEASURED BASE RATES. The probabilities express how much of
   each evidence list is currently satisfied — they are emphatically not "55% of the time this
   resolved upward", because this platform has no historical sample large enough to make that
   claim. The history store (history.js) exists to build that sample over time; until it has one,
   the honest label is `heuristic`, and it travels with the number to the screen.
   ============================================================ */

const S = require('./stats');
const { structure } = require('./structure');

const WINDOW = 24;                   // 6h at 15m
const RECENT = 4;

/* Did price bounce and then fail — a relief rally that made a new low afterwards?
   This is the classic continuation tell, and the reason "it already bounced once" is not
   evidence of a bottom. */
function failedRally(close, minBounce) {
  const c = (close || []).slice(-WINDOW).filter(v => S.isNum(v) && v > 0);
  if (c.length < 8) return null;
  const bounce = minBounce == null ? 0.015 : minBounce;
  let low = c[0], lowI = 0, sawRally = false, failed = false, hadRally = false;
  for (let i = 1; i < c.length; i++) {
    if (c[i] < low) {
      if (sawRally) failed = true;   // new low after a qualifying bounce
      low = c[i]; lowI = i; sawRally = false;
    } else if (c[i] / low - 1 >= bounce) { sawRally = true; hadRally = true; }
  }
  /* `hadRally` separates "bounced and held" from "never bounced at all".
     Without it, a straight-line decline scores as evidence FOR recovery — there were no failed
     rallies, because there were no rallies. That is the opposite of what the absence means, and
     it inflated the recovery probability during exactly the move it should have deflated it. */
  return { failed, hadRally, lastLowBarsAgo: c.length - 1 - lowI };
}

/* Volume that spiked and then drained — the flush finishing. */
function volumeContracting(vol, close) {
  if (!vol || !close || vol.length !== close.length || close.length < 20) return null;
  const qv = close.map((c, i) => (+vol[i] || 0) * c);
  const tail = qv.slice(-16);
  if (tail.length < 12) return null;
  const peak = Math.max(...tail);
  const peakIdx = tail.lastIndexOf(peak);
  const now = S.mean(tail.slice(-RECENT));
  if (!(peak > 0) || !S.isNum(now)) return null;
  return { contracting: peakIdx <= tail.length - RECENT - 1 && now < peak * 0.6, ratio: now / peak, barsSincePeak: tail.length - 1 - peakIdx };
}

/* Share of coins whose most recent bars are greener than their wider window — breadth turning,
   measured without needing a stored earlier snapshot. */
function breadthTurning(snap) {
  const tks = snap.tickers || [];
  let recentUp = 0, windowUp = 0, n = 0;
  for (const tk of tks) {
    const cl = snap.coins[tk].fine && snap.coins[tk].fine.close;
    const r1 = S.retOver(cl, RECENT), r2 = S.retOver(cl, WINDOW);
    if (!S.isNum(r1) || !S.isNum(r2)) continue;
    n++;
    if (r1 > 0) recentUp++;
    if (r2 > 0) windowUp++;
  }
  if (!n) return null;
  return { recentPct: recentUp / n * 100, windowPct: windowUp / n * 100, improving: recentUp / n > windowUp / n + 0.15, n };
}

function recoveryEngine(snap, ctx) {
  const c = ctx || {};
  const zigzag = c.zigzag || (() => []);
  if (!snap || !snap.coins || !snap.coins.BTC) return { ok: false, reason: 'BTC series unavailable' };

  const btc = snap.coins.BTC;
  const btcSt = structure(btc.h1 && btc.h1.close, zigzag);
  const ethSt = snap.coins.ETH ? structure(snap.coins.ETH.h1 && snap.coins.ETH.h1.close, zigzag) : null;

  const btcRet4h = S.retOver(btc.fine.close, 16);
  const btcRetRecent = S.retOver(btc.fine.close, RECENT);
  const fr = failedRally(btc.fine.close);
  const vc = volumeContracting(btc.fine.vol, btc.fine.close);
  const bt = breadthTurning(snap);

  const oi = c.oi && c.oi.available ? c.oi : null;
  const funding = c.funding && c.funding.available ? c.funding : null;

  /* Only meaningful after an actual selloff. Calling a flat tape "recovering" is noise. */
  const selloff = S.isNum(btcRet4h) && btcRet4h <= -0.015;

  const rec = [
    { k: 'btcHigherLow', w: 0.20, v: btcSt.ok ? (btcSt.lastLowTag === 'HL' ? 1 : btcSt.lastLowTag === 'LL' ? 0 : 0.5) : null },
    { k: 'btcStoppedFalling', w: 0.16, v: S.isNum(btcRetRecent) ? S.ramp(btcRetRecent, -0.01, 0.005) : null },
    { k: 'ethStabilising', w: 0.10, v: ethSt && ethSt.ok ? (ethSt.verdict === 'bearish' ? 0 : ethSt.verdict === 'bullish' ? 1 : 0.5) : null },
    { k: 'breadthImproving', w: 0.16, v: bt ? S.ramp(bt.recentPct - bt.windowPct, -5, 25) : null },
    { k: 'volumeContracting', w: 0.12, v: vc ? (vc.contracting ? 1 : S.ramp(1 - vc.ratio, 0, 0.5)) : null },
    { k: 'noFailedRally', w: 0.08, v: (fr && fr.hadRally) ? (fr.failed ? 0 : 1) : null },
    { k: 'openInterestFlushed', w: 0.10, v: oi ? S.ramp(-(oi.market.oiChange || 0), 0.002, 0.04) : null },
    { k: 'fundingNormalising', w: 0.08, v: funding ? (funding.reversal && funding.reversal.available ? (funding.reversal.normalising ? 1 : 0.2) : (funding.crowding === 'balanced' ? 0.8 : 0.3)) : null }
  ];

  const con = [
    { k: 'btcLowerLow', w: 0.20, v: btcSt.ok ? (btcSt.lastLowTag === 'LL' ? 1 : btcSt.lastLowTag === 'HL' ? 0 : 0.5) : null },
    { k: 'btcStillFalling', w: 0.16, v: S.isNum(btcRetRecent) ? S.ramp(-btcRetRecent, -0.005, 0.01) : null },
    { k: 'ethWeak', w: 0.10, v: ethSt && ethSt.ok ? (ethSt.verdict === 'bearish' ? 1 : ethSt.verdict === 'bullish' ? 0 : 0.5) : null },
    { k: 'breadthStillWeak', w: 0.16, v: bt ? S.ramp(bt.windowPct - bt.recentPct, -5, 25) : null },
    { k: 'volumeStillElevated', w: 0.12, v: vc ? (vc.contracting ? 0 : S.ramp(vc.ratio, 0.5, 1)) : null },
    { k: 'failedRelief', w: 0.08, v: (fr && fr.hadRally) ? (fr.failed ? 1 : 0) : null },
    { k: 'openInterestElevated', w: 0.10, v: oi ? S.ramp(oi.market.oiChange || 0, -0.02, 0.02) : null },
    { k: 'fundingStillCrowded', w: 0.08, v: funding ? (funding.extreme ? 1 : funding.crowding === 'balanced' ? 0.1 : 0.6) : null }
  ];

  const rs = S.scoreParts(rec), cs = S.scoreParts(con);
  if (!rs || !cs) return { ok: false, reason: 'not enough evidence available to weigh recovery against continuation' };

  const total = rs.score + cs.score;
  const recoveryProb = total > 0 ? Math.round(rs.score / total * 100) : 50;
  const continuationRisk = 100 - recoveryProb;

  /* WHAT WOULD CONFIRM IT. The brief asks for levels, not adjectives — this is the sentence a
     trader can actually act on, quoted from the coin's own structure. */
  const reclaim = btcSt.ok && btcSt.lastHigh ? btcSt.lastHigh : null;
  const breakdown = btcSt.ok && btcSt.lastLow ? btcSt.lastLow : null;

  return {
    ok: true,
    selloff,
    recoveryProb, continuationRisk,
    basis: 'heuristic',
    basisNote: 'These weigh how much of each evidence list is currently satisfied. They are NOT measured historical base rates — this platform has no sample large enough to claim one.',
    confidenceCoverage: Math.min(rs.coverage, cs.coverage),
    recoveryEvidence: rs.used, recoveryMissing: rs.missing,
    continuationEvidence: cs.used, continuationMissing: cs.missing,
    signals: {
      btcStructure: btcSt.ok ? btcSt.verdict : null,
      btcLastLowTag: btcSt.ok ? btcSt.lastLowTag : null,
      btcRet4h, btcRetRecent,
      failedRally: fr, volume: vc, breadth: bt,
      oiChange: oi ? oi.market.oiChange : null,
      fundingNormalising: funding && funding.reversal && funding.reversal.available ? funding.reversal.normalising : null
    },
    levels: {
      confirmRecoveryAbove: reclaim,
      invalidateBelow: breakdown,
      text: reclaim
        ? `Recovery thesis strengthens if BTC reclaims ${fmt(reclaim)} and then holds a higher low above it.`
        : 'No clean reclaim level on BTC yet — structure has not printed a pivot to trade against.'
    },
    verdict: recoveryProb >= 65 ? 'flush-recovery-likely'
      : continuationRisk >= 65 ? 'continuation-likely'
        : 'undecided',
    inputs: ['btcStructure', 'breadth', 'volume', 'priceSeries'].concat(oi ? ['openInterest'] : []).concat(funding ? ['funding'] : [])
  };
}

function fmt(v) {
  if (!S.isNum(v)) return '—';
  return v >= 1000 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(4);
}

module.exports = { recoveryEngine, failedRally, volumeContracting, breadthTurning };
