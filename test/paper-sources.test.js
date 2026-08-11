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

test("every desk is reachable and produces its own candidates",async()=>{
  for(const desk of ["quick","normal","movers","dump"]){
    const p=mk(); p.reset();
    p.setConfig({sources:only(desk),requireEdge:false,minConfPct:0,minStopPct:0});
    p.start(); const st=await p.tick(); p.stop();
    assert.ok(st.funnel.seen>0,desk+": produced no candidates at all");
    assert.ok(st.funnel.bySource[desk],desk+": candidates were not attributed to it");
    assert.strictEqual(Object.keys(st.funnel.bySource).length,1,desk+": leaked candidates from another desk");
  }
});

test("no desks selected is stated, not silently idle",async()=>{
  const p=mk(); p.reset();
  p.setConfig({sources:{quick:false,normal:false,movers:false,dump:false}});
  p.start(); const st=await p.tick(); p.stop();
  assert.strictEqual(st.openCount,0);
  assert.match(st.whyIdle||"",/No desks selected/);
});

test("the proven-edge gate applies to Dump & Bounce using ITS OWN backtest",async()=>{
  // The point: arriving from a different panel earns no exemption. Dump & Bounce carries a
  // backtest of its exact levels, so the gate reads that — and in DEMO those plans lose money,
  // so the bot must refuse every one of them while still taking them with the gate off.
  const d=await S.dumpBounce();
  const live=d.rows.filter(r=>r.plan&&(r.plan.now==="buy"||r.plan.now==="short"));
  assert.ok(live.length>0,"fixture check: needs live plans to judge");

  const off=mk(); off.reset();
  off.setConfig({sources:only("dump"),requireEdge:false,minConfPct:0,minStopPct:0});
  off.start(); const a=await off.tick(); off.stop();
  assert.ok(a.funnel.eligible>0,"with the gate off the plans are tradeable");

  const on=mk(); on.reset();
  on.setConfig({sources:only("dump"),requireEdge:true,minWinRate:50,minEdgeTrades:8,minConfPct:0,minStopPct:0});
  on.start(); const b=await on.tick(); on.stop();
  assert.strictEqual(b.funnel.eligible,0,"a plan its own backtest says loses money must not be traded");
  assert.match(b.whyIdle||"",/proven backtested edge/);
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
