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
  // IST calendar date (UTC+5:30, no DST): shift the epoch forward 5.5h then read the UTC date → "today" rolls at IST midnight, not UTC's.
  const istDay = () => new Date(Date.now()+5.5*3600*1000).toISOString().slice(0,10);

  const DEFAULTS = {
    running:false, halted:false, goalHit:false,
    capital:100000, riskPct:1, dailyTargetPct:10, maxLev:5, tab:'Crypto', tf:'15m',
    timeframes:['15m','30m','1h'],                      // the bot hunts across these itself — you don't pick a TF (faster frames = quicker fills)
    feeBps:0, slipBps:0, dayLossLimitPct:5, cooldownMin:20, maxConcurrent:20,
    allowShort:true, allowPending:true, allowAggressive:false,   // aggressive = market-enter the strongest near-zone setups (still R:R-guarded)
    // --- discipline guards (what a smart trader does): never stop inside the noise, don't revenge-trade, don't fight the tape ---
    minStopPct:0.7,           // skip any trade whose stop sits closer than this % of price (inside 1-tick noise → instant stop-out)
    stopCooldownMin:90,       // after a LOSING stop-out, sit out this coin for this long (vs the shorter win cooldown)
    maxStopOutsPerCoin:2,     // after this many stop-outs in a day, bench the coin for the rest of the day (no revenge trades)
    lossStreakPause:3,        // after this many consecutive losing closes, stand down…
    streakPauseMin:45,        // …for this long, to let the tape settle (stop fighting a one-way market)
    stopOuts:{}, lossStreak:0, pauseUntil:0,
    cash:100000, positions:[], pending:[], closed:[], cooldown:{},
    startedAt:null, lastRun:null, lastError:null, dayAnchor:null, dayStartEquity:100000
  };
  let S = load();
  let lastPrices = {};

  function load(){ let st; try{ st=Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(FILE,'utf8'))); }catch(e){ st=JSON.parse(JSON.stringify(DEFAULTS)); }
    st.feeBps=0; st.slipBps=0;                                   // frictionless while validating raw accuracy (remove to re-enable costs)
    st.timeframes=DEFAULTS.timeframes.slice();                   // migrate to the current auto timeframe set
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
    // NOISE-FLOOR guard: a stop sitting inside 1-tick noise gets hit within a minute regardless of the idea. A smart trader
    // won't place a stop that tight — so skip it. (This is the main fix for the wave of trades that stopped out in ~1 min.)
    if(Math.abs(entry-stop) < entry*(S.minStopPct||0)/100) return false;
    const eq=markEquity(prices||lastPrices), qty=sizeQty(entry,stop,lev,eq); if(!(qty>0)) return false;
    const entryFee=feeOf(qty*entry); S.cash-=entryFee;
    S.positions.push({ id:Date.now()+'_'+a.sym, sym:a.sym, name:a.name, tk:a.tk||'', cls:a.cls, dir, lev,
      entry, stop, initStop:stop, targets:targets.slice(0,3), qty, remQty:qty, taken:0,
      openAt:Date.now(), lastPx:entry, feesPaid:entryFee, realized:0, tf:a.tf||S.tf, regime:a.regime||'trend' });
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
    const pnl=p.realized-p.feesPaid, cost=p.entry*p.qty;
    const loss = pnl<0;
    if(loss){
      // DON'T revenge-trade: sit this coin out longer after a loss; bench it for the day after repeated stop-outs.
      S.stopOuts[p.sym]=(S.stopOuts[p.sym]||0)+1;
      const benched = S.stopOuts[p.sym] >= (S.maxStopOutsPerCoin||99);
      S.cooldown[p.sym] = benched ? (Date.now()+24*3600*1000) : (Date.now()+(S.stopCooldownMin||S.cooldownMin||60)*60000);
      // DON'T fight the tape: after a run of losses, stand down for a while.
      S.lossStreak=(S.lossStreak||0)+1;
      if(S.lossStreak >= (S.lossStreakPause||99)) S.pauseUntil = Date.now()+(S.streakPauseMin||45)*60000;
    } else {
      S.lossStreak=0;                                                        // a win breaks the streak
      S.cooldown[p.sym]=Date.now()+(S.cooldownMin||0)*60000;
    }
    S.closed.unshift({ sym:p.sym, name:p.name, tk:p.tk, side:p.dir>0?'LONG':'SHORT', lev:p.lev, tf:p.tf, entry:p.entry, regime:p.regime||'trend',
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
      // Label the stop by what it really was: initial stop = a loss; after T1 the stop sits at breakeven; after T2 it's
      // trailed into profit. So a "stop" that fires post-target is a protected/winning exit, not a loss — say so.
      if(stopHit){ const r = p.taken<=0 ? 'stop' : (p.taken>=2 ? 'trail' : 'be'); reduce(p,p.remQty,p.stop,r); continue; }
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
    const exp=Math.min(FILL_BARS*tfMin(a.tf||'15m')*60000, 6*3600*1000);   // ~6 bars, but never rest more than 6 hours
    S.pending.push({ id:Date.now()+'_'+a.sym, sym:a.sym, name:a.name, tk:a.tk||'', cls:a.cls, dir, lev, limit, stop, targets:targets.slice(0,3), qty,
      placedAt:Date.now(), expiresAt:Date.now()+exp, tf:a.tf||'15m', regime:a.regime||'trend' });
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
    // BTC-weak quick short: a falling Bitcoin IS the confirmation for alt shorts, so take these at a lower per-coin bar.
    const corrShort = r.setup && r.setup.regime==='correction' && Math.abs(r.sig.score)>=12;
    if(corrShort) return true;
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
      const base={ sym:r.asset.sym, name:r.asset.name, tk:r.asset.tk||'', cls:r.asset.cls, dir:d, stop:r.setup.stop, targets:(r.setup.targets||[]).slice(0,3), tf:(r._tf||(S.timeframes&&S.timeframes[0])||'15m'), regime:(r.setup.regime||'trend') };
      if(base.targets.length<3) continue;
      const px0=(prices&&prices[r.asset.sym])||r.sig.price; if(!(px0>0)) continue;
      // aggressive = only the STRONGEST setups (MTF-confirmed AND score≥25) may skip the limit and enter at market,
      // and ONLY if buying here still leaves ≥1:1 reward:risk to T1 — so it never chases an extended move into bad math.
      const topTier = r.mtf && r.mtf.agree>=2 && Math.abs(r.sig.score)>=25;
      if(k==='buynow'||k==='buybreak')       openPosition(base, px0+slipOf(px0), lev, prices);
      else if(k==='sellnow'||k==='sellbreak') openPosition(base, px0-slipOf(px0), lev, prices);
      else if(k==='waitdip'){
        const me=px0+slipOf(px0), risk=me-base.stop, rr=risk>0?(base.targets[0]-me)/risk:0;
        if(S.allowAggressive && topTier && rr>=1) openPosition(base, me, lev, prices);
        else placePending({...base, limit:r.setup.entryHi}, lev);
      }
      else if(k==='waitbounce'){
        const me=px0-slipOf(px0), risk=base.stop-me, rr=risk>0?(me-base.targets[0])/risk:0;
        if(S.allowAggressive && topTier && rr>=1) openPosition(base, me, lev, prices);
        else placePending({...base, limit:r.setup.entryLo}, lev);
      }
    }
  }

  async function tick(){
    if(!S.running) return snapshot();
    S.lastRun=Date.now(); S.lastError=null;
    try{
      const today=istDay();   // IST calendar day — the target window is IST midnight → IST midnight
      if(S.dayAnchor!==today){ S.dayAnchor=today; S.dayStartEquity=markEquity(lastPrices); S.halted=false; S.goalHit=false; S.stopOuts={}; S.lossStreak=0; S.pauseUntil=0; }  // new day resets (incl. discipline counters)
      let prices={}; try{ prices=await liveQuotes(S.tab)||{}; }catch(e){}
      lastPrices=prices;
      manage(prices);
      checkPending(prices);
      const eq=markEquity(prices);
      if(!S.goalHit && eq >= S.dayStartEquity*(1 + S.dailyTargetPct/100)){ flattenAll(prices,'target'); S.goalHit=true; }   // 🎯 hit the day's goal → lock it in
      if(eq <= S.dayStartEquity*(1 - S.dayLossLimitPct/100)) S.halted=true;                                                 // 🛑 daily loss limit
      const paused = Date.now() < (S.pauseUntil||0);                                                                        // ⏸ standing down after a loss streak
      if(!S.halted && !S.goalHit && !paused && (S.positions.length+S.pending.length) < S.maxConcurrent){
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
    // --- edge / expectancy: the numbers that actually say whether it makes money ---
    const pnls=S.closed.map(t=>t.pnl);
    const winPnls=pnls.filter(v=>v>0), lossPnls=pnls.filter(v=>v<=0);
    const grossWin=winPnls.reduce((a,b)=>a+b,0), grossLoss=-lossPnls.reduce((a,b)=>a+b,0); // grossLoss = positive magnitude
    const avgWin=winPnls.length?grossWin/winPnls.length:0;
    const avgLoss=lossPnls.length?grossLoss/lossPnls.length:0;                              // positive magnitude
    const expectancy=tot?pnls.reduce((a,b)=>a+b,0)/tot:0;                                   // avg ₹ per trade — >0 means an edge
    const profitFactor=grossLoss>0?grossWin/grossLoss:(grossWin>0?99:0);                    // >1 means winners outweigh losers
    const benched=Object.keys(S.stopOuts||{}).filter(s=>(S.stopOuts[s]||0)>=(S.maxStopOutsPerCoin||99));
    return { running:S.running, halted:S.halted, goalHit:S.goalHit, tab:S.tab, timeframes:S.timeframes, usdtInr:(typeof rate==='function'?(rate()||0):0),
      paused:(Date.now()<(S.pauseUntil||0)), pauseUntil:S.pauseUntil||0, lossStreak:S.lossStreak||0, benched,
      config:{capital:S.capital,riskPct:S.riskPct,dailyTargetPct:S.dailyTargetPct,maxLev:S.maxLev,feeBps:S.feeBps,slipBps:S.slipBps,dayLossLimitPct:S.dayLossLimitPct,allowShort:S.allowShort,allowPending:S.allowPending,allowAggressive:S.allowAggressive,minStopPct:S.minStopPct,stopCooldownMin:S.stopCooldownMin,maxStopOutsPerCoin:S.maxStopOutsPerCoin,lossStreakPause:S.lossStreakPause,streakPauseMin:S.streakPauseMin},
      cash:S.cash, equity:eq, startEquity:S.capital, retPct:(eq/S.capital-1)*100,
      dayStartEquity:S.dayStartEquity, dayRetPct:S.dayStartEquity?(eq/S.dayStartEquity-1)*100:0, targetEquity:S.dayStartEquity*(1+S.dailyTargetPct/100),
      marginUsed:grossMargin(), openCount:S.positions.length, pendingCount:S.pending.length,
      positions:S.positions.map(p=>({sym:p.sym,name:p.name,tk:p.tk,side:p.dir>0?'LONG':'SHORT',lev:p.lev,tf:p.tf,regime:p.regime||'trend',entry:p.entry,stop:p.stop,targets:p.targets,remQty:p.remQty,qty:p.qty,taken:p.taken,lastPx:p.lastPx,uPnl:uPnl(p,(P&&P[p.sym])||p.lastPx)})),
      pending:S.pending.map(o=>({sym:o.sym,name:o.name,side:o.dir>0?'LONG':'SHORT',lev:o.lev,qty:o.qty,limit:o.limit,stop:o.stop,tf:o.tf,expiresAt:o.expiresAt})),
      closed:S.closed.slice(0,100), stats:{trades:tot,wins,losses:tot-wins,winRate:tot?wins/tot*100:0,realizedPnl:S.closed.reduce((a,t)=>a+t.pnl,0),avgWin,avgLoss,expectancy,profitFactor},
      startedAt:S.startedAt, lastRun:S.lastRun, lastError:S.lastError };
  }

  function setConfig(c){
    ['capital','riskPct','dailyTargetPct','maxLev','feeBps','slipBps','dayLossLimitPct','cooldownMin','maxConcurrent','minStopPct','stopCooldownMin','maxStopOutsPerCoin','lossStreakPause','streakPauseMin'].forEach(k=>{ if(c[k]!=null&&!isNaN(+c[k])) S[k]=+c[k]; });
    if(c.tab)S.tab=c.tab; if(c.tf)S.tf=c.tf;
    if(c.allowShort!=null)S.allowShort=!!c.allowShort;
    if(c.allowPending!=null)S.allowPending=!!c.allowPending;
    if(c.allowAggressive!=null)S.allowAggressive=!!c.allowAggressive;
    save(); return snapshot();
  }
  function start(){ if(!S.startedAt){ S.startedAt=Date.now(); S.cash=S.capital; S.dayStartEquity=S.capital; } S.running=true; S.halted=false; S.goalHit=false; save(); return snapshot(); }
  function stop(){ S.running=false; save(); return snapshot(); }
  function reset(){ const cfg={capital:S.capital,riskPct:S.riskPct,dailyTargetPct:S.dailyTargetPct,maxLev:S.maxLev,tab:S.tab,tf:S.tf,feeBps:S.feeBps,slipBps:S.slipBps,dayLossLimitPct:S.dayLossLimitPct,allowShort:S.allowShort,allowPending:S.allowPending,allowAggressive:S.allowAggressive,maxConcurrent:S.maxConcurrent,cooldownMin:S.cooldownMin,minStopPct:S.minStopPct,stopCooldownMin:S.stopCooldownMin,maxStopOutsPerCoin:S.maxStopOutsPerCoin,lossStreakPause:S.lossStreakPause,streakPauseMin:S.streakPauseMin};
    S=JSON.parse(JSON.stringify(DEFAULTS)); Object.assign(S,cfg); S.cash=S.capital; save(); return snapshot(); }

  return { tick, start, stop, reset, setConfig, getState:()=>snapshot(), __state:()=>S };
};
