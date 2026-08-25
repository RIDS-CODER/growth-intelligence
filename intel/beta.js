/* ============================================================
   INTEL — BETA / AMPLIFICATION ENGINE

   How hard does this coin get hit when BTC moves? For someone holding 4x leveraged alt longs
   this is the difference between a drawdown and a liquidation: at beta 2.75, BTC only has to
   fall 9% to take the coin down 25%, and a 4x position is gone.

   THREE NUMBERS, THREE DIFFERENT CLAIMS — the engine keeps them apart because they disagree in
   exactly the situations that matter:

     beta          OLS slope over the window. The statistically sound "typical" sensitivity.
     downsideBeta  the same slope fitted ONLY to bars where BTC fell. Alts routinely track BTC
                   1:1 upward and 2:1 downward; a symmetric beta averages that asymmetry away,
                   and the asymmetry IS the risk.
     amplification realised ratio of this window's total move to BTC's. This is the number in
                   "BTC −2%, SUI −5.5% → 2.75x". It is not a regression and is deliberately
                   undefined when BTC barely moved, because dividing by ~0 manufactures a
                   terrifying ratio out of noise.
   ============================================================ */

const S = require('./stats');
const { basketReturns } = require('./correlation');

const HIGH_BETA = 1.8;               // downside beta at or above this is flagged as amplification risk
const MIN_SAMPLES = 10;
const BARS_4H = 16;                  // 16 × 15m

function betaEngine(snap, ctx) {
  const c = ctx || {};
  const wk = c.window || '1h';
  const tks = (snap && snap.tickers) || [];
  if (!snap || !snap.coins || !snap.coins.BTC) {
    return { ok: false, reason: 'BTC series unavailable — beta here is measured against BTC', coins: {} };
  }
  const btcWin = snap.coins.BTC.win[wk];
  if (!btcWin || !btcWin.ret || btcWin.ret.length < MIN_SAMPLES) {
    return { ok: false, reason: `BTC has under ${MIN_SAMPLES} samples on the ${wk} window`, coins: {} };
  }
  const btcRet = btcWin.ret;
  const ethRet = snap.coins.ETH ? (snap.coins.ETH.win[wk] || {}).ret : null;
  const basket = basketReturns(snap, tks, wk);

  // Realised window moves, for the amplification ratio.
  const btcMove = S.retOver(snap.coins.BTC.fine && snap.coins.BTC.fine.close, BARS_4H);

  const coins = {};
  for (const tk of tks) {
    const r = (snap.coins[tk].win[wk] || {}).ret;
    if (!r || r.length < MIN_SAMPLES) { coins[tk] = { ok: false, reason: 'insufficient samples' }; continue; }
    const move = S.retOver(snap.coins[tk].fine && snap.coins[tk].fine.close, BARS_4H);
    const db = S.downsideBeta(r, btcRet);
    coins[tk] = {
      ok: true,
      beta: S.beta(r, btcRet),
      betaEth: ethRet ? S.beta(r, ethRet) : null,
      betaMarket: basket.length ? S.beta(r, basket) : null,
      downsideBeta: db,
      amplification: S.amplification(move, btcMove),
      move4h: move,
      highBeta: S.isNum(db) && db >= HIGH_BETA
    };
  }

  const alts = (snap.alts || []).filter(tk => coins[tk] && coins[tk].ok);
  const altBeta = S.median(alts.map(tk => coins[tk].beta));
  const altDownsideBeta = S.median(alts.map(tk => coins[tk].downsideBeta));
  const altAmp = S.median(alts.map(tk => coins[tk].amplification));

  const risky = alts.filter(tk => coins[tk].highBeta)
    .map(tk => ({ tk, downsideBeta: +coins[tk].downsideBeta.toFixed(2), amplification: coins[tk].amplification, move4h: coins[tk].move4h }))
    .sort((a, b) => b.downsideBeta - a.downsideBeta);

  return {
    ok: true,
    window: wk,
    coins,
    btcMove4h: btcMove,
    altBeta, altDownsideBeta, altAmplification: altAmp,
    /* The headline sentence's number. Only stated when BTC actually moved enough for a ratio to
       mean something — otherwise the UI says so rather than printing a spurious multiple. */
    amplificationStatement: (S.isNum(altAmp) && S.isNum(btcMove) && Math.abs(btcMove) >= 0.005 && altAmp > 0)
      ? { factor: +altAmp.toFixed(2), btcMove4h: btcMove }
      : null,
    highBetaRisk: risky.length > 0 && S.isNum(altDownsideBeta) && altDownsideBeta >= 1.3,
    highBetaCoins: risky.slice(0, 8),
    threshold: HIGH_BETA,
    inputs: ['returnSeries', 'btcBenchmark', 'tradedValueWeights']
  };
}

/* ---- ONE COIN VS THE MARKET (brief §10) ----
   Classification hinges on alpha — the part of the coin's move that its beta does NOT explain.
   A coin down 4% with a beta of 2 while the market is down 3% is not "weak"; it is doing exactly
   what it should. Calling that underperformance would have the trader cutting the wrong name.

   The alpha threshold scales with the coin's own volatility, so a quiet large-cap and a jumpy
   micro-cap are not judged against the same bar. */
function coinVsMarket(tk, snap, betas, corrs) {
  const coin = snap && snap.coins && snap.coins[tk];
  if (!coin) return { ok: false, reason: 'coin not in tracked universe' };
  const b = betas && betas.coins && betas.coins[tk];
  const move = S.retOver(coin.fine && coin.fine.close, BARS_4H);
  const btcMove = betas && betas.btcMove4h;

  // Market move = volume-weighted alt basket over the same 4h.
  const altMoves = (snap.alts || []).map(t => ({ r: S.retOver(snap.coins[t].fine && snap.coins[t].fine.close, BARS_4H), w: +snap.coins[t].qv || 0 }));
  const marketMove = S.weightedMean(altMoves.map(x => x.r), altMoves.map(x => x.w));

  if (!S.isNum(move) || !S.isNum(marketMove)) return { ok: false, reason: 'insufficient price history to compare against the market' };

  const beta = b && b.ok && S.isNum(b.betaMarket) ? b.betaMarket : 1;
  const alpha = move - beta * marketMove;

  const rets = ((coin.win['1h'] || {}).ret || []).filter(S.isNum);
  const vol = S.stdev(rets) || 0.01;
  const thr = Math.max(0.01, vol * 3);            // 3 bar-sigma — beyond routine wobble

  const corr = corrs && corrs.headWindow && corrs.windows[corrs.headWindow]
    && corrs.windows[corrs.headWindow].per[tk] && corrs.windows[corrs.headWindow].per[tk].btc;

  let klass, note;
  if (S.isNum(corr) && corr < 0.35) {
    klass = move >= 0 ? 'decoupling-bullish' : 'decoupling-bearish';
    note = `moving largely independently of BTC (correlation ${corr.toFixed(2)})`;
  } else if (alpha > thr) {
    klass = 'stronger-than-market'; note = 'outperforming after adjusting for how much it normally moves';
  } else if (alpha < -thr) {
    klass = 'weaker-than-market'; note = 'underperforming beyond what its usual sensitivity explains';
  } else {
    klass = 'market-driven'; note = 'moving about as much as its beta to the market implies — this is not coin-specific';
  }

  return {
    ok: true, tk, klass, note,
    move4h: move, marketMove4h: marketMove, btcMove4h: btcMove,
    beta, alpha, alphaThreshold: thr, corrBtc: S.isNum(corr) ? corr : null,
    downsideBeta: b && b.ok ? b.downsideBeta : null,
    inputs: ['coinReturns', 'altBasketReturns', 'betaToMarket', 'correlationToBtc']
  };
}

module.exports = { betaEngine, coinVsMarket, HIGH_BETA };
