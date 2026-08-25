/* ============================================================
   INTEL — ORCHESTRATOR

   Wires the engines into one snapshot and owns the ordering, which is not arbitrary: breadth's
   altcoin-stress score consumes correlation and beta, the cascade detector consumes breadth,
   correlation, open interest and funding, and the regime classifier consumes all of them. Each
   engine is a pure function of what came before it, so the whole thing is a single pass with no
   circular reads and nothing recomputed twice.

   DEPENDENCIES ARE INJECTED, exactly as paper.js does it. This module never requires server.js —
   that would be circular — and never opens its own price connection. `loadCrypto`, `ticker24`,
   `zigzag` and `resampleSeries` all arrive from the caller, which is what guarantees the Market
   Health panel and the card next to it are reading the same candles.

   FAILURE POLICY: an engine that cannot run returns `ok:false` with a reason and the pass
   continues. One unreachable futures venue must never blank the breadth panel, and a coin with a
   broken series must never take down the regime read.
   ============================================================ */

const createData = require('./data');
const createDerivs = require('./derivs');
const createGlobal = require('./global');
const createHistory = require('./history');
const createMacroData = require('./macroData');
const createCalendar = require('./calendar');
const { macroEngine } = require('./macro');
const { attribution } = require('./attribution');
const { fragility } = require('./fragility');
const createMomentum = require('./momentum');
const { breadth } = require('./breadth');
const { correlation } = require('./correlation');
const { betaEngine, coinVsMarket } = require('./beta');
const { structure } = require('./structure');
const { transmission } = require('./transmission');
const { openInterestEngine } = require('./openInterest');
const { fundingEngine } = require('./funding');
const { liquidityEngine } = require('./liquidity');
const { liquidationEngine } = require('./liquidation');
const { recoveryEngine } = require('./recovery');
const { positionRisk } = require('./positionRisk');
const { classify, whyNarrative, sectorWeakness } = require('./regime');
const { buildAlerts, formatTelegram, coinRules } = require('./alerts');
const S = require('./stats');

const TTL = 45 * 1000;               // matches the dashboard's refresh cadence
const DERIV_TOP = 12;                // symbols we spend per-symbol futures requests on

module.exports = function createIntel(deps) {
  const d = deps || {};
  const data = createData(d);
  const derivs = createDerivs({ enabled: d.derivsEnabled, maxPerSymbol: DERIV_TOP, maxDepth: 8 });
  const globalStats = createGlobal({ coingeckoKey: d.coingeckoKey });
  const history = createHistory({ dir: d.dir || __dirname });
  const macroData = createMacroData({ enabled: d.macroEnabled });
  const calendar = createCalendar({ dir: d.dir || require('path').join(__dirname, '..') });
  const zigzag = d.zigzag || (() => []);
  const momentum = createMomentum({});

  let cache = null, cacheAt = 0, inflight = null;
  let alertState = {};
  let lastError = null;

  async function compute() {
    const snap = await data.snapshot();
    if (!snap || !snap.tickers.length) {
      return { ok: false, ts: Date.now(), reason: 'No crypto series could be loaded. ' + (snap && snap.errors.length ? snap.errors.slice(0, 3).map(e => `${e.tk}: ${e.err}`).join('; ') : ''), errors: (snap && snap.errors) || [] };
    }

    // --- pure engines over the snapshot -------------------------------------------------
    const corr = correlation(snap);
    const betas = betaEngine(snap);
    const br = breadth(snap, {
      zigzag,
      avgCorrBtc: corr.ok ? corr.avgCorrBtc : null,
      altDownsideBeta: betas.ok ? betas.altDownsideBeta : null
    });
    const trans = transmission(snap);
    const btcStructure = snap.coins.BTC ? structure(snap.coins.BTC.h1 && snap.coins.BTC.h1.close, zigzag) : { ok: false, reason: 'no BTC series' };
    const ethStructure = snap.coins.ETH ? structure(snap.coins.ETH.h1 && snap.coins.ETH.h1.close, zigzag) : { ok: false, reason: 'no ETH series' };

    // --- external adapters, all best-effort and all in parallel -------------------------
    const topByVol = snap.tickers.slice().sort((a, b) => (+snap.coins[b].qv || 0) - (+snap.coins[a].qv || 0)).slice(0, DERIV_TOP);
    const wanted = Array.from(new Set(['BTC', 'ETH'].concat(topByVol, d.extraSymbols || []))).filter(t => snap.coins[t]).slice(0, DERIV_TOP);

    const [fundingRaw, oiRaw, depthRaw, fundHistRaw, dom, macroRaw] = await Promise.all([
      derivs.funding().catch(e => ({ available: false, reason: String(e.message || e) })),
      derivs.openInterest(wanted).catch(e => ({ available: false, reason: String(e.message || e) })),
      derivs.depth((d.depthSymbols || []).concat(wanted.slice(0, 4))).catch(e => ({ available: false, reason: String(e.message || e) })),
      derivs.fundingHistory(wanted).catch(e => ({ available: false, reason: String(e.message || e) })),
      globalStats.dominance().catch(e => ({ available: false, reason: String(e.message || e) })),
      macroData.load().catch(e => ({ available: false, reason: String(e.message || e) }))
    ]);

    /* Event risk is computed from a LOCAL FILE and is therefore never knocked out by a network
       failure. That is deliberate: "do not open leverage into CPI" is the single most valuable
       guard in this module, and it must not depend on the least reliable thing in it. */
    let eventRisk;
    try { eventRisk = calendar.eventRisk(); }
    catch (e) { eventRisk = { ok: false, configured: false, inWindow: false, reason: 'calendar unreadable: ' + String(e.message || e) }; }
    const macro = macroEngine(macroRaw, snap, eventRisk);
    /* WHICH factor is moving crypto, and whether the current move is supported by its own
       internals. Attribution runs first — fragility consumes it to spot a rally that is
       decoupling upward from the equity benchmark it normally tracks. */
    const attrib = attribution(macroRaw, snap);

    const oi = openInterestEngine(snap, oiRaw);
    const funding = fundingEngine(snap, fundingRaw, fundHistRaw, { btcRet4h: br.ok ? br.btc.ret4h : null });
    const liquidity = liquidityEngine(snap, depthRaw);

    // --- composite engines --------------------------------------------------------------
    const liquidation = liquidationEngine(snap, {
      breadth: br, correlation: corr, oi, funding,
      liquidations: await derivs.liquidations()
    });
    const recovery = recoveryEngine(snap, { zigzag, oi, funding });
    const sector = sectorWeakness(snap);

    const frag = fragility(snap, { zigzag, IND: d.IND, breadth: br, macro, attribution: attrib, funding, oi });

    const regime = classify({ breadth: br, correlation: corr, transmission: trans, liquidation, oi, funding, liquidity, recovery, sector, btcStructure, macro, fragility: frag });
    const why = whyNarrative({ breadth: br, transmission: trans, liquidation, oi, funding, beta: betas, recovery, regimeInfo: regime, correlation: corr, macro, attribution: attrib, fragility: frag });

    // Prices kept for the history store's forward-return scoring.
    const prices = {};
    for (const tk of ['BTC', 'ETH'].concat(topByVol)) if (snap.coins[tk] && snap.coins[tk].price > 0) prices[tk] = snap.coins[tk].price;

    /* Data-quality strip. The UI renders this verbatim — every conclusion on the page is only as
       good as this block, so it is never collapsed or hidden behind a toggle. */
    const dataQuality = {
      coinsLoaded: snap.tickers.length,
      coinsFailed: snap.errors.length,
      priceAgeMs: Date.now() - (snap.fineAt || snap.ts),
      delayed: Date.now() - (snap.fineAt || snap.ts) > 5 * 60 * 1000,
      available: {
        prices: true, breadth: br.ok, correlation: corr.ok, beta: betas.ok,
        openInterest: oi.available, funding: funding.available,
        orderBookDepth: liquidity.depthAvailable, liquidations: false,
        btcDominance: dom.available,
        macro: macro.available, eventCalendar: !!(eventRisk && eventRisk.configured && !eventRisk.stale)
      },
      unavailable: [
        !oi.available ? { k: 'openInterest', why: oi.reason } : null,
        !funding.available ? { k: 'funding', why: funding.reason } : null,
        !liquidity.depthAvailable ? { k: 'orderBookDepth', why: liquidity.depthReason } : null,
        { k: 'liquidations', why: 'No public REST source; only a WebSocket stream this server does not hold open. The cascade detector runs INFERRED and is confidence-capped.' },
        !dom.available ? { k: 'btcDominance', why: dom.reason } : null,
        !macro.available ? { k: 'macro', why: macro.reason } : null,
        (eventRisk && (!eventRisk.configured || eventRisk.stale)) ? { k: 'eventCalendar', why: eventRisk.reason } : null
      ].filter(Boolean),
      errors: snap.errors.slice(0, 8)
    };

    return {
      ok: true, ts: Date.now(),
      regime, why,
      breadth: br, correlation: corr, beta: betas, transmission: trans,
      structure: { btc: btcStructure, eth: ethStructure },
      oi, funding, liquidity, liquidation, recovery, sector,
      macro, eventRisk, attribution: attrib, fragility: frag,
      /* Hoisted to the top level because this is what other surfaces act on: the scanner
         degrades its confidence by `confidenceMultiplier`, the paper bot refuses to open while
         `blockNewLeverage` is set, and the position panel prints `reasons` verbatim. */
      gate: macro.gate,
      dominance: {
        available: dom.available, value: dom.value, reason: dom.reason,
        volumeShare: globalStats.volumeShare(snap),
        volumeShareNote: 'BTC share of tracked 24h traded value — a participation read, NOT market-cap dominance.'
      },
      universe: snap.tickers,
      dataQuality,
      __prices: prices
    };
  }

  async function get(force) {
    if (!force && cache && Date.now() - cacheAt < TTL) return { ...cache, cached: true };
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const r = await compute();
        if (r.ok) { cache = r; cacheAt = Date.now(); }
        lastError = r.ok ? null : r.reason;
        return r;
      } catch (e) {
        lastError = String((e && e.message) || e);
        if (cache) return { ...cache, cached: true, staleError: lastError };
        return { ok: false, ts: Date.now(), reason: lastError };
      } finally { inflight = null; }
    })();
    return inflight;
  }

  /* One position, fully contextualised. Reuses the cached market pass — a position card must
     never trigger 80 candle fetches of its own. */
  async function position(pos, opts) {
    const intel = await get();
    if (!intel.ok) return { ok: false, reason: intel.reason };
    const snap = await data.snapshot();
    return positionRisk(pos, snap, {
      breadth: intel.breadth, correlation: intel.correlation, beta: intel.beta,
      oi: intel.oi, funding: intel.funding, liquidity: intel.liquidity,
      liquidation: intel.liquidation, recovery: intel.recovery, regimeInfo: intel.regime,
      macro: intel.macro, eventRisk: intel.eventRisk
    }, { zigzag, ...(opts || {}) });
  }

  async function coinContext(tk) {
    const intel = await get();
    if (!intel.ok) return { ok: false, reason: intel.reason };
    const snap = await data.snapshot();
    if (!snap.coins[tk]) return { ok: false, reason: `${tk} is not in the tracked universe` };
    return {
      ok: true, tk,
      vsMarket: coinVsMarket(tk, snap, intel.beta, intel.correlation),
      structure: structure(snap.coins[tk].h1 && snap.coins[tk].h1.close, zigzag),
      beta: intel.beta.ok ? intel.beta.coins[tk] : null,
      liquidity: intel.liquidity.ok ? intel.liquidity.coins[tk] : null,
      funding: intel.funding.available ? intel.funding.coins[tk] : null,
      oi: intel.oi.available ? intel.oi.coins[tk] : null,
      regime: intel.regime
    };
  }

  /* The background loop: refresh, record for the backtester, and emit any alerts that just
     transitioned. Called on a timer by server.js. */
  async function tick(opts) {
    const o = opts || {};
    const intel = await get(true);
    if (!intel.ok) return { ok: false, reason: intel.reason, alerts: [] };
    try { history.record(intel); } catch (e) { /* history is best-effort; never block alerts */ }

    // Per-coin alerts only for coins the trader actually holds.
    const coinAlerts = [];
    if (o.watchedCoins && o.watchedCoins.length) {
      const snap = await data.snapshot();
      for (const tk of o.watchedCoins) {
        if (!snap.coins[tk]) continue;
        coinAlerts.push(...coinRules(coinVsMarket(tk, snap, intel.beta, intel.correlation), tk));
      }
    }
    const { alerts, state } = buildAlerts(intel, alertState, { coinAlerts, cooldownMs: o.cooldownMs });
    alertState = state;
    return { ok: true, alerts, regime: intel.regime.regime, ts: intel.ts };
  }

  /* The gate, on its own and cheap to call.
     The paper bot asks this every minute and the scanner asks it on every render, so it must not
     drag a full market pass behind it — `get()` is cached, and a failure here fails OPEN with the
     reason attached rather than silently blocking every trade the platform would ever suggest. */
  async function gate() {
    /* THE EVENT BLOCK IS COMPUTED FIRST AND INDEPENDENTLY.
       An earlier version read the gate straight off the cached market pass, which quietly tied
       "do not open leverage into CPI" to two things it has no business depending on: a 45-second
       market-data cache, and the crypto pass succeeding at all. If CoinDCX were unreachable the
       whole intel pass would fail and the event block would vanish with it — losing the one
       protection here that needs no network. The calendar is a local file; it is read on every
       call, and it wins regardless of what the rest of the pass did. */
    let ev = null;
    try { ev = calendar.eventRisk(); } catch (e) { ev = null; }
    const evBlock = !!(ev && ev.ok && ev.inWindow);
    const evReason = evBlock ? ev.message : null;

    const merge = base => ({
      ...base,
      blockNewLeverage: base.blockNewLeverage || evBlock,
      blockLongs: base.blockLongs || evBlock,
      blockShorts: base.blockShorts || evBlock,
      confidenceMultiplier: evBlock ? Math.min(base.confidenceMultiplier, 0.4) : base.confidenceMultiplier,
      degraded: base.degraded || evBlock,
      reasons: evBlock && !base.reasons.includes(evReason) ? [evReason, ...base.reasons] : base.reasons,
      eventRisk: ev
    });

    const permissive = reason => merge({
      ok: false, blockNewLeverage: false, blockLongs: false, blockShorts: false,
      confidenceMultiplier: 1, degraded: false, reasons: [reason]
    });

    try {
      const i = await get();
      if (i.ok && i.gate) return merge({ ...i.gate, ok: true, ts: i.ts });
      return permissive('Market intelligence unavailable: ' + (i.reason || 'unknown') + ' — macro gating is OFF, technical signals are unchecked.');
    } catch (e) {
      return permissive('Macro gate errored (' + String(e.message || e).slice(0, 60) + ') — macro gating is OFF.');
    }
  }

  return {
    get, position, coinContext, tick, gate,
    /* The momentum detector is deliberately OUTSIDE the 45s market pass. It reads the ticker
       buffer directly, so a caller gets a sub-minute answer without waiting on a candle sweep —
       which is the entire point of it existing. */
    momentum,
    calendar, macroData,
    history,
    derivsHealth: () => derivs.health(),
    formatTelegram,
    __data: data,
    __alertState: () => alertState,
    __resetAlerts: () => { alertState = {}; },
    lastError: () => lastError
  };
};
