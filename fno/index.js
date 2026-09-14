/* ============================================================
   F&O — ORCHESTRATOR

   Wires the six modules into one pass and owns the ordering, which is not arbitrary:

     instruments → which contracts exist, and the lot size everything else scales off
     chain       → the forward from parity, then the vol surface built on that forward
     vol         → is this volatility cheap, using the chain's ATM IV and the index's own history
     strategy    → what to trade given that read, the user's capital and their risk budget
     costs       → charged into every candidate before any of them is ranked
     signal      → the plan for whichever one won

   DEPENDENCIES ARE INJECTED, exactly as intel/index.js and paper.js do it. This module never
   requires server.js — that would be circular — and never opens its own price connection.
   `quotes` and `candles` arrive from the caller, which is what guarantees the options tab and the
   index card beside it are reading the same feed.

   IT REUSES THE MACRO WORK RATHER THAN REPEATING IT. The India VIX series comes from
   intel/macroData.js, which is already fetching it for the Market Health panel, and the event
   calendar comes from intel/calendar.js, which already knows when CPI and the FOMC land. Two
   feeds that were already running now do double duty; no new pipeline, no new failure mode.

   FAILURE POLICY, inherited from the rest of the platform: a stage that cannot run returns
   `ok:false` with a reason and the pass continues. No instrument master must not blank the
   volatility read; no IV history must not blank the chain.
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');

const createInstruments = require('./instruments');
const createCosts = require('./costs');
const BS = require('./bs');
const CH = require('./chain');
const VOL = require('./vol');
const ST = require('./strategy');
const SIG = require('./signal');

const TTL = 45 * 1000;                 // matches the dashboard's refresh cadence
const STRIKE_WINDOW = 18;              // strikes either side of the money to quote on the main expiry
const TERM_WINDOW = 4;                 // and on the further expiries, which only need an ATM vol
const TERM_EXPIRIES = 3;               // how many expiries the term structure is built from
const IV_HISTORY_MAX = 4000;

const isNum = v => typeof v === 'number' && isFinite(v);

module.exports = function createFno(deps) {
  const d = deps || {};
  const dir = d.dir || path.join(__dirname, '..');
  const instruments = createInstruments({ cacheFile: d.instrumentCache, fetchImpl: d.fetchImpl });
  const costs = createCosts({ file: d.costFile });
  const now = d.now || (() => Date.now());

  let cache = new Map();
  let lastError = null;

  /* ---- IV history: one at-the-money reading per underlying per session ----
     The same JSONL-and-trim shape as intel/history.js. It exists so that in about a quarter this
     platform can compute an IV percentile from its own recorded data instead of leaning on the
     India VIX substitute — and so BANKNIFTY and SENSEX, which have no volatility index at all,
     eventually get one too. */
  const IV_FILE = path.join(dir, 'fno-iv-history.jsonl');
  let ivRows = null, ivWriteFails = 0;

  function ivLoad() {
    if (ivRows) return ivRows;
    try {
      ivRows = fs.readFileSync(IV_FILE, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { ivRows = []; }
    return ivRows;
  }

  function ivRecord(underlying, iv, atmDays) {
    if (!isNum(iv) || iv <= 0) return false;
    const rows = ivLoad();
    const day = new Date(now() + 5.5 * 3600000).toISOString().slice(0, 10);   // IST day
    // One row per underlying per day — the last reading of the session wins.
    const i = rows.findIndex(r => r.u === underlying && r.d === day);
    const row = { u: underlying, d: day, iv: +iv.toPrecision(6), dte: atmDays != null ? +atmDays.toFixed(1) : null, ts: now() };
    if (i >= 0) rows[i] = row; else rows.push(row);
    if (rows.length > IV_HISTORY_MAX) rows.splice(0, rows.length - IV_HISTORY_MAX);
    try { fs.writeFileSync(IV_FILE, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); }
    catch { ivWriteFails++; return false; }
    return true;
  }

  const ivSeries = u => ivLoad().filter(r => r.u === u).map(r => r.iv);

  /* India VIX arrives from the macro adapter in PERCENTAGE POINTS (13.5), while every implied vol
     in this stack is a fraction (0.135). Comparing them without dividing would put the percentile
     a hundred times out and read every market as historically calm. */
  async function indiaVixSeries() {
    if (!d.macroData || !d.macroData.load) return [];
    try {
      const m = await d.macroData.load();
      const s = m && m.available && m.data && m.data.series && m.data.series.INDIAVIX;
      if (!s || !s.dates) return [];
      return s.dates.map(dt => s.closes[dt] / 100).filter(v => isNum(v) && v > 0);
    } catch { return []; }
  }

  /* ============================================================
     ONE EXPIRY, FULLY ANALYSED
     ============================================================ */
  async function analyseExpiry(master, underlying, expiryMs, width, spotHint) {
    const chainDef = instruments.chain(master, underlying, expiryMs);
    if (!chainDef) return { ok: false, reason: `expiry ${new Date(expiryMs).toISOString().slice(0, 10)} is not listed for ${underlying}` };

    /* Seed the strike window from the previous forward if we have one, else from the middle of
       the listed range — which is a reasonable proxy for the money, since exchanges list strikes
       symmetrically around it. Either way the forward itself is derived from parity afterwards,
       so a poor seed costs a few wasted quotes and nothing else. */
    const seed = isNum(spotHint) ? spotHint
      : chainDef.strikes[Math.floor(chainDef.strikes.length / 2)];
    const keys = instruments.quoteKeys(chainDef, seed, width);
    if (!keys.length) return { ok: false, reason: 'no instrument keys around the money on this expiry' };

    let quotes = {};
    try { quotes = await d.quotes(keys); }
    catch (e) {
      // The quote loader now reports the actual HTTP status and what it tried, so pass the whole
      // thing through rather than truncating it into a shrug.
      return { ok: false, reason: 'quote fetch failed — ' + String(e.message || e).slice(0, 400) };
    }
    if (!quotes || !Object.keys(quotes).length) {
      return { ok: false, reason: 'the quote feed returned an empty result for this expiry. If the market is closed there may be no live board; if it is open, check the Upstox login on the dashboard.' };
    }

    const out = CH.analyse({ chain: chainDef, quotes, now: now(), r: isNum(d.rate) ? d.rate : 0.065, spotHint: seed });
    // A degraded feed is still a feed — but the panel has to say which one it got.
    if (out.ok && quotes.__degraded) {
      out.quality.warnings.unshift(quotes.__degraded);
      out.quality.feedDegraded = true;
    }
    return out;
  }

  /* ============================================================
     THE FULL PASS
     ============================================================ */
  async function board(opts) {
    const o = opts || {};
    const underlying = String(o.underlying || 'NIFTY').toUpperCase();
    const capital = isNum(o.capital) ? o.capital : null;
    const riskPct = isNum(o.riskPct) ? o.riskPct : 0.02;
    const view = o.view || 'unsure';

    const ck = JSON.stringify([underlying, o.expiry || 0, capital, riskPct, view, o.targetLevel || 0, o.allowUndefinedRisk || false]);
    const hit = cache.get(ck);
    if (!o.force && hit && now() - hit.at < TTL) return hit.v;

    const out = { ok: false, underlying, ts: now() };

    /* ---- 1. the contract master ---- */
    const master = await instruments.load(o.force);
    if (!master.available) {
      out.reason = master.reason;
      out.stage = 'instruments';
      /* DO NOT SEND THE USER AFTER A FIREWALL BY DEFAULT. assets.upstox.com is object storage,
         which answers a request for a key that does not exist with 403 rather than 404 whenever
         listing is denied — so "blocked" and "no such file" are indistinguishable from the status
         code alone. The Stocks tab pulls NSE.json.gz off the same host every day, and that is the
         one observation that tells the two apart, so the hint leads with it. */
      out.hint = 'The contract master could not be read. Check the Stocks tab first: it downloads NSE.json.gz '
        + 'from the same host (assets.upstox.com) every day. If Stocks is populated, the host is reachable and '
        + 'this is not a network problem — it means none of the candidate files contained index derivatives, '
        + 'which is a schema change worth reporting. If Stocks is ALSO empty, the host is genuinely blocked '
        + 'from this server.';
      lastError = master.reason;
      return out;
    }
    out.warnings = (master.data.warnings || []).slice(0, 6);
    /* Which of the candidate master files actually worked. Worth surfacing rather than burying:
       the filename could not be verified from the build sandbox, so the first live run is what
       settles it — and the answer should be visible without reading a log. */
    out.instrumentSource = master.data.sources || null;

    const exps = instruments.expiries(master.data, underlying, { now: now(), minHoursLeft: isNum(o.minHoursLeft) ? o.minHoursLeft : 0 });
    if (!exps.length) {
      out.reason = `no unexpired contracts listed for ${underlying}`;
      out.stage = 'expiries';
      return out;
    }
    out.expiries = exps.slice(0, 8);

    const wantExpiry = isNum(o.expiry) ? Number(o.expiry) : exps[0].expiry;

    /* ---- 2. the chain ---- */
    const a = await analyseExpiry(master.data, underlying, wantExpiry, STRIKE_WINDOW, o.spot);
    if (!a.ok) {
      out.reason = a.reason;
      out.stage = 'chain';
      lastError = a.reason;
      return out;
    }
    out.chain = a;
    out.ok = true;

    if (isNum(a.atmIv)) ivRecord(underlying, a.atmIv, a.daysLeft);

    /* ---- 3. the term structure: the ATM vol of the next couple of expiries ----
       Only a narrow band is quoted on those, because all that is needed from them is an
       at-the-money implied vol. */
    const termPoints = [{ days: a.daysLeft, iv: a.atmIv, expiry: a.expiry, label: a.expiryDate }];
    for (const e of exps.slice(0, TERM_EXPIRIES)) {
      if (e.expiry === wantExpiry) continue;
      const b = await analyseExpiry(master.data, underlying, e.expiry, TERM_WINDOW, a.forward);
      if (b.ok && isNum(b.atmIv)) termPoints.push({ days: b.daysLeft, iv: b.atmIv, expiry: b.expiry, label: b.expiryDate });
      if (termPoints.length >= TERM_EXPIRIES) break;
    }
    const term = VOL.termStructure(termPoints);

    /* ---- 4. the volatility read ---- */
    let realized = { ok: false, reason: 'no daily candles for the underlying' };
    let moveComparison = { ok: false };
    const und = instruments.underlying(master.data, underlying);
    if (d.candles && und) {
      try {
        const c = await d.candles(und.spotKey || (und.futures[0] && und.futures[0].key), 'daily');
        if (c && Array.isArray(c.close) && c.close.length > 30) {
          const rows = c.close.map((cl, i) => ({
            c: cl, h: c.high ? c.high[i] : null, l: c.low ? c.low[i] : null, o: c.open ? c.open[i] : null
          }));
          realized = VOL.realizedVol(rows, { window: 20 });
          if (a.expectedMove && isNum(a.expectedMove.pct)) {
            moveComparison = VOL.impliedVsRealisedMove({
              impliedPct: a.expectedMove.pct, closes: c.close,
              horizonDays: Math.max(1, Math.round(a.daysLeft * 5 / 7))     // calendar days → sessions
            });
          }
        }
      } catch (e) { realized = { ok: false, reason: 'candle fetch failed: ' + String(e.message || e).slice(0, 80) }; }
    }

    const hist = VOL.resolveIvHistory(underlying, { own: ivSeries(underlying), indiaVix: await indiaVixSeries() });
    const ivPct = hist.series
      ? VOL.ivPercentile(a.atmIv, hist.series, { source: hist.source, sourceNote: hist.note })
      : { ok: false, reason: hist.note, source: null };

    const vrp = VOL.varianceRiskPremium({ iv: a.atmIv, rv: realized.ok ? realized.recommended : null });

    /* Scheduled event risk, straight from the macro calendar the crypto side already maintains. */
    let event = null;
    if (d.calendar && d.calendar.eventRisk) {
      try {
        const er = d.calendar.eventRisk();
        const next = er && er.next;
        if (next && isNum(next.at) && next.at <= a.expiry) {
          event = { inWindow: true, label: next.label, at: next.at, impact: next.impact, beforeExpiry: true };
        } else if (er && er.blocked) {
          event = { inWindow: true, label: (next && next.label) || 'a scheduled high-impact event', at: next && next.at, impact: 'high' };
        }
      } catch (e) { /* the calendar is advisory; a bad edit must not take the options tab down */ }
    }

    const assessment = VOL.assess({ ivPercentile: ivPct, vrp, moveComparison, termStructure: term, event });
    out.vol = {
      atmIv: a.atmIv, realized, ivPercentile: ivPct, ivHistory: { source: hist.source, exact: hist.exact, note: hist.note, own: ivSeries(underlying).length },
      vrp, termStructure: term, moveComparison, event, assessment
    };

    /* ---- 5. structures, sized against the user's capital ---- */
    if (capital) {
      out.strategy = ST.propose({
        analysis: a, vol: assessment, capital, riskPct, view, costs,
        allowUndefinedRisk: o.allowUndefinedRisk === true
      });
      if (out.strategy.ok && out.strategy.best) {
        out.plan = SIG.plan({
          candidate: out.strategy.best, analysis: a, vol: assessment, costs,
          now: now(), targetLevel: isNum(o.targetLevel) ? o.targetLevel : null,
          eventInWindow: !!(event && event.inWindow),
          eventBlocked: !!(event && event.impact === 'high' && o.respectEvents !== false && event.blocked)
        });
      }
    } else {
      out.strategy = { ok: false, reason: 'enter your available capital to see structures and position sizes — every number in that section scales off it' };
    }

    out.costRates = { asOf: costs.rates().asOf, verified: costs.rates().verified === true, source: costs.rates().source };
    cache.set(ck, { at: now(), v: out });
    if (cache.size > 40) cache = new Map([...cache.entries()].slice(-20));
    return out;
  }

  /* ---- lighter endpoints ---- */

  async function list() {
    const m = await instruments.load();
    if (!m.available) return { ok: false, reason: m.reason };
    const out = [];
    for (const k of Object.keys(createInstruments.UNDERLYINGS)) {
      const u = instruments.underlying(m.data, k);
      if (!u) continue;
      const exps = instruments.expiries(m.data, k, { now: now() });
      out.push({
        key: k, name: u.name, exchange: u.exchange, tier: u.tier,
        expiries: exps.slice(0, 8),
        lotSize: exps[0] ? exps[0].lotSize : null
      });
    }
    return { ok: true, underlyings: out, warnings: m.data.warnings || [], asOf: m.asOf, source: m.source };
  }

  /* The expiry decision on a position the user actually holds. Reuses the cost model directly —
     there is nothing to add here beyond passing the numbers through. */
  function expiryDecision(q) {
    return costs.expiryDecision(q);
  }

  return {
    board, list, expiryDecision,
    instruments, costs,
    ivStats: () => ({ file: IV_FILE, rows: ivLoad().length, writeFails: ivWriteFails, byUnderlying: ivLoad().reduce((m, r) => (m[r.u] = (m[r.u] || 0) + 1, m), {}) }),
    lastError: () => lastError,
    __ivRecord: ivRecord,
    /* null, not [] — an empty array is truthy, so the lazy loader would serve the stale cache
       forever and never notice the file underneath it had changed. */
    __resetIv: () => { ivRows = null; try { fs.unlinkSync(IV_FILE); } catch { } }
  };
};

module.exports.STRIKE_WINDOW = STRIKE_WINDOW;
