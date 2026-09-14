/* ============================================================
   F&O — OPTION CHAIN ANALYTICS

   Turns a wall of quotes into the handful of numbers a decision actually rests on: what the
   market thinks the index will be worth at expiry (the forward), how much it expects it to move
   (the straddle), what it is charging extra for (the skew), and which strikes can actually be
   traded without the spread eating the idea.

   THE FORWARD COMES FROM THE CHAIN, NOT FROM THE SPOT PRICE.
   Put-call parity is a no-arbitrage identity — it holds whatever the volatility surface looks
   like and whatever the dividends are — so F = K + e^(rT)(C − P) reads the market's own forward
   straight off the quotes. Taking it from the spot index instead would require guessing the
   dividend yield of fifty companies over the contract's life, and being wrong about that bends
   every implied vol and every delta on the board. The forward is taken as the MEDIAN across the
   near-the-money strikes rather than from one pair, because one stale leg on one strike would
   otherwise move the whole surface.

   IMPLIED VOL IS BUILT FROM OUT-OF-THE-MONEY OPTIONS ONLY.
   For any strike, the call and the put must imply the same volatility — parity forces it. So
   using both is not extra information, it is the same information twice, and the in-the-money
   one is the half that is illiquid, wide and frequently stale. Calls are used above the forward,
   puts below. Where the two disagree at the same strike that disagreement is not averaged away,
   it is REPORTED, because it is the cleanest available measure of how trustworthy the feed is.

   WHAT THIS FILE IS CAREFUL NOT TO OVERSELL.
   Max pain and the put-call ratio are computed because they are watched by enough people to
   matter, not because the evidence that they predict anything is strong. Both are labelled
   descriptive. The skew is different — it is a price, not a folk indicator, and it says
   concretely what the market is paying up for.
   ============================================================ */

'use strict';

const BS = require('./bs');

const isNum = v => typeof v === 'number' && isFinite(v);

const median = arr => {
  const v = arr.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

/* ---- what one quote is worth ----
   The mid of a live two-sided quote is the fair value; a last-traded price is a historical fact
   that may be an hour old. Which one was used is carried through every downstream number so a
   chain priced entirely off stale LTPs cannot masquerade as a live one.

   A zero bid is not a price. Far-out strikes routinely show 0.00 / 0.05, and treating that as a
   0.025 mid would feed a fictional premium into the vol surface. */
function quoteValue(q) {
  if (!q) return null;
  const bid = isNum(q.bid) ? q.bid : null;
  const ask = isNum(q.ask) ? q.ask : null;
  const ltp = isNum(q.ltp) && q.ltp > 0 ? q.ltp : null;

  /* A LIVE MARKET OVERRULES A LAST-TRADED PRICE, ALWAYS — including a one-sided one.
     The tempting ordering is to prefer any LTP over a book with an empty bid, and it is wrong in
     the exact case that matters: a wing strike quoted 0.00 / 0.05 whose last print was 0.30 two
     hours ago. The LTP is a historical fact that the current market has already contradicted —
     nobody will pay 0.30 for something offered at 0.05. Preferring it would put a six-fold
     phantom premium into the vol surface on precisely the strikes where vega is smallest, which
     is how a fabricated wing becomes a fabricated skew. */
  if (bid !== null && ask !== null && ask >= bid) {
    if (bid > 0) return { px: (bid + ask) / 2, src: 'mid', bid, ask, spread: ask - bid, spreadPct: (ask - bid) / ((ask + bid) / 2) };
    if (ask > 0) return { px: ask / 2, src: 'no-bid', bid, ask, spread: ask, spreadPct: 2 };
  }
  if (ltp !== null) {
    // Half a book still bounds the price, even when it cannot produce a mid.
    let px = ltp;
    if (ask !== null && ask > 0 && px > ask) px = ask;
    if (bid !== null && bid > 0 && px < bid) px = bid;
    return {
      px, src: 'ltp', bid, ask,
      spread: (bid !== null && ask !== null && ask >= bid) ? ask - bid : null,
      spreadPct: null, clamped: px !== ltp
    };
  }
  return null;
}

/* ============================================================
   THE FORWARD
   ============================================================ */

function impliedForward(rows, T, r, hint) {
  /* Two passes. The first is a rough median over every strike that has both legs, which needs no
     external input at all — the chain bootstraps its own at-the-money. The second narrows to the
     band around that estimate, where both legs are liquid and parity is reliable, and takes the
     median again. Far-out strikes are excluded from the refined pass precisely because the wide
     spreads that make them unreliable also make them the ones most likely to skew a mean. */
  const cands = [];
  for (const row of rows) {
    const c = row.CE && row.CE.q, p = row.PE && row.PE.q;
    if (!c || !p) continue;
    if (c.src === 'no-bid' || p.src === 'no-bid') continue;
    const F = BS.impliedForward(c.px, p.px, row.strike, T, r);
    if (isNum(F) && F > 0) cands.push({ strike: row.strike, F, src: c.src === 'mid' && p.src === 'mid' ? 'mid' : 'ltp' });
  }
  if (!cands.length) return { ok: false, reason: 'no strike has both a call and a put quote — the forward cannot be derived from parity' };

  const rough = isNum(hint) && hint > 0 ? hint : median(cands.map(c => c.F));
  const band = rough * 0.03;
  let near = cands.filter(c => Math.abs(c.strike - rough) <= band);
  if (near.length < 3) near = cands.slice().sort((a, b) => Math.abs(a.strike - rough) - Math.abs(b.strike - rough)).slice(0, 5);

  const vals = near.map(c => c.F).sort((a, b) => a - b);
  const F = median(vals);
  const iqr = (quantile(vals, 0.75) - quantile(vals, 0.25));

  /* DISPERSION IS THE DATA-QUALITY SIGNAL. On a live chain every near-the-money strike agrees on
     the forward to within a point or two, because any wider gap would be an arbitrage. A spread
     of tens of points means legs are not trading together — a feed problem, a halt, or the
     minutes right after the open. The number is still returned; the caller is told how much to
     trust it. */
  const dispersionPct = F > 0 ? iqr / F : null;
  const allMid = near.every(c => c.src === 'mid');

  return {
    ok: true, forward: F,
    strikesUsed: near.length, candidates: cands.length,
    dispersion: iqr, dispersionPct,
    pricedOnMid: allMid,
    quality: dispersionPct == null ? 'unknown'
      : dispersionPct < 0.0005 ? 'tight'
        : dispersionPct < 0.002 ? 'loose'
          : 'suspect',
    note: dispersionPct != null && dispersionPct >= 0.002
      ? 'near-the-money strikes disagree about the forward by more than 0.2% — legs are not trading together, so treat every implied vol on this chain as provisional'
      : (allMid ? null : 'some strikes were priced off last-traded prices rather than live quotes')
  };
}

/* ============================================================
   THE MAIN ENTRY POINT
   ============================================================ */

function analyse(input) {
  const o = input || {};
  const chainDef = o.chain;
  const quotes = o.quotes || {};
  const r = isNum(o.r) ? o.r : 0.065;
  const nowMs = isNum(o.now) ? o.now : Date.now();

  if (!chainDef || !Array.isArray(chainDef.strikes) || !chainDef.strikes.length) {
    return { ok: false, reason: 'no chain definition supplied' };
  }
  const T = BS.yearsToExpiry(nowMs, chainDef.expiry);
  if (!isNum(T) || T < BS.MIN_T) {
    return { ok: false, reason: 'this expiry has passed or is inside its final minute — nothing on it can be priced' };
  }
  const lotSize = chainDef.lotSize;
  if (!isNum(lotSize) || lotSize <= 0) {
    return { ok: false, reason: 'no lot size on this expiry — position sizing would be meaningless, so nothing is reported' };
  }

  /* ---- assemble the rows ---- */
  const rows = [];
  let quoted = 0, onMid = 0, onLtp = 0;
  for (const k of chainDef.strikes) {
    const def = chainDef.byStrike[k] || chainDef.byStrike[String(k)];
    if (!def) continue;
    const row = { strike: Number(k), CE: null, PE: null };
    for (const side of ['CE', 'PE']) {
      const leg = def[side];
      if (!leg) continue;
      const q = quoteValue(quotes[leg.key]);
      const raw = quotes[leg.key] || {};
      row[side] = {
        key: leg.key, tradingSymbol: leg.tradingSymbol, q,
        oi: isNum(raw.oi) ? raw.oi : null,
        oiChange: isNum(raw.oiChange) ? raw.oiChange : null,
        volume: isNum(raw.volume) ? raw.volume : null
      };
      if (q) { quoted++; if (q.src === 'mid') onMid++; else onLtp++; }
    }
    if (row.CE || row.PE) rows.push(row);
  }
  if (!quoted) return { ok: false, reason: 'no strike on this expiry returned a usable quote' };

  /* ---- the forward ---- */
  const fwd = impliedForward(rows, T, r, o.spotHint);
  if (!fwd.ok) return { ok: false, reason: fwd.reason, quotedLegs: quoted };
  const F = fwd.forward;

  /* ---- at the money ---- */
  let atmStrike = null, bestD = Infinity;
  for (const row of rows) {
    const d = Math.abs(row.strike - F);
    if (d < bestD) { bestD = d; atmStrike = row.strike; }
  }

  /* ============================================================
     THE VOLATILITY SURFACE — out-of-the-money side only

     Above the forward a call is out of the money, below it a put is. Those are the liquid,
     tight, actively-traded halves of the chain; their in-the-money mirrors carry the same
     information by parity but arrive through much worse quotes. Using the OTM side is standard
     practice and it is also the honest one here, because it stops a stale deep-ITM print from
     manufacturing a vol spike on the wing.
     ============================================================ */
  const surface = [];
  const parityDisagreement = [];

  for (const row of rows) {
    const otmSide = row.strike >= F ? 'CE' : 'PE';
    const itmSide = otmSide === 'CE' ? 'PE' : 'CE';
    const entry = { strike: row.strike, moneyness: row.strike / F - 1, otmSide };

    for (const side of ['CE', 'PE']) {
      const leg = row[side];
      if (!leg || !leg.q) continue;
      const sol = BS.impliedVol({ type: side, price: leg.q.px, F, K: row.strike, T, r });
      leg.iv = sol.ok ? sol.iv : null;
      leg.ivQuality = sol.ok ? sol.quality : null;
      leg.ivReason = sol.ok ? null : sol.reason;
      leg.ivPerTick = sol.ok ? sol.ivPerTick : null;
      if (sol.ok) {
        const v = BS.black76({ type: side, F, K: row.strike, T, sigma: sol.iv, r });
        leg.delta = v.delta; leg.gamma = v.gamma; leg.vega = v.vega;
        leg.theta = v.theta; leg.thetaDay = v.thetaDay; leg.decay1d = v.decay1d;
        leg.probItm = v.probItm; leg.intrinsic = v.intrinsic; leg.extrinsic = v.extrinsic;
      }
    }

    /* PARITY SAYS THESE MUST MATCH. A call and a put on the same strike and the same forward
       imply the same volatility, necessarily. Where they do not, one of the two quotes is stale
       — and that gap is the most direct read available on feed health, so it is measured rather
       than averaged into silence. */
    const cIv = row.CE && row.CE.iv, pIv = row.PE && row.PE.iv;
    if (isNum(cIv) && isNum(pIv) && Math.abs(row.strike - F) < F * 0.02) {
      parityDisagreement.push(Math.abs(cIv - pIv));
    }

    /* A NO-BID STRIKE CONTRIBUTES NOTHING TO THE SURFACE. Its "price" is half an offer against
       an empty bid — a number the market has never agreed to, invented by the midpoint formula.
       It is excluded from the forward above for the same reason, and excluding it there while
       admitting it here would have let the fictional premium back in through the vol curve,
       which is where it does the damage: a fabricated wing quote becomes a fabricated skew. */
    const otm = row[otmSide];
    if (otm && otm.q && otm.q.src !== 'no-bid' && isNum(otm.iv) && otm.ivQuality !== 'unusable') {
      entry.iv = otm.iv;
      entry.delta = otm.delta;
      entry.source = otmSide;
      entry.quality = otm.ivQuality;
      surface.push(entry);
    }
    row.itmSide = itmSide;
  }

  surface.sort((a, b) => a.strike - b.strike);

  /* ---- at-the-money volatility ----
     Interpolated at the forward rather than read off the nearest strike, because with a 50-point
     strike step the nearest strike can sit 25 points away and the smile is steep enough there
     for that to matter. */
  const atmIv = interpAt(surface, F);

  /* ---- expected move ---- */
  const atmRow = rows.find(x => x.strike === atmStrike);
  const ceQ = atmRow && atmRow.CE && atmRow.CE.q;
  const peQ = atmRow && atmRow.PE && atmRow.PE.q;
  const straddle = ceQ && peQ ? ceQ.px + peQ.px : null;
  const expected = straddle != null
    ? { ...BS.expectedMoveFromStraddle(straddle, F), straddle, atmStrike, basis: 'ATM straddle' }
    : (isNum(atmIv) ? { ...BS.expectedMove(F, T, atmIv), basis: 'interpolated ATM implied vol' } : null);

  /* ============================================================
     SKEW — what the market is paying extra for

     The 25-delta risk reversal: the implied vol of the put that has a 25% chance of finishing in
     the money, minus that of the equivalent call. Positive means downside protection costs more
     than upside participation, which is the normal state for an equity index and becomes extreme
     before and during stress.

     This one is a PRICE, not a sentiment gauge. It says what protection costs today against what
     it has cost, and it is the number that decides whether a directional view is better expressed
     by buying an option or by selling the other one.
     ============================================================ */
  const put25 = findByDelta(surface, -0.25);
  const call25 = findByDelta(surface, 0.25);
  const skew = (put25 && call25) ? (() => {
    const rr25 = put25.iv - call25.iv;

    /* THE RAW RISK REVERSAL IS NOT COMPARABLE ACROSS EXPIRIES, and thresholding it directly is a
       bug waiting to happen. The 25-delta strikes sit at roughly ±0.674·σ√T in log-moneyness, so
       the band they span runs from 0.46% out on a one-day option to 4.58% on a quarterly — a
       tenfold range. A fixed cutoff of "2 vol points is steep" would therefore be unreachable on
       a weekly during an actual panic and would trigger on a quarterly in a dead market.

       Dividing by atmIv·√T strips the expiry out and recovers the underlying SMILE SLOPE, which
       is the expiry-invariant quantity and the one worth thresholding. */
    const slope = isNum(atmIv) && atmIv > 0 && T > 0 ? rr25 / (atmIv * Math.sqrt(T)) : null;
    return {
      rr25, slope,
      put25: { strike: put25.strike, iv: put25.iv },
      call25: { strike: call25.strike, iv: call25.iv },
      // Smile curvature: how much more both wings cost than the middle.
      butterfly25: isNum(atmIv) ? (put25.iv + call25.iv) / 2 - atmIv : null,
      reading: !isNum(slope) ? 'skew measured, but not comparable without an at-the-money vol'
        : slope > 0.8 ? 'downside protection is markedly more expensive than upside — the market is paying up for puts'
          : slope < -0.1 ? 'calls are bid over puts, which is unusual for an index and typically marks a chase'
            : 'skew is close to its normal mild put bias',
      note: 'slope is the risk reversal normalised by atmIv·√T, so weeklies and monthlies can be compared on one scale'
    };
  })() : null;

  /* ============================================================
     POSITIONING — open interest, and two indicators worth their caveats
     ============================================================ */
  let ceOi = 0, peOi = 0, ceVol = 0, peVol = 0, oiRows = 0;
  for (const row of rows) {
    if (row.CE && isNum(row.CE.oi)) { ceOi += row.CE.oi; oiRows++; }
    if (row.PE && isNum(row.PE.oi)) { peOi += row.PE.oi; oiRows++; }
    if (row.CE && isNum(row.CE.volume)) ceVol += row.CE.volume;
    if (row.PE && isNum(row.PE.volume)) peVol += row.PE.volume;
  }
  const haveOi = oiRows > 0 && (ceOi > 0 || peOi > 0);

  const pcr = haveOi && ceOi > 0 ? {
    oi: peOi / ceOi,
    volume: ceVol > 0 ? peVol / ceVol : null,
    /* DESCRIPTIVE, NOT PREDICTIVE. The put-call ratio is watched widely enough to move prices
       when it is extreme, which is the only honest argument for computing it. Its standalone
       forecasting record is poor, and it is meaningless without a history to compare against —
       a reading of 1.1 says nothing until you know whether this chain usually runs at 0.7 or
       1.4. It is reported raw and unspun. */
    caveat: 'a raw ratio with no historical context. Watched widely; weak on its own.'
  } : null;

  const walls = haveOi ? oiWalls(rows, F) : null;
  const pain = haveOi ? maxPain(rows, lotSize) : null;

  /* ============================================================
     LIQUIDITY — which of these can actually be traded

     The single most useful column on an option chain and the one retail screens leave out. A
     strike with a 12% spread is not cheap, it is untradeable: the round trip starts a quarter of
     the way to the target before anything has moved.
     ============================================================ */
  const liquidity = [];
  for (const row of rows) {
    for (const side of ['CE', 'PE']) {
      const leg = row[side];
      if (!leg || !leg.q) continue;
      const sp = leg.q.spreadPct;
      leg.tradeable = sp == null ? null : sp <= 0.05;
      leg.liquidityNote = sp == null ? 'no live two-sided quote — spread unknown'
        : sp > 0.15 ? 'spread is wider than 15% of the price; the round trip alone is a large loss'
          : sp > 0.05 ? 'wide spread — expect meaningful slippage in and out'
            : null;
      if (isNum(sp)) liquidity.push({ strike: row.strike, side, spreadPct: sp, oi: leg.oi, volume: leg.volume });
    }
  }
  const medSpread = median(liquidity.map(l => l.spreadPct));

  /* ---- data quality, gathered in one place ---- */
  const ivGap = median(parityDisagreement);
  const quality = {
    quotedLegs: quoted,
    onMid, onLtp,
    midShare: quoted > 0 ? onMid / quoted : 0,
    forward: fwd.quality,
    forwardDispersionPct: fwd.dispersionPct,
    /* The call-put implied vol gap near the money. Under parity this is zero; anything above a
       point or so means one side is not keeping up. */
    parityIvGap: ivGap,
    parityIvGapNote: isNum(ivGap) && ivGap > 0.01
      ? `calls and puts near the money disagree on implied vol by ${(ivGap * 100).toFixed(1)} points. Under put-call parity they must agree, so one side of the feed is stale.`
      : null,
    haveOpenInterest: haveOi,
    medianSpreadPct: medSpread,
    usable: fwd.quality !== 'suspect' && quoted >= 6,
    warnings: []
  };
  if (!haveOi) quality.warnings.push('no open interest in the quote feed — max pain, the put-call ratio and the OI walls are unavailable');
  if (quality.midShare < 0.5) quality.warnings.push('more than half these strikes were priced off last-traded prices rather than live bid/ask; spreads and slippage are guesses on those rows');
  if (fwd.note) quality.warnings.push(fwd.note);
  if (quality.parityIvGapNote) quality.warnings.push(quality.parityIvGapNote);

  return {
    ok: true,
    underlying: chainDef.underlying, name: chainDef.name, exchange: chainDef.exchange,
    expiry: chainDef.expiry, expiryDate: new Date(chainDef.expiry).toISOString().slice(0, 10),
    T, daysLeft: T * 365, lotSize, r,
    forward: F, forwardDetail: fwd,
    atmStrike, atmIv,
    strikeStep: chainDef.strikeStep,
    expectedMove: expected,
    skew, pcr, maxPain: pain, oiWalls: walls,
    surface, rows,
    quality
  };
}

/* Linear interpolation of the vol surface at an arbitrary level. Falls back to the nearest
   point outside the quoted range rather than extrapolating a smile, because extrapolated wings
   are where vol models produce their most confident nonsense. */
function interpAt(surface, level) {
  if (!surface.length || !isNum(level)) return null;
  if (level <= surface[0].strike) return surface[0].iv;
  if (level >= surface[surface.length - 1].strike) return surface[surface.length - 1].iv;
  for (let i = 1; i < surface.length; i++) {
    const a = surface[i - 1], b = surface[i];
    if (level <= b.strike) {
      const w = (level - a.strike) / (b.strike - a.strike);
      return a.iv + w * (b.iv - a.iv);
    }
  }
  return null;
}

/* The strike whose delta is closest to the target, interpolated between the two that straddle
   it. Returns null rather than the nearest available when the chain does not reach that delta —
   a 25-delta reading taken from a 40-delta strike is not a 25-delta reading. */
function findByDelta(surface, target) {
  const pts = surface.filter(s => isNum(s.delta) && isNum(s.iv));
  if (pts.length < 2) return null;
  const want = Math.abs(target);
  const side = target < 0 ? pts.filter(p => p.delta < 0) : pts.filter(p => p.delta > 0);
  if (side.length < 2) return null;
  const sorted = side.slice().sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
  let lo = null, hi = null;
  for (const p of sorted) {
    if (Math.abs(p.delta) <= want) lo = p;
    if (Math.abs(p.delta) >= want && !hi) hi = p;
  }
  if (!lo || !hi) return null;
  if (lo === hi) return { strike: lo.strike, iv: lo.iv, delta: lo.delta, exact: true };
  const dl = Math.abs(lo.delta), dh = Math.abs(hi.delta);
  if (dh === dl) return { strike: lo.strike, iv: lo.iv, delta: lo.delta, exact: true };
  const w = (want - dl) / (dh - dl);
  return {
    strike: lo.strike + w * (hi.strike - lo.strike),
    iv: lo.iv + w * (hi.iv - lo.iv),
    delta: target, exact: false
  };
}

/* MAX PAIN — the expiry level at which the total payout to option buyers is smallest.

   Computed because it is watched, and labelled because it is weak. The theory is that writers
   have both the incentive and the means to pin the index there; the evidence is thin, it shifts
   whenever open interest shifts, and it says nothing about the path in between. Treated as a
   landmark on the map, never as a forecast. */
function maxPain(rows, lotSize) {
  const levels = rows.map(r => r.strike);
  let best = null, bestPay = Infinity;
  const curve = [];
  for (const P of levels) {
    let pay = 0;
    for (const row of rows) {
      if (row.CE && isNum(row.CE.oi) && P > row.strike) pay += row.CE.oi * (P - row.strike);
      if (row.PE && isNum(row.PE.oi) && P < row.strike) pay += row.PE.oi * (row.strike - P);
    }
    pay *= lotSize;
    curve.push({ strike: P, payout: pay });
    if (pay < bestPay) { bestPay = pay; best = P; }
  }
  return best === null ? null : {
    strike: best, payout: bestPay, curve,
    caveat: 'descriptive only. The pinning theory has weak empirical support, the level moves as open interest moves, and it says nothing about the path between here and expiry.'
  };
}

/* The strikes carrying the most open interest. Heavy call OI above the market and heavy put OI
   below are conventionally read as resistance and support — the reasoning being that writers
   defend them. It is a real effect near expiry and an overstated one otherwise, so both are
   returned with the open interest attached and the interpretation left visible. */
function oiWalls(rows, F) {
  const calls = rows.filter(r => r.CE && isNum(r.CE.oi) && r.CE.oi > 0 && r.strike > F)
    .map(r => ({ strike: r.strike, oi: r.CE.oi })).sort((a, b) => b.oi - a.oi).slice(0, 3);
  const puts = rows.filter(r => r.PE && isNum(r.PE.oi) && r.PE.oi > 0 && r.strike < F)
    .map(r => ({ strike: r.strike, oi: r.PE.oi })).sort((a, b) => b.oi - a.oi).slice(0, 3);
  if (!calls.length && !puts.length) return null;
  return {
    resistance: calls, support: puts,
    caveat: 'heavy open interest marks levels the market is positioned around, which is not the same as levels it cannot pass. The effect is real close to expiry and weak away from it.'
  };
}

module.exports = { analyse, impliedForward, quoteValue, maxPain, oiWalls, findByDelta, interpAt };
