/* ============================================================
   INTEL — BTC → ETH → ALTCOIN TRANSMISSION ENGINE

   Determines who is DRIVING. "Everything is red" is not a diagnosis; "BTC broke first, ETH
   followed twenty minutes later, and the small caps are now falling twice as fast as BTC" is,
   and the two imply different trades. The first says panic; the second says the move has a
   source, a direction of travel, and a place where it will stop.

   TWO INDEPENDENT PIECES OF EVIDENCE, because either alone is easy to fool:

   1. LEAD–LAG CORRELATION. Correlate BTC's returns against the alt basket's returns shifted
      forward k bars. If the fit is best at k>0, BTC's move is arriving in alts later — BTC
      leads. Contemporaneous correlation (k=0) cannot distinguish leadership from a common cause;
      this can.

   2. SEQUENCING. Which group crossed its decline threshold first in wall-clock terms. This is
      what a trader actually watched happen, and it corroborates (or contradicts) the statistics.

   MARKET CAP IS NOT AVAILABLE. Tiers are cut by 24h TRADED VALUE, which is a decent proxy and is
   labelled as one everywhere it appears — never as market cap.
   ============================================================ */

const S = require('./stats');
const { basketReturns } = require('./correlation');

const MAX_LAG = 4;                   // 4 × 15m = an hour of transmission delay, generously wide
const DECLINE_TRIGGER = -0.01;       // 1% down from the window start counts as "this group moved"
const SEQ_BARS = 24;                 // look back 6h for the sequencing read
const ACCEL_BARS = 4;

/* Best lag of `lead` ahead of `follow`, by correlation. Positive lag = lead moves first. */
function leadLag(lead, follow, maxLag) {
  const L = maxLag || MAX_LAG;
  let best = { lag: 0, corr: S.pearson(lead, follow) };
  const base = best.corr;
  for (let k = 1; k <= L; k++) {
    const a = lead.slice(0, lead.length - k);
    const b = follow.slice(k);
    const v = S.pearson(a, b);
    if (S.isNum(v) && (!S.isNum(best.corr) || v > best.corr)) best = { lag: k, corr: v };
  }
  return { lag: best.lag, corr: best.corr, corr0: base, leads: best.lag > 0 && S.isNum(best.corr) && S.isNum(base) && best.corr - base >= 0.05 };
}

/* Cumulative return path over the last n bars, from the start of that window. */
function cumPath(close, n) {
  const c = (close || []).filter(v => S.isNum(v) && v > 0);
  if (c.length < 3) return null;
  const s = c.slice(Math.max(0, c.length - n));
  const base = s[0];
  return s.map(v => v / base - 1);
}

/* First index at which a cumulative path crossed the trigger. null = never crossed. */
function firstCross(path, trigger) {
  if (!path) return null;
  for (let i = 0; i < path.length; i++) if (path[i] <= trigger) return i;
  return null;
}

/* Volume-weighted cumulative path for a group of tickers. */
function groupPath(snap, tks, n) {
  const paths = tks.map(tk => ({ p: cumPath(snap.coins[tk].fine && snap.coins[tk].fine.close, n), w: +snap.coins[tk].qv || 0 }))
    .filter(x => x.p);
  if (!paths.length) return null;
  const len = Math.min(...paths.map(x => x.p.length));
  const out = [];
  for (let i = 0; i < len; i++) {
    out.push(S.weightedMean(paths.map(x => x.p[x.p.length - len + i]), paths.map(x => x.w)));
  }
  return out;
}

/* Tertiles by traded value — our stand-in for large / mid / small cap. */
function tiers(snap) {
  const alts = (snap.alts || []).slice().sort((a, b) => (+snap.coins[b].qv || 0) - (+snap.coins[a].qv || 0));
  const t = Math.max(1, Math.ceil(alts.length / 3));
  return { large: alts.slice(0, t), mid: alts.slice(t, 2 * t), small: alts.slice(2 * t) };
}

function transmission(snap, ctx) {
  if (!snap || !snap.coins || !snap.coins.BTC) return { ok: false, reason: 'BTC series unavailable — leadership here is measured relative to BTC' };
  const alts = snap.alts || [];
  if (alts.length < 5) return { ok: false, reason: `only ${alts.length} altcoins loaded — too few to read transmission` };

  const wk = '15m';
  const btcRet = (snap.coins.BTC.win[wk] || {}).ret;
  const ethRet = snap.coins.ETH ? (snap.coins.ETH.win[wk] || {}).ret : null;
  const altRet = basketReturns(snap, alts, wk);
  if (!btcRet || !altRet.length) return { ok: false, reason: 'insufficient 15m return samples for a lead–lag read' };

  const btcToAlt = leadLag(btcRet, altRet);
  const ethToAlt = ethRet ? leadLag(ethRet, altRet) : null;
  const btcToEth = ethRet ? leadLag(btcRet, ethRet) : null;

  // ---- sequencing ----
  const tg = tiers(snap);
  const paths = {
    BTC: cumPath(snap.coins.BTC.fine && snap.coins.BTC.fine.close, SEQ_BARS),
    ETH: snap.coins.ETH ? cumPath(snap.coins.ETH.fine && snap.coins.ETH.fine.close, SEQ_BARS) : null,
    large: groupPath(snap, tg.large, SEQ_BARS),
    mid: groupPath(snap, tg.mid, SEQ_BARS),
    small: groupPath(snap, tg.small, SEQ_BARS)
  };
  const crossed = {};
  const moves = {};
  for (const k of Object.keys(paths)) {
    crossed[k] = firstCross(paths[k], DECLINE_TRIGGER);
    moves[k] = paths[k] && paths[k].length ? paths[k][paths[k].length - 1] : null;
  }
  const order = Object.keys(crossed).filter(k => crossed[k] != null).sort((a, b) => crossed[a] - crossed[b]);

  // ---- acceleration: are alts pulling away from BTC in the most recent bars? ----
  const tail = (p, n) => (p && p.length > n) ? p[p.length - 1] - p[p.length - 1 - n] : null;
  const btcRecent = tail(paths.BTC, ACCEL_BARS);
  const altRecentPath = groupPath(snap, alts, SEQ_BARS);
  const altRecent = tail(altRecentPath, ACCEL_BARS);
  const altTotal = altRecentPath && altRecentPath.length ? altRecentPath[altRecentPath.length - 1] : null;
  const btcTotal = moves.BTC;
  /* MIN_BENCH matches stats.amplification's floor exactly.
     These two engines both publish an "alts are amplifying BTC by Nx" claim, and with different
     floors they disagreed in the smoke run: the narrative printed 2.7x while beta.js reported the
     ratio undefined, because BTC had moved only 0.3%. Two numbers for one fact is the bug class
     this codebase keeps paying for — one floor, one answer. */
  const MIN_BENCH = 0.005;
  const ratioRecent = (S.isNum(altRecent) && S.isNum(btcRecent) && Math.abs(btcRecent) >= MIN_BENCH) ? altRecent / btcRecent : null;
  const ratioTotal = (S.isNum(altTotal) && S.isNum(btcTotal) && Math.abs(btcTotal) >= MIN_BENCH) ? altTotal / btcTotal : null;
  const accelerating = S.isNum(ratioRecent) && S.isNum(ratioTotal) && btcTotal < 0 && ratioRecent > ratioTotal * 1.2 && ratioRecent > 1;

  // ---- direction of the whole complex ----
  const falling = S.isNum(btcTotal) && btcTotal < -0.005;
  const rising = S.isNum(btcTotal) && btcTotal > 0.005;

  /* ---- STABILISING? ----
     The reverse sequence: BTC stops falling first, then ETH, then alts. Detected as "the last
     ACCEL_BARS are materially less negative than the window as a whole". This is a transmission
     observation only — whether it becomes a recovery is recovery.js's call, and it needs OI and
     volume evidence this engine does not look at. */
  const stabilising = S.isNum(btcRecent) && S.isNum(btcTotal) && btcTotal < -0.01 && btcRecent > -0.002;

  let leader = 'unclear', leaderWhy = '';
  if (btcToAlt.leads && (!ethToAlt || btcToAlt.lag >= ethToAlt.lag)) {
    leader = 'BTC'; leaderWhy = `alt returns track BTC's best when shifted ${btcToAlt.lag} bar(s) later`;
  } else if (ethToAlt && ethToAlt.leads) {
    leader = 'ETH'; leaderWhy = `alt returns track ETH's best when shifted ${ethToAlt.lag} bar(s) later`;
  } else if (order.length && order[0] !== 'BTC' && order[0] !== 'ETH') {
    leader = 'alts'; leaderWhy = `${order[0]}-cap alts crossed their decline threshold before BTC did`;
  } else if (order.length && order[0] === 'BTC') {
    leader = 'BTC'; leaderWhy = 'BTC crossed its decline threshold before the rest of the complex';
  } else if (order.length && order[0] === 'ETH') {
    leader = 'ETH'; leaderWhy = 'ETH crossed its decline threshold before BTC or the alt tiers';
  }

  return {
    ok: true,
    leader, leaderWhy,
    falling, rising, stabilising, accelerating,
    leadLag: { btcToAlt, ethToAlt, btcToEth },
    sequence: order,
    crossedAtBar: crossed,
    moves,
    tiers: { large: tg.large.length, mid: tg.mid.length, small: tg.small.length },
    tierMoves: { large: moves.large, mid: moves.mid, small: moves.small },
    altVsBtcRatio: ratioTotal,
    altVsBtcRatioRecent: ratioRecent,
    windowBars: SEQ_BARS,
    narrative: narrate({ leader, falling, rising, stabilising, accelerating, moves, ratioTotal, order }),
    inputs: ['15mReturnSeries', 'tradedValueTiers', 'laggedCorrelation'],
    caveat: 'Tiers are cut by 24h traded value; true market capitalisation is not available to this platform.'
  };
}

function pctTxt(v) { return S.isNum(v) ? (v * 100).toFixed(1) + '%' : '—'; }

function narrate(f) {
  const parts = [];
  if (f.stabilising) {
    parts.push('BTC has stopped making new lows over the last hour while the wider complex is still repairing.');
    parts.push('That is the shape a deleveraging flush takes as it ends — but it is a shape, not a confirmation.');
    return parts.join(' ');
  }
  if (!f.falling && !f.rising) return 'No dominant leadership right now — BTC is close to flat and the complex is drifting rather than transmitting.';

  const dir = f.falling ? 'risk-off' : 'risk-on';
  if (f.leader === 'BTC') parts.push(`BTC-led ${dir} detected. BTC is moving first and the move is propagating into ETH and the high-beta alts.`);
  else if (f.leader === 'ETH') parts.push(`ETH-led ${dir}. ETH is moving ahead of BTC and dragging the alt complex with it.`);
  else if (f.leader === 'alts') parts.push(`Alt-led ${dir}. The move started in the alt tiers rather than in BTC — this is positioning unwinding, not a macro impulse.`);
  else parts.push(`Broad ${dir} with no clean leader — everything is moving at once, which usually means an external catalyst rather than internal rotation.`);

  if (S.isNum(f.moves.BTC)) parts.push(`BTC ${pctTxt(f.moves.BTC)} over the window.`);
  if (S.isNum(f.moves.small) && S.isNum(f.moves.large)) {
    parts.push(`By traded-value tier: large ${pctTxt(f.moves.large)}, mid ${pctTxt(f.moves.mid)}, small ${pctTxt(f.moves.small)}.`);
  }
  if (f.accelerating) parts.push('Altcoin downside is currently ACCELERATING relative to BTC — the tail of the market is being sold harder than the head.');
  /* The "alts are amplifying BTC by Nx" sentence deliberately lives in beta.js and nowhere else.
     This engine measures its ratio over a 6h window and beta measures over 4h, so both asserting
     it in prose put two different multiples in front of the trader for one fact. The ratio is
     still published in this engine's data (window-labelled) for anyone who wants it. */
  return parts.join(' ');
}

module.exports = { transmission, leadLag, cumPath, firstCross, tiers, MAX_LAG, DECLINE_TRIGGER };
