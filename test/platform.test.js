/* Platform-wide checks. These are the cross-cutting invariants that no single feature owns, and
   that a targeted test would never catch — the kind of thing that only shows up when you open
   every panel and press every button. */
const test=require("node:test");
const assert=require("node:assert");
const fs=require("node:fs");
const path=require("node:path");
const S=require("../server.js");

const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const script=html.match(/<script>([\s\S]*)<\/script>/)[1];

test("every inline handler in the page has a definition",()=>{
  // A typo'd onclick is invisible until a user clicks it and nothing happens.
  const refs=new Set();
  for(const m of html.matchAll(/\bon(?:click|input|change|submit)="([a-zA-Z_$][\w$]*)\s*\(/g))refs.add(m[1]);
  const defined=new Set();
  for(const m of script.matchAll(/\bfunction\s+([a-zA-Z_$][\w$]*)/g))defined.add(m[1]);
  for(const m of script.matchAll(/\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g))defined.add(m[1]);
  const missing=[...refs].filter(r=>!defined.has(r));
  assert.ok(refs.size>30,"fixture check: the page should have plenty of handlers");
  assert.deepStrictEqual(missing,[],"handlers with no definition");
});

test("every /api path the UI fetches is actually served",()=>{
  const served=new Set();
  const srv=fs.readFileSync(path.join(__dirname,"..","server.js"),"utf8");
  for(const m of srv.matchAll(/p==="(\/api\/[a-z/-]*)"/g))served.add(m[1]);
  const called=new Set();
  for(const m of script.matchAll(/fetchT?\('(\/api\/[a-z/-]*)/g))called.add(m[1]);
  const missing=[...called].filter(c=>!served.has(c));
  assert.ok(called.size>10,"fixture check");
  assert.deepStrictEqual(missing,[],"UI calls routes the server does not serve");
});

test("resolveAsset finds EVERY instrument by the symbol a human would type",()=>{
  // LT and ABB are exact NSE tickers that are also prefixes of LTIM/LTTS and ABBOTINDIA. They were
  // refused as "ambiguous" until exact `ts` matching was added ahead of the prefix fallback.
  const uni=[...S.universeFor("Stocks"),...S.universeFor("ETFs / Indices"),
             ...S.universeFor("Commodities"),...S.universeFor("Crypto")];
  const bad=[];
  for(const a of uni){
    const typed=a.ts||a.tk||a.sym;
    const got=S.resolveAsset(typed);
    if(!got||got.sym!==a.sym)bad.push(typed+" -> "+(got?got.sym:"REFUSED"));
  }
  assert.ok(uni.length>150,"fixture check: the whole universe");
  assert.deepStrictEqual(bad,[],"instruments that cannot be found by their own ticker");
  assert.strictEqual(S.resolveAsset("LT").sym,"LT.NS","an exact ticker must beat a prefix");
  assert.strictEqual(S.resolveAsset("B"),null,"but a genuinely ambiguous prefix is still refused");
});

test("the tracked-setup lifecycle banks a third at each target and ratchets the stop",()=>{
  S.__resetSetups();
  const sym="LIFEUSDT";
  S.trackSetups([{asset:{sym,tk:"LIFE",name:"L",cls:"Crypto",src:"cg"},
    sig:{price:100,verdict:"BUY"},action:{kind:"buynow"},confidence:{label:"High",pct:70},dec:2,
    setup:{dir:1,entryLo:98,entryHi:102,stop:94,riskPct:6,targets:[110,120,130],ret:[10,20,30],rrr:2,regime:"range"}}],"1h","quick");
  const a=()=>S.__getSetups().active[0];
  S.sweepSetups({[sym]:100}); assert.strictEqual(a().status,"filled");
  S.sweepSetups({[sym]:112}); assert.strictEqual(a().hitT,1); assert.strictEqual(a().stop,100,"breakeven after T1");
  S.sweepSetups({[sym]:122}); assert.strictEqual(a().hitT,2); assert.strictEqual(a().stop,110,"T1 after T2");
  S.sweepSetups({[sym]:131});
  const r=S.__getSetups().resolved[0];
  assert.strictEqual(r.status,"target");
  assert.strictEqual(r.pnlPct,20,"(10+20+30)/3 — a third banked at each target");
});

test("a stop-out is recorded at the STOP, not at the sampled price",()=>{
  S.__resetSetups();
  const sym="STOPUSDT";
  S.trackSetups([{asset:{sym,tk:"S",name:"S",cls:"Crypto",src:"cg"},
    sig:{price:100,verdict:"BUY"},action:{kind:"buynow"},confidence:{label:"High",pct:70},dec:2,
    setup:{dir:1,entryLo:98,entryHi:102,stop:94,riskPct:6,targets:[110,120,130],ret:[10,20,30],rrr:2,regime:"range"}}],"1h","quick");
  S.sweepSetups({[sym]:100});
  S.sweepSetups({[sym]:91});                      // gapped well through the stop
  const r=S.__getSetups().resolved[0];
  assert.strictEqual(r.exit,94,"sampling once a minute must not overstate the loss");
  assert.strictEqual(r.pnlPct,-6,"the planned risk, not -9");
});

test("a setup that never fills resolves as no-trade, not as a loss",()=>{
  S.__resetSetups();
  const sym="EXPUSDT";
  S.trackSetups([{asset:{sym,tk:"E",name:"E",cls:"Crypto",src:"cg"},
    sig:{price:100,verdict:"BUY"},action:{kind:"buynow"},confidence:{label:"High",pct:70},dec:2,
    setup:{dir:1,entryLo:98,entryHi:102,stop:94,riskPct:6,targets:[110,120,130],ret:[10,20,30],rrr:2,regime:"range"}}],"1h","quick");
  S.__getSetups().active[0].expires=Date.now()-1;
  S.sweepSetups({[sym]:150});
  const r=S.__getSetups().resolved[0];
  assert.strictEqual(r.status,"expired");
  assert.strictEqual(r.pnlPct,null,"never filled means nothing was risked");
});

test("the reversal flag on a tracked setup sets and clears with the signal",()=>{
  S.__resetSetups();
  const asset={sym:"REVUSDT",tk:"R",name:"R",cls:"Crypto",src:"cg"};
  S.trackSetups([{asset,sig:{price:100,verdict:"BUY"},action:{kind:"buynow"},
    confidence:{label:"High",pct:70},dec:2,
    setup:{dir:1,entryLo:98,entryHi:102,stop:94,riskPct:6,targets:[110,120,130],ret:[10,20,30],rrr:2,regime:"range"}}],"1h","quick");
  S.sweepSetups({REVUSDT:100});
  S.markReversals([{asset,sig:{verdict:"SELL",price:100}}],"1h");
  assert.ok(S.__getSetups().active[0].rev,"signal flipped against a filled long");
  S.markReversals([{asset,sig:{verdict:"BUY",price:100}}],"1h");
  assert.ok(!S.__getSetups().active[0].rev,"and clears when it comes back");
});

test("the research panel never claims agreement on a direction when the verdict is HOLD",()=>{
  // It rendered "NO CONSENSUS · 100% of timeframes agree" and "Only 100% of the timeframes agree
  // on a direction" together — `agree` is agreement on the WINNING verdict, and HOLD can win it.
  assert.match(script,/agree there is <b>no clean direction<\/b>/,
    "unanimous HOLD needs its own sentence");
  const onlyLine=script.match(/Only <b>\$\{c\.agree\}%<\/b> of the timeframes agree on a direction/);
  assert.ok(onlyLine,"the directional wording must still exist for real disagreement");
  const idx=script.indexOf("Only <b>${c.agree}%</b> of the timeframes agree on a direction");
  const guard=script.slice(Math.max(0,idx-600),idx);
  assert.match(guard,/c\.verdict==='HOLD'/,"…but only on the non-HOLD branch");
});

test("the paper bot explains why it is holding nothing",()=>{
  // Being correctly SELECTIVE and being BROKEN look identical from the panel — flat equity, no
  // positions, no error — unless the bot reports what it rejected.
  const paper=fs.readFileSync(path.join(__dirname,"..","paper.js"),"utf8");
  assert.match(paper,/function whyIdle/);
  assert.match(paper,/funnel\.notScalp\+\+/);
  assert.match(paper,/funnel\.noEdge\+\+/);
  assert.match(paper,/funnel:S\.funnel\|\|null, whyIdle:whyIdle\(\)/,"and publishes it in the state");
  assert.match(script,/s\.running&&s\.whyIdle/,"and the panel shows it while running");
});
