/* ============================================================
   INTEL — MARKET REGIME CLASSIFIER + "WHY IS EVERYTHING FALLING?"

   This is the layer that refuses to say "the market is bearish".

   Every other engine produces one dimension. This one reads them together and names the
   SITUATION, because the trade depends on the mechanism and not on the direction. Three markets
   can all be down 5% with 80% of the board red:

     • a cascade    — mechanical, self-terminating, historically a place to buy the tail
     • fresh shorts — conviction selling with new money behind it, no reason to stop
     • a vacuum     — nobody is selling much at all, the bids simply left

   Same candle. Opposite trades. Naming which one it is, and showing the evidence that led there,
   is the entire product.

   ORDER MATTERS. The checks run most-specific-and-urgent first, so a liquidation cascade is
   never reported as a "broad pullback" merely because that test also passes.
   ============================================================ */

const S = require('./stats');

/* A small, factual sector map for well-known tickers. This is public categorisation, not derived
   data — and a coin that is not in it is reported as `unclassified` rather than guessed into a
   bucket. Sector weakness is only claimed when enough of a sector is actually mapped. */
const SECTORS = {
  L1: ['BTC', 'ETH', 'SOL', 'ADA', 'AVAX', 'DOT', 'NEAR', 'APT', 'SUI', 'SEI', 'TON', 'ATOM', 'ALGO', 'TRX', 'ICP', 'TIA', 'INJ'],
  L2: ['MATIC', 'POL', 'ARB', 'OP', 'STRK', 'MANTA', 'METIS', 'ZK'],
  DeFi: ['UNI', 'AAVE', 'MKR', 'CRV', 'LDO', 'SNX', 'COMP', 'SUSHI', 'CAKE', 'DYDX', 'PENDLE', 'ENA'],
  Meme: ['DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'MEME', 'BOME'],
  AI: ['FET', 'RNDR', 'RENDER', 'AGIX', 'OCEAN', 'TAO', 'AKT', 'ARKM', 'WLD'],
  Exchange: ['BNB', 'OKB', 'CRO', 'KCS', 'GT'],
  Payments: ['XRP', 'LTC', 'BCH', 'XLM', 'HBAR'],
  Gaming: ['AXS', 'SAND', 'MANA', 'IMX', 'GALA', 'ENJ', 'PIXEL', 'BEAM'],
  Ordinals: ['ORDI', 'SATS', 'RATS', '1000SATS']
};
const sectorOf = tk => {
  for (const s of Object.keys(SECTORS)) if (SECTORS[s].includes(tk)) return s;
  return null;
};

const REGIMES = {
  'long-liquidation-cascade': { label: 'LONG LIQUIDATION CASCADE', tone: 'red', risk: 'critical' },
  'short-squeeze': { label: 'SHORT SQUEEZE', tone: 'green', risk: 'elevated' },
  'flush-recovery': { label: 'LEVERAGE FLUSH → RECOVERY', tone: 'green', risk: 'elevated' },
  'liquidity-vacuum': { label: 'LIQUIDITY VACUUM', tone: 'red', risk: 'critical' },
  'oi-deleveraging': { label: 'RISK-OFF / LEVERAGE FLUSH', tone: 'red', risk: 'high' },
  'long-crowding': { label: 'EXCESSIVE LONG CROWDING', tone: 'amber', risk: 'high' },
  'sector-weakness': { label: 'SECTOR-SPECIFIC WEAKNESS', tone: 'amber', risk: 'moderate' },
  'external-shock': { label: 'MARKET-WIDE SHOCK', tone: 'red', risk: 'high' },
  'btc-led-correction': { label: 'BTC-LED CORRECTION', tone: 'red', risk: 'high' },
  'eth-led-weakness': { label: 'ETH-LED WEAKNESS', tone: 'amber', risk: 'moderate' },
  'broad-altcoin-risk-off': { label: 'BROAD ALTCOIN RISK-OFF', tone: 'red', risk: 'high' },
  'trend-reversal': { label: 'TREND REVERSAL', tone: 'red', risk: 'high' },
  'macro-event-window': { label: 'SCHEDULED EVENT WINDOW', tone: 'amber', risk: 'high' },
  'macro-risk-off': { label: 'MACRO-DRIVEN RISK-OFF', tone: 'red', risk: 'high' },
  'macro-dominated': { label: 'MACRO-DRIVEN TAPE', tone: 'amber', risk: 'elevated' },
  'normal-pullback': { label: 'NORMAL PULLBACK', tone: 'amber', risk: 'moderate' },
  'broad-risk-on': { label: 'BROAD RISK-ON', tone: 'green', risk: 'low' },
  'btc-led-rally': { label: 'BTC-LED RALLY', tone: 'green', risk: 'low' },
  'quiet': { label: 'QUIET / RANGE', tone: 'neutral', risk: 'low' },
  'unknown': { label: 'INSUFFICIENT DATA', tone: 'neutral', risk: null }
};

/* Sector weakness: one mapped sector materially worse than the rest of the mapped board.
   Requires at least 3 coins in the sector AND 6 mapped outside it, so a single name never
   becomes "the DeFi sector is collapsing". */
function sectorWeakness(snap) {
  const tks = snap.tickers || [];
  const groups = {};
  let mapped = 0;
  for (const tk of tks) {
    const s = sectorOf(tk); if (!s) continue;
    const r = S.retOver(snap.coins[tk].fine && snap.coins[tk].fine.close, 16);
    if (!S.isNum(r)) continue;
    (groups[s] = groups[s] || []).push({ tk, r });
    mapped++;
  }
  if (mapped < 9) return { available: false, reason: `only ${mapped} tracked coins fall in the known sector map — too few to compare sectors`, mapped };
  const meds = {};
  for (const s of Object.keys(groups)) if (groups[s].length >= 3) meds[s] = S.median(groups[s].map(x => x.r));
  const keys = Object.keys(meds);
  if (keys.length < 2) return { available: false, reason: 'fewer than two sectors have enough mapped coins to compare', mapped };
  const overall = S.median(Object.values(meds));
  let worst = null;
  for (const s of keys) if (!worst || meds[s] < meds[worst]) worst = s;
  const gap = meds[worst] - overall;
  return {
    available: true, mapped,
    sectors: meds, worst, worstMedian: meds[worst], overallMedian: overall, gap,
    /* 3 percentage points worse than the median sector, and actually negative — a sector can be
       "worst" in a rally without being weak. */
    flagged: gap <= -0.03 && meds[worst] < -0.01,
    members: (groups[worst] || []).map(x => x.tk)
  };
}

function classify(parts) {
  const { breadth, correlation, transmission, liquidation, oi, funding, liquidity, recovery, sector, macro } = parts;
  const why = [];
  const bs = breadth && breadth.ok ? breadth.score : null;
  const falling = transmission && transmission.ok ? transmission.falling : (S.isNum(bs) && bs < -20);

  const pick = (key, reasons) => ({ regime: key, ...REGIMES[key], why: reasons });

  if (!breadth || !breadth.ok) return pick('unknown', [breadth ? breadth.reason : 'no breadth data']);

  /* ---- MACRO OUTRANKS EVERYTHING BELOW IT, AND THAT ORDERING IS THE POINT ----
     An event window or a dollar shock is not one more input to weigh against breadth — it is a
     statement that the crypto-internal read is about to stop mattering. Classifying such a tape
     as a "BTC-led correction" would send the trader looking for the level where it stops, when
     the honest answer is that no level prices an unreleased number. */
  const ev = macro && macro.eventRisk;
  if (ev && ev.ok && ev.inWindow) {
    why.push(ev.message);
    if (macro.available && S.isNum(macro.cryptoMacro.taReliability)) why.push(`technical reliability ${macro.cryptoMacro.taReliability}/100`);
    return pick('macro-event-window', why);
  }
  if (macro && macro.available) {
    const m = macro.regime;
    if (['vol-spike', 'dollar-squeeze', 'yield-shock'].includes(m.regime) && falling) {
      why.push(...m.why);
      why.push(`macro risk appetite ${macro.riskAppetite} — this decline has an external driver, not an internal one`);
      return pick('macro-risk-off', why);
    }
    if (S.isNum(macro.riskAppetite) && macro.riskAppetite <= -50 && falling) {
      why.push(`macro risk appetite ${macro.riskAppetite} (${macro.riskAppetiteLabel})`);
      why.push(...m.why);
      return pick('macro-risk-off', why);
    }
  }

  // 1 — the cascade outranks everything, in either direction.
  if (liquidation && liquidation.ok && liquidation.cascade.detected) {
    why.push(`cascade confidence ${liquidation.cascade.confidence}% (${liquidation.mode})`);
    why.push(...liquidation.evidence.slice(0, 4));
    return pick(liquidation.cascade.side === 'long' ? 'long-liquidation-cascade' : 'short-squeeze', why);
  }
  // 2 — the flush is over and turning.
  if (recovery && recovery.ok && recovery.selloff && recovery.verdict === 'flush-recovery-likely') {
    why.push(`recovery ${recovery.recoveryProb}% vs continuation ${recovery.continuationRisk}%`);
    if (recovery.signals.btcLastLowTag === 'HL') why.push('BTC printed a higher low');
    if (recovery.signals.volume && recovery.signals.volume.contracting) why.push('volume spiked then drained');
    return pick('flush-recovery', why);
  }
  // 3 — the book is empty; this outranks direction because size, not side, is the problem.
  if (liquidity && liquidity.ok && liquidity.marketVacuum) {
    why.push(`${Math.round(liquidity.pctVacuum)}% of scored coins show abnormal price impact`);
    why.push(liquidity.tier);
    return pick('liquidity-vacuum', why);
  }
  // 4 — positioning unwinding, named explicitly. Needs a real OI feed.
  if (falling && oi && oi.available && oi.market.deleveraging) {
    why.push(`open interest ${(oi.market.oiChange * 100).toFixed(1)}% while price fell — positions closing, not new shorts`);
    return pick('oi-deleveraging', why);
  }
  // 5 — crowding BEFORE the damage: the warning regime.
  if (funding && funding.available && funding.extreme && funding.crowding.indexOf('longs') === 0 && !falling) {
    why.push(`median funding ${(funding.medianRate * 100).toFixed(3)}% per 8h — longs paying heavily to stay in`);
    return pick('long-crowding', why);
  }
  // 6 — one sector, not the market.
  if (sector && sector.available && sector.flagged && S.isNum(bs) && bs > -45) {
    why.push(`${sector.worst} median ${(sector.worstMedian * 100).toFixed(1)}% vs ${(sector.overallMedian * 100).toFixed(1)}% across sectors`);
    why.push(`affected: ${sector.members.slice(0, 6).join(', ')}`);
    return pick('sector-weakness', why);
  }
  // 7 — everything at once with nobody leading. We cannot see news, and we say so.
  if (falling && correlation && correlation.ok && correlation.spike && transmission && transmission.ok && transmission.leader === 'unclear') {
    why.push(`correlation spiked to ${correlation.avgCorrBtc.toFixed(2)} with no identifiable leader`);
    why.push('simultaneous, leaderless moves usually mean an external catalyst');
    return pick('external-shock', why);
  }
  // 8/9 — leadership-named declines.
  if (falling && transmission && transmission.ok && transmission.leader === 'BTC') {
    why.push(transmission.leaderWhy);
    if (S.isNum(breadth.pctRed)) why.push(`${Math.round(breadth.pctRed)}% of tracked assets red`);
    return pick('btc-led-correction', why);
  }
  if (falling && transmission && transmission.ok && transmission.leader === 'ETH') {
    why.push(transmission.leaderWhy);
    return pick('eth-led-weakness', why);
  }
  // 10 — alts bleeding harder than the majors.
  if (S.isNum(breadth.altStress) && breadth.altStress >= 60 && S.isNum(bs) && bs < -20) {
    why.push(`altcoin stress ${breadth.altStress}/100`);
    if (S.isNum(breadth.alt.pctRed)) why.push(`${Math.round(breadth.alt.pctRed)}% of altcoins red`);
    return pick('broad-altcoin-risk-off', why);
  }
  // 11 — structural break rather than a dip.
  if (S.isNum(bs) && bs <= -60 && parts.btcStructure && parts.btcStructure.ok && parts.btcStructure.verdict === 'bearish') {
    why.push(`breadth ${bs} with BTC printing lower highs and lower lows`);
    return pick('trend-reversal', why);
  }
  /* A tape that is quiet by every crypto-internal measure but is being driven from outside.
     Named last, because the more specific crypto diagnoses above are more actionable when they
     apply — but named at all, because "nothing unusual internally" plus "correlation to the
     Nasdaq at 0.8" is not a calm market, it is a market whose chart is not the one to read. */
  if (macro && macro.available && S.isNum(macro.cryptoMacro.taReliability) && macro.cryptoMacro.taReliability < 35) {
    why.push(`technical reliability ${macro.cryptoMacro.taReliability}/100`);
    why.push(macro.cryptoMacro.message);
    return pick('macro-dominated', why);
  }

  // 12/13 — the ordinary cases.
  if (S.isNum(bs) && bs < -15) {
    why.push(`breadth ${bs}, no leverage or liquidity stress detected`);
    return pick('normal-pullback', why);
  }
  if (S.isNum(bs) && bs >= 45) {
    why.push(`breadth ${bs} — broad participation to the upside`);
    return pick(transmission && transmission.ok && transmission.leader === 'BTC' ? 'btc-led-rally' : 'broad-risk-on', why);
  }
  if (S.isNum(bs) && bs >= 15) { why.push(`breadth ${bs}`); return pick('broad-risk-on', why); }
  why.push(`breadth ${bs} — no directional conviction either way`);
  return pick('quiet', why);
}

/* ---- "WHY IS EVERYTHING FALLING?" ----
   The one-click diagnostic. Assembled entirely from measured facts; each sentence that depends
   on an unavailable feed is simply not written, and the gap is listed at the end instead of
   being papered over. */
function whyNarrative(parts) {
  const { breadth, transmission, liquidation, oi, funding, beta, recovery, regimeInfo, correlation, macro } = parts;
  const out = [];
  const pctTxt = v => S.isNum(v) ? (v * 100).toFixed(1) + '%' : null;

  if (!breadth || !breadth.ok) {
    return { text: 'Not enough of the market loaded to explain what is happening. ' + ((breadth && breadth.reason) || ''), unavailable: ['market breadth'] };
  }

  const up = S.isNum(breadth.score) && breadth.score > 15;
  out.push(`${regimeInfo.label} detected.`);

  // Where the move is.
  const bits = [];
  if (S.isNum(breadth.btc.ret24h)) bits.push(`BTC is ${breadth.btc.ret24h >= 0 ? 'up' : 'down'} ${pctTxt(Math.abs(breadth.btc.ret24h))} over 24h`);
  if (S.isNum(breadth.eth.ret24h)) bits.push(`ETH ${breadth.eth.ret24h >= 0 ? 'up' : 'down'} ${pctTxt(Math.abs(breadth.eth.ret24h))}`);
  if (S.isNum(breadth.alt.pctRed)) bits.push(`${Math.round(up ? breadth.alt.pctGreen : breadth.alt.pctRed)}% of tracked altcoins are ${up ? 'green' : 'red'}`);
  if (bits.length) out.push(bits.join(', ') + '.');

  /* ---- MACRO GOES HIGH IN THE NARRATIVE, ON PURPOSE ----
     If the driver is external, that is the first thing worth knowing — reading four sentences of
     crypto-internal detail before learning the dollar is up 2% gets the emphasis exactly
     backwards for someone deciding whether to hold leverage. */
  if (macro && macro.eventRisk && macro.eventRisk.ok && macro.eventRisk.inWindow) {
    out.push(macro.eventRisk.message);
  }
  if (macro && macro.available) {
    const bits = [];
    for (const k of ['DXY', 'US10Y', 'VIX', 'NDX']) {
      const x = macro.instruments[k];
      if (x && S.isNum(x.chg5d)) bits.push(`${x.name} ${x.chg5d >= 0 ? '+' : ''}${(x.chg5d * 100).toFixed(1)}% (5d)`);
    }
    if (bits.length) out.push(`Macro backdrop: ${bits.join(', ')}. Risk appetite ${macro.riskAppetite} — ${macro.riskAppetiteLabel}.`);
    if (S.isNum(macro.cryptoMacro.taReliability) && macro.cryptoMacro.taReliability < 55) {
      out.push(macro.cryptoMacro.message);
    }
  } else if (macro && macro.warning) {
    out.push(macro.warning);
  }

  // Positioning — only when the feed exists.
  if (oi && oi.available && S.isNum(oi.market.oiChange)) {
    out.push(`Open interest has ${oi.market.oiChange < 0 ? 'fallen' : 'risen'} ${pctTxt(Math.abs(oi.market.oiChange))}.`);
    out.push(oi.market.meaning);
  }
  if (funding && funding.available && funding.messages.length) out.push(funding.messages[0]);

  // Mechanism.
  if (liquidation && liquidation.ok && liquidation.cascade.detected) {
    out.push(`This carries the signature of a ${liquidation.cascade.side === 'long' ? 'leveraged long deleveraging event' : 'short squeeze'} rather than ${liquidation.cascade.side === 'long' ? 'fresh short selling' : 'fresh buying'} — ${liquidation.cascade.confidence}% confidence (${liquidation.mode}).`);
    if (liquidation.evidence.length) out.push('Evidence: ' + liquidation.evidence.join('; ') + '.');
  }

  // Transmission + amplification.
  if (transmission && transmission.ok && transmission.narrative) out.push(transmission.narrative);
  if (beta && beta.ok && beta.amplificationStatement) {
    out.push(`Altcoins are currently amplifying BTC by roughly ${beta.amplificationStatement.factor.toFixed(1)}x.`);
  }
  if (correlation && correlation.ok && correlation.singleRiskAsset) {
    out.push(`Correlation to BTC is ${correlation.avgCorrBtc.toFixed(2)} — the board is trading as a single risk asset, so holding eight alt positions is currently closer to holding one position at eight times the size.`);
  }

  // What happens next, and what would prove it.
  if (recovery && recovery.ok) {
    out.push(`Recovery ${recovery.recoveryProb}% vs continuation ${recovery.continuationRisk}% on current evidence (heuristic, not a measured base rate).`);
    if (recovery.levels && recovery.levels.text) out.push(recovery.levels.text);
  }

  const unavailable = [];
  if (!oi || !oi.available) unavailable.push('open interest');
  if (!funding || !funding.available) unavailable.push('funding');
  unavailable.push('liquidation feed');
  if (macro && !macro.available) unavailable.push('macro (dollar, rates, volatility, equities)');
  if (unavailable.length) {
    out.push(`DATA UNAVAILABLE: ${unavailable.join(', ')}. Conclusions above are drawn without ${unavailable.length > 1 ? 'them' : 'it'}.`);
  }

  return { text: out.filter(Boolean).join(' '), unavailable };
}

module.exports = { classify, whyNarrative, sectorWeakness, sectorOf, SECTORS, REGIMES };
