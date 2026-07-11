/* ============================================================
   PAPER-TRADING ENGINE (simulation only — never touches real money)
   Crypto-FUTURES style, goal-seeking:
     • You set Capital + a Daily target %. The bot RANKS recommendations by
       conviction (score + multi-TF confirmation + backtest grade), takes only
       the best, sizes each by Risk %, and applies the engine's per-trade
       leverage (volatility-scaled, capped by your Max leverage).
     • LONG + SHORT, market ("… NOW") and pending limit ("WAIT for the dip/bounce").
     • Manages stop / scale-out / breakeven ratchet.
     • Hits the daily target → flattens and stands down until tomorrow.
     • Halts for the day at the daily loss limit.
   Fees/slippage default to 0 so you can judge raw signal accuracy.
   ============================================================ */
module.exports = function createPaper({ scan, liveQuotes, dir, rate }) {
  const fs = require('fs'), path = require('path');
  const FILE = path.join(dir, 'paper-state.json');
  const TF_MIN = {'5m':5,'15m':15,'30m':30,'1h':60,'4h':240,'6h':360,'12h':720,'daily':1440,'intraday':30};
  const FILL_BARS = 6;
  const tfMin = tf => TF_MIN[tf] || 30;

  const DEFAULTS = {
    running:false, halted:false, goalHit:false,
    capital:100000, riskPct:1, dailyTargetPct:10, maxLev:5, tab:'Crypto', tf:'15m',
    timeframes:['15m','1h','4h'],                       // the bot hunts across these itself — you don't pick a TF
    feeBps:0, slipBps:0, dayLossLimitPct:5, cooldownMin:20, maxConcurrent:20,
    allowShort:true, allowPending:true,
    cash:100000, positions:[], pending:[], closed:[], cooldown:{},
    startedAt:null, lastRun:null, lastError:null, dayAnchor:null, dayStartEquity:100000
  };
  let S = load();
  let lastPrices = {};

  function load(){ let st; try{ st=Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(FILE,'utf8'))); }catch(e){ st=JSON.parse(JSON.stringify(DEFAULTS)); }
    st.feeBps=0; st.slipBps=0;   // frictionless while validating raw accuracy (remove to re-enable costs)
    return st; }
  function save(){ try{ fs.writeFileSync(FILE, JSON.stringify(S)); }catch(e){} }
  const feeOf = notional => Math.abs(notional)*(S.feeBps/10000);
  const slipOf = px => px*(S.slipBps/10000);
  const uPnl = (p,px) => p.dir*(((px||p.lastPx||p.entry))-p.entry)*p.remQty;
  function markEquity(prices){ let m=S.cash; for(const p of S.positions){ const px=(prices&&prices[p.sym])||p.lastPx||p.entry; m+=uPnl(p,px); } return m; }
  function grossMargin(){ let g=0; for(const p of S.positions)g+=p.remQty*p.entry/(p.lev||1); for(const o of S.pending)g+=o.qty*o.limit/(o.lev||1); return g; }
  const held = sym => S.positions.some(p=>p.sym===sym) || S.pending.some(o=>o.sym===sym);
  const onCooldown = sym => S.cooldown && S.cooldown[sym] && Date.now()<S.cooldown[sym];
  const levFor = r => Math.max(1, Math.min(S.maxLev||1, (r.setup && r.setup.suggestedLev) || 1));   // engine's volatility-scaled lev, capped by user

  // risk-based size, limited so posted margin never exceeds free equity
  function sizeQty(entry, stop, lev, eq){
    const dist=Math.abs(entry-stop);
    if(!(dist>0)||!(eq>0)||!(lev>0)) return 0;                 // guard against NaN/degenerate inputs
    let qty = (eq*(S.riskPct/100)) / dist;
    const marginRoom = eq - grossMargin();
    if(qty*entry/lev > marginRoom){ if(marginRoom<=0) return 0; qty = marginRoom*lev/entry; }
    return (isFinite(qty)&&qty>0) ? qty : 0;
  }

  function openPosition(a, entry, lev, prices){
    const {dir,stop,targets}=a;
    if(!((dir>0&&stop<entry&&targets[0]>entry)||(dir<0&&stop>entry&&targets[0]<entry))) return false;
    const eq=markEquity(prices||lastPrices), qty=sizeQty(entry,stop,lev,eq); if(!(qty>0)) return false;
    const entryFee=feeOf(qty*entry); S.cash-=entryFee;
    S.positions.push({ id:Date.now()+'_'+a.sym, sym:a.sym, name:a.name, tk:a.tk||'', cls:a.cls, dir, lev,
      entry, stop, initStop:stop, targets:targets.slice(0,3), qty, remQty:qty, taken:0,
      openAt:Date.now(), lastPx:entry, feesPaid:entryFee, realized:0, tf:a.tf||S.tf });
    return true;
  }
  function reduce(p, qty, px, reason){
    qty=Math.min(qty,p.remQty); if(!(qty>0)) return;
    const fill=px - p.dir*slipOf(px);
    const exitFee=feeOf(qty*fill), pnl=p.dir*(fill-p.entry)*qty;
    S.cash += (pnl-exitFee); p.realized+=pnl; p.feesPaid+=exitFee; p.remQty-=qty;
    if(p.remQty<=1e-9) closePosition(p,reason);
  }
  function closePosition(p, reason){
    S.positions=S.positions.filter(x=>x.id!==p.id);
    S.cooldown[p.sym]=Date.now()+(S.cooldownMin||0)*60000;
    const pnl=p.realized-p.feesPaid, cost=p.entry*p.qty;
    S.closed.unshift({ sym:p.sym, name:p.name, tk:p.tk, side:p.dir>0?'LONG':'SHORT', lev:p.lev, tf:p.tf, entry:p.entry,
      openAt:p.openAt, closedAt:Date.now(), reason, pnl, pnlPct:cost?pnl/cost*100*(p.lev||1):0, holdMin:Math.round((Date.now()-p.openAt)/60000) });
    if(S.closed.length>500) S.closed.length=500;
  }
  function flattenAll(prices, reason){
    for(const p of S.positions.slice()){ const px=(prices&&prices[p.sym])||p.lastPx||p.entry; reduce(p,p.remQty,px,reason); }
    S.pending=[];
  }

  function manage(prices){
    for(const p of S.positions.slice()){
      const px=prices&&prices[p.sym]; if(!(px>0)) continue; p.lastPx=px;
      const stopHit = p.dir>0 ? px<=p.stop : px>=p.stop;
      if(stopHit){ reduce(p,p.remQty,p.stop,'stop'); continue; }
      const hit = k => p.dir>0 ? px>=p.targets[k] : px<=p.targets[k];
      if(p.taken<1 && hit(0)){ reduce(p,p.qty/3,p.targets[0],'T1'); if(p.remQty>1e-9){p.taken=1;p.stop=p.entry;} }
      if(p.taken<2 && hit(1)){ reduce(p,p.qty/3,p.targets[1],'T2'); if(p.remQty>1e-9){p.taken=2;p.stop=p.targets[0];} }
      if(p.taken<3 && hit(2)){ reduce(p,p.remQty,p.targets[2],'T3'); }
    }
  }
  function checkPending(prices){
    for(const o of S.pending.slice()){
      if(Date.now()>o.expiresAt){ S.pending=S.pending.filter(x=>x.id!==o.id); continue; }
      const px=prices&&prices[o.sym]; if(!(px>0)) continue;
      const reached = o.dir>0 ? px<=o.limit : px>=o.limit;
      if(reached){ S.pending=S.pending.filter(x=>x.id!==o.id); openPosition(o, o.limit, o.lev, prices); }
    }
  }
  function placePending(a, lev){
    const {dir,limit,stop,targets}=a;
    if(!((dir>0&&stop<limit&&targets[0]>limit)||(dir<0&&stop>limit&&targets[0]<limit))) return;
    const eq=markEquity(lastPrices), qty=sizeQty(limit,stop,lev,eq); if(!(qty>0)) return;
    S.pending.push({ id:Date.now()+'_'+a.sym, sym:a.sym, name:a.name, tk:a.tk||'', cls:a.cls, dir, lev, limit, stop, targets:targets.slice(0,3), qty,
      placedAt:Date.now(), expiresAt:Date.now()+FILL_BARS*tfMin(a.tf||'15m')*60000, tf:a.tf||'15m' });
  }

  // --- strategic selection: rank by conviction, take only quality setups ---
  const kindDir = k => (k==='buynow'||k==='buybreak'||k==='waitdip') ? 1 : (k==='sellnow'||k==='sellbreak'||k==='waitbounce') ? -1 : 0;
  function eligible(r){
    if(!r||!r.sig||!r.action||!r.setup) return false;
    const d=kindDir(r.action.kind); if(!d) return false;
    if(d<0 && !S.allowShort) return false;
    if((r.action.kind==='waitdip'||r.action.kind==='waitbounce') && !S.allowPending) return false;
    const mtfOk = r.mtf && r.mtf.agree>=2;                 // confirmed on a higher timeframe
    const strong = Math.abs(r.sig.score)>=20;             // or strong standalone conviction
    return mtfOk || strong;
  }
  const conviction = r => Math.abs(r.sig.score) + (r.mtf?r.mtf.agree*6:0) + ((r.bt&&r.bt.score)?r.bt.score*0.3:0);

  function openFromScan(results, prices){
    // rank by conviction across ALL timeframes, then keep only the BEST instance per coin (highest-conviction TF wins)
    const seen=new Set();
    const cands = results.filter(eligible).sort((a,b)=>conviction(b)-conviction(a))
      .filter(r=>{ const sym=r.asset.sym; if(seen.has(sym))return false; seen.add(sym); return !held(sym)&&!onCooldown(sym); });
    for(const r of cands){
      if(S.positions.length+S.pending.length >= S.maxConcurrent) break;
      if(held(r.asset.sym)) continue;   // state changes as we place — never double-commit a coin
      const k=r.action.kind, d=kindDir(r.action.kind), lev=levFor(r);
      const base={ sym:r.asset.sym, name:r.asset.name, tk:r.asset.tk||'', cls:r.asset.cls, dir:d, stop:r.setup.stop, targets:(r.setup.targets||[]).slice(0,3), tf:(r._tf||(S.timeframes&&S.timeframes[0])||'15m') };
      if(base.targets.length<3) continue;
      const px0=(prices&&prices[r.asset.sym])||r.sig.price; if(!(px0>0)) continue;
      if(k==='buynow'||k==='buybreak')       openPosition(base, px0+slipOf(px0), lev, prices);
      else if(k==='sellnow'||k==='sellbreak') openPosition(base, px0-slipOf(px0), lev, prices);
      else if(k==='waitdip')                  placePending({...base, limit:r.setup.entryHi}, lev);
      else if(k==='waitbounce')               placePending({...base, limit:r.setup.entryLo}, lev);
    }
  }

  async function tick(){
    if(!S.running) return snapshot();
    S.lastRun=Date.now(); S.lastError=null;
    try{
      const today=new Date().toDateString();
      if(S.dayAnchor!==today){ S.dayAnchor=today; S.dayStartEquity=markEquity(lastPrices); S.halted=false; S.goalHit=false; }  // new day resets
      let prices={}; try{ prices=await liveQuotes(S.tab)||{}; }catch(e){}
      lastPrices=prices;
      manage(prices);
      checkPending(prices);
      const eq=markEquity(prices);
      if(!S.goalHit && eq >= S.dayStartEquity*(1 + S.dailyTargetPct/100)){ flattenAll(prices,'target'); S.goalHit=true; }   // 🎯 hit the day's goal → lock it in
      if(eq <= S.dayStartEquity*(1 - S.dayLossLimitPct/100)) S.halted=true;                                                 // 🛑 daily loss limit
      if(!S.halted && !S.goalHit && (S.positions.length+S.pending.length) < S.maxConcurrent){
        const tfs=(S.timeframes&&S.timeframes.length)?S.timeframes:['15m'];
        let all=[];                                                   // hunt across ALL timeframes, then rank the best
        for(const tf of tfs){ try{ const d=await scan(S.tab,tf); if(d&&Array.isArray(d.results)){ for(const r of d.results) r._tf=tf; all=all.concat(d.results); } }catch(e){} }
        if(all.length) openFromScan(all, prices);
      }
    }catch(e){ S.lastError=String(e.message||e); }
    save(); return snapshot();
  }

  function snapshot(prices){
    const P=prices||lastPrices, eq=markEquity(P);
    const wins=S.closed.filter(t=>t.pnl>0).length, tot=S.closed.length;
    return { running:S.running, halted:S.halted, goalHit:S.goalHit, tab:S.tab, timeframes:S.timeframes, usdtInr:(typeof rate==='function'?(rate()||0):0),
      config:{capital:S.capital,riskPct:S.riskPct,dailyTargetPct:S.dailyTargetPct,maxLev:S.maxLev,feeBps:S.feeBps,slipBps:S.slipBps,dayLossLimitPct:S.dayLossLimitPct,allowShort:S.allowShort,allowPending:S.allowPending},
      cash:S.cash, equity:eq, startEquity:S.capital, retPct:(eq/S.capital-1)*100,
      dayStartEquity:S.dayStartEquity, dayRetPct:S.dayStartEquity?(eq/S.dayStartEquity-1)*100:0, targetEquity:S.dayStartEquity*(1+S.dailyTargetPct/100),
      marginUsed:grossMargin(), openCount:S.positions.length, pendingCount:S.pending.length,
      positions:S.positions.map(p=>({sym:p.sym,name:p.name,tk:p.tk,side:p.dir>0?'LONG':'SHORT',lev:p.lev,tf:p.tf,entry:p.entry,stop:p.stop,targets:p.targets,remQty:p.remQty,qty:p.qty,taken:p.taken,lastPx:p.lastPx,uPnl:uPnl(p,(P&&P[p.sym])||p.lastPx)})),
      pending:S.pending.map(o=>({sym:o.sym,name:o.name,side:o.dir>0?'LONG':'SHORT',lev:o.lev,qty:o.qty,limit:o.limit,stop:o.stop,tf:o.tf,expiresAt:o.expiresAt})),
      closed:S.closed.slice(0,100), stats:{trades:tot,wins,winRate:tot?wins/tot*100:0,realizedPnl:S.closed.reduce((a,t)=>a+t.pnl,0)},
      startedAt:S.startedAt, lastRun:S.lastRun, lastError:S.lastError };
  }

  function setConfig(c){
    ['capital','riskPct','dailyTargetPct','maxLev','feeBps','slipBps','dayLossLimitPct','cooldownMin','maxConcurrent'].forEach(k=>{ if(c[k]!=null&&!isNaN(+c[k])) S[k]=+c[k]; });
    if(c.tab)S.tab=c.tab; if(c.tf)S.tf=c.tf;
    if(c.allowShort!=null)S.allowShort=!!c.allowShort;
    if(c.allowPending!=null)S.allowPending=!!c.allowPending;
    save(); return snapshot();
  }
  function start(){ if(!S.startedAt){ S.startedAt=Date.now(); S.cash=S.capital; S.dayStartEquity=S.capital; } S.running=true; S.halted=false; S.goalHit=false; save(); return snapshot(); }
  function stop(){ S.running=false; save(); return snapshot(); }
  function reset(){ const cfg={capital:S.capital,riskPct:S.riskPct,dailyTargetPct:S.dailyTargetPct,maxLev:S.maxLev,tab:S.tab,tf:S.tf,feeBps:S.feeBps,slipBps:S.slipBps,dayLossLimitPct:S.dayLossLimitPct,allowShort:S.allowShort,allowPending:S.allowPending,maxConcurrent:S.maxConcurrent,cooldownMin:S.cooldownMin};
    S=JSON.parse(JSON.stringify(DEFAULTS)); Object.assign(S,cfg); S.cash=S.capital; save(); return snapshot(); }

  return { tick, start, stop, reset, setConfig, getState:()=>snapshot(), __state:()=>S };
};
