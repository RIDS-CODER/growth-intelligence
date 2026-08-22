/* ============================================================
   INTEL — SCHEDULED EVENT RISK

   Technical analysis has nothing to say about 8:30am on CPI day. The chart looks the same at
   8:29 as it did all week, and then an exogenous number arrives and every level on it becomes
   irrelevant for the next hour. Carrying leverage into that is not a trading decision, it is a
   coin flip with a spread — and it is one of the most common ways a technically sound position
   gets liquidated.

   THREE HONESTY RULES, because a wrong calendar is worse than no calendar:

   1. STALENESS IS LOUD. Past `validThrough` the calendar stops being trusted and says so. A
      silently expired schedule would have the app confidently reporting "no events for 30 days"
      forever, which is the most dangerous possible failure for this feature.

   2. UNVERIFIED DATES ARE MARKED. Entries shipped with the app carry `unverified:true` until the
      user checks them against the Fed/BLS/RBI. They still fire warnings — an unverified FOMC date
      is better than none — but they are labelled everywhere they appear, and never presented as
      established fact.

   3. NFP IS DERIVED, NOT CONFIGURED. It is the first Friday of every month by rule, so it is
      computed and cannot go stale. Everything else is irregular and has to come from the file.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const HOUR = 3600 * 1000;
const DEFAULT_BLOCK_BEFORE = 6;
const DEFAULT_BLOCK_AFTER = 2;

/* US Eastern DST: second Sunday of March to first Sunday of November.
   NFP and CPI are released at 8:30am ET, which is 12:30 UTC in summer and 13:30 UTC in winter —
   an hour's error either way would put the blocking window in the wrong place. */
function nthWeekdayUTC(year, month, weekday, n) {
  const d = new Date(Date.UTC(year, month, 1));
  const shift = (weekday - d.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + shift + (n - 1) * 7));
}
function isUsDst(dt) {
  const y = dt.getUTCFullYear();
  const start = nthWeekdayUTC(y, 2, 0, 2);         // 2nd Sunday of March
  const end = nthWeekdayUTC(y, 10, 0, 1);          // 1st Sunday of November
  return dt >= start && dt < end;
}
/* 8:30am ET on a given UTC date → the correct UTC instant. */
function etMorningRelease(dateUTC) {
  const probe = new Date(Date.UTC(dateUTC.getUTCFullYear(), dateUTC.getUTCMonth(), dateUTC.getUTCDate(), 12, 30));
  return new Date(probe.getTime() + (isUsDst(probe) ? 0 : HOUR));
}

/* First Friday of a month — the NFP rule, and the only event here that needs no maintenance. */
function nfpFor(year, month) {
  return etMorningRelease(nthWeekdayUTC(year, month, 5, 1));
}
function derivedNfp(now, monthsAhead) {
  const out = [];
  const base = new Date(now);
  for (let i = 0; i <= (monthsAhead == null ? 2 : monthsAhead); i++) {
    const d = nfpFor(base.getUTCFullYear(), base.getUTCMonth() + i);
    if (d.getTime() >= now - 3 * HOUR) {
      out.push({ at: d.toISOString(), kind: 'nfp', impact: 'high', label: 'US Non-Farm Payrolls', derived: true, unverified: false });
    }
  }
  return out;
}

module.exports = function createCalendar(opts) {
  const o = opts || {};
  const FILE = o.file || path.join(o.dir || path.join(__dirname, '..'), 'macro-calendar.json');
  let cache = null, cacheAt = 0, mtime = 0;

  function readFile() {
    try {
      const st = fs.statSync(FILE);
      // Re-read only when the file actually changed — the user is expected to edit this live.
      if (cache && st.mtimeMs === mtime && Date.now() - cacheAt < 60000) return cache;
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      mtime = st.mtimeMs; cacheAt = Date.now();
      cache = raw;
      return raw;
    } catch (e) {
      cache = null;
      return { __err: String((e && e.message) || e).slice(0, 90) };
    }
  }

  function events(now) {
    const t = now || Date.now();
    const raw = readFile();
    const nfp = derivedNfp(t, 2);

    if (raw.__err) {
      return {
        ok: true, configured: false,
        reason: `macro-calendar.json could not be read (${raw.__err}) — only the derived NFP dates are known.`,
        stale: false, validThrough: null,
        upcoming: nfp.map(e => ({ ...e, ms: Date.parse(e.at) })).sort((a, b) => a.ms - b.ms)
      };
    }

    const validThrough = raw.validThrough ? Date.parse(raw.validThrough + 'T23:59:59Z') : null;
    const stale = validThrough != null && t > validThrough;

    const listed = Array.isArray(raw.events) ? raw.events : [];
    const parsed = listed
      .map(e => ({ ...e, ms: Date.parse(e.at) }))
      .filter(e => isFinite(e.ms));

    /* A stale file's dates are DROPPED, not merely flagged. Past its validity the schedule is an
       unknown, and showing last year's FOMC dates as "upcoming" is exactly the false comfort this
       whole module exists to prevent. The derived NFP dates survive, because a rule cannot expire. */
    const all = (stale ? [] : parsed).concat(nfp.map(e => ({ ...e, ms: Date.parse(e.at) })));
    const upcoming = all.filter(e => e.ms >= t - 3 * HOUR).sort((a, b) => a.ms - b.ms);

    return {
      ok: true, configured: true, stale,
      reason: stale ? `macro-calendar.json expired on ${raw.validThrough}. Its dates are no longer trusted — only the derived NFP dates remain. Add new dates and extend validThrough.` : null,
      validThrough: raw.validThrough || null,
      blockHoursBefore: +raw.blockHoursBefore > 0 ? +raw.blockHoursBefore : DEFAULT_BLOCK_BEFORE,
      blockHoursAfter: +raw.blockHoursAfter > 0 ? +raw.blockHoursAfter : DEFAULT_BLOCK_AFTER,
      unverifiedCount: upcoming.filter(e => e.unverified).length,
      upcoming
    };
  }

  /* The operational question: am I inside a window where leverage should not be opened? */
  function eventRisk(now) {
    const t = now || Date.now();
    const c = events(t);
    const before = c.blockHoursBefore || DEFAULT_BLOCK_BEFORE;
    const after = c.blockHoursAfter || DEFAULT_BLOCK_AFTER;

    const next = c.upcoming.find(e => e.ms >= t) || null;
    const active = c.upcoming.find(e =>
      e.impact === 'high' && t >= e.ms - before * HOUR && t <= e.ms + after * HOUR) || null;

    const hoursToNext = next ? (next.ms - t) / HOUR : null;

    return {
      ok: true,
      configured: c.configured, stale: c.stale, reason: c.reason,
      validThrough: c.validThrough,
      unverifiedCount: c.unverifiedCount,
      next: next ? { ...next, hoursAway: +((next.ms - t) / HOUR).toFixed(1) } : null,
      hoursToNext,
      /* inWindow gates new leveraged entries. It requires impact:'high' — an RBI decision moves
         Indian equities and barely touches crypto, so it warns without blocking. */
      inWindow: !!active,
      window: active ? {
        label: active.label, kind: active.kind, at: active.at,
        unverified: !!active.unverified,
        hoursAway: +((active.ms - t) / HOUR).toFixed(1),
        phase: t < active.ms ? 'before' : 'after'
      } : null,
      message: active
        ? `${active.label} ${t < active.ms ? 'in ' + ((active.ms - t) / HOUR).toFixed(1) + 'h' : 'was ' + ((t - active.ms) / HOUR).toFixed(1) + 'h ago'}. Price is about to be driven by a number nobody has seen yet — chart levels do not price it. New leveraged entries are blocked in this window.${active.unverified ? ' (This date is UNVERIFIED — confirm it against the official source.)' : ''}`
        : (next ? `Next scheduled event: ${next.label} in ${((next.ms - t) / HOUR).toFixed(1)}h.` : 'No scheduled high-impact events on the calendar.'),
      upcoming: c.upcoming.slice(0, 6)
    };
  }

  return { events, eventRisk, __file: FILE, __derivedNfp: derivedNfp, __nfpFor: nfpFor, __etMorningRelease: etMorningRelease, __isUsDst: isUsDst };
};

module.exports.nfpFor = nfpFor;
module.exports.isUsDst = isUsDst;
module.exports.etMorningRelease = etMorningRelease;
module.exports.nthWeekdayUTC = nthWeekdayUTC;
