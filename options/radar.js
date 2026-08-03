/* ============================================================
   Options Radar — SERVICE WIRING
   Ties adapters → scoring → store together and exposes the calls the HTTP layer needs.
   Kept separate from server.js so the radar can be tested and run headless.
   ============================================================ */
"use strict";
const path=require("path");
const S=require("./score.js");
const A=require("./adapters.js");
const B=require("./backtest.js");
const V=require("./vol.js");
const P=require("./plain.js");
const Store=require("./store.js");

const DAY=86400000;
const UNDERLYINGS=["BTC","ETH","SOL"];

function create(opts){
  opts=opts||{};
  const cfg=S.withDefaults(opts.config||{});
  const store=opts.store||Store.open(opts.dir||__dirname,{});
  const venue=opts.venue||"deribit";
  const adapter=opts.adapter||(venue==="coindcx"
    ? A.coindcxAdapter(opts.coindcx||{})
    : A.deribitAdapter(opts.deribit||{}));
  // ₹ conversion for display. Deribit prices in USD; CoinDCX already quotes INR.
  const toInr=opts.toInr||(v=>v);
  const state={lastScan:0,lastError:null,cache:{},backfillNoted:false};

  /* Point-in-time bucket history, as the scorer and the backtest both need it. */
  const history=(underlying,tenor,bucket,asOfMs)=>{
    const to=asOfMs||Date.now();
    try{ return store.bucketHistory(underlying,tenor,bucket,to-90*DAY); }
    catch(e){ return null; }
  };

  async function scanOne(underlying,fetchImpl){
    const raw=await adapter.fetchRaw(underlying,fetchImpl);
    const snap=A.buildSnapshot(Object.assign(raw,{
      rvol30:opts.realizedVol?opts.realizedVol(underlying):raw.rvol30
    }));
    // The THESIS: the app's own directional read on the underlying, reused rather than
    // reinvented, so an options card agrees with what the rest of the dashboard says.
    const view=opts.view?opts.view(underlying):null;
    const closes=opts.closes?opts.closes(underlying):null;
    const res=S.scoreSnapshot(snap,{history,view,contractSize:opts.contractSize||1,toInr},cfg);
    // Translate every surfaced card into plain English for someone who has never traded an option.
    for(const sig of [...res.buys,...res.sells]){
      try{
        sig.plain=P.explainSignal(sig,{spot:snap.spot,contractSize:opts.contractSize||1,
          closes,view,candidates:res.candidates||0});
      }catch(e){}
    }

    // persist: the tape for backtesting, the bucket points for the 90d baseline,
    // the signals for the forward record, and the rejections for the lookup.
    try{ store.putSnapshot(snap); }catch(e){}
    try{
      const byExp={};
      snap.quotes.forEach(q=>{(byExp[q.expiry_ms]=byExp[q.expiry_ms]||[]).push(q);});
      const fits={};
      for(const [e,qs] of Object.entries(byExp)){
        const f=V.fitSmile(qs.map(q=>({k:q.k,iv:q.iv,vega:q.greeks.vega,spread:q.spread})),qs[0].T);
        f.expiry_ms=+e; f.T=qs[0].T; fits[e]=f;
      }
      S.bucketPoints(snap,fits,cfg).forEach(p=>store.putBucketIV(p));
    }catch(e){}
    try{ [...res.buys,...res.sells].forEach(s=>store.putSignal(s)); }catch(e){}
    try{ res.rejections.forEach(r=>store.putRejection(r)); }catch(e){}
    return res;
  }

  return {
    config:cfg, store, venue,
    /** Scan every underlying. Failures are per-underlying, never fatal. */
    async scan(fetchImpl){
      const out={ts:Date.now(),venue,underlyings:{},errors:{}};
      for(const u of (opts.underlyings||UNDERLYINGS)){
        try{ out.underlyings[u]=await scanOne(u,fetchImpl); }
        catch(e){ out.errors[u]=String(e&&e.message||e); }
      }
      // Top 3 each way ACROSS underlyings, which is what the panel shows.
      const all=Object.values(out.underlyings).flatMap(r=>[...r.buys,...r.sells]);
      out.buys=all.filter(s=>s.side==="buy").sort((a,b)=>b.score_10-a.score_10).slice(0,cfg.topN);
      out.sells=all.filter(s=>s.side==="sell").sort((a,b)=>b.score_10-a.score_10).slice(0,cfg.topN);
      out.backfilled=[...out.buys,...out.sells].some(s=>s.quality&&s.quality.backfilled);
      // Per-underlying view summary, so the panel can say "no clear direction on SOL — sitting
      // this one out" rather than silently showing nothing.
      out.views={};
      for(const [u,r] of Object.entries(out.underlyings))
        out.views[u]={score:r.view?r.view.score:null,label:r.view?r.view.label:null,
                      noView:!!r.noView,candidates:r.counts?r.counts.scored:0};
      state.lastScan=out.ts; state.cache=out;
      return out;
    },
    /** "Why isn't X here?" — answers from the recorded pipeline result, not a re-derivation. */
    explain(contractId){
      if(!contractId)return {found:false,message:"Enter a contract id."};
      const shown=[...(state.cache.buys||[]),...(state.cache.sells||[])].find(s=>s.id===contractId);
      if(shown)return {found:true,surfaced:true,id:contractId,
        message:`It IS surfaced — ${shown.side.toUpperCase()} at ${shown.score_10}/10.`,signal:shown};
      let rej=null;
      try{ rej=store.lastRejection(contractId); }catch(e){}
      if(!rej)return {found:false,id:contractId,
        message:"No record of that contract in the last scan. Check the exact id, or it may not be listed on this venue."};
      const STAGE={normalize:"Could not be read from the venue feed",
                   filter:"Failed a hard filter",
                   score:"Passed the filters but no signal had enough data",
                   structure:"Scored as a SELL but could not be made defined-risk",
                   rank:"Scored, but did not make the top 3"};
      return {found:true,surfaced:false,id:contractId,stage:rej.stage,
        headline:STAGE[rej.stage]||rej.stage, message:rej.reason, detail:rej.detail,
        as_of:rej.ts_ms};
    },
    /** Backtest over the stored tape. */
    async backtest(underlying,fromMs,toMs,btOpts){
      const tape=store.snapshots(underlying,fromMs,toMs);
      if(!tape.length)return {error:"No stored snapshots yet for "+underlying+
        " — the tape builds as the radar scans. Backtesting needs history it has actually seen."};
      return B.replay(tape,Object.assign({history,contractSize:opts.contractSize||1,toInr,cfg},btOpts||{}));
    },
    /** Rolling forward performance for the always-on-screen strip. */
    performance(windowDays){
      const w=windowDays||90;
      let sigs=[];
      try{ sigs=store.signalsSince(Date.now()-w*DAY); }catch(e){}
      // Resolve each historical signal against the tape it can be settled on.
      const byU={};
      sigs.forEach(s=>{(byU[s.underlying]=byU[s.underlying]||[]).push(s);});
      const trades=[];
      for(const [u,list] of Object.entries(byU)){
        let tape=[];
        try{ tape=store.snapshots(u,Date.now()-w*DAY,Date.now()); }catch(e){}
        if(!tape.length)continue;
        const r=B.replay(tape,{history,contractSize:opts.contractSize||1,toInr,cfg});
        trades.push(...r.trades);
      }
      const out=B.rollingPerformance(trades,w);
      out.signals_recorded=sigs.length;
      return out;
    },
    state:()=>({...state,storeKind:store.kind,venue,
      coindcxConfigured:typeof adapter.configured==="function"?adapter.configured():true})
  };
}

module.exports={create,UNDERLYINGS};
