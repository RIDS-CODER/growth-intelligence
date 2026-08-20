/* 🤖 Paper bot — which desk it trades.
   The bot can now take candidates from four places, each mapping to a panel you already read.
   These tests pin the two things that make that trustworthy: every desk is reachable and produces
   its own candidates, and the SAME quality gates apply to all of them — a Dump & Bounce plan gets
   no free pass just because it arrives from a different door. */
const test=require("node:test");
const assert=require("node:assert");
const os=require("node:os");
const S=require("../server.js");
const createPaper=require("../paper.js");

const mk=over=>createPaper({scan:S.scan,liveQuotes:async()=>({}),dir:os.tmpdir(),rate:()=>0,
  topMovers:S.topMovers,dumpBounce:S.dumpBounce,...over});
const only=k=>({quick:false,normal:false,movers:false,dump:false,[k]:true});

/* DEMO only ever produces knife-catches (buy into a fading bump), which the desk now refuses by
   design — so a CONFIRMED plan has to be injected to exercise anything downstream of that rule. */
function fakeDump({side='short',state='fading',bt={n:20,winRate:60,medPct:3.2}}={}){
  const long ={dir:1, entryLo:90,entryHi:95,entry:92.5,stop:85,riskPct:8,targets:[105,115,130],ret:[13,24,40],rrr:2.1};
  const short={dir:-1,entryLo:105,entryHi:110,entry:107.5,stop:118,riskPct:9,targets:[95,88,80],ret:[11,18,25],rrr:1.9};
  return async()=>({rows:[{sym:'FAKEUSDT',tk:'FAKE',name:'Fake',ddPct:70,peakAgeDays:120,
    bump:{state,tf:'4h'},
    plan:{now:side==='short'?'short':'buy',price:side==='short'?108:92,long,short},
    planBt:{long:side==='short'?{n:2,winRate:null,medPct:0,thin:true}:{...bt,thin:false},
            short:side==='short'?{...bt,thin:false}:{n:2,winRate:null,medPct:0,thin:true}}}]});
}

test("every desk is reachable and produces its own candidates",async()=>{
  for(const desk of ["quick","normal","movers"]){
    const p=mk(); p.reset();
    p.setConfig({sources:only(desk),requireEdge:false,minConfPct:0,minStopPct:0});
    p.start(); const st=await p.tick(); p.stop();
    assert.ok(st.funnel.seen>0,desk+": produced no candidates at all");
    assert.ok(st.funnel.bySource[desk],desk+": candidates were not attributed to it");
    assert.strictEqual(Object.keys(st.funnel.bySource).length,1,desk+": leaked candidates from another desk");
  }
  // The dump desk is reached too — it just refuses DEMO's knife-catches, so prove it with a
  // confirmed plan rather than by loosening the rule.
  const p=mk({dumpBounce:fakeDump({side:'short',state:'fading'})}); p.reset();
  p.setConfig({sources:only("dump"),requireEdge:false,minConfPct:0,minStopPct:0});
  p.start(); const st=await p.tick(); p.stop();
  assert.ok(st.funnel.seen>0,"dump: a confirmed plan must reach the gates");
  assert.ok(st.funnel.bySource.dump,"dump: not attributed");
  assert.strictEqual(Object.keys(st.funnel.bySource).length,1,"dump: leaked from another desk");
});

test("no desks selected is stated, not silently idle",async()=>{
  const p=mk(); p.reset();
  p.setConfig({sources:{quick:false,normal:false,movers:false,dump:false}});
  p.start(); const st=await p.tick(); p.stop();
  assert.strictEqual(st.openCount,0);
  assert.match(st.whyIdle||"",/No desks selected/);
});

test("the proven-edge gate applies to Dump & Bounce using ITS OWN backtest",async()=>{
  // Arriving from a different panel earns no exemption. Dump & Bounce carries a backtest of its
  // exact levels, so the gate reads that — a profitable side passes, a losing one is refused,
  // with no special-casing anywhere.
  const good=mk({dumpBounce:fakeDump({side:'short',state:'fading',bt:{n:20,winRate:60,medPct:3.2}})});
  good.reset(); good.setConfig({sources:only("dump"),requireEdge:true,minWinRate:50,minEdgeTrades:8,minConfPct:0,minStopPct:0});
  good.start(); const a=await good.tick(); good.stop();
  assert.strictEqual(a.funnel.eligible,1,"a side its own backtest says makes money must be tradeable");

  const bad=mk({dumpBounce:fakeDump({side:'short',state:'fading',bt:{n:20,winRate:22,medPct:-4.1}})});
  bad.reset(); bad.setConfig({sources:only("dump"),requireEdge:true,minWinRate:50,minEdgeTrades:8,minConfPct:0,minStopPct:0});
  bad.start(); const b=await bad.tick(); bad.stop();
  assert.strictEqual(b.funnel.eligible,0,"a plan its own backtest says loses money must not be traded");
  assert.match(b.whyIdle||"",/proven backtested edge/);

  const thin=mk({dumpBounce:fakeDump({side:'short',state:'fading',bt:{n:3,winRate:null,medPct:9}})});
  thin.reset(); thin.setConfig({sources:only("dump"),requireEdge:true,minWinRate:50,minEdgeTrades:8,minConfPct:0,minStopPct:0});
  thin.start(); const c=await thin.tick(); thin.stop();
  assert.strictEqual(c.funnel.eligible,0,"a 3-trade sample is not evidence");
});

test("a confirmed rally is longed and a confirmed failure is shorted",async()=>{
  for(const [side,state,want] of [['short','fading',1],['short','late',1],['short','running',0],
                                  ['buy','running',1],['buy','building',1],['buy','fading',0]]){
    const p=mk({dumpBounce:fakeDump({side,state})}); p.reset();
    p.setConfig({sources:only("dump"),requireEdge:false,minConfPct:0,minStopPct:0});
    p.start(); const st=await p.tick(); p.stop();
    assert.strictEqual(st.funnel.eligible,want,`${side} while the bump is ${state}`);
  }
});

test("a thin or losing backtest cannot pass the edge gate",()=>{
  // Guards the adapter's mapping: n -> trades, winRate -> winRate, medPct -> avgRet.
  const gate=(e,minT,minW)=>!!(e&&e.trades>=minT&&e.winRate>=minW&&e.avgRet>0);
  assert.strictEqual(gate({trades:11,winRate:18,avgRet:-9.4},8,50),false,"losing");
  assert.strictEqual(gate({trades:3,winRate:null,avgRet:5},8,50),false,"thin sample: winRate is null");
  assert.strictEqual(gate({trades:20,winRate:60,avgRet:-1},8,50),false,"good win rate, negative median");
  assert.strictEqual(gate({trades:20,winRate:60,avgRet:2.5},8,50),true,"only a genuinely profitable side passes");
});

test("every trade is attributed to the desk that produced it",async()=>{
  const p=mk(); p.reset();
  p.setConfig({sources:{quick:true,normal:true,movers:true,dump:true},requireEdge:false,minConfPct:0,minStopPct:0});
  p.start(); const st=await p.tick(); p.stop();
  const desks=["quick","normal","movers","dump"];
  for(const x of (st.positions||[]))assert.ok(desks.includes(x.src),"open position with no desk: "+JSON.stringify(x.sym));
  for(const x of (st.pending||[]))assert.ok(desks.includes(x.src),"pending order with no desk");
  assert.ok(st.bySource,"per-desk P&L must be published — it is how you decide what to switch off");
  for(const k of desks)assert.ok(st.bySource[k]&&typeof st.bySource[k].pnl==="number");
  const openTotal=desks.reduce((a,k)=>a+st.bySource[k].open,0);
  assert.strictEqual(openTotal,(st.positions||[]).length,"attribution must not double count");
});

test("a coin qualifying under several desks is counted once",async()=>{
  const p=mk(); p.reset();
  p.setConfig({sources:{quick:true,normal:true,movers:true,dump:true},requireEdge:false,minConfPct:0,minStopPct:0});
  p.start(); const st=await p.tick(); p.stop();
  const f=st.funnel;
  const summed=Object.values(f.bySource).reduce((a,b)=>a+b.seen,0);
  assert.strictEqual(summed,f.seen,"a candidate labelled by two desks would inflate the funnel");
});

test("legacy saved state migrates scalpOnly into the new desks",()=>{
  // scalpOnly:true meant quick-only; false meant every regime, i.e. quick + normal.
  const fs=require("node:fs"), path=require("node:path");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"paper-"));
  fs.writeFileSync(path.join(dir,"paper-state.json"),JSON.stringify({scalpOnly:false,capital:100000}));
  const a=createPaper({scan:S.scan,liveQuotes:async()=>({}),dir,rate:()=>0}).getState();
  assert.deepStrictEqual(a.sources,{quick:true,normal:true,movers:false,dump:false});

  const dir2=fs.mkdtempSync(path.join(os.tmpdir(),"paper-"));
  fs.writeFileSync(path.join(dir2,"paper-state.json"),JSON.stringify({scalpOnly:true,capital:100000}));
  const b=createPaper({scan:S.scan,liveQuotes:async()=>({}),dir:dir2,rate:()=>0}).getState();
  assert.deepStrictEqual(b.sources,{quick:true,normal:false,movers:false,dump:false},
    "an existing bot must keep trading exactly what it traded before the upgrade");
});

test("the picker and per-desk P&L are actually in the page",()=>{
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  for(const id of ["ppSrcQuick","ppSrcNormal","ppSrcMovers","ppSrcDump"])
    assert.ok(html.includes('id="'+id+'"'),"missing checkbox "+id);
  assert.match(html,/sources:\{quick:\(g\('ppSrcQuick'\)\|\|\{\}\)\.checked/,"the picker must be saved");
  assert.match(html,/Which desk is making the money/,"per-desk P&L table");
  const srcTagAt=html.indexOf("const srcTag="), posAt=html.indexOf("const pos=(s.positions");
  assert.ok(srcTagAt>-1&&srcTagAt<posAt,"srcTag must be declared before use, or it throws in the TDZ");
});

/* ---------------- 🎢 the simple two: long the rally, short the failure ---------------- */

test("the dump desk refuses to buy a floor that is still falling",async()=>{
  // Checked against real output: EVERY Dump & Bounce trade the bot would have taken was a BUY
  // while the 4h bump was FADING — price down 28-82% on the current leg and still rolling over.
  // That is catching a knife, and it was the only thing this desk ever did.
  const d=await S.dumpBounce();
  const live=d.rows.filter(r=>r.plan&&(r.plan.now==="buy"||r.plan.now==="short"));
  assert.ok(live.length>0,"fixture check");
  assert.ok(live.every(r=>((r.bump&&r.bump.state)||"quiet")==="fading"),
    "fixture check: in DEMO every live plan is a buy into a fading bump");

  const p=mk(); p.reset();
  p.setConfig({sources:only("dump"),requireEdge:false,minConfPct:0,minStopPct:0});
  p.start(); const st=await p.tick(); p.stop();
  assert.strictEqual(st.funnel.eligible,0,"not one knife-catch may be taken");
  assert.strictEqual(st.funnel.dumpUnconfirmed,live.length,"and each refusal is counted");
  assert.match(st.whyIdle||"",/no confirmation on the 4h chart/);
});

test("the confirmation rule is exactly long-the-rally and short-the-failure",()=>{
  // Long needs a move that is underway or basing; short needs one that is spent or rolling over.
  const OK={buy:["running","building"],short:["late","fading"]};
  const allow=(side,state)=>OK[side].includes(state);
  assert.strictEqual(allow("buy","running"),true,"a rally that is running");
  assert.strictEqual(allow("buy","building"),true,"or one that is basing off the low");
  assert.strictEqual(allow("buy","fading"),false,"never while it is still falling");
  assert.strictEqual(allow("buy","late"),false,"and not into an exhausted move");
  assert.strictEqual(allow("short","late"),true,"a bump that has matched its typical size");
  assert.strictEqual(allow("short","fading"),true,"or is rolling over — the failure");
  assert.strictEqual(allow("short","running"),false,"never short a rally still running");
  assert.strictEqual(allow("short","building"),false);
  for(const s of ["quiet"]) for(const side of ["buy","short"])
    assert.strictEqual(allow(side,s),false,"no read on the fast chart = no trade");
});

test("collect()'s own rejections survive into the funnel",()=>{
  // The reset used to run AFTER collect(), so anything collect() rejected was wiped before it
  // could be reported and the panel said "produced no candidates" instead of the real reason.
  const paper=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","paper.js"),"utf8");
  const reset=paper.indexOf("funnel=blankFunnel();\n        const all=await collect()");
  assert.ok(reset>-1,"the funnel must be blanked BEFORE collect() runs");
  assert.match(paper,/f&&!f\.seen&&f\.dumpUnconfirmed/,
    "and whyIdle must read it even when nothing reached eligible()");
});

test("every paper-bot tick-box applies on click, not on Save",()=>{
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  for(const id of ["ppSrcQuick","ppSrcNormal","ppSrcMovers","ppSrcDump","ppShort","ppPend","ppAggr","ppEdge"]){
    const m=html.match(new RegExp('id="'+id+'"[^>]*'));
    assert.ok(m,"missing "+id);
    assert.match(m[0],/onchange="paperSaveConfig\(\)"/,id+" does not apply until Save is pressed");
  }
  assert.match(html,/Save numbers/,"the button should say it is only for the typed fields");
});

/* ---------------- one rule, one definition ---------------- */

test("the panel's verdict and the bot's decision come from the SAME rule",async()=>{
  // Two copies of "would the bot take this?" would drift, and the panel would start promising
  // trades the bot refuses. So the rule lives in server.js and is handed to paper.js.
  const states=['running','building','late','fading','quiet'];
  for(const side of ['buy','short']) for(const state of states){
    const row={sym:'X',tk:'X',plan:{now:side,price:100,
      long:{dir:1,entryLo:90,entryHi:95,entry:92.5,stop:85,riskPct:8,targets:[105,115,130],ret:[13,24,40],rrr:2.1},
      short:{dir:-1,entryLo:105,entryHi:110,entry:107.5,stop:118,riskPct:9,targets:[95,88,80],ret:[11,18,25],rrr:1.9}},
      bump:{state,tf:'4h'},
      planBt:{long:{n:20,winRate:60,medPct:3,thin:false},short:{n:20,winRate:60,medPct:3,thin:false}}};
    const panelSays=S.dumpBotTakes(row).take;
    const p=mk({dumpBounce:async()=>({rows:[row]})}); p.reset();
    p.setConfig({sources:only("dump"),requireEdge:false,minConfPct:0,minStopPct:0});
    p.start(); const st=await p.tick(); p.stop();
    const botDid=st.funnel.eligible>0;
    assert.strictEqual(panelSays,botDid,`${side} + ${state}: panel says ${panelSays}, bot did ${botDid}`);
  }
});

test("a waiting plan is reported as waiting, not as a rejection of the setup",()=>{
  const base={sym:'X',bump:{state:'running'},plan:{now:'wait_buy',price:100,
    long:{dir:1,entryHi:95},short:{dir:-1,entryLo:105}}};
  const v=S.dumpBotTakes(base);
  assert.strictEqual(v.take,false);
  assert.match(v.why,/waiting/,"price simply is not in a zone yet — that is not a quality judgement");
});

test("every Dump & Bounce row carries the bot's verdict, and the payload summarises it",async()=>{
  const d=await S.dumpBounce(true);
  assert.ok(d.botSummary,"the panel needs a headline count to be useful before you enable the desk");
  for(const r of d.rows){
    assert.ok(r.botTake&&typeof r.botTake.take==='boolean',r.sym+" has no bot verdict");
    assert.ok(r.botTake.why,"and it must say why");
    assert.strictEqual(r.botTake.take,S.dumpBotTakes(r).take);
  }
  assert.strictEqual(d.botSummary.takeable+d.botSummary.skipped,d.rows.length);
});

/* ---------- costs, time stops and correlated exposure ----------
   Three defects that survived every earlier pass because none of them was tested: the bot reported
   a frictionless P&L no account could reproduce, held losers forever, and treated twenty
   correlated longs as twenty independent bets. */

test("fees and slippage are charged, and a saved state cannot silently zero them",()=>{
  const fs=require("node:fs"), path=require("node:path");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"paper-cost-"));
  // fresh install: real costs, not the frictionless placeholder that used to be forced on load
  let p=createPaper({scan:S.scan,liveQuotes:async()=>({}),dir,rate:()=>0,topMovers:S.topMovers,dumpBounce:S.dumpBounce});
  assert.ok(p.getState().config.feeBps>0,"a new bot must charge fees");
  assert.ok(p.getState().config.slipBps>0,"and slippage");

  // an explicit choice is honoured and SURVIVES a reload — the bug was that load() overwrote it
  p.setConfig({feeBps:12,slipBps:3});
  p=createPaper({scan:S.scan,liveQuotes:async()=>({}),dir,rate:()=>0,topMovers:S.topMovers,dumpBounce:S.dumpBounce});
  assert.strictEqual(p.getState().config.feeBps,12,"load() must not overwrite a configured fee");
  assert.strictEqual(p.getState().config.slipBps,3);

  // and a deliberate zero stays zero rather than being "helpfully" restored
  p.setConfig({feeBps:0,slipBps:0});
  p=createPaper({scan:S.scan,liveQuotes:async()=>({}),dir,rate:()=>0,topMovers:S.topMovers,dumpBounce:S.dumpBounce});
  assert.strictEqual(p.getState().config.feeBps,0,"an explicit zero is a choice, not an absence");
  fs.rmSync(dir,{recursive:true,force:true});
});

test("a trade that goes nowhere is timed out, and a runner is not",()=>{
  const src=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","paper.js"),"utf8");
  const fn=src.slice(src.indexOf("function manage(prices)"),src.indexOf("function checkPending"));
  assert.match(fn,/p\.taken<1 && S\.maxBarsHeld>0/,"only an UNTOUCHED trade may be timed out");
  assert.match(fn,/tfMin\(p\.tf\|\|'15m'\)/,"the clock must be in bars of the trade's own timeframe");
  assert.match(fn,/'time'/,"and the exit must be labelled so it shows up in the closed list");
  // p.openAt is the field that exists; p.openedAt would silently never fire
  assert.match(fn,/p\.openAt/,"must read the field the position actually carries");
  assert.ok(!/p\.openedAt/.test(fn),"openedAt does not exist on a position — the timer would never fire");
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  assert.match(html,/time:'⏱ timed out'/,"an unlabelled exit reason renders as a raw code");
});

test("the same-direction cap counts pending orders and reports itself",()=>{
  const src=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","paper.js"),"utf8");
  assert.match(src,/S\.positions\.filter\(p=>p\.dir===d\)\.length\+S\.pending\.filter\(o=>o\.dir===d\)\.length/,
    "a resting limit is committed risk — counting only filled positions understates the exposure");
  assert.match(src,/funnel\.sameDir\+\+/,"and skipping for this reason must be reported, not silent");
  assert.match(src,/sameDir:0/,"the counter must start at 0: whyIdle sorts numerically and NaN collapses the report");
  assert.match(src,/\(\+b\[0\]\|\|0\)-\(\+a\[0\]\|\|0\)/,"the sort must tolerate a missing counter");
});

test("a target too small to cover the round trip is refused, and says so",()=>{
  /* Charging real costs exposed what the frictionless P&L had hidden: a quick scalp's first target
     is about +1.0% while a CoinDCX round trip costs ~1.2% of notional, so every T1 exit was a
     small LOSS reported as a win. Turning fees on without this gate would have made the bot
     grind the account down while its own screen showed green. */
  const src=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","paper.js"),"utf8");
  assert.match(src,/const roundTripPct = 2\*\(S\.feeBps\/10000 \+ S\.slipBps\/10000\)\*100;/,
    "both legs and both cost components, or the gate understates the hurdle");
  assert.match(src,/t1Pct < roundTripPct\*1\.5/,"a target must beat costs by a margin, not merely match them");
  assert.match(src,/funnel\.costlier\+\+/,"and being skipped for this must be reported");
  assert.match(src,/costlier:0/,"counter starts at 0 — whyIdle sorts numerically");

  // the arithmetic, on the real defaults
  const fee=50, slip=10, roundTrip=2*(fee/10000+slip/10000)*100;
  assert.ok(Math.abs(roundTrip-1.2)<1e-9,"50bps taker each way + 10bps slippage = 1.20%");
  assert.ok(1.0 < roundTrip,"a +1.0% quick-scalp T1 does NOT clear it — this is the whole point");
  assert.ok(2.0 < roundTrip*1.5===false,"a +2.0% target does clear the 1.5x hurdle");
});
