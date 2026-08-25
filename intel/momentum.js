/* ============================================================
   INTEL — EXCHANGE-WIDE MOMENTUM DETECTOR

   ============================================================
   WHY THIS EXISTS: THE PLATFORM WAS BLIND TO VERTICAL MOVES
   ============================================================
   The scanner classifies every setup by regime. `buildSetup` sets `scalp = adx < 26`, and a coin
   going vertical has a HIGH ADX by definition — so it lands in `breakout`/`trend`, and every fast
   surface then filters exactly those out:

       index.html   quick   = results.filter(regime === 'range' || 'correction')
       server.js    trackSetups / alertEligible   — same test
       paper.js     isScalp                        — same test

   The result: a coin doing +45% in an hour could not appear in ⚡ Quick Trades, could not be
   tracked, and could never fire a Telegram alert. Only 🔥 Volume Movers showed it, and Movers has
   no alerting. That is not a bug — it is a mean-reversion platform working as designed — but it
   is the opposite of what someone watching a 5-minute vertical needs.

   Three further things made the candle path structurally too slow for this:
     • `processAsset` drops the forming bar, so a 5m signal is up to 5 minutes stale, 15m up to 15.
     • the scan is cached 40s and the panel polls 45s — another ~85s on top.
     • the universe is the top 120 by traded value, so a coin only enters it AFTER it has moved.

   ============================================================
   THE FIX: READ THE TICKER, NOT THE CANDLES
   ============================================================
   `cdxGetTicker()` returns EVERY market on the exchange in ONE request, and the server already
   calls it every ~3 seconds to price the live quotes. Recording those snapshots gives:

     • sub-minute resolution        — no candle interval to wait for
     • no forming-bar problem       — the last trade IS the data
     • the whole exchange           — not the top 120 by yesterday's volume
     • no extra API cost            — it is the request the server already makes

   Volume comes from differencing the ticker's rolling 24h volume between snapshots. Over ten
   seconds the amount ageing out of the back of a 24h window is negligible next to a genuine
   spike, so the delta is a good surge proxy — but it IS a proxy, and negative deltas (the window
   rolling) are discarded rather than treated as data.

   ============================================================
   THIS MUST NOT BECOME A CHASE BUTTON
   ============================================================
   Catching a move at +2% and catching it at +45% are opposite trades, and a detector that simply
   shouts when something is green would reliably deliver the second one. Every result therefore
   carries a STAGE and an explicit LATENESS: how much of the move already happened before we saw
   it. An extended vertical is reported as extended, with the plain statement that this is where
   leveraged entries get liquidated — not as an opportunity.
   ============================================================ */

const S = require('./stats');

const KEEP_MS = 20 * 60 * 1000;      // 20 minutes of ticker history
const MIN_GAP_MS = 8 * 1000;         // downsample: at most one snapshot per 8s
const MAX_SNAPS = 200;

/* Windows we report, in minutes. */
const W1 = 1, W5 = 5, W15 = 15;

const MIN_ABS_MOVE = 0.012;          // 1.2% over 5m — below this it is not a "vertical"
const MIN_Z = 2.5;                   // …and it must also be large FOR THIS COIN
const EXTENDED_MOVE = 0.10;          // a 10%+ run is materially extended
const STALL_FRAC = 0.15;             // last minute contributing under this share = losing steam
const MIN_TYPICAL_5M = 0.0015;       // floor for 'normal 5m move' — below this we are measuring noise
const Z_DISPLAY_CAP = 20;            // a ratio beyond this says 'off the scale', not a precise multiple

module.exports = function createMomentum(opts) {
  const o = opts || {};
  const keepMs = o.keepMs || KEEP_MS;
  const minGap = o.minGapMs == null ? MIN_GAP_MS : o.minGapMs;
  /* snaps: [{ t, px:{market:price}, vol:{market:vol24}, meta:{market:{high,low,chg24}} }] */
  let snaps = [];
  let lastRecordAt = 0;
  let seen = 0;

  /* Called with the RAW CoinDCX ticker array. Cheap and synchronous — it must never slow down the
     quote path it is piggybacking on. */
  function record(rows, now) {
    const t = now || Date.now();
    if (!Array.isArray(rows) || !rows.length) return false;
    if (t - lastRecordAt < minGap) return false;          // downsample
    const px = {}, vol = {}, meta = {};
    for (const r of rows) {
      if (!r || !r.market) continue;
      const p = +r.last_price;
      if (!(p > 0)) continue;
      px[r.market] = p;
      const v = +r.volume; if (isFinite(v) && v >= 0) vol[r.market] = v;
      const hi = +r.high, lo = +r.low, ch = +r.change_24_hour;
      meta[r.market] = { high: isFinite(hi) ? hi : null, low: isFinite(lo) ? lo : null, chg24: isFinite(ch) ? ch : null };
    }
    if (!Object.keys(px).length) return false;
    snaps.push({ t, px, vol, meta });
    lastRecordAt = t; seen++;
    const cutoff = t - keepMs;
    while (snaps.length && snaps[0].t < cutoff) snaps.shift();
    if (snaps.length > MAX_SNAPS) snaps.splice(0, snaps.length - MAX_SNAPS);
    return true;
  }

  /* The snapshot closest to `mins` ago, provided one exists within a tolerance — otherwise null,
     so a young buffer reports "not enough history yet" instead of silently comparing against
     whatever happened to be oldest. */
  function at(minsAgo, now) {
    const target = (now || Date.now()) - minsAgo * 60000;
    let best = null, gap = Infinity;
    for (const s of snaps) {
      const g = Math.abs(s.t - target);
      if (g < gap) { gap = g; best = s; }
    }
    const tol = Math.max(20000, minsAgo * 60000 * 0.4);
    return (best && gap <= tol) ? best : null;
  }

  /* Typical move for this coin over `mins`, from the coin's OWN RECENT TICKS.
     A fixed percentage threshold is useless across a book where one coin ranges 2% a day and
     another 40% — the same 1.5% print is noise on one and an event on the other. So the move has
     to be normalised. The question is by what.

     NOT BY THE 24-HOUR RANGE, which was the first attempt and is quietly self-defeating: the 24h
     high/low INCLUDES the move being detected. A coin that has already run 45% today has a huge
     range, a huge denominator, and therefore needs an absurd further move to register — the
     detector goes blind exactly as a move develops, which is the opposite of useful. It also
     under-reacts to the second leg of a continuation, which is often the tradeable one.

     Instead: the MEDIAN absolute per-tick return over the buffer, scaled to the window. The median
     is robust — while a push occupies a minority of the buffer it reflects the coin's calm, which
     is the baseline the move should be judged against. The 24h range stays as a fallback for a
     buffer too short to have its own history. */
  function typicalFromBuffer(market, mins) {
    const rets = [];
    for (let i = 1; i < snaps.length; i++) {
      const a = snaps[i - 1].px[market], b = snaps[i].px[market];
      if (!(a > 0) || !(b > 0)) continue;
      const dt = (snaps[i].t - snaps[i - 1].t) / 60000;
      if (!(dt > 0)) continue;
      rets.push(Math.abs(b / a - 1) / Math.sqrt(dt));      // per-minute-equivalent move
    }
    if (rets.length < 8) return null;
    const med = S.median(rets);
    if (!S.isNum(med) || !(med > 0)) return null;
    /* FLOOR THE DENOMINATOR. A coin that barely printed between ticks — thin book, stale feed, or
       simply a quiet few minutes — gives a near-zero median, and dividing by it produced "56×
       its normal move", which is not a number anyone can act on. Real markets always carry some
       noise; below this floor the ratio is measuring rounding, not conviction. The absolute-move
       gate does the real filtering anyway, so the floor costs no sensitivity. */
    return Math.max(med * Math.sqrt(mins), MIN_TYPICAL_5M * Math.sqrt(mins / W5));
  }

  function typicalFromRange(m, mins) {
    if (!m || !(m.high > 0) || !(m.low > 0) || !(m.high > m.low)) return null;
    const mid = (m.high + m.low) / 2;
    if (!(mid > 0)) return null;
    const daily = (m.high - m.low) / mid;
    const scaled = daily * Math.sqrt(mins / (24 * 60));
    return scaled > 0 ? scaled : null;
  }

  function typicalMove(market, m, mins) {
    const fromBuf = typicalFromBuffer(market, mins);
    if (S.isNum(fromBuf)) return { value: fromBuf, basis: 'recent-ticks' };
    const fromRange = typicalFromRange(m, mins);
    return S.isNum(fromRange) ? { value: fromRange, basis: '24h-range' } : null;
  }

  function scan(ctx) {
    const c = ctx || {};
    const now = c.now || Date.now();
    if (snaps.length < 3) {
      return { ok: false, reason: `only ${snaps.length} ticker snapshot(s) buffered — momentum needs a few minutes of history after a restart`, movers: [], snapshots: snaps.length };
    }
    const latest = snaps[snaps.length - 1];
    const spanMin = (latest.t - snaps[0].t) / 60000;
    const ref1 = at(W1, now), ref5 = at(W5, now), ref15 = at(W15, now);
    if (!ref5) {
      return { ok: false, reason: `only ${spanMin.toFixed(1)} minutes of ticker history buffered — need ${W5} for a momentum read`, movers: [], snapshots: snaps.length, spanMin };
    }

    const quoteOf = c.quote || 'INR';
    const out = [];
    for (const market of Object.keys(latest.px)) {
      if (quoteOf && !market.endsWith(quoteOf)) continue;
      const base = market.slice(0, -quoteOf.length);
      if (!base || (c.isStable && c.isStable(base))) continue;

      const p = latest.px[market];
      const p5 = ref5.px[market];
      if (!(p > 0) || !(p5 > 0)) continue;
      const chg5 = p / p5 - 1;

      const p1 = ref1 ? ref1.px[market] : null;
      const chg1 = (p1 > 0) ? p / p1 - 1 : null;
      const p15 = ref15 ? ref15.px[market] : null;
      const chg15 = (p15 > 0) ? p / p15 - 1 : null;

      const m = latest.meta[market] || {};
      const typ = typicalMove(market, m, W5);
      const typ5 = typ ? typ.value : null;
      const z = (S.isNum(typ5) && typ5 > 0) ? chg5 / typ5 : null;

      /* Volume traded between the reference snapshot and now, from the 24h rolling total.
         Negative means the window rolled more than was traded — not usable, so it is dropped. */
      const v0 = ref5.vol[market], v1 = latest.vol[market];
      const volDelta = (S.isNum(v0) && S.isNum(v1) && v1 >= v0) ? v1 - v0 : null;
      const minutes = (latest.t - ref5.t) / 60000;
      const volPerMin = (S.isNum(volDelta) && minutes > 0) ? volDelta / minutes : null;
      const vol24 = S.isNum(v1) ? v1 : null;
      // Surge = this window's rate versus the coin's own average rate over 24h.
      const surge = (S.isNum(volPerMin) && S.isNum(vol24) && vol24 > 0) ? volPerMin / (vol24 / 1440) : null;

      const absMove = Math.abs(chg5);
      const thrust = absMove >= (c.minAbs || MIN_ABS_MOVE) && (!S.isNum(z) || Math.abs(z) >= (c.minZ || MIN_Z));
      if (!thrust) continue;

      const dir = chg5 > 0 ? 1 : -1;
      /* How much of the last five minutes' move landed in the last minute. High = still igniting;
         low = the push is already over and what is left is drift. */
      const lastMinShare = (S.isNum(chg1) && absMove > 0) ? Math.abs(chg1) / absMove : null;
      const run15 = S.isNum(chg15) ? Math.abs(chg15) : absMove;

      const stage = classify({ absMove, run15, lastMinShare, dir, chg1, chg5 });
      out.push({
        market, base, price: p,
        chg1m: chg1, chg5m: chg5, chg15m: chg15, chg24h: m.chg24,
        z: S.isNum(z) ? +S.clamp(z, -Z_DISPLAY_CAP, Z_DISPLAY_CAP).toFixed(1) : null,
        zCapped: S.isNum(z) && Math.abs(z) > Z_DISPLAY_CAP,
        typical5m: typ5, typicalBasis: typ ? typ.basis : null,
        surge: S.isNum(surge) ? +surge.toFixed(1) : null,
        volumeProxy: S.isNum(volDelta),
        dir, direction: dir > 0 ? 'up' : 'down',
        lastMinShare: S.isNum(lastMinShare) ? +lastMinShare.toFixed(2) : null,
        stage: stage.stage, stageLabel: stage.label, lateness: stage.lateness,
        warning: stage.warning,
        score: Math.round(Math.min(100, (S.isNum(z) ? Math.min(Math.abs(z), 8) / 8 : 0.5) * 60 + Math.min(absMove / 0.06, 1) * 40))
      });
    }

    out.sort((a, b) => b.score - a.score);
    const igniting = out.filter(x => x.stage === 'igniting');
    return {
      ok: true,
      ts: now, snapshots: snaps.length, spanMin: +spanMin.toFixed(1),
      windows: { fast: W1, main: W5, slow: W15 },
      thresholds: { minAbsMove: c.minAbs || MIN_ABS_MOVE, minZ: c.minZ || MIN_Z },
      movers: out.slice(0, c.limit || 25),
      count: out.length,
      igniting: igniting.length,
      note: 'Measured from live ticker snapshots, not candles — no forming-bar lag and no top-120 universe limit. Volume is inferred from 24h-volume deltas and is a proxy, not a trade feed.',
      caveat: 'A move already extended is reported as extended. Detection is not an entry signal — see each row\'s stage and lateness.'
    };
  }

  /* STAGE: the difference between useful and dangerous.
     `lateness` is the honest number — the share of the visible run that happened before this read.
     A 45% vertical spotted at +44% is a detection, not an opportunity, and it says so. */
  function classify(f) {
    const { absMove, run15, lastMinShare, dir } = f;
    const late = (run15 > 0) ? S.clamp(1 - absMove / run15, 0, 1) : 0;
    const extended = run15 >= EXTENDED_MOVE;
    const stalling = S.isNum(lastMinShare) && lastMinShare < STALL_FRAC;
    const word = dir > 0 ? 'rally' : 'drop';

    if (extended && stalling) {
      return { stage: 'stalling', label: 'Extended and losing momentum', lateness: late,
        warning: `Already ${(run15 * 100).toFixed(0)}% into this ${word} over 15m and the last minute has added almost nothing. Entering here means paying the full move and inheriting all of the reversal risk — this is where leveraged entries get liquidated.` };
    }
    if (extended) {
      return { stage: 'extended', label: 'Already extended', lateness: late,
        warning: `${(run15 * 100).toFixed(0)}% of this ${word} has already happened over 15m. Detection is not an entry: the reward left is what remains, the risk is the whole move.` };
    }
    if (stalling) {
      return { stage: 'stalling', label: 'Losing momentum', lateness: late,
        warning: `The push has faded — the last minute added under ${Math.round(STALL_FRAC * 100)}% of the 5-minute move.` };
    }
    if (S.isNum(lastMinShare) && lastMinShare >= 0.5) {
      return { stage: 'igniting', label: 'Igniting — move is happening now', lateness: late, warning: null };
    }
    return { stage: 'running', label: 'Running', lateness: late, warning: null };
  }

  return {
    record, scan, classify,
    stats: () => ({ snapshots: snaps.length, seen, spanMin: snaps.length > 1 ? +((snaps[snaps.length - 1].t - snaps[0].t) / 60000).toFixed(1) : 0, keepMs, minGap }),
    __snaps: () => snaps,
    __reset: () => { snaps = []; lastRecordAt = 0; seen = 0; }
  };
};

module.exports.MIN_ABS_MOVE = MIN_ABS_MOVE;
module.exports.MIN_Z = MIN_Z;
module.exports.EXTENDED_MOVE = EXTENDED_MOVE;
module.exports.STALL_FRAC = STALL_FRAC;
module.exports.MIN_TYPICAL_5M = MIN_TYPICAL_5M;
module.exports.Z_DISPLAY_CAP = Z_DISPLAY_CAP;
