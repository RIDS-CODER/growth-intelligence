/* ============================================================
   Options Radar — VENUE ADAPTERS
   The scorer never sees a venue payload; it sees a normalized Snapshot.

   CoinDCX publishes no documented options-chain endpoint, so its adapter is written
   against the normalized shape and driven by a fixture until the real endpoint is
   supplied — swapping it in touches only `fetchRaw`. Deribit runs live meanwhile and
   is the backfill source for the 90d IV baseline either way.

   Every adapter validates shape at runtime: a missing field must surface as an explicit
   reject, never as `undefined` that later reads as 0 and poisons a z-score.
   ============================================================ */
"use strict";
const V=require("./vol.js");

/* ---------- normalization helpers ---------- */
const num=v=>{const n=typeof v==="string"?parseFloat(v):v;return typeof n==="number"&&isFinite(n)?n:null;};
const YEAR_MS=365*24*3600*1000;

/**
 * Validate + normalize one quote. Returns {quote} or {reject:{reason,detail}}.
 * `iv` is optional: when the venue does not publish it we solve it from the mark.
 */
function normalizeQuote(raw,ctx){
  const id=raw.id||raw.instrument_name;
  if(!id)return {reject:{reason:"missing instrument id",detail:{}}};
  const strike=num(raw.strike), expiry=num(raw.expiry_ms);
  if(!(strike>0))return {reject:{reason:"missing/invalid strike",detail:{id}}};
  if(!(expiry>0))return {reject:{reason:"missing/invalid expiry",detail:{id}}};
  const kind=(raw.kind||"").toLowerCase()==="put"?"put":"call";
  const bid=num(raw.bid), ask=num(raw.ask);
  let mark=num(raw.mark);
  if(mark==null&&bid!=null&&ask!=null)mark=(bid+ask)/2;
  if(!(mark>0))return {reject:{reason:"no usable mark price",detail:{id,bid,ask}}};

  const T=(expiry-ctx.ts_ms)/YEAR_MS;
  if(!(T>0))return {reject:{reason:"already expired",detail:{id,expiry}}};
  const F=ctx.forwardFor(expiry);
  if(!(F>0))return {reject:{reason:"no forward for expiry",detail:{id,expiry}}};

  // IV: prefer the venue's own number, else solve Black-76 from the mark.
  let iv=num(raw.iv), iv_src=iv!=null&&iv>0?"venue":null;
  if(iv==null||!(iv>0)){
    iv=V.impliedVol(kind,mark,F,strike,T,ctx.df==null?1:ctx.df);
    iv_src=iv!=null?"computed":null;
  }
  if(iv==null||!(iv>0))
    return {reject:{reason:"implied vol not solvable from mark (no resolvable time value)",
                    detail:{id,mark,strike,F,T:+T.toFixed(6)}}};

  const g=V.greeks(kind,F,strike,T,iv,ctx.df==null?1:ctx.df);
  const spread=(bid!=null&&ask!=null&&ask>=bid)?(ask-bid):null;
  return {quote:{
    id, kind, strike, expiry_ms:expiry, T,
    bid, ask, mark, spread,
    spread_pct: (spread!=null&&mark>0)?100*spread/mark:null,
    oi:num(raw.oi)||0, vol24h:num(raw.vol24h)||0,
    iv, iv_src, greeks:g,
    k: Math.log(strike/F), F,
    underlying: ctx.underlying, venue: ctx.venue
  }};
}

/** Normalize a whole venue chain into a Snapshot. Rejections are returned, not thrown. */
function buildSnapshot(raw,opts){
  opts=opts||{};
  const ts=raw.ts_ms||Date.now();
  const forwards=(raw.forwards||[]).filter(f=>num(f.F)>0&&num(f.expiry_ms)>0);
  const spot=num(raw.spot);
  // Forward per expiry; fall back to spot when the venue gives no term structure. Falling back
  // is recorded so the scorer can flag it — a missing basis biases every k in the chain.
  let fwdFallback=false;
  const forwardFor=(exp)=>{
    const hit=forwards.find(f=>Math.abs(f.expiry_ms-exp)<60000);
    if(hit)return hit.F;
    const near=forwards.slice().sort((a,b)=>Math.abs(a.expiry_ms-exp)-Math.abs(b.expiry_ms-exp))[0];
    if(near)return near.F;
    fwdFallback=true; return spot;
  };
  const ctx={ts_ms:ts,underlying:raw.underlying,venue:raw.venue,df:raw.df==null?1:raw.df,forwardFor};
  const quotes=[],rejects=[];
  for(const q of (raw.quotes||[])){
    const r=normalizeQuote(q,ctx);
    if(r.reject)rejects.push({id:q.id||q.instrument_name||"?",stage:"normalize",...r.reject});
    else quotes.push(r.quote);
  }
  return {
    ts_ms:ts, venue:raw.venue, underlying:raw.underlying,
    spot, forwards, funding_rate:num(raw.funding_rate)||0, basis_bps:num(raw.basis_bps)||0,
    rvol30:num(raw.rvol30), fx_usdinr:num(raw.fx_usdinr)||null,
    quote_ccy:raw.quote_ccy||"USD",
    forward_fallback:fwdFallback,
    quotes, rejects
  };
}

/* ============================================================
   DERIBIT — live, documented public API. Also the cold-start backfill source.
   ============================================================ */
const DERIBIT="https://www.deribit.com/api/v2";
async function getJSON(url,fetchImpl){
  const f=fetchImpl||globalThis.fetch;
  const r=await f(url,{headers:{Accept:"application/json"}});
  if(!r.ok)throw new Error("HTTP "+r.status+" "+url.slice(0,80));
  return r.json();
}
function parseDeribitName(name){
  // BTC-26DEC25-90000-C
  const m=/^([A-Z]+)-(\d{1,2}[A-Z]{3}\d{2})-(\d+(?:\.\d+)?)-(C|P)$/.exec(name||"");
  if(!m)return null;
  const MON={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
  const d=/^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(m[2]);
  if(!d||MON[d[2]]==null)return null;
  // Deribit settles at 08:00 UTC
  const expiry=Date.UTC(2000+parseInt(d[3],10),MON[d[2]],parseInt(d[1],10),8,0,0);
  return {underlying:m[1],expiry_ms:expiry,strike:parseFloat(m[3]),kind:m[4]==="C"?"call":"put"};
}
function deribitAdapter(cfg){
  cfg=cfg||{};
  return {
    venue:"deribit",
    async fetchRaw(underlying,fetchImpl){
      const [book,idx]=await Promise.all([
        getJSON(`${DERIBIT}/public/get_book_summary_by_currency?currency=${underlying}&kind=option`,fetchImpl),
        getJSON(`${DERIBIT}/public/get_index_price?index_name=${underlying.toLowerCase()}_usd`,fetchImpl)
      ]);
      const rows=(book&&book.result)||[];
      const spot=(idx&&idx.result&&idx.result.index_price)||null;
      // Deribit quotes option premium in units of the UNDERLYING; convert to quote ccy.
      const quotes=[],fwdBy={};
      for(const r of rows){
        const p=parseDeribitName(r.instrument_name);
        if(!p)continue;
        const u=num(r.underlying_price);
        if(u>0)fwdBy[p.expiry_ms]=u;                    // per-expiry forward, straight from the venue
        const toCcy=v=>(num(v)!=null&&u>0)?num(v)*u:null;
        quotes.push({
          id:r.instrument_name, kind:p.kind, strike:p.strike, expiry_ms:p.expiry_ms,
          bid:toCcy(r.bid_price), ask:toCcy(r.ask_price), mark:toCcy(r.mark_price),
          oi:num(r.open_interest)||0, vol24h:num(r.volume)||0,
          iv:num(r.mark_iv)!=null?num(r.mark_iv)/100:null   // Deribit reports IV in percent
        });
      }
      return {
        venue:"deribit", underlying, ts_ms:Date.now(), spot, quote_ccy:"USD",
        forwards:Object.entries(fwdBy).map(([e,F])=>({expiry_ms:+e,F})),
        quotes
      };
    }
  };
}

/* ============================================================
   COINDCX — no documented public options-chain endpoint.
   `fetchRaw` is the ONLY thing that needs replacing once the real endpoint is known;
   everything downstream already speaks the normalized shape. Until then it serves an
   injected fixture so the whole pipeline is exercisable and testable.
   ============================================================ */
function coindcxAdapter(cfg){
  cfg=cfg||{};
  return {
    venue:"coindcx",
    // Replace this body with the live call; keep the returned shape identical.
    async fetchRaw(underlying,fetchImpl){
      if(typeof cfg.fixture==="function")return cfg.fixture(underlying);
      if(cfg.fixture)return cfg.fixture;
      const err=new Error("coindcx options endpoint not configured");
      err.code="NO_ENDPOINT";
      throw err;
    },
    configured(){ return !!cfg.fixture||!!cfg.endpoint; }
  };
}

/** Fetch + normalize in one call. Never throws on a bad row — bad rows become rejects. */
async function loadSnapshot(adapter,underlying,extra,fetchImpl){
  const raw=await adapter.fetchRaw(underlying,fetchImpl);
  return buildSnapshot(Object.assign(raw,extra||{}));
}

module.exports={normalizeQuote,buildSnapshot,deribitAdapter,coindcxAdapter,loadSnapshot,parseDeribitName};
