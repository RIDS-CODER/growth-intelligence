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
module.exports = function createPaper({ scan, liveQuotes, dir, rate, topMovers, dumpBounce, dumpRule }) {
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
    timeframes:['5m','15m','30m','1h'],                 // the bot hunts across ALL of these itself — more scalp opportunities, same quality bar
    feeBps:0, slipBps:0, dayLossLimitPct:5, cooldownMin:20, maxConcurrent:20,
    allowShort:true, allowPending:true, allowAggressive:false,   // aggressive = market-enter the strongest near-zone setups (still R:R-guarded)
    /* WHICH DESK THE BOT TRADES. Each maps to a panel you already read, so what the bot takes is
       what you would have seen. `scalpOnly` used to be the only lever here — it is now just the
       difference between `quick` and `normal`, and is migrated on load for older saved state. */
    sources:{ quick:true, normal:false, movers:false, dump:false },
    scalpOnly:true,           // legacy: kept so old saved state migrates cleanly
    minConfPct:68,            // and only at High confidence (68 = the High threshold) — quality over quantity
    requireEdge:true,         // and only if THIS coin+direction actually made money in its own backtest…
    minWinRate:50,            // …with a historical win rate ≥ this on that side…
    minEdgeTrades:8,          // …over at least this many historical trades (else not enough evidence)
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
  // Belt and braces for a corrupt value; the real legacy migration happens in load().
  if(!S.sources || typeof S.sources!=='object')
    S.sources = {quick:true,normal:false,movers:false,dump:false};
  const SOURCES=['quick','normal','movers','dump'];
  const srcOn=k=>!!(S.sources&&S.sources[k]);
  const isScalp=r=>!!(r&&r.setup&&(r.setup.regime==='range'||r.setup.regime==='correction'));
  let lastPrices = {};

  function load(){ let st, raw=null;
    try{ raw=JSON.parse(fs.readFileSync(FILE,'utf8')); st=Object.assign({}, DEFAULTS, raw); }catch(e){ st=JSON.parse(JSON.stringify(DEFAULTS)); }
    /* Migrate BEFORE the DEFAULTS merge can hide it. `sources` is in DEFAULTS now, so a state file
       written by the old bot still comes back with sources set — and an existing bot running
       scalpOnly:false (every regime) would have been silently narrowed to quick-only on upgrade.
       Only the RAW file can tell us the user never chose desks, so the check lives here. */
    if(raw && !raw.sources)
      st.sources = raw.scalpOnly===false ? {quick:true,normal:true,movers:false,dump:false}
                                         : {quick:true,normal:false,movers:false,dump:false};
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
      openAt:Date.now(), lastPx:entry, feesPaid:entryFee, realized:0, tf:a.tf||S.tf, regime:a.regime||'trend', src:a.src||'quick' });
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
    S.closed.unshift({ sym:p.sym, name:p.name, tk:p.tk, side:p.dir>0?'LONG':'SHORT', lev:p.lev, tf:p.tf, entry:p.entry, regime:p.regime||'trend', src:p.src||'quick',
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
      placedAt:Date.now(), expiresAt:Date.now()+exp, tf:a.tf||'15m', regime:a.regime||'trend', src:a.src||'quick' });
  }

  // --- strategic selection: rank by conviction, take only quality setups ---
  const kindDir = k => (k==='buynow'||k==='buybreak'||k==='waitdip') ? 1 : (k==='sellnow'||k==='sellbreak'||k==='waitbounce') ? -1 : 0;
  /* ---------- WHERE CANDIDATES COME FROM ----------
     Four desks, each mapping to a panel you already read, so what the bot takes is what you would
     have seen yourself. They are normalised to one shape here; everything downstream (ranking,
     the quality gates, sizing, management) is shared, so a Dump & Bounce trade is held to exactly
     the same standard as a Quick Trade. */
  /* THE SIMPLE TWO ONLY: "long the rally" and "short the failure".
     A live plan alone is not enough. Checked against real output, every Dump & Bounce trade the
     bot would have taken was a BUY while the 4h bump was still FADING — buying the floor with
     price down 28-82% on the current leg and still rolling over. That is catching a knife, not
     trading the pattern, and it is the single worst variant of this setup.
     So the fast chart has to CONFIRM the direction before the bot will act:
       long  — only when the bump is `running` (a move is underway) or `building` (the fall has
               stopped and it is basing). Never while it is still fading.
       short — only when the bump is `late` (already matched its typical size) or `fading` (rolling
               over). That is what "the failure" means.
     Anything else is a plan without a trigger, and is left to you to read on the panel. */
  // The rule lives in server.js next to the data and is handed in, so the bot and the 🎢 panel can
  // never disagree about what will be traded. The literal below is only a standalone fallback.
  const DUMP_OK={ long:['running','building'], short:['late','fading'] };
  const dumpTakes = typeof dumpRule==='function' ? dumpRule
    : (r)=>{ const p=r&&r.plan; if(!p||(p.now!=='buy'&&p.now!=='short')) return {take:false};
             const side=p.now==='buy'?'long':'short';
             return {take:DUMP_OK[side].includes((r.bump&&r.bump.state)||'quiet')}; };
  function dumpCandidate(r){
    const p=r&&r.plan; if(!p) return null;
    if(p.now!=='buy' && p.now!=='short') return null;      // only LIVE plans, same as the panel
    const s = p.now==='buy' ? p.long : p.short;
    if(!s || !(s.targets||[]).length) return null;
    if(!dumpTakes(r).take){ funnel.dumpUnconfirmed++; return null; }
    const bt=r.planBt||{}, side=s.dir>0?bt.long:bt.short;
    return {
      asset:{sym:r.sym,tk:r.tk||'',name:r.name||r.tk||r.sym,cls:'Crypto',src:'cg'},
      sig:{price:p.price,score:s.dir>0?20:-20,verdict:s.dir>0?'BUY':'SELL'},
      action:{kind:s.dir>0?'buynow':'sellnow',cls:'now'},
      setup:{dir:s.dir,entryLo:s.entryLo,entryHi:s.entryHi,entry:s.entry,stop:s.stop,
        riskPct:s.riskPct,targets:(s.targets||[]).slice(0,3),ret:s.ret,rrr:s.rrr,regime:'dumpbounce'},
      confidence:(side&&!side.thin&&side.winRate!=null)
        ?{label:side.winRate>=50?'High':side.winRate>=35?'Medium':'Low',pct:side.winRate}:null,
      /* The proven-edge gate reads btSide. Dump & Bounce carries its OWN backtest of these exact
         levels, so the gate applies to it natively: a thin sample has winRate null and a losing
         plan has a negative median, and both are rejected without any special-casing. */
      btSide:{long: bt.long?{trades:bt.long.n,winRate:bt.long.winRate,avgRet:bt.long.medPct}:null,
              short:bt.short?{trades:bt.short.n,winRate:bt.short.winRate,avgRet:bt.short.medPct}:null},
      _tf:(r.bump&&r.bump.tf)||'4h', _src:'dump'
    };
  }
  async function collect(){
    const out=[], tfs=(S.timeframes&&S.timeframes.length)?S.timeframes:['15m'];
    if(srcOn('quick')||srcOn('normal')||srcOn('movers')){
      let scanned=[];
      for(const tf of tfs){ try{ const d=await scan(S.tab,tf);
        if(d&&Array.isArray(d.results)) for(const r of d.results) scanned.push({...r,_tf:tf}); }catch(e){} }
      // Volume Movers is the same scan filtered to coins that passed the participation gate — taking
      // it from there rather than from the movers payload keeps the backtest fields the gates need.
      let moverSyms=null;
      if(srcOn('movers')&&typeof topMovers==='function'){
        moverSyms=new Set();
        for(const tf of tfs){ try{ const m=await topMovers(S.tab,tf);
          (m&&m.movers||[]).forEach(x=>moverSyms.add(x.sym)); }catch(e){} }
      }
      for(const r of scanned){
        // A coin can qualify under several desks. Label it with the most specific one so the
        // per-source P&L below attributes it once, not three times.
        if(moverSyms&&moverSyms.has(r.asset.sym)){ out.push({...r,_src:'movers'}); continue; }
        if(srcOn('quick')&&isScalp(r)){ out.push({...r,_src:'quick'}); continue; }
        if(srcOn('normal')&&!isScalp(r)){ out.push({...r,_src:'normal'}); continue; }
      }
    }
    if(srcOn('dump')&&typeof dumpBounce==='function'){
      try{ const d=await dumpBounce(); for(const r of (d&&d.rows||[])){ const c=dumpCandidate(r); if(c) out.push(c); } }catch(e){}
    }
    return out;
  }

  // Why the bot passed on everything. Without this, a correctly SELECTIVE bot and a broken one
  // look identical from the panel: equity flat, no positions, no error. Counts are per tick.
  const blankFunnel=()=>({seen:0,noDirection:0,shortsOff:0,pendingOff:0,notScalp:0,lowConf:0,noEdge:0,dumpUnconfirmed:0,eligible:0,bySource:{}});
  let funnel=blankFunnel();
  function eligible(r){
    funnel.seen++;
    const sk=r&&r._src||'quick';
    const fs_=funnel.bySource[sk]=funnel.bySource[sk]||{seen:0,eligible:0};
    fs_.seen++;
    if(!r||!r.sig||!r.action||!r.setup) return false;
    const d=kindDir(r.action.kind); if(!d){ funnel.noDirection++; return false; }
    if(d<0 && !S.allowShort){ funnel.shortsOff++; return false; }
    if((r.action.kind==='waitdip'||r.action.kind==='waitbounce') && !S.allowPending){ funnel.pendingOff++; return false; }
    // SCALP-ONLY: only the quick/scalp regimes (range + correction) — never trend or breakout setups.
    // (regime is decided by which desks are enabled — see collect())
    // HIGH-CONFIDENCE ONLY: take only setups at/above the confidence floor (default 68 = High). Fall back to a
    // score proxy if the richer confidence metric isn't on the result (older scan payloads) so the bot isn't bricked.
    const conf = (r.confidence && r.confidence.pct!=null) ? r.confidence.pct : Math.min(97, Math.abs(r.sig.score)*2.2);
    if(conf < (S.minConfPct||0)){ funnel.lowConf++; return false; }
    // PROVEN EDGE ONLY: this coin's backtest, on THIS direction, must have actually made money — enough trades,
    // a win rate above the floor, and positive average return. No demonstrated edge on that side → don't take it.
    if(S.requireEdge){
      const side = r.setup.dir>0 ? 'long' : 'short';
      const e = r.btSide && r.btSide[side];
      if(!e || !(e.trades>=(S.minEdgeTrades||0)) || !(e.winRate>=(S.minWinRate||0)) || !(e.avgRet>0)){ funnel.noEdge++; return false; }
    }
    funnel.eligible++; fs_.eligible++;
    return true;
  }
  // Plain-English reason the bot is flat, built from the biggest rejection bucket.
  function whyIdle(){
    if(!SOURCES.some(srcOn)) return 'No desks selected — tick at least one of Quick / Normal / Movers / Dump & Bounce.';
    const f=S.funnel;
    // A candidate rejected inside collect() never reaches eligible(), so `seen` stays 0 while the
    // real reason sits in dumpUnconfirmed. Check that before concluding "nothing was found".
    if(f&&!f.seen&&f.dumpUnconfirmed)
      return `Scanned ${f.dumpUnconfirmed} Dump & Bounce plans, took none: no confirmation on the 4h chart — it only longs a rally that is running or basing, and only shorts a bump that is late or rolling over, never a floor that is still falling.`;
    if(!f||!f.seen) return 'The enabled desks produced no candidates on this pass.';
    if(f.eligible) return null;
    const buckets=[[f.dumpUnconfirmed,'the Dump & Bounce plans had no confirmation on the 4h chart — it only longs a rally that is running or basing, and only shorts a bump that is late or rolling over, never a floor that is still falling'],
      [f.notScalp,'none were scalp setups (range/correction) — turn off ⚡ Scalp only to widen'],
      [f.noEdge,'none had a proven backtested edge on that side — lower 📊 Proven edge / Min hist win %'],
      [f.lowConf,'none reached the confidence floor — lower Min conf %'],
      [f.noDirection,'the engine had no actionable entry on any of them'],
      [f.shortsOff,'the only candidates were shorts, and Shorts is off'],
      [f.pendingOff,'the only candidates needed a resting limit, and Dip limits is off']];
    buckets.sort((a,b)=>b[0]-a[0]);
    return buckets[0][0] ? `Scanned ${f.seen} setups, took none: ${buckets[0][1]}.` : null;
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
      const base={ sym:r.asset.sym, name:r.asset.name, tk:r.asset.tk||'', cls:r.asset.cls, dir:d, stop:r.setup.stop, targets:(r.setup.targets||[]).slice(0,3), tf:(r._tf||(S.timeframes&&S.timeframes[0])||'15m'), regime:(r.setup.regime||'trend'), src:(r._src||'quick') };
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
        // Reset BEFORE collecting: collect() records its own rejections (e.g. Dump & Bounce plans
        // with no 4h confirmation), and blanking afterwards threw those counts away.
        funnel=blankFunnel();
        const all=await collect();          // every enabled desk, across every timeframe, one shape
        if(all.length) openFromScan(all, prices);
        S.funnel=funnel;
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
      funnel:S.funnel||null, whyIdle:whyIdle(), sources:{...S.sources},
      /* WHICH DESK ACTUALLY MAKES MONEY. The point of choosing sources is being able to switch
         off the one that loses, so every closed trade is attributed and totalled here. */
      bySource:(()=>{ const o={};
        for(const k of SOURCES) o[k]={trades:0,wins:0,pnl:0,open:0,winRate:null};
        for(const t of S.closed){ const k=o[t.src||'quick']||o.quick; k.trades++; if(t.pnl>0)k.wins++; k.pnl+=t.pnl; }
        for(const p of S.positions){ const k=o[p.src||'quick']||o.quick; k.open++; }
        for(const k of SOURCES) if(o[k].trades) o[k].winRate=Math.round(100*o[k].wins/o[k].trades);
        return o; })(),
      config:{capital:S.capital,riskPct:S.riskPct,dailyTargetPct:S.dailyTargetPct,maxLev:S.maxLev,feeBps:S.feeBps,slipBps:S.slipBps,dayLossLimitPct:S.dayLossLimitPct,allowShort:S.allowShort,allowPending:S.allowPending,allowAggressive:S.allowAggressive,scalpOnly:S.scalpOnly,minConfPct:S.minConfPct,requireEdge:S.requireEdge,minWinRate:S.minWinRate,minEdgeTrades:S.minEdgeTrades,minStopPct:S.minStopPct,stopCooldownMin:S.stopCooldownMin,maxStopOutsPerCoin:S.maxStopOutsPerCoin,lossStreakPause:S.lossStreakPause,streakPauseMin:S.streakPauseMin},
      cash:S.cash, equity:eq, startEquity:S.capital, retPct:(eq/S.capital-1)*100,
      dayStartEquity:S.dayStartEquity, dayRetPct:S.dayStartEquity?(eq/S.dayStartEquity-1)*100:0, targetEquity:S.dayStartEquity*(1+S.dailyTargetPct/100),
      marginUsed:grossMargin(), openCount:S.positions.length, pendingCount:S.pending.length,
      positions:S.positions.map(p=>({sym:p.sym,name:p.name,tk:p.tk,side:p.dir>0?'LONG':'SHORT',lev:p.lev,tf:p.tf,regime:p.regime||'trend',src:p.src||'quick',entry:p.entry,stop:p.stop,targets:p.targets,remQty:p.remQty,qty:p.qty,taken:p.taken,lastPx:p.lastPx,uPnl:uPnl(p,(P&&P[p.sym])||p.lastPx)})),
      pending:S.pending.map(o=>({sym:o.sym,name:o.name,side:o.dir>0?'LONG':'SHORT',lev:o.lev,qty:o.qty,limit:o.limit,stop:o.stop,tf:o.tf,src:o.src||'quick',expiresAt:o.expiresAt})),
      closed:S.closed.slice(0,100), stats:{trades:tot,wins,losses:tot-wins,winRate:tot?wins/tot*100:0,realizedPnl:S.closed.reduce((a,t)=>a+t.pnl,0),avgWin,avgLoss,expectancy,profitFactor},
      startedAt:S.startedAt, lastRun:S.lastRun, lastError:S.lastError };
  }

  function setConfig(c){
    ['capital','riskPct','dailyTargetPct','maxLev','feeBps','slipBps','dayLossLimitPct','cooldownMin','maxConcurrent','minStopPct','stopCooldownMin','maxStopOutsPerCoin','lossStreakPause','streakPauseMin','minConfPct','minWinRate','minEdgeTrades'].forEach(k=>{ if(c[k]!=null&&!isNaN(+c[k])) S[k]=+c[k]; });
    if(c.sources&&typeof c.sources==='object'){ S.sources=S.sources||{};
      for(const k of SOURCES) if(c.sources[k]!=null) S.sources[k]=!!c.sources[k]; }
    if(c.tab)S.tab=c.tab; if(c.tf)S.tf=c.tf;
    if(c.allowShort!=null)S.allowShort=!!c.allowShort;
    if(c.allowPending!=null)S.allowPending=!!c.allowPending;
    if(c.allowAggressive!=null)S.allowAggressive=!!c.allowAggressive;
    if(c.scalpOnly!=null)S.scalpOnly=!!c.scalpOnly;
    if(c.requireEdge!=null)S.requireEdge=!!c.requireEdge;
    save(); return snapshot();
  }
  function start(){ if(!S.startedAt){ S.startedAt=Date.now(); S.cash=S.capital; S.dayStartEquity=S.capital; } S.running=true; S.halted=false; S.goalHit=false; save(); return snapshot(); }
  function stop(){ S.running=false; save(); return snapshot(); }
  function reset(){ const cfg={capital:S.capital,riskPct:S.riskPct,dailyTargetPct:S.dailyTargetPct,maxLev:S.maxLev,tab:S.tab,tf:S.tf,feeBps:S.feeBps,slipBps:S.slipBps,dayLossLimitPct:S.dayLossLimitPct,allowShort:S.allowShort,allowPending:S.allowPending,allowAggressive:S.allowAggressive,scalpOnly:S.scalpOnly,minConfPct:S.minConfPct,requireEdge:S.requireEdge,minWinRate:S.minWinRate,minEdgeTrades:S.minEdgeTrades,maxConcurrent:S.maxConcurrent,cooldownMin:S.cooldownMin,minStopPct:S.minStopPct,stopCooldownMin:S.stopCooldownMin,maxStopOutsPerCoin:S.maxStopOutsPerCoin,lossStreakPause:S.lossStreakPause,streakPauseMin:S.streakPauseMin};
    S=JSON.parse(JSON.stringify(DEFAULTS)); Object.assign(S,cfg); S.cash=S.capital; save(); return snapshot(); }

  return { tick, start, stop, reset, setConfig, getState:()=>snapshot(), __state:()=>S };
};
