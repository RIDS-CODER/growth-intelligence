/* ============================================================
   Options Radar — BACKTEST HARNESS
   Replays the stored snapshot tape, scores each one with the LIVE scoring service, and
   follows every signal to its outcome.

   Two things this deliberately does NOT do:
   - It never re-derives fair value from data the signal could not have seen. Each snapshot
     is scored with only the history available at that timestamp.
   - It never reports a hit rate without the sample size and interval behind it. On thin
     option history a 12-trade sample will otherwise read as an edge.

   Slippage: HALF THE SPREAD on both entry and exit, per spec.
   ============================================================ */
"use strict";
const S=require("./score.js");
const V=require("./vol.js");

const DAY=86400000;

/* Fill price including half-spread slippage.
   Buying pays mark + half spread; selling receives mark − half spread. */
function fillPrice(q,dir){
  const half=(q.spread!=null&&q.spread>0)?q.spread/2:0;
  return dir>0 ? q.mark+half : q.mark-half;
}
const quoteById=(snap,id)=>snap.quotes.find(q=>q.id===id)||null;

/* Fallback trend read for a self-contained replay: fast vs slow mean of the prices seen so
   far. Deliberately crude and clearly labelled — a production backtest should pass the app's
   real engine via opts.view so it measures the screener that actually ships. Never looks
   beyond the prices already appended, so it stays point-in-time. */
function trendView(spots){
  if(!spots||spots.length<10)return null;      // below this there is no trend to read at all
  // Adapt the windows to the tape: a short replay should still be gated, not silently ungated.
  const slowN=Math.min(20,spots.length), fastN=Math.max(3,Math.floor(slowN/4));
  const last=n=>{const a=spots.slice(-n);return a.reduce((s,x)=>s+x,0)/a.length;};
  const fast=last(fastN), slow=last(slowN);
  if(!(slow>0))return null;
  const score=Math.max(-40,Math.min(40,Math.round(400*(fast-slow)/slow)));
  return {score, label: score>=20?"clearly rising":score>=12?"leaning up"
    : score<=-20?"clearly falling":score<=-12?"leaning down":"no clear direction",
    approx:true};
}

/* Value a position at a later snapshot, or settle it intrinsically at expiry. */
function exitValue(sig,snap,fwd){
  if(sig.structure){
    const s=quoteById(snap,sig.structure.short_leg), l=quoteById(snap,sig.structure.long_leg);
    if(s&&l) return {ok:true, value:fillPrice(s,1)-fillPrice(l,-1)};   // buy back short, sell long
    return {ok:false};
  }
  const q=quoteById(snap,sig.id);
  if(q) return {ok:true, value:fillPrice(q,-1)};                        // sell the long back
  return {ok:false};
}
function settleIntrinsic(sig,F){
  const intr=(kind,K)=>kind==="call"?Math.max(0,F-K):Math.max(0,K-F);
  if(sig.structure){
    const shortK=sig.structure.short_strike!=null?sig.structure.short_strike:sig.strike;
    const longK=sig.structure.long_strike;
    if(longK==null)return null;
    return intr(sig.kind,shortK)-intr(sig.kind,longK);                  // what we owe, net
  }
  return intr(sig.kind,sig.strike);
}

/* Wilson score interval — honest small-sample bounds on a hit rate.
   A normal approximation would report an interval that excludes 0 or 1 on tiny samples. */
function wilson(k,n,z){
  if(!n)return [null,null];
  z=z||1.96;
  const p=k/n, d=1+z*z/n;
  const c=(p+z*z/(2*n))/d, m=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;
  return [Math.max(0,c-m),Math.min(1,c+m)];
}
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;

/**
 * Replay a tape.
 *   snapshots : chronological Snapshot[] for ONE underlying
 *   opts.holdDays  : close after N days (default: hold to expiry)
 *   opts.history   : (underlying,tenor,bucket,asOfMs) => {iv:[],backfilled,n,nativeN}
 *   opts.cfg       : scoring config (weights etc.)
 * Returns per-trade rows plus aggregate and per-signal attribution.
 */
function replay(snapshots,opts){
  opts=opts||{};
  const cfg=S.withDefaults(opts.cfg);
  const tape=(snapshots||[]).slice().sort((a,b)=>a.ts_ms-b.ts_ms);
  const trades=[],openBySig=new Map();
  const seen=new Set();                       // one trade per contract+side per signal episode
  const spots=[];                             // the tape's own price history, for the view fallback
  let viewSource=opts.view?"caller-supplied (live engine)":"derived from the tape's own price history";

  for(let i=0;i<tape.length;i++){
    const snap=tape[i];
    if(snap.spot>0)spots.push(snap.spot);
    // Point-in-time history only — never data from after this timestamp.
    const histFn=opts.history?((u,t,b)=>opts.history(u,t,b,snap.ts_ms)):()=>null;
    // The direction gate must apply here too, or the backtest measures a screener that
    // does not exist. Prefer the caller's real engine; otherwise derive a trend read from
    // the prices seen SO FAR in the tape (never later ones).
    const view=opts.view?opts.view(snap.underlying,snap.ts_ms):trendView(spots);
    // A scoring failure must NOT skip the close pass below — expiry snapshots legitimately
    // carry no quotable contracts, and skipping them would strand every open position.
    let scored={buys:[],sells:[]};
    try{ scored=S.scoreSnapshot(snap,{history:histFn,view,contractSize:opts.contractSize||1,toInr:opts.toInr},cfg); }
    catch(e){ scored={buys:[],sells:[]}; }

    /* close anything now closable */
    for(const [key,open] of [...openBySig]){
      const held=(snap.ts_ms-open.entry_ts)/DAY;
      const expired=snap.ts_ms>=open.expiry_ms;
      const timeUp=opts.holdDays!=null&&held>=opts.holdDays;
      if(!expired&&!timeUp)continue;
      let exitVal=null,how;
      if(expired){
        const F=(snap.forwards&&snap.forwards.length)?snap.forwards[0].F:snap.spot;
        exitVal=settleIntrinsic(open.sig,F); how="expiry";
      }else{
        const ev=exitValue(open.sig,snap,null);
        if(!ev.ok)continue;                   // contract not quoted this snapshot — try next one
        exitVal=ev.value; how="close";
      }
      if(exitVal==null)continue;
      // dir=+1 we paid entry and receive exit; dir=-1 (credit) we received entry and pay exit
      const pnl=open.dir>0?(exitVal-open.entry):(open.entry-exitVal);
      const basis=open.dir>0?open.entry:Math.max(open.maxLoss,1e-9);   // long: premium at risk; short: capped loss
      trades.push({
        id:open.sig.id, side:open.sig.side, underlying:snap.underlying,
        entry_ts:open.entry_ts, exit_ts:snap.ts_ms, held_days:+held.toFixed(3), exit_how:how,
        entry:+open.entry.toFixed(6), exit:+exitVal.toFixed(6),
        basis:+basis.toFixed(6),          // capital at risk — the denominator for EVERY return figure
        pnl:+pnl.toFixed(6), ret_pct:+(100*pnl/basis).toFixed(3),
        score:open.sig.score_10, contrib:open.sig.contrib, z:open.sig.z,
        quality:open.sig.quality, structured:!!open.sig.structure
      });
      openBySig.delete(key);
    }

    /* open new signals */
    for(const sig of [...scored.buys,...scored.sells]){
      const key=sig.id+"|"+sig.side;
      if(openBySig.has(key))continue;
      const episode=key+"|"+Math.floor(sig.ts_ms/(opts.dedupeMs||6*3600000));
      if(seen.has(episode))continue;
      seen.add(episode);
      let entry,maxLoss,dir;
      if(sig.structure){
        const s=quoteById(snap,sig.structure.short_leg), l=quoteById(snap,sig.structure.long_leg);
        if(!s||!l)continue;
        entry=fillPrice(s,-1)-fillPrice(l,1);      // credit received, after slippage on both legs
        if(!(entry>0))continue;                    // slippage ate the whole credit — not tradeable
        maxLoss=Math.abs(sig.structure.width!=null?sig.structure.width:0)-entry;
        if(!(maxLoss>0))continue;
        dir=-1;
      }else{
        const q=quoteById(snap,sig.id);
        if(!q)continue;
        entry=fillPrice(q,1);                      // debit paid, after slippage
        if(!(entry>0))continue;
        maxLoss=entry; dir=1;
      }
      openBySig.set(key,{sig,entry,maxLoss,dir,entry_ts:snap.ts_ms,expiry_ms:sig.expiry_ms});
    }
  }

  /* anything still open at the end of the tape is UNRESOLVED — excluded from the stats
     rather than marked-to-last-price, which would flatter a truncated sample. */
  const unresolved=openBySig.size;
  const out=summarize(trades,unresolved,cfg);
  out.assumptions.direction_view=viewSource;
  return out;
}

function statsFor(rows){
  if(!rows.length)return {n:0,hit_rate:null,ci:[null,null],avg_ret_pct:null,median_ret_pct:null,
                          best:null,worst:null};
  const wins=rows.filter(r=>r.pnl>0).length;
  const rets=rows.map(r=>r.ret_pct).sort((a,b)=>a-b);
  const [lo,hi]=wilson(wins,rows.length);
  return {
    n:rows.length, hit_rate:+(wins/rows.length).toFixed(4),
    ci:[lo==null?null:+lo.toFixed(4),hi==null?null:+hi.toFixed(4)],
    avg_ret_pct:+mean(rows.map(r=>r.ret_pct)).toFixed(3),
    median_ret_pct:+rets[rets.length>>1].toFixed(3),
    best:+rets[rets.length-1].toFixed(2), worst:+rets[0].toFixed(2)
  };
}

function summarize(trades,unresolved,cfg){
  const overall=statsFor(trades);
  const bySide={buy:statsFor(trades.filter(t=>t.side==="buy")),
                sell:statsFor(trades.filter(t=>t.side==="sell"))};

  // ATTRIBUTION — which signal actually predicted. A trade is credited to the signal that
  // contributed most to its composite, so a headline hit rate can be decomposed instead of
  // taken on faith.
  const bySignal={};
  for(const t of trades){
    const entries=Object.entries(t.contrib||{}).filter(([,v])=>isFinite(v)&&v!==0);
    if(!entries.length)continue;
    const dom=entries.sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]))[0][0];
    (bySignal[dom]=bySignal[dom]||[]).push(t);
  }
  const attribution={};
  for(const [k,rows] of Object.entries(bySignal))attribution[k]=statsFor(rows);

  // Post-tax: India VDA treats gains at 30%+cess with NO loss offset, so a symmetric gross
  // edge is asymmetric after tax. Applied per trade, never netted.
  const taxed=trades.map(t=>{
    const drag=t.pnl>0?S.taxDrag(t.pnl,cfg.tax):0;
    // Same denominator as the gross return. Dividing the post-tax P&L by the credit received
    // while the gross figure used capital at risk makes tax look like it IMPROVES returns.
    const basis=t.basis!=null&&t.basis>0?t.basis:Math.max(t.entry||0,1e-9);
    return {...t,pnl_post_tax:t.pnl-drag,ret_post_tax_pct:+(100*(t.pnl-drag)/basis).toFixed(3)};
  });
  const postTax=taxed.length?{
    avg_ret_pct:+mean(taxed.map(t=>t.ret_post_tax_pct)).toFixed(3),
    total_pnl:+taxed.reduce((s,t)=>s+t.pnl_post_tax,0).toFixed(6)
  }:{avg_ret_pct:null,total_pnl:null};

  const lowSample=trades.length<30;
  return {
    trades, n:trades.length, unresolved,
    overall, bySide, attribution,
    gross:{total_pnl:+trades.reduce((s,t)=>s+t.pnl,0).toFixed(6)},
    postTax,
    lowSample,
    verdict: !trades.length ? "No completed trades in this tape — nothing to judge."
      : lowSample ? `Only ${trades.length} completed trades — the hit rate is not yet distinguishable from chance. Treat as unvalidated.`
      : (overall.avg_ret_pct>0 ? `Positive gross edge over ${trades.length} trades; check the post-tax line before believing it.`
                               : `Negative over ${trades.length} trades — the screener did not pay in this window.`),
    assumptions:{ slippage:"half the bid-ask spread on entry and exit, both legs of a spread",
                  unresolved_excluded:true,
                  tax:`${cfg.tax.gainsRatePct}% + ${cfg.tax.cessPct}% cess on gains, no loss offset` }
  };
}

/* Rolling forward-performance summary for the always-on-screen strip.
   Same shape as the backtest so the UI renders either without branching. */
function rollingPerformance(trades,windowDays){
  const cutoff=Date.now()-(windowDays||90)*DAY;
  const rows=(trades||[]).filter(t=>t.exit_ts>=cutoff);
  const out=summarize(rows,0,S.withDefaults({}));
  out.window_days=windowDays||90;
  return out;
}

module.exports={replay,summarize,statsFor,wilson,fillPrice,settleIntrinsic,rollingPerformance,trendView};
