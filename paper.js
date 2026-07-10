/* ============================================================
   PAPER-TRADING ENGINE (simulation only — never touches real money)
   A server-side control loop that mirrors the eventual live executor:
     scan → size by risk → simulate a fill (slippage+fees) → manage
     stop / scale-out targets / trailing → close → journal.
   Swap simulateFill() for a real exchange order later and it's a live bot.
   ============================================================ */
module.exports = function createPaper({ scan, liveQuotes, dir }) {
  const fs = require('fs'), path = require('path');
  const FILE = path.join(dir, 'paper-state.json');

  const DEFAULTS = {
    running:false, halted:false,
    capital:100000, riskPct:1, maxPos:5, tab:'Crypto', tf:'15m',
    feeBps:40, slipBps:10, dayLossLimitPct:5,          // 0.40% fee + 0.10% slippage per fill; halt after -5% on the day
    cooldownMin:20,                                     // don't re-enter the same symbol for N minutes after a close
    cash:100000, positions:[], closed:[], cooldown:{},
    startedAt:null, lastRun:null, lastError:null,
    dayAnchor:null, dayStartEquity:100000
  };
  let S = load();

  function load(){ try{ return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(FILE,'utf8'))); }catch(e){ return JSON.parse(JSON.stringify(DEFAULTS)); } }
  function save(){ try{ fs.writeFileSync(FILE, JSON.stringify(S)); }catch(e){} }
  const fee = v => v*(S.feeBps/10000);
  const slip = px => px*(S.slipBps/10000);
  function markEquity(prices){ let m=S.cash; for(const p of S.positions){ const px=(prices&&prices[p.sym])||p.lastPx||p.entry; m+=p.remQty*px; } return m; }

  // ---- open a paper position from a scan result (long only, actionable BUY) ----
  function openOne(r, prices){
    if(!r||!r.sig||r.sig.verdict!=='BUY'||!r.action||r.action.cls!=='now') return;   // only live "BUY NOW" setups
    const sym=r.asset.sym;
    if(S.positions.some(p=>p.sym===sym)) return;                                       // one position per symbol
    if(S.cooldown&&S.cooldown[sym]&&Date.now()<S.cooldown[sym]) return;                // re-entry cooldown after a close
    const px0=(prices&&prices[sym])||r.sig.price; if(!(px0>0)) return;
    const entry=px0+slip(px0);                                                         // adverse slippage on entry
    const stop=r.setup.stop, targets=(r.setup.targets||[]).slice(0,3);
    if(!(entry>stop) || targets.length<3 || !(targets[0]>entry)) return;               // valid long: stop below, T1 above the live entry
    const riskCap=markEquity(prices)*(S.riskPct/100);
    let qty=riskCap/(entry-stop);
    let cost=qty*entry;
    const maxCost=S.cash*0.95; if(cost>maxCost){ cost=maxCost; qty=cost/entry; }
    if(!(qty>0) || !(cost>0) || cost>S.cash) return;
    const entryFee=fee(cost);
    S.cash -= (cost+entryFee);
    S.positions.push({ id:Date.now()+'_'+sym, sym, name:r.asset.name, tk:r.asset.tk||'', cls:r.asset.cls,
      entry, stop, initStop:stop, targets, qty, remQty:qty, taken:0,
      openAt:Date.now(), lastPx:entry, costBasis:cost+entryFee, netProceeds:0, tf:S.tf });
  }

  function sell(p, qty, px, reason){
    qty=Math.min(qty, p.remQty); if(!(qty>0)) return;
    const fill=px-slip(px);                                                            // adverse slippage on exit
    const proceeds=qty*fill, exitFee=fee(proceeds);
    S.cash += (proceeds-exitFee); p.netProceeds += (proceeds-exitFee); p.remQty -= qty;
    if(p.remQty<=1e-9) closePosition(p, reason);
  }
  function closePosition(p, reason){
    S.positions = S.positions.filter(x=>x.id!==p.id);
    S.cooldown[p.sym]=Date.now()+(S.cooldownMin||0)*60000;                             // block immediate re-entry
    const pnl=p.netProceeds - p.costBasis, pnlPct=pnl/p.costBasis*100;
    S.closed.unshift({ sym:p.sym, name:p.name, tk:p.tk, cls:p.cls, tf:p.tf, entry:p.entry,
      openAt:p.openAt, closedAt:Date.now(), reason, pnl, pnlPct, holdMin:Math.round((Date.now()-p.openAt)/60000) });
    if(S.closed.length>500) S.closed.length=500;
  }

  // ---- manage open positions against live prices (stop / scale-out / breakeven ratchet) ----
  function manage(prices){
    for(const p of S.positions.slice()){
      const px=prices&&prices[p.sym]; if(!(px>0)) continue; p.lastPx=px;
      if(px<=p.stop){ sell(p, p.remQty, p.stop, 'stop'); continue; }                   // stopped out
      if(p.taken<1 && px>=p.targets[0]){ sell(p, p.qty/3, p.targets[0], 'T1'); if(p.remQty>1e-9){ p.taken=1; p.stop=p.entry; } }        // → breakeven
      if(p.taken<2 && px>=p.targets[1]){ sell(p, p.qty/3, p.targets[1], 'T2'); if(p.remQty>1e-9){ p.taken=2; p.stop=p.targets[0]; } }   // → lock T1
      if(p.taken<3 && px>=p.targets[2]){ sell(p, p.remQty, p.targets[2], 'T3'); }                                                      // final third
    }
  }

  // ---- one control-loop iteration ----
  async function tick(){
    if(!S.running) return snapshot();
    S.lastRun=Date.now(); S.lastError=null;
    try{
      const today=new Date().toDateString();
      if(S.dayAnchor!==today){ S.dayAnchor=today; S.dayStartEquity=markEquity(null); S.halted=false; }   // daily reset
      let prices={}; try{ prices=await liveQuotes(S.tab)||{}; }catch(e){}
      manage(prices);
      const eq=markEquity(prices);
      if(eq <= S.dayStartEquity*(1 - S.dayLossLimitPct/100)) S.halted=true;             // daily circuit breaker
      if(!S.halted && S.positions.length < S.maxPos){
        let d=null; try{ d=await scan(S.tab, S.tf); }catch(e){}
        if(d && Array.isArray(d.results)){
          for(const r of d.results){ if(S.positions.length>=S.maxPos) break; openOne(r, prices); }
        }
      }
    }catch(e){ S.lastError=String(e.message||e); }
    save(); return snapshot();
  }

  function snapshot(prices){
    const eq=markEquity(prices);
    const wins=S.closed.filter(t=>t.pnl>0).length, tot=S.closed.length;
    const realized=S.closed.reduce((a,t)=>a+t.pnl,0);
    return { running:S.running, halted:S.halted, tab:S.tab, tf:S.tf, config:{capital:S.capital,riskPct:S.riskPct,maxPos:S.maxPos,feeBps:S.feeBps,slipBps:S.slipBps,dayLossLimitPct:S.dayLossLimitPct},
      cash:S.cash, equity:eq, startEquity:S.capital, retPct:(eq/S.capital-1)*100,
      openCount:S.positions.length, positions:S.positions.map(p=>({sym:p.sym,name:p.name,tk:p.tk,entry:p.entry,stop:p.stop,targets:p.targets,remQty:p.remQty,qty:p.qty,taken:p.taken,lastPx:p.lastPx,uPnl:(p.lastPx-p.entry)*p.remQty,openAt:p.openAt})),
      closed:S.closed.slice(0,100), stats:{trades:tot,wins,winRate:tot?wins/tot*100:0,realizedPnl:realized},
      startedAt:S.startedAt, lastRun:S.lastRun, lastError:S.lastError };
  }

  function setConfig(c){ ['capital','riskPct','maxPos','tab','tf','feeBps','slipBps','dayLossLimitPct'].forEach(k=>{ if(c[k]!=null&&!isNaN(+c[k])||k==='tab'||k==='tf'){ if(k==='tab'||k==='tf')S[k]=c[k]; else S[k]=+c[k]; } }); save(); return snapshot(); }
  function start(){ if(!S.startedAt){ S.startedAt=Date.now(); S.cash=S.capital; S.dayStartEquity=S.capital; } S.running=true; S.halted=false; save(); return snapshot(); }
  function stop(){ S.running=false; save(); return snapshot(); }
  function reset(){ const cfg={capital:S.capital,riskPct:S.riskPct,maxPos:S.maxPos,tab:S.tab,tf:S.tf,feeBps:S.feeBps,slipBps:S.slipBps,dayLossLimitPct:S.dayLossLimitPct};
    S=JSON.parse(JSON.stringify(DEFAULTS)); Object.assign(S,cfg); S.cash=S.capital; save(); return snapshot(); }

  return { tick, start, stop, reset, setConfig, getState:()=>snapshot(), __state:()=>S };
};
