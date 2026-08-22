/* ============================================================
   INTEL — MACRO DATA ADAPTER

   The instruments that move crypto and Indian equities from outside their own charts. Same
   honesty envelope as derivs.js: `{available, reason, data}`, and a feed that cannot be reached
   is a RESULT, never a zero.

   WHY THIS FILE EXISTS AT ALL
   A technically perfect long can be destroyed by a dollar rally or a CPI print, and nothing on a
   price chart warns you first. Every indicator in the main engine is endogenous — computed from
   the coin's own history — so the entire platform was structurally blind to the largest and most
   frequent cause of a leveraged position failing. This is the exogenous half.

   DATE-KEYED CLOSES, NOT ARRAYS. Crypto trades 7 days a week and DXY does not. Correlating a
   365-bar crypto series against a 252-bar macro series positionally would silently pair Monday's
   BTC with the previous Thursday's dollar and produce a confident, meaningless number. Everything
   here is keyed by YYYY-MM-DD so the correlation engine can intersect dates instead of guessing.

   SOURCES, in order of preference:
     1. Yahoo Finance chart API — free, no key, one shape for every instrument, reachable from
        India. Covers indices, futures, FX and yields.
     2. Stooq CSV — free, no key, different infrastructure. Used when Yahoo fails for a symbol.

   Neither could be verified from the build sandbox (its proxy 403s all outbound market data,
   including endpoints this server already uses successfully in production), so this is written
   defensively: every response is shape-checked before it is trusted, and a symbol that fails both
   sources is reported missing rather than filled in.
   ============================================================ */

const REQ_TIMEOUT = 9000;
const YH_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

/* Each instrument states what it TELLS you, because a number without an interpretation is how a
   macro panel becomes wallpaper. `invert:true` means "up is risk-OFF for crypto". */
const INSTRUMENTS = {
  DXY: { yahoo: 'DX-Y.NYB', stooq: 'dx.f', name: 'US Dollar Index', invert: true, group: 'global', why: 'Crypto\'s most reliable macro inverse — a rising dollar drains risk appetite everywhere.' },
  US10Y: { yahoo: '^TNX', stooq: null, name: 'US 10-year yield', invert: true, group: 'global', yieldScale: true, why: 'The risk-free rate every other asset is priced against. Rising yields compress risk assets.' },
  VIX: { yahoo: '^VIX', stooq: null, name: 'VIX (equity fear)', invert: true, group: 'global', why: 'When VIX spikes, cross-asset correlation goes toward 1 and single-asset technicals stop working.' },
  SPX: { yahoo: '^GSPC', stooq: '^spx', name: 'S&P 500', invert: false, group: 'global', why: 'Broad risk appetite.' },
  NDX: { yahoo: '^IXIC', stooq: '^ndq', name: 'Nasdaq Composite', invert: false, group: 'global', why: 'The index BTC tracks most closely when macro is in charge.' },
  GOLD: { yahoo: 'GC=F', stooq: 'xauusd', name: 'Gold', invert: false, group: 'global', why: 'Safe-haven rotation, and a debasement hedge that sometimes moves with crypto and sometimes against it.' },
  CRUDE: { yahoo: 'CL=F', stooq: 'cl.f', name: 'Crude oil', invert: true, group: 'global', why: 'Inflation input — sustained strength pressures central banks toward tighter policy.' },
  USDINR: { yahoo: 'USDINR=X', stooq: 'usdinr', name: 'USD/INR', invert: true, group: 'india', why: 'Your own currency exposure, and a read on foreign flows into Indian assets.' },
  NIFTY: { yahoo: '^NSEI', stooq: '^nkx', name: 'NIFTY 50', invert: false, group: 'india', why: 'Your equity desk\'s benchmark.' },
  INDIAVIX: { yahoo: '^INDIAVIX', stooq: null, name: 'India VIX', invert: true, group: 'india', why: 'Indian equity fear gauge.' }
};

const off = reason => ({ available: false, reason, asOf: null, data: null });
const shortErr = e => String((e && e.message) || e).slice(0, 90);
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(REQ_TIMEOUT), headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(REQ_TIMEOUT) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

/* Yahoo's chart payload. Shape-checked rather than trusted: a rate-limit page or an error object
   arrives with HTTP 200 often enough that assuming the happy path would inject junk. */
function parseYahoo(j) {
  const res = j && j.chart && Array.isArray(j.chart.result) && j.chart.result[0];
  if (!res || !Array.isArray(res.timestamp)) return null;
  const q = res.indicators && Array.isArray(res.indicators.quote) && res.indicators.quote[0];
  if (!q || !Array.isArray(q.close)) return null;
  const closes = {};
  for (let i = 0; i < res.timestamp.length; i++) {
    const c = +q.close[i];
    if (!isFinite(c) || c <= 0) continue;                 // Yahoo pads holidays with nulls
    closes[dayKey(res.timestamp[i] * 1000)] = c;
  }
  const keys = Object.keys(closes);
  if (keys.length < 5) return null;
  return { closes, last: closes[keys[keys.length - 1]], meta: (res.meta && res.meta.regularMarketPrice) || null };
}

/* Stooq CSV: Date,Open,High,Low,Close,Volume */
function parseStooq(txt) {
  if (!txt || txt.length < 40 || /^<|Exceeded/i.test(txt.trim())) return null;
  const lines = txt.trim().split('\n');
  const head = lines[0].toLowerCase();
  if (head.indexOf('close') < 0) return null;
  const cols = head.split(',');
  const di = cols.indexOf('date'), ci = cols.indexOf('close');
  if (di < 0 || ci < 0) return null;
  const closes = {};
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    const c = +p[ci];
    if (!isFinite(c) || c <= 0 || !p[di]) continue;
    closes[p[di].slice(0, 10)] = c;
  }
  const keys = Object.keys(closes);
  if (keys.length < 5) return null;
  return { closes, last: closes[keys[keys.length - 1]], meta: null };
}

module.exports = function createMacroData(opts) {
  const cfg = opts || {};
  const enabled = cfg.enabled !== false && process.env.INTEL_MACRO !== 'off';
  let cache = null, cacheAt = 0, inflight = null;
  const TTL = (cfg.ttlMs || 15 * 60 * 1000);        // macro moves on a slower clock than a 15m candle

  async function fetchOne(key) {
    const inst = INSTRUMENTS[key];
    let lastErr = null;
    for (const host of YH_HOSTS) {
      try {
        const j = await getJSON(`${host}/v8/finance/chart/${encodeURIComponent(inst.yahoo)}?interval=1d&range=6mo`);
        const p = parseYahoo(j);
        if (p) return { ...p, source: 'yahoo' };
        lastErr = new Error('unexpected chart shape');
      } catch (e) { lastErr = e; }
    }
    if (inst.stooq) {
      try {
        const t = await getText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(inst.stooq)}&i=d`);
        const p = parseStooq(t);
        if (p) return { ...p, source: 'stooq' };
        lastErr = new Error('unexpected csv shape');
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no source returned usable data');
  }

  async function load(force) {
    if (!enabled) return off('macro adapter disabled (INTEL_MACRO=off)');
    if (!force && cache && Date.now() - cacheAt < TTL) return cache;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const keys = Object.keys(INSTRUMENTS);
        const series = {}, failed = [];
        // Sequential-ish with small concurrency: ten symbols at once is a reliable way to get
        // rate-limited, and a partial macro read is worth more than none.
        const jobs = keys.map(k => async () => {
          try {
            const r = await fetchOne(k);
            let closes = r.closes;
            /* ^TNX has been quoted both as the yield (4.25) and as yield×10 (42.5) over the
               years. A 42% US 10-year would rewrite every downstream threshold, so normalise on
               magnitude rather than trusting a convention that has already changed once. */
            if (INSTRUMENTS[k].yieldScale && r.last > 25) {
              const scaled = {};
              for (const d of Object.keys(closes)) scaled[d] = closes[d] / 10;
              closes = scaled;
            }
            const dates = Object.keys(closes).sort();
            series[k] = {
              key: k, name: INSTRUMENTS[k].name, invert: INSTRUMENTS[k].invert, group: INSTRUMENTS[k].group,
              why: INSTRUMENTS[k].why, source: r.source,
              closes, dates, last: closes[dates[dates.length - 1]], lastDate: dates[dates.length - 1]
            };
          } catch (e) { failed.push({ key: k, err: shortErr(e) }); }
        });
        let i = 0;
        await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
          while (i < jobs.length) await jobs[i++]();
        }));

        if (!Object.keys(series).length) {
          const why = failed.length ? failed.slice(0, 3).map(f => `${f.key}: ${f.err}`).join('; ') : 'no instruments returned data';
          return off('no macro instrument could be fetched — ' + why);
        }
        const out = {
          available: true, reason: null, asOf: Date.now(),
          data: { series, failed, covered: Object.keys(series).length, total: keys.length }
        };
        cache = out; cacheAt = Date.now();
        return out;
      } catch (e) {
        return cache || off('macro fetch failed: ' + shortErr(e));
      } finally { inflight = null; }
    })();
    return inflight;
  }

  return { load, INSTRUMENTS, __parseYahoo: parseYahoo, __parseStooq: parseStooq, enabled };
};

module.exports.INSTRUMENTS = INSTRUMENTS;
module.exports.__parseYahoo = parseYahoo;
module.exports.__parseStooq = parseStooq;
