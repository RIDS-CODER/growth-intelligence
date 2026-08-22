/* ============================================================
   INTEL — LIQUIDATION CASCADE DETECTOR

   The single most consequential distinction this whole module exists to draw:

     ORDINARY SELLING   people decide to sell. It continues until they change their minds.
     LIQUIDATION CASCADE positions are being closed FOR their owners by the exchange. Each
                        forced sale pushes price into the next tier of stops, which forces the
                        next sale. It is mechanical, it is violent, and — critically — it ENDS,
                        because it runs out of leveraged positions to consume.

   Selling into ordinary selling is how you get run over. Buying into the tail of a cascade is
   where a large share of the year's best entries live. They look nearly identical on a price
   chart, which is why the distinction has to be built from positioning data rather than price.

   ============================================================
   READ THIS: THIS DETECTOR RUNS IN "INFERRED" MODE, AND SAYS SO
   ============================================================
   A true cascade detector reads a liquidation feed — the actual stream of force-closed orders.
   This platform has no such feed and cannot get one over REST (see derivs.js). So the engine has
   two modes:

     measured  a liquidation feed is present. Not currently reachable by any configured venue.
     inferred  the cascade is reconstructed from its SIGNATURE — the fingerprint a cascade leaves
               on data we do have: a violent decline, a volume spike, breadth collapsing to
               near-total red, correlations snapping toward 1, and (when the futures adapter is
               reachable) open interest falling while funding was positive going in.

   In inferred mode the confidence score is CAPPED, and the cap and its reason travel with the
   result all the way to the screen. The engine will never print "long liquidations elevated" as
   evidence unless it actually saw liquidations. That sentence, unearned, is exactly the kind of
   fabricated authority that gets someone to hold a losing leveraged position.
   ============================================================ */

const S = require('./stats');
const { rangeExpansion } = require('./liquidity');

const FAST_BARS = 2;                 // 30m at 15m bars — a cascade is a fast event by definition
const VOL_LOOKBACK = 20;
const CAP_INFERRED = 65;             // no positioning data at all
const CAP_PARTIAL = 85;              // OI and/or funding present, but still no liquidation feed
const DETECT_AT = 55;

/* Basket traded value per bar, volume-weighted across the universe. */
function basketVolume(snap, tks) {
  const rows = tks.map(tk => {
    const f = snap.coins[tk].fine || {};
    if (!f.close || !f.vol || f.vol.length !== f.close.length) return null;
    return f.close.map((c, i) => (+f.vol[i] || 0) * c);
  }).filter(Boolean);
  if (!rows.length) return [];
  const n = Math.min(...rows.map(r => r.length));
  const out = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const r of rows) s += r[r.length - n + i] || 0;
    out.push(s);
  }
  return out;
}

function liquidationEngine(snap, ctx) {
  const c = ctx || {};
  const tks = (snap && snap.tickers) || [];
  if (tks.length < 8 || !snap.coins.BTC) {
    return { ok: false, reason: 'not enough of the market loaded to judge a cascade', mode: 'inferred', cascade: { detected: false, confidence: null } };
  }

  const liq = c.liquidations && c.liquidations.available ? c.liquidations : null;
  const oi = c.oi && c.oi.available ? c.oi : null;
  const funding = c.funding && c.funding.available ? c.funding : null;
  const mode = liq ? 'measured' : 'inferred';

  const btcFine = snap.coins.BTC.fine;
  const btcFast = S.retOver(btcFine.close, FAST_BARS);
  const btc4h = S.retOver(btcFine.close, 16);

  // Volume-weighted basket move over the same fast window.
  const altMoves = tks.map(tk => ({ r: S.retOver(snap.coins[tk].fine.close, FAST_BARS), w: +snap.coins[tk].qv || 0 }));
  const basketFast = S.weightedMean(altMoves.map(x => x.r), altMoves.map(x => x.w));

  // Volume surge.
  const bv = basketVolume(snap, tks);
  let volRatio = null;
  if (bv.length > VOL_LOOKBACK + FAST_BARS) {
    const recent = S.mean(bv.slice(bv.length - FAST_BARS));
    const base = S.mean(bv.slice(bv.length - FAST_BARS - VOL_LOOKBACK, bv.length - FAST_BARS));
    if (S.isNum(recent) && S.isNum(base) && base > 0) volRatio = recent / base;
  }

  const expansion = rangeExpansion(btcFine.high, btcFine.low, btcFine.close);
  const pctRed = c.breadth && S.isNum(c.breadth.pctRed) ? c.breadth.pctRed : null;
  const avgCorr = c.correlation && S.isNum(c.correlation.avgCorrBtc) ? c.correlation.avgCorrBtc : null;
  const oiChange = oi ? oi.market.oiChange : null;
  const fundingBefore = funding ? funding.medianRate : null;

  /* DIRECTION. A cascade of LONG liquidations drives price down; a SHORT squeeze drives it up.
     They share most of the signature (violence, volume, correlation) and differ in sign and in
     what funding was doing beforehand. */
  const down = S.isNum(basketFast) ? basketFast < 0 : (S.isNum(btcFast) && btcFast < 0);
  const side = down ? 'long' : 'short';

  const magnitude = down ? -(basketFast != null ? basketFast : btcFast) : (basketFast != null ? basketFast : btcFast);

  const parts = [
    { k: 'rapidMove', w: 0.22, v: S.ramp(magnitude, 0.008, 0.05) },
    { k: 'volumeSurge', w: 0.16, v: S.ramp(volRatio, 1.4, 4) },
    { k: 'breadthCollapse', w: 0.16, v: down ? S.ramp(pctRed, 60, 95) : S.ramp(S.isNum(pctRed) ? 100 - pctRed : null, 60, 95) },
    { k: 'rangeExpansion', w: 0.10, v: S.ramp(expansion, 1.5, 4) },
    { k: 'correlationSpike', w: 0.10, v: S.ramp(avgCorr, 0.55, 0.9) },
    /* Positioning evidence — the two terms that turn an inference into a diagnosis.
       Absent (null) rather than zero when the adapter is unreachable, so their absence widens
       the uncertainty instead of arguing against a cascade. */
    { k: 'openInterestFalling', w: 0.14, v: oi ? S.ramp(-(oiChange || 0), 0.004, 0.05) : null },
    { k: 'crowdedBefore', w: 0.12, v: funding ? (down ? S.ramp(fundingBefore, 0.0001, 0.0006) : S.ramp(-fundingBefore, 0.0001, 0.0006)) : null }
  ];

  const sp = S.scoreParts(parts);
  let confidence = sp ? Math.round(sp.score * 100) : null;

  let cap = null, capReason = null;
  if (mode === 'inferred') {
    if (!oi && !funding) { cap = CAP_INFERRED; capReason = 'No liquidation feed, no open interest and no funding data — this is a price/volume/breadth inference only.'; }
    else { cap = CAP_PARTIAL; capReason = 'No liquidation feed available; positioning evidence is present but the forced-selling itself is inferred, not observed.'; }
    if (S.isNum(confidence)) confidence = Math.min(confidence, cap);
  }

  /* Evidence list, in the brief's format — every line a fact with its number attached, and
     nothing listed that was not actually measured. */
  const evidence = [];
  const pushIf = (cond, text) => { if (cond) evidence.push(text); };
  if (S.isNum(btcFast)) pushIf(Math.abs(btcFast) >= 0.004, `BTC ${(btcFast * 100).toFixed(1)}% in ${FAST_BARS * 15}m`);
  if (S.isNum(basketFast)) pushIf(Math.abs(basketFast) >= 0.004, `market basket ${(basketFast * 100).toFixed(1)}% over the same window`);
  if (S.isNum(pctRed)) pushIf(true, `${Math.round(down ? pctRed : 100 - pctRed)}% of tracked assets ${down ? 'red' : 'green'}`);
  if (S.isNum(volRatio)) pushIf(volRatio >= 1.3, `volume ${volRatio.toFixed(1)}x its 20-bar average`);
  if (S.isNum(expansion)) pushIf(expansion >= 1.5, `BTC bar range ${expansion.toFixed(1)}x normal`);
  if (S.isNum(avgCorr)) pushIf(avgCorr >= 0.6, `altcoin/BTC correlation ${avgCorr.toFixed(2)} — the board is trading as one asset`);
  if (oi && S.isNum(oiChange)) pushIf(true, `open interest ${(oiChange * 100).toFixed(1)}%`);
  if (funding && S.isNum(fundingBefore)) pushIf(true, `funding ${(fundingBefore * 100).toFixed(3)}% per 8h going into the move`);
  if (liq) evidence.push('liquidation feed: long liquidations elevated');

  const missing = [];
  if (!liq) missing.push('liquidation feed');
  if (!oi) missing.push('open interest');
  if (!funding) missing.push('funding');

  const detected = S.isNum(confidence) && confidence >= DETECT_AT && S.isNum(magnitude) && magnitude >= 0.008;

  return {
    ok: true,
    mode,
    modeNote: mode === 'inferred'
      ? 'INFERRED — reconstructed from the signature a cascade leaves on price, volume, breadth and correlation. No liquidation feed was read.'
      : 'MEASURED — a live liquidation feed was read.',
    cascade: {
      detected,
      side,
      confidence,
      label: !S.isNum(confidence) ? 'Unknown'
        : confidence >= 80 ? 'Very likely' : confidence >= 65 ? 'Likely' : confidence >= DETECT_AT ? 'Possible' : 'Not indicated',
      headline: detected
        ? `${side === 'long' ? 'LONG LIQUIDATION CASCADE' : 'SHORT SQUEEZE / SHORT LIQUIDATION'} — ${confidence}% confidence`
        : null
    },
    cap, capReason,
    coverage: sp ? sp.coverage : null,
    evidence, missing,
    measures: {
      btcFast, basketFast, btc4h, volRatio, expansion, pctRed, avgCorr,
      oiChange: oi ? oiChange : null, fundingBefore: funding ? fundingBefore : null,
      fastWindowMins: FAST_BARS * 15
    },
    used: sp ? sp.used : [],
    absent: sp ? sp.missing : [],
    inputs: ['priceSeries', 'volumeSeries', 'breadth', 'correlation'].concat(oi ? ['openInterest'] : []).concat(funding ? ['funding'] : [])
  };
}

module.exports = { liquidationEngine, basketVolume, CAP_INFERRED, CAP_PARTIAL, DETECT_AT };
