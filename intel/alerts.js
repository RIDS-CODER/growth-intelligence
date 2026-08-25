/* ============================================================
   INTEL — MARKET EVENT ALERTS

   FIRES ON THE TRANSITION, NOT ON THE STATE. A market that sits in risk-off for six hours is one
   event, not 360 of them. Every rule here therefore fires when a condition BECOMES true and then
   stays quiet — the existing Dump & Bounce alerts already learned this lesson (`dbAlertLast`),
   and an intelligence layer that pages you every minute during a selloff is one you mute on the
   day it would have mattered.

   A re-arm is required before the same alert can fire again: the condition has to clear the
   lower hysteresis band first. Without that, a metric hovering on the threshold produces a
   stream of alerts that all describe the same moment.

   Severity and confidence travel with every alert, and confidence is inherited from the engine
   that produced it — including its data-availability cap. An alert built on inferred evidence
   says so in its own text.
   ============================================================ */

const S = require('./stats');

const COOLDOWN_MS = 45 * 60 * 1000;      // same event cannot re-fire inside this window

/* Each rule: `on` is the trigger, `off` is the re-arm band (hysteresis).
   sev: 'red' | 'amber' | 'green'. */
const RULES = [
  {
    k: 'market-selloff', sev: 'red', icon: '🔴', title: 'MARKET-WIDE SELL-OFF',
    on: i => i.breadth.ok && S.isNum(i.breadth.score) && i.breadth.score <= -55,
    off: i => i.breadth.ok && S.isNum(i.breadth.score) && i.breadth.score > -40,
    conf: i => Math.min(95, Math.round(Math.abs(i.breadth.score))),
    text: i => `Breadth ${i.breadth.score} · ${Math.round(i.breadth.pctRed)}% of tracked assets red · ${i.regime.label}.`
  },
  {
    k: 'altcoin-stress', sev: 'amber', icon: '🟠', title: 'ALTCOIN STRESS',
    on: i => i.breadth.ok && S.isNum(i.breadth.altStress) && i.breadth.altStress >= 65,
    off: i => i.breadth.ok && S.isNum(i.breadth.altStress) && i.breadth.altStress < 50,
    conf: i => Math.round(i.breadth.altStress),
    text: i => `Altcoin stress ${i.breadth.altStress}/100 · ${Math.round(i.breadth.alt.pctRed)}% of altcoins red · median alt 4h ${(i.breadth.alt.medianRet4h * 100).toFixed(1)}%.`
  },
  {
    k: 'liquidation-cascade', sev: 'red', icon: '🔴', title: 'LONG LIQUIDATION CASCADE',
    on: i => i.liquidation.ok && i.liquidation.cascade.detected && i.liquidation.cascade.side === 'long',
    off: i => !i.liquidation.ok || !i.liquidation.cascade.detected,
    conf: i => i.liquidation.cascade.confidence,
    text: i => `${i.liquidation.cascade.confidence}% confidence (${i.liquidation.mode}). ${i.liquidation.evidence.slice(0, 4).join(' · ')}.` +
      (i.liquidation.mode === 'inferred' ? ' No liquidation feed — inferred from price, volume, breadth and correlation.' : '')
  },
  {
    k: 'short-squeeze', sev: 'amber', icon: '🟠', title: 'SHORT SQUEEZE',
    on: i => i.liquidation.ok && i.liquidation.cascade.detected && i.liquidation.cascade.side === 'short',
    off: i => !i.liquidation.ok || !i.liquidation.cascade.detected,
    conf: i => i.liquidation.cascade.confidence,
    text: i => `${i.liquidation.cascade.confidence}% confidence (${i.liquidation.mode}). ${i.liquidation.evidence.slice(0, 4).join(' · ')}.`
  },
  {
    k: 'leverage-crowding', sev: 'amber', icon: '🟠', title: 'HIGH LEVERAGE CROWDING',
    on: i => i.funding.available && i.funding.extreme,
    off: i => !i.funding.available || i.funding.crowding === 'balanced',
    conf: i => 70,
    text: i => `${i.funding.crowding.replace(/-/g, ' ')} · median funding ${(i.funding.medianRate * 100).toFixed(3)}% per 8h.`
  },
  {
    k: 'liquidity-vacuum', sev: 'red', icon: '🔴', title: 'LIQUIDITY VACUUM',
    on: i => i.liquidity.ok && i.liquidity.marketVacuum,
    off: i => !i.liquidity.ok || !i.liquidity.marketVacuum,
    conf: i => Math.min(90, Math.round(i.liquidity.pctVacuum * 2)),
    text: i => `${Math.round(i.liquidity.pctVacuum)}% of scored coins show abnormal price impact (${i.liquidity.tier}). Small market orders can move price disproportionately — reduce size and avoid market orders.`
  },
  {
    k: 'flush-recovery', sev: 'green', icon: '🟢', title: 'LIQUIDATION FLUSH RECOVERY',
    on: i => i.recovery.ok && i.recovery.selloff && i.recovery.verdict === 'flush-recovery-likely',
    off: i => !i.recovery.ok || i.recovery.verdict !== 'flush-recovery-likely',
    conf: i => i.recovery.recoveryProb,
    text: i => `Recovery ${i.recovery.recoveryProb}% vs continuation ${i.recovery.continuationRisk}% (heuristic). ${i.recovery.levels.text}`
  },
  {
    k: 'broad-recovery', sev: 'green', icon: '🟢', title: 'BROAD MARKET RECOVERY',
    on: i => i.breadth.ok && S.isNum(i.breadth.score) && i.breadth.score >= 45,
    off: i => i.breadth.ok && S.isNum(i.breadth.score) && i.breadth.score < 25,
    conf: i => Math.min(95, Math.round(i.breadth.score)),
    text: i => `Breadth ${i.breadth.score} · ${Math.round(i.breadth.pctGreen)}% green · ${Math.round(i.breadth.pctAbove20)}% back above their 20 EMA.`
  },
  /* ---- MACRO ALERTS ----
     These fire on conditions that have nothing to do with any coin's chart, which is exactly why
     they need their own channel: nothing in the crypto-internal rules above would ever raise
     them, and they are the ones that arrive before a technically clean position gets destroyed. */
  {
    k: 'macro-event-window', sev: 'red', icon: '🔴', title: 'SCHEDULED EVENT — LEVERAGE BLOCKED',
    on: i => !!(i.eventRisk && i.eventRisk.ok && i.eventRisk.inWindow),
    off: i => !(i.eventRisk && i.eventRisk.inWindow),
    conf: () => 95,
    text: i => i.eventRisk.message + ' New leveraged entries are blocked until the window closes.'
  },
  {
    k: 'macro-risk-off', sev: 'red', icon: '🔴', title: 'MACRO RISK-OFF',
    on: i => !!(i.macro && i.macro.available && S.isNum(i.macro.riskAppetite) && i.macro.riskAppetite <= -50),
    off: i => !!(i.macro && i.macro.available && S.isNum(i.macro.riskAppetite) && i.macro.riskAppetite > -30),
    conf: i => Math.min(95, Math.abs(i.macro.riskAppetite)),
    text: i => `${i.macro.regime.label} · risk appetite ${i.macro.riskAppetite} (${i.macro.riskAppetiteLabel}). ${(i.macro.regime.why || []).join(' · ')}. New leveraged longs are blocked while macro is this hostile.`
  },
  {
    k: 'ta-unreliable', sev: 'amber', icon: '🟠', title: 'TECHNICALS BEING OVERRIDDEN BY MACRO',
    on: i => !!(i.macro && i.macro.available && S.isNum(i.macro.cryptoMacro.taReliability) && i.macro.cryptoMacro.taReliability < 35),
    off: i => !!(i.macro && i.macro.available && S.isNum(i.macro.cryptoMacro.taReliability) && i.macro.cryptoMacro.taReliability >= 50),
    conf: i => 100 - i.macro.cryptoMacro.taReliability,
    text: i => `Technical reliability ${i.macro.cryptoMacro.taReliability}/100. ${i.macro.cryptoMacro.message} Setup confidence is being degraded by ${Math.round((1 - i.macro.gate.confidenceMultiplier) * 100)}%.`
  },
  /* ---- THE TWO THE USER ASKED FOR BY NAME ---- */
  {
    /* Names the factor and the direction: "the dollar is dragging crypto", not "macro is bad". */
    k: 'macro-driver', sev: 'amber', icon: '🟠', title: 'MACRO FACTOR MOVING CRYPTO',
    on: i => !!(i.attribution && i.attribution.ok && i.attribution.externallyDriven && i.attribution.material),
    off: i => !(i.attribution && i.attribution.ok && i.attribution.externallyDriven),
    conf: i => Math.min(90, Math.round(Math.abs(i.attribution.explainedShare) * 100)),
    text: i => i.attribution.headline
  },
  {
    /* The "it looks like a rally but nothing is holding it up" warning. Careful wording: this
       never claims a reversal is coming, only that fewer things are supporting the move than the
       price implies — which is a claim the data can actually carry. */
    k: 'fragile-move', sev: 'amber', icon: '🟠', title: 'MOVE NOT SUPPORTED BY ITS INTERNALS',
    on: i => !!(i.fragility && i.fragility.ok && i.fragility.active && S.isNum(i.fragility.score) && i.fragility.score >= 65),
    off: i => !(i.fragility && i.fragility.ok && i.fragility.active && S.isNum(i.fragility.score) && i.fragility.score >= 50),
    conf: i => i.fragility.score,
    text: i => `${i.fragility.direction === 'up' ? 'Rally' : 'Decline'} fragility ${i.fragility.score}/100 — ${i.fragility.firedCount} of ${i.fragility.totalSignals} internal supports missing. ` +
      i.fragility.signals.filter(s => s.fired).slice(0, 3).map(s => s.detail).join('; ') + '. ' + i.fragility.disclaimer
  },
  {
    k: 'macro-unavailable', sev: 'amber', icon: '🟠', title: 'MACRO DATA UNAVAILABLE',
    on: i => !!(i.macro && !i.macro.available),
    off: i => !!(i.macro && i.macro.available),
    conf: () => null,
    text: i => (i.macro.warning || 'Macro feed unreachable.') + ' Macro gating is currently OFF — the platform is back to chart-only, which is the state it was in before this layer existed.'
  },
  {
    k: 'btc-alt-divergence', sev: 'amber', icon: '🟠', title: 'BTC/ALT DIVERGENCE',
    on: i => i.breadth.ok && S.isNum(i.breadth.ethVsBtc.h4) && Math.abs(i.breadth.ethVsBtc.h4) >= 0.03,
    off: i => i.breadth.ok && S.isNum(i.breadth.ethVsBtc.h4) && Math.abs(i.breadth.ethVsBtc.h4) < 0.015,
    conf: i => 65,
    text: i => `ETH is ${(i.breadth.ethVsBtc.h4 * 100).toFixed(1)}pp ${i.breadth.ethVsBtc.h4 > 0 ? 'stronger' : 'weaker'} than BTC over 4h — the complex is not moving as one.`
  }
];

/* Per-coin alerts, evaluated only for coins the trader actually holds — a board-wide
   "underperforming" list would be forty lines of noise. */
function coinRules(vs, tk) {
  const out = [];
  if (!vs || !vs.ok) return out;
  if (vs.klass === 'weaker-than-market' || vs.klass === 'decoupling-bearish') {
    out.push({
      k: 'coin-under:' + tk, sev: 'red', icon: '🔴', title: 'COIN UNDERPERFORMING MARKET', conf: 70,
      text: `${tk} ${(vs.move4h * 100).toFixed(1)}% over 4h while the altcoin market is ${(vs.marketMove4h * 100).toFixed(1)}%. ${vs.note}. Treat as higher risk.`
    });
  } else if (vs.klass === 'stronger-than-market' || vs.klass === 'decoupling-bullish') {
    out.push({
      k: 'coin-over:' + tk, sev: 'green', icon: '🟢', title: 'COIN OUTPERFORMING MARKET', conf: 70,
      text: `${tk} ${(vs.move4h * 100).toFixed(1)}% over 4h while the altcoin market is ${(vs.marketMove4h * 100).toFixed(1)}%. ${vs.note}.`
    });
  }
  return out;
}

/* `state` is owned by the caller and persists between runs: { key: {armed, lastFired} }. */
function buildAlerts(intel, state, opts) {
  const st = state || {};
  const o = opts || {};
  const now = o.now || Date.now();
  const cooldown = o.cooldownMs == null ? COOLDOWN_MS : o.cooldownMs;
  const fired = [];

  const evaluate = (key, isOn, isOff, make) => {
    const s = st[key] || (st[key] = { armed: true, lastFired: 0 });
    let on = false, offNow = false;
    try { on = !!isOn(); } catch (e) { on = false; }
    try { offNow = isOff ? !!isOff() : !on; } catch (e) { offNow = !on; }
    if (offNow) s.armed = true;                                  // cleared the band → may fire again
    if (!on || !s.armed) return;
    /* `s.lastFired` truthiness, not a bare subtraction. A never-fired rule carries lastFired:0,
       and `now - 0 < cooldown` suppresses the very FIRST alert of a rule's life whenever `now` is
       smaller than the cooldown window. Wall-clock epochs hide this in production and it shows up
       instantly under a test clock — but "never fired" and "fired at epoch zero" are different
       states and only one of them should be rate-limited. */
    if (s.lastFired && now - s.lastFired < cooldown) return;
    s.armed = false; s.lastFired = now;
    const a = make();
    if (a) fired.push(a);
  };

  for (const r of RULES) {
    evaluate(r.k, () => r.on(intel), () => r.off(intel), () => {
      let conf = null, text = '';
      try { conf = r.conf(intel); } catch (e) { conf = null; }
      try { text = r.text(intel); } catch (e) { text = ''; }
      return { key: r.k, icon: r.icon, severity: r.sev, title: r.title, confidence: S.isNum(conf) ? conf : null, text, ts: now };
    });
  }

  for (const c of (o.coinAlerts || [])) {
    evaluate(c.k, () => true, () => false, () => ({ key: c.k, icon: c.icon, severity: c.sev, title: c.title, confidence: c.conf, text: c.text, ts: now }));
  }

  return { alerts: fired, state: st };
}

function formatTelegram(a) {
  const sev = a.severity === 'red' ? 'HIGH' : a.severity === 'amber' ? 'ELEVATED' : 'INFO';
  return `${a.icon} <b>${a.title}</b>\n` +
    `Severity ${sev}${S.isNum(a.confidence) ? ` · confidence ${a.confidence}%` : ''}\n` +
    `${a.text}\n` +
    `<i>Market-structure intelligence, not financial advice. Verify on your platform before trading.</i>`;
}

module.exports = { buildAlerts, formatTelegram, coinRules, RULES, COOLDOWN_MS };
