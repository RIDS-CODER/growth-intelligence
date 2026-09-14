/* ============================================================
   F&O — INSTRUMENT MASTER

   Everything downstream needs to know which contracts exist: which underlyings have options,
   which expiries are listed, which strikes, and — the one that decides how much money is at
   risk per trade — the LOT SIZE.

   THE LOT SIZE IS NEVER WRITTEN DOWN IN THIS CODEBASE.
   NIFTY has been 75, then 50, then 25, then 50, then 75. BANKNIFTY has been 25, 20, 15, 30, 35.
   The exchange revises them by circular to keep contract value inside a mandated band, and the
   revision takes effect on a specific expiry. A hardcoded lot size is therefore not a
   simplification, it is a time bomb: every position size, every margin estimate and every rupee
   of projected P&L in this platform scales linearly off it, so a stale constant silently
   misstates risk by tens of percent until someone notices. It is read from the exchange's own
   master on every load, and a contract that arrives without one is DROPPED rather than defaulted.

   THE SAME APPLIES TO EXPIRY DAYS. NIFTY weeklies have moved between Thursday and Tuesday;
   SEBI cut the number of weekly expiries per exchange in 2024. So this file contains no
   weekday rule at all — the listed expiries are read from the master and sorted. Nothing here
   can go stale when the exchange changes its calendar, because nothing here encodes one.

   SANDBOX LIMITATION, STATED PLAINLY: the build environment's proxy returns 403 for every
   outbound market endpoint, including assets.upstox.com, which this server reaches successfully
   in production. The parser below therefore could NOT be run against a live master. It is
   written tolerantly — accepting the several field spellings the existing server.js loaders
   already accept — and, more importantly, it REPORTS what it failed to find rather than
   returning a confidently empty chain. If Upstox renames a field, `warnings` says so on the
   dashboard instead of the options tab quietly showing nothing.
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REQ_TIMEOUT = 30000;                 // the F&O master is tens of megabytes
const ASSETS = 'https://assets.upstox.com/market-quote/instruments/exchange';

/* The index underlyings worth trading. "Good scope" in the user's phrasing means enough
   liquidity that the spread does not eat the edge — and that is measured, not asserted: chain.js
   ranks what it actually sees. This list is the candidate set, not a claim about any of them.

   spotKey is present only for the three whose Upstox index keys are already confirmed elsewhere
   in this codebase (server.js INDICES). The others are left null deliberately rather than
   guessed, and nothing here depends on having one — the forward is derived from put-call parity
   on the chain itself, which needs no spot input at all. */
const UNDERLYINGS = {
  NIFTY: { name: 'NIFTY 50', exchange: 'NSE', file: 'NSE_FO', spotKey: 'NSE_INDEX|Nifty 50', match: ['NIFTY', 'NIFTY50'], tier: 1 },
  BANKNIFTY: { name: 'Bank NIFTY', exchange: 'NSE', file: 'NSE_FO', spotKey: 'NSE_INDEX|Nifty Bank', match: ['BANKNIFTY', 'NIFTYBANK'], tier: 1 },
  SENSEX: { name: 'SENSEX', exchange: 'BSE', file: 'BSE_FO', spotKey: 'BSE_INDEX|SENSEX', match: ['SENSEX'], tier: 1 },
  FINNIFTY: { name: 'Nifty Financial Services', exchange: 'NSE', file: 'NSE_FO', spotKey: null, match: ['FINNIFTY'], tier: 2 },
  MIDCPNIFTY: { name: 'Nifty Midcap Select', exchange: 'NSE', file: 'NSE_FO', spotKey: null, match: ['MIDCPNIFTY'], tier: 2 },
  BANKEX: { name: 'BANKEX', exchange: 'BSE', file: 'BSE_FO', spotKey: null, match: ['BANKEX'], tier: 2 }
};

/* ---- WHERE THE MASTER ACTUALLY COMES FROM ----

   Upstox publishes instrument files at assets.upstox.com, and the naming is NOT something this
   codebase can verify from a build sandbox — every request to that host is blocked here, so a
   wrong URL and a blocked one look identical.

   What IS known, from the loader in server.js that has worked in production since day one:
   `NSE.json.gz` is a PER-EXCHANGE file containing several segments. It has to be, because that
   loader filters `segment === "NSE_EQ"` out of it — there would be nothing to filter if the file
   held only equities. So the derivatives are very likely inside `NSE.json.gz` rather than in a
   separate `NSE_FO.json.gz`, and a segment-level file may not exist at all.

   THAT AMBIGUITY MUST NOT SIT ON THE CRITICAL PATH. assets.upstox.com is object storage, and
   object storage answers a request for a key that does not exist with 403 Forbidden rather than
   404 whenever listing is denied — which is the default. So "the file is not there" and "you are
   blocked" produce the same status code, and guessing wrong would present as an unfixable
   network fault on a perfectly healthy server.

   So each logical master is a CHAIN of candidates, tried in order, and a candidate only counts as
   a success if it actually yields contracts. The second entry in every chain is the file this
   codebase already downloads successfully every day, which makes the fallback proven rather than
   hopeful. Whichever one worked is reported, so the answer stops being a guess after the first
   live run. */
const SOURCES = {
  NSE_FO: ['NSE_FO', 'NSE', 'complete'],
  BSE_FO: ['BSE_FO', 'BSE', 'complete']
};

const isNum = v => typeof v === 'number' && isFinite(v);
const off = reason => ({ available: false, reason, asOf: null, data: null });

/* ---- tolerant field readers ----
   server.js's existing loaders already accept several spellings for the same field because the
   master has not been consistent about them. These follow suit, and every one of them is
   permitted to fail: a missing value returns null and the caller decides whether that is fatal
   for this row. Nothing is defaulted. */
const pick = (o, keys) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return null;
};
const num = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : null;
};

/* Expiry arrives as epoch milliseconds on some rows and as a date string on others — the MCX
   loader in server.js already handles both, so this does too. */
function parseExpiry(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!isFinite(v) || v <= 0) return null;
    return v > 1e12 ? v : v * 1000;               // seconds or milliseconds
  }
  const n = Number(v);
  if (isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const t = Date.parse(v);
  return isFinite(t) ? t : null;
}

const OPT_TYPES = { CE: 'CE', PE: 'PE', CALL: 'CE', PUT: 'PE' };

/* Classify one row of the master. Returns null for anything that is not an index option or
   future on a tracked underlying, which is the overwhelming majority of a 60,000-row file. */
function classify(row, wantMatch) {
  const key = pick(row, ['instrument_key', 'instrumentKey']);
  if (!key) return null;

  const asset = String(pick(row, ['asset_symbol', 'underlying_symbol', 'assetSymbol', 'underlyingSymbol', 'name']) || '').toUpperCase().trim();
  if (!asset || !wantMatch.has(asset)) return null;

  const rawType = String(pick(row, ['instrument_type', 'instrumentType', 'option_type', 'optionType']) || '').toUpperCase().trim();
  const expiry = parseExpiry(pick(row, ['expiry', 'expiry_date', 'expiryDate']));
  if (!expiry) return null;

  const tsym = String(pick(row, ['trading_symbol', 'tradingsymbol', 'tradingSymbol', 'name']) || '');

  /* LOT SIZE IS MANDATORY. A contract whose lot size cannot be read is unusable — every
     position-sizing and risk number downstream is a multiple of it — so the row is dropped and
     counted rather than being filled in with the last value anyone remembered. */
  const lotSize = num(pick(row, ['lot_size', 'lotSize', 'minimum_lot', 'lot']));

  if (rawType === 'FUT' || rawType === 'FUTIDX' || rawType === 'FUTURE') {
    return { kind: 'FUT', key, asset, expiry, tradingSymbol: tsym, lotSize, tick: num(pick(row, ['tick_size', 'tickSize'])) };
  }
  const type = OPT_TYPES[rawType];
  if (!type) return null;
  const strike = num(pick(row, ['strike_price', 'strikePrice', 'strike']));
  if (!isNum(strike) || strike <= 0) return null;
  return { kind: 'OPT', key, asset, expiry, type, strike, tradingSymbol: tsym, lotSize, tick: num(pick(row, ['tick_size', 'tickSize'])) };
}

/* ============================================================
   THE LOADER
   ============================================================ */

function createInstruments(opts) {
  const cfg = opts || {};
  const doFetch = cfg.fetchImpl || ((url, init) => fetch(url, init));
  const cacheFile = cfg.cacheFile === null ? null : (cfg.cacheFile || path.join(__dirname, '..', 'fno-instruments.json'));
  const now = cfg.now || (() => Date.now());
  const files = cfg.files || null;                          // tests inject parsed rows directly
  const TTL = cfg.ttlMs || 6 * 60 * 60 * 1000;

  let cache = null, cacheAt = 0, inflight = null;

  const dayKey = () => new Date(now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);   // IST day

  async function fetchMaster(name) {
    const r = await doFetch(`${ASSETS}/${name}.json.gz`, { signal: AbortSignal.timeout(REQ_TIMEOUT) });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    /* The endpoint serves gzip, but some proxies transparently decompress and hand back plain
       JSON with the same URL. Sniff the magic bytes rather than assuming, because assuming
       produces an "incorrect header check" crash that looks like a network fault. */
    const gz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    const text = (gz ? zlib.gunzipSync(buf) : buf).toString('utf8');
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error(`${name}: master is not an array`);
    return arr;
  }

  /* Turn raw master rows into the nested shape everything else reads:
       underlying → expiry → strike → { CE, PE }
     plus the futures ladder and the per-expiry lot size. */
  function build(rowsByFile) {
    const warnings = [];
    const underlyings = {};
    let scanned = 0, kept = 0, droppedNoLot = 0;

    for (const [ukey, u] of Object.entries(UNDERLYINGS)) {
      const rows = rowsByFile[u.file];
      if (!rows) { warnings.push(`${ukey}: master file ${u.file} was not loaded`); continue; }

      const wantMatch = new Set(u.match);
      const expiries = {};
      const futures = [];
      let seen = 0;

      for (const row of rows) {
        scanned++;
        const c = classify(row, wantMatch);
        if (!c) continue;
        seen++;
        if (!isNum(c.lotSize) || c.lotSize <= 0) { droppedNoLot++; continue; }
        kept++;

        if (c.kind === 'FUT') { futures.push(c); continue; }

        const e = expiries[c.expiry] || (expiries[c.expiry] = { expiry: c.expiry, byStrike: {}, lotSizes: new Set(), tick: c.tick });
        const s = e.byStrike[c.strike] || (e.byStrike[c.strike] = { strike: c.strike, CE: null, PE: null });
        s[c.type] = { key: c.key, tradingSymbol: c.tradingSymbol, lotSize: c.lotSize, strike: c.strike, type: c.type, expiry: c.expiry };
        e.lotSizes.add(c.lotSize);
      }

      if (!seen) { warnings.push(`${ukey}: no contracts matched in ${u.file} — check the underlying symbol or the master schema`); continue; }

      const list = Object.values(expiries).sort((a, b) => a.expiry - b.expiry).map(e => {
        const lots = [...e.lotSizes];
        /* One expiry should have exactly one lot size. More than one means the master mixes
           contracts from either side of a revision, or the parser matched something it should
           not have. Either way the user is told rather than the engine picking one. */
        if (lots.length > 1) warnings.push(`${ukey} ${new Date(e.expiry).toISOString().slice(0, 10)}: ${lots.length} different lot sizes in one expiry (${lots.join(', ')}) — position sizing will use the most common`);
        const counts = {};
        for (const s of Object.values(e.byStrike)) {
          const l = (s.CE || s.PE).lotSize;
          counts[l] = (counts[l] || 0) + 1;
        }
        const lotSize = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
        const strikes = Object.keys(e.byStrike).map(Number).sort((a, b) => a - b);
        const paired = strikes.filter(k => e.byStrike[k].CE && e.byStrike[k].PE).length;
        return {
          expiry: e.expiry, lotSize, tick: e.tick,
          strikes, byStrike: e.byStrike,
          strikeCount: strikes.length, pairedStrikes: paired,
          strikeStep: strikes.length > 2 ? medianStep(strikes) : null
        };
      });

      underlyings[ukey] = {
        key: ukey, name: u.name, exchange: u.exchange, spotKey: u.spotKey, tier: u.tier,
        expiries: list,
        futures: futures.sort((a, b) => a.expiry - b.expiry)
      };
    }

    if (droppedNoLot) {
      warnings.push(`${droppedNoLot} contracts were dropped for having no readable lot size — every position size depends on it, so they are excluded rather than defaulted`);
    }
    if (!Object.keys(underlyings).length) {
      return { ok: false, reason: 'no tracked underlying produced any contracts — the master schema has probably changed', warnings, scanned };
    }
    return { ok: true, underlyings, warnings, scanned, kept, droppedNoLot };
  }

  function medianStep(sorted) {
    const d = [];
    for (let i = 1; i < sorted.length; i++) d.push(sorted[i] - sorted[i - 1]);
    d.sort((a, b) => a - b);
    return d[d.length >> 1];
  }

  function readCache() {
    if (!cacheFile) return null;
    try {
      const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (j && j.date === dayKey() && j.data) return j;
    } catch { /* a missing or corrupt cache is a cache miss, not an error */ }
    return null;
  }

  function writeCache(data) {
    if (!cacheFile) return;
    try { fs.writeFileSync(cacheFile, JSON.stringify({ date: dayKey(), at: now(), data })); } catch { /* best effort */ }
  }

  async function load(force) {
    if (!force && cache && now() - cacheAt < TTL) return cache;
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        if (!force) {
          const disk = readCache();
          if (disk) {
            cache = { available: true, reason: null, asOf: disk.at, data: revive(disk.data), source: 'disk cache' };
            cacheAt = now();
            return cache;
          }
        }

        const wanted = [...new Set(Object.values(UNDERLYINGS).map(u => u.file))];
        const rowsByFile = {};
        const failed = [];
        const usedSource = {};
        const downloaded = new Map();        // one `complete.json.gz` serves both exchanges

        for (const f of wanted) {
          if (files && files[f]) { rowsByFile[f] = files[f]; usedSource[f] = 'injected'; continue; }

          /* Walk the candidate chain. A DOWNLOAD IS NOT A SUCCESS — the exchange-wide file will
             fetch happily and might contain no derivatives at all, which is precisely the case
             that would otherwise present as "0 contracts" with no explanation. A candidate only
             counts when it actually yields contracts for an underlying on this exchange. */
          const wantMatch = new Set();
          for (const u of Object.values(UNDERLYINGS)) if (u.file === f) for (const m of u.match) wantMatch.add(m);

          for (const cand of (SOURCES[f] || [f])) {
            // Failures are remembered as well as successes: `complete.json.gz` is the last resort
            // for both exchanges, and downloading it twice to fail twice helps nobody.
            if (downloaded.get(cand) === null) continue;
            let arr = downloaded.get(cand);
            if (!arr) {
              try { arr = await fetchMaster(cand); downloaded.set(cand, arr); }
              catch (e) { downloaded.set(cand, null); failed.push(`${cand}: ${String(e.message).slice(0, 70)}`); continue; }
            }
            let hits = 0;
            for (const row of arr) { if (classify(row, wantMatch)) { hits++; if (hits >= 20) break; } }
            if (!hits) { failed.push(`${cand}: downloaded ${arr.length} rows but none are ${f} contracts`); continue; }
            rowsByFile[f] = arr; usedSource[f] = cand;
            break;
          }
        }

        if (!Object.keys(rowsByFile).length) {
          /* THE DIAGNOSTIC THAT SEPARATES THE TWO CAUSES. `NSE.json.gz` is the file the Stocks tab
             downloads every day, so if that tab is populated the host is plainly reachable and
             this is not a network fault. Saying so stops the user chasing firewalls. */
          return off('could not reach any F&O instrument master — ' + failed.join('; ')
            + '. Every candidate above lives on assets.upstox.com, and NSE.json.gz among them is the '
            + 'same file the Stocks tab downloads daily — so if Stocks is loading, this is not a network problem.');
        }

        const built = build(rowsByFile);
        if (!built.ok) return off(built.reason);
        if (failed.length) built.warnings.push('some instrument sources were skipped: ' + failed.join('; '));
        for (const [f, src] of Object.entries(usedSource)) {
          if (src !== f && src !== 'injected') {
            built.warnings.push(`${f} contracts were read from ${src}.json.gz — the segment-level file was not available, which is expected if Upstox publishes one master per exchange rather than per segment`);
          }
        }
        built.sources = usedSource;

        writeCache(built);
        cache = { available: true, reason: null, asOf: now(), data: built, source: Object.values(usedSource).join(', ') || 'upstox' };
        cacheAt = now();
        return cache;
      } catch (e) {
        // A previously good load beats nothing; an outage should not blank the options tab.
        return cache || off('instrument master load failed: ' + String(e.message).slice(0, 120));
      } finally { inflight = null; }
    })();
    return inflight;
  }

  // JSON round-trips turn the numeric strike keys into strings; nothing else needs reviving.
  function revive(d) { return d; }

  /* ---- accessors ----
     All of them tolerate a chain that does not exist, because an expiry can be delisted between
     one load and the next. */

  function underlying(data, key) {
    return (data && data.underlyings && data.underlyings[String(key || '').toUpperCase()]) || null;
  }

  /* Listed expiries that have not yet passed, nearest first. `after` lets a caller skip the one
     expiring in an hour — on expiry afternoon the front weekly is a different instrument
     psychologically and its Greeks are meaningless. */
  function expiries(data, key, opts2) {
    const u = underlying(data, key);
    if (!u) return [];
    const o = opts2 || {};
    const t = isNum(o.now) ? o.now : now();
    const minMs = isNum(o.minHoursLeft) ? o.minHoursLeft * 3600 * 1000 : 0;
    return u.expiries
      .filter(e => e.expiry - t > minMs)
      .map(e => ({
        expiry: e.expiry, lotSize: e.lotSize, strikeCount: e.strikeCount,
        pairedStrikes: e.pairedStrikes, strikeStep: e.strikeStep,
        daysLeft: (e.expiry - t) / 86400000,
        date: new Date(e.expiry).toISOString().slice(0, 10)
      }));
  }

  function chain(data, key, expiryMs) {
    const u = underlying(data, key);
    if (!u) return null;
    const e = u.expiries.find(x => x.expiry === Number(expiryMs));
    if (!e) return null;
    return { underlying: u.key, name: u.name, exchange: u.exchange, ...e };
  }

  /* The strike nearest a level, which is how the ATM row is found once the forward is known. */
  function nearestStrike(chainObj, level) {
    if (!chainObj || !isNum(level) || !chainObj.strikes.length) return null;
    let best = null, bestD = Infinity;
    for (const k of chainObj.strikes) {
      const d = Math.abs(k - level);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  /* Every instrument key needed to quote a band of strikes around a level. Kept to a window
     because a NIFTY expiry lists hundreds of strikes and quoting all of them would be a large,
     slow request for rows nobody will trade. */
  function quoteKeys(chainObj, level, width) {
    if (!chainObj) return [];
    const w = isNum(width) ? width : 15;
    const atm = nearestStrike(chainObj, level);
    const idx = chainObj.strikes.indexOf(atm);
    const from = Math.max(0, idx - w), to = Math.min(chainObj.strikes.length, idx + w + 1);
    const keys = [];
    for (const k of chainObj.strikes.slice(from, to)) {
      const s = chainObj.byStrike[k];
      if (s.CE) keys.push(s.CE.key);
      if (s.PE) keys.push(s.PE.key);
    }
    return keys;
  }

  return { load, UNDERLYINGS, SOURCES, underlying, expiries, chain, nearestStrike, quoteKeys, __build: build, __classify: classify, __parseExpiry: parseExpiry };
}

module.exports = createInstruments;
module.exports.UNDERLYINGS = UNDERLYINGS;
module.exports.SOURCES = SOURCES;
module.exports.__parseExpiry = parseExpiry;
