/* Crypto pricing, across every tab.
   The rule this file enforces: ONE coin has ONE price, whichever panel you are looking at, and the
   ₹ <-> $ round trip is lossless. Both have been broken before — once by a panel inventing its own
   series, once by reporting a rate the server had not priced with — so they are pinned here. */
const test=require("node:test");
const assert=require("node:assert");
const S=require("../server.js");

test("₹ -> $ is lossless in CoinDCX mode: the UI divides by the rate the server priced with",()=>{
  S.__setMode("coindcx");
  S.__setCdxTicker({USDTINR:89.2,BTCUSDT:104500,BTCINR:9350000,XAIUSDT:0.0067,SOLUSDT:182.4});
  const rate=S.priceRate();
  assert.strictEqual(rate,89.2);
  assert.strictEqual(S.priceRateSrc(),"coindcx");
  for(const [tk,usdt] of [["BTC",104500],["XAI",0.0067],["SOL",182.4]]){
    const inr=S.cdxLiveInr(tk);
    assert.ok(Math.abs(inr/rate-usdt)<1e-9,tk+": ₹"+inr+" / "+rate+" must return exactly $"+usdt);
  }
});

test("a coin is priced off its LIQUID USDT market, not a thin INR last-trade",()=>{
  // BTCINR here is stale by 0.3%. Pricing off it would drift from what the CoinDCX app shows.
  S.__setMode("coindcx");
  S.__setCdxTicker({USDTINR:89.2,BTCUSDT:104500,BTCINR:9350000});
  assert.strictEqual(S.cdxLiveInr("BTC"),104500*89.2);
  // With no USDT market it may fall back to the INR pair rather than returning nothing.
  S.__setCdxTicker({USDTINR:89.2,FOOINR:1234});
  assert.strictEqual(S.cdxLiveInr("FOO"),1234);
  assert.strictEqual(S.cdxLiveInr("NOPE"),0);
});

test("the USDT rate survives a missing USDTINR market",()=>{
  S.__setMode("coindcx");
  S.__setCdxTicker({BTCINR:8_920_000,BTCUSDT:100_000});   // implies 89.2
  assert.ok(Math.abs(S.cdxUsdtInr()-89.2)<1e-9);
  S.__setCdxTicker({});
  assert.strictEqual(S.cdxUsdtInr(),0,"no data must be 0, never a guess");
});

test("global mode reports the FX rate it actually priced with",()=>{
  S.__setMode("binance"); S.__setFx(86.4);
  assert.strictEqual(S.priceRate(),86.4);
  assert.strictEqual(S.priceRateSrc(),"fx","the UI must be told ₹ carries no India premium here");
  // loadBinance multiplies the USD close by exactly this, so dividing returns the USD price.
  assert.ok(Math.abs((182.4*86.4)/S.priceRate()-182.4)<1e-9);
});

test("EVERY tab reports the same price for the same coin",async()=>{
  // The bug this pins: 🎢 Dump & Bounce built its own synthetic tapes in DEMO, so BTC read ₹0.46
  // there while every other tab read ₹5,386.25 — the same coin, four different numbers.
  const scan=await S.scan("Crypto","1h");
  const byScan={}; (scan.results||[]).forEach(r=>byScan[r.asset.sym]=r.sig.price);
  const mov=await S.topMovers("Crypto","1h");
  const byMov={}; (mov.movers||[]).forEach(m=>byMov[m.sym]=m.live);
  const db=await S.dumpBounce(true);
  const byDb={}; (db.rows||[]).forEach(r=>{ if(r.plan)byDb[r.sym]=r.plan.price; });
  S.__resetPositions();
  for(const s of ["BTC","ETH","SOL"])await S.addPosition({sym:s,side:1,entry:1000});
  const byPos={}; S.__getPositions().forEach(p=>byPos[p.sym]=p.price);

  let compared=0;
  for(const sym of Object.keys(byScan)){
    const ref=byScan[sym];
    for(const [panel,map] of [["movers",byMov],["dump&bounce",byDb],["positionWatch",byPos]]){
      if(map[sym]==null)continue;
      compared++;
      assert.ok(Math.abs(map[sym]/ref-1)<1e-6,
        `${sym}: ${panel} says ${map[sym]} but the scanner says ${ref}`);
    }
  }
  assert.ok(compared>=4,"fixture check: needs several overlapping coins to be a real comparison");
});

test("rescaling a demo tape changes the price and NOTHING else",()=>{
  // Scaling is affine, so every ratio the features compute must be identical afterwards.
  const raw=S.synthBump(4242), scaled=S.demoRescale(raw,"ETHUSDT");
  assert.notStrictEqual(raw.price,scaled.price,"fixture check: the rescale must actually move it");
  const a=S.bumpProfile(raw.close,raw.vol), b=S.bumpProfile(scaled.close,raw.vol);
  assert.strictEqual(a.medPct,b.medPct);
  assert.strictEqual(a.retraceMed,b.retraceMed);
  assert.strictEqual(a.state,b.state);
  const pa=S.tradePlan(raw.close,raw.high,raw.low,a), pb=S.tradePlan(scaled.close,scaled.high,scaled.low,b);
  assert.strictEqual(pa.now,pb.now);
  assert.deepStrictEqual(pa.long.ret,pb.long.ret,"target %s must not move");
  assert.strictEqual(pa.long.rrr,pb.long.rrr);
  assert.strictEqual(pa.long.riskPct,pb.long.riskPct);
});

test("Position Watch labels where its price came from, so a candle fallback is visible",async()=>{
  S.__resetPositions();
  const p=(await S.addPosition({sym:"BTC",side:1,entry:1000})).position;
  assert.ok(["live","candle"].includes(p.priceSrc),"a silent fallback is how a stale price hides");
  assert.ok(p.price>0);
  await S.positionsSweep();
  const q=S.__getPositions()[0];
  assert.ok(["live","candle"].includes(q.priceSrc));
  assert.strictEqual(q.pnlPct,S.posPnl(q,q.price),"P&L must be computed off the price actually shown");
});

test("resolveAsset refuses an ambiguous prefix rather than guessing",()=>{
  // "B" matches BTC and BNB. Silently watching the wrong instrument is worse than refusing.
  assert.strictEqual(S.resolveAsset("B"),null);
  assert.strictEqual(S.resolveAsset("BTC").sym,"BTCUSDT");
  assert.strictEqual(S.resolveAsset("BTCUSDT").sym,"BTCUSDT");
  assert.strictEqual(S.resolveAsset("XYZZY"),null);
});

/* ---------------- the USDT rate must never be served stale ---------------- */

test("a cached payload carries a LIVE rate, not the one frozen when it was built",async()=>{
  /* The reported bug. Every heavy endpoint is cached — scan and movers 40s, backtest 10 min,
     🎢 Dump & Bounce 30 MINUTES — and each baked `usdtInr` into the cached object. The browser
     keeps one global rate on last-writer-wins, so a Dump & Bounce refresh could stamp a rate half
     an hour old over a fresh one, and every panel then divided a CURRENT ₹ price by a STALE rate:
     ₹ looked right while $ drifted. */
  S.__setFx(88.50);
  await S.topMovers("Crypto","5m");
  await S.dumpBounce(true);
  await S.scan("Crypto","5m");
  S.__setFx(91.50);                                   // the market moves
  const live=S.priceRate();
  assert.strictEqual(live,91.50);
  for(const [name,p] of [["movers",await S.topMovers("Crypto","5m")],
                         ["dumpBounce",await S.dumpBounce()],
                         ["scan",await S.scan("Crypto","5m")]]){
    assert.ok(p.cached,name+": fixture check — this call must be a cache hit");
    assert.strictEqual(p.usdtInr,live,name+" served a stale rate with a cached payload");
    assert.ok(p.rateAt>0,name+" must timestamp the rate so the browser can order updates");
  }
});

test("withLiveRate re-reads the rate every time",()=>{
  S.__setFx(80);
  const a=S.withLiveRate({x:1});
  S.__setFx(95);
  const b=S.withLiveRate({x:1});
  assert.strictEqual(a.usdtInr,80);
  assert.strictEqual(b.usdtInr,95);
  assert.ok(b.rateAt>=a.rateAt);
  assert.strictEqual(b.x,1,"it must not disturb the payload it wraps");
});

/* The browser's rate guard, lifted out of index.html and RUN — not pattern-matched. It decides
   which USDT/INR rate every $ price on the page divides by, so it is worth executing. */
function rateGuard(){
  const vm=require("node:vm");
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const from=script.indexOf("let usdtInrAt=0"), to=script.indexOf("let lastCryptoMode");
  assert.ok(from>0&&to>from,"could not locate the rate block in index.html");
  const ctx=vm.createContext({usdtInr:0,scalpRateSrc:""});
  vm.runInContext(script.slice(from,to)+
    ";globalThis.setRate=setRate;globalThis.markRateNow=markRateNow;"+
    // the guard reads the clock through the sandbox's own Date, so travel has to happen in there
    ";globalThis.__advance=ms=>{const r=Date.now.bind(Date);Date.now=()=>r()+ms;};",ctx);
  return ctx;
}

test("the browser refuses a rate reading older than the one it already has",()=>{
  // Panels poll on different clocks (20s / 30s / 45s), so responses arrive out of order. Plain
  // last-writer-wins would let a slow panel stamp an older rate over a newer one.
  const c=rateGuard();
  c.setRate({usdtInr:89.0,rateSrc:"coindcx",rateAge:0});
  assert.strictEqual(c.usdtInr,89.0);
  c.setRate({usdtInr:86.0,rateSrc:"coindcx",rateAge:40000});   // a 40s-old reading arriving late
  assert.strictEqual(c.usdtInr,89.0,"a stale reading must not overwrite a fresher one");
  c.setRate({usdtInr:90.0,rateSrc:"coindcx",rateAge:0});
  assert.strictEqual(c.usdtInr,90.0,"a fresh reading must still get through");
});

test("rate ordering never compares the server's clock against the browser's",()=>{
  /* THE REGRESSION THIS PINS. The guard used to order by the server's `rateAt` timestamp while
     the browser's own CoinDCX fetches stamped the same variable with local Date.now(). Two clocks,
     one variable: a browser a few seconds ahead of the server rejected every later server reading
     as "older" — permanently — and $ prices drifted while ₹ stayed correct. Ordering is by AGE
     now, which means the same thing on both machines. */
  const c=rateGuard();
  c.usdtInr=89.0; c.markRateNow('coindcx');                     // browser fetch: local clock, age 0
  // A server whose clock trails the browser by an hour. Under the old timestamp comparison every
  // one of these would have been discarded forever.
  for(const v of [89.5,90.0,90.5]){
    c.setRate({usdtInr:v,rateSrc:"coindcx",rateAge:0,rateAt:Date.now()-3600e3});
    assert.strictEqual(c.usdtInr,v,"a server reading must be judged by its age, not its clock");
  }
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.ok(!/d\.rateAt/.test(script),"reading the server's timestamp reintroduces the cross-clock bug");
  const direct=[...script.matchAll(/if\(d\.usdtInr>0\)\s*\{?\s*usdtInr\s*=/g)];
  assert.strictEqual(direct.length,0,"a payload writer bypassing setRate() reintroduces the bug");
});

test("a source we got NO rate from must never block the one source that works",()=>{
  /* THE REGRESSION THIS PINS — the one that broke the $ USDT toggle outright.
     markRateNow() stamped the source unconditionally, but its callers assign the rate
     conditionally:
         if(bt&&bu&&...) usdtInr=...; else if(ui&&...) usdtInr=...;
         markRateNow('coindcx');
     A CoinDCX ticker that answered without a usable BTCINR/BTCUSDT or USDTINR pair therefore left
     usdtInr at 0 while claiming a fresh CoinDCX rate. The server's FX rate was outranked and
     dropped, and because pollQuotes re-stamps every 8s the 5-minute escape hatch never opened.
     usdtInr stayed 0 forever and every $ price silently printed in ₹. */
  const c=rateGuard();
  c.markRateNow('coindcx');                                   // ticker answered, but no rate came out of it
  assert.strictEqual(c.usdtInr,0,"fixture check: we hold no rate");
  c.setRate({usdtInr:88.4,rateSrc:"fx",rateAge:0});
  assert.strictEqual(c.usdtInr,88.4,"the only rate available must be accepted, whatever its source");
  // and a real CoinDCX reading still outranks it afterwards
  c.setRate({usdtInr:89.9,rateSrc:"coindcx",rateAge:0});
  assert.strictEqual(c.usdtInr,89.9);
});

test("ONE rate formula: the browser derives CoinDCX's USDT/INR exactly as the server does",()=>{
  /* THE BUG BEHIND "$3.43 here vs $3.21 on CoinDCX". Two formulas for one rate:
       server  cdxUsdtInr()      -> USDTINR market first, BTCINR/BTCUSDT ratio as fallback
       browser (three places)    -> ratio FIRST, USDTINR as fallback
     Both labelled 'coindcx', both writing the one shared `usdtInr`. ₹ built with one got divided
     by the other, so the cancellation in (price × rate) ÷ rate broke and $ ran off by exactly the
     gap between the two readings. A stale BTCINR last-trade is enough: 3.21 × (95.1/89.0) = 3.43. */
  const vm=require("node:vm");
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const i=script.indexOf("function cdxRateFromTicker(t)");
  assert.ok(i>0,"the browser must have ONE named rate formula, not three inline copies");
  const ctx=vm.createContext({});
  vm.runInContext(script.slice(i,script.indexOf("let lastCryptoMode"))+";globalThis.f=cdxRateFromTicker;",ctx);
  const tk=(o)=>Object.entries(o).map(([market,last_price])=>({market,last_price:String(last_price)}));

  // when they disagree, BOTH sides must pick USDTINR — the direct pair, not the BTC-implied one
  S.__setMode("coindcx");
  S.__setCdxTicker({USDTINR:89.0,BTCINR:8_563_000,BTCUSDT:90_000});   // ratio implies 95.1
  assert.strictEqual(S.cdxUsdtInr(),89.0,"fixture check: server prefers the direct market");
  assert.strictEqual(ctx.f(tk({USDTINR:89.0,BTCINR:8_563_000,BTCUSDT:90_000})),89.0,
    "the browser must agree with the server, or ₹ and $ come apart");

  // and both fall back to the ratio the same way when the direct market is missing
  S.__setCdxTicker({BTCINR:8_563_000,BTCUSDT:90_000});
  assert.ok(Math.abs(S.cdxUsdtInr()-8_563_000/90_000)<1e-9);
  assert.ok(Math.abs(ctx.f(tk({BTCINR:8_563_000,BTCUSDT:90_000}))-8_563_000/90_000)<1e-9);
  assert.strictEqual(ctx.f(tk({})),0,"no data must be 0, never a guess");
  // no inline copy may survive anywhere in the page
  assert.ok(!/last_price\/\+bu\.last_price/.test(script),"an inline rate derivation reintroduces the split");
});

test("$ is the venue's OWN number, so no rate — right or wrong — can move it",()=>{
  /* The structural fix. $ used to be reconstructed as ₹ ÷ rate, which is exact only while the
     dividing rate is the reading that multiplied. Carrying the exchange's real USDT price means
     the dollar figure is the exchange's by construction. */
  const vm=require("node:vm");
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const i=script.indexOf("const usdTxt=");
  const ctx=vm.createContext({cryptoCcy:"USDT",usdtInr:95.1});   // a WRONG shared rate, deliberately
  vm.runInContext(script.slice(i,script.indexOf("// Currency-aware input conversion"))+
    ";globalThis.livePriceTxt=livePriceTxt;globalThis.usdTxt=usdTxt;",ctx);
  ctx.cryptoPrice=(v,rate)=>{const r=(rate>0)?rate:ctx.usdtInr;return ctx.cryptoCcy==='USDT'&&r>0?ctx.usdTxt(v/r):'₹'+v;};
  ctx.fmtR=r=>v=>ctx.cryptoPrice(v,r.rateUsed);

  const r={asset:{cls:"Crypto"},sig:{price:3.21*89.0,priceUsd:3.21},rateUsed:89.0};
  assert.strictEqual(ctx.livePriceTxt(r),"$3.2100",
    "the exchange's own $ must win over any rate arithmetic");
  // and with no dollar twin it must still use the rate that BUILT the ₹, not the shared one
  delete r.sig.priceUsd;
  assert.strictEqual(ctx.livePriceTxt(r),"$3.2100",
    "falling back must divide by rateUsed (89.0), not the stale shared 95.1 that produced $3.43");
});

test("a $ price can never be older than the ₹ beside it",()=>{
  /* THE FREEZE THIS PINS. The $ view prefers sig.priceUsd unconditionally, but the quote poll
     only WROTE it when the USD map carried the symbol. So the first tick that arrived without one
     stopped the dollar figure dead: ₹ kept moving, $ sat still, permanently, until a full rescan
     replaced the object. The server's own fallback serves exactly that shape —
     `Object.assign(usd, cgUsdCache||{})` hands back an empty map before the USD cache is filled —
     and a coin whose USDT pair drops out of the ticker does the same. */
  const vm=require("node:vm");
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const el=()=>({textContent:"",style:{color:""}});
  const ctx=vm.createContext({
    cryptoCcy:"USDT", usdtInr:89.0, lastResults:[], setInterval(){},
    document:{getElementById:()=>el(),querySelectorAll:()=>[]},
    updateCcyWarn(){}, refreshStaleFlags(){}, id4:s=>s.replace(/[^a-z0-9]/gi,""),
  });
  vm.runInContext(
    script.slice(script.indexOf("const usdTxt="),script.indexOf("// Currency-aware input conversion"))+
    script.slice(script.indexOf("function cryptoPrice(v,rate)"),script.indexOf("const fmtR=r=>v=>"))+
    "const fmtR=r=>v=>cryptoPrice(v,r.rateUsed);"+
    script.slice(script.indexOf("function applyQuotes(map,usdMap)"),script.indexOf("async function pollQuotes"))+
    ";globalThis.applyQuotes=applyQuotes;globalThis.livePriceTxt=livePriceTxt;",ctx);

  const r={asset:{cls:"Crypto",sym:"PROMINR"},sig:{price:3.21*89,priceUsd:3.21},rateUsed:89.0};
  ctx.lastResults=[r];
  assert.strictEqual(ctx.livePriceTxt(r),"$3.2100","fixture check: starts on the venue's own number");

  // the coin moves 10%, and this tick carries NO usd map (the server's empty-cache fallback)
  ctx.applyQuotes({PROMINR:3.531*89},{});
  assert.strictEqual(r.sig.priceUsd,undefined,"a $ we cannot refresh must be dropped, not kept");
  assert.strictEqual(ctx.livePriceTxt(r),"$3.5310",
    "the $ view must fall back to rate conversion, which is as fresh as the ₹ it divides");

  // and when the venue's own number IS supplied again, it takes over
  ctx.applyQuotes({PROMINR:3.6*89},{PROMINR:3.61});
  assert.strictEqual(r.sig.priceUsd,3.61);
  assert.strictEqual(ctx.livePriceTxt(r),"$3.6100","the exchange's own number wins whenever we have it");
});

test("a failing browser feed falls through to the server instead of freezing silently",()=>{
  /* THE STALL THIS PINS. The browser-direct branch ended in a bare `catch(e){}` followed by an
     unconditional `return`, so one failed read — a rate limit, a blip, a CORS change — stopped the
     price dead with no error, no fallback and no sign of it, until the next full rescan. A
     non-array body like {"message":"Too many requests"} did the same without even throwing. */
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const fn=script.slice(script.indexOf("async function pollQuotes()"),script.indexOf("const getMinScore="));
  assert.ok(!/\}catch\(e\)\{\}\s*return;/.test(fn),"a swallowed error must not also skip the fallback");
  assert.match(fn,/if\(!Array\.isArray\(t\)\)throw/,"a refusal body must be treated as a failure, not ignored");
  assert.match(fn,/\/\/ fall through/,"the direct branch must fall through to the server on failure");
  // the server call must come AFTER the direct branch, reachable from it
  assert.ok(fn.indexOf("/api/quotes?tab=")>fn.indexOf("ticker refused"),
    "the server path has to be downstream of the direct failure");
  assert.match(fn,/directBackoffUntil=Date\.now\(\)\+/,"repeated failures must back off, not hammer");
});

test("the age of the price on screen is shown, and coloured as it goes stale",()=>{
  /* A frozen price and a quiet market look identical — the only reason a stall can sit unnoticed.
     Five separate reports of "lagging" came down to nobody being able to see the age. */
  const vm=require("node:vm");
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const el={textContent:"",style:{color:""}};
  const ctx=vm.createContext({document:{getElementById:()=>el},setInterval(){}});
  vm.runInContext(script.slice(script.indexOf("let lastQuoteAt=0"),script.indexOf("async function pollQuotes"))+
    ";globalThis.paint=paintQuoteAge;globalThis.set=(t,w)=>{lastQuoteAt=t;quoteWhy=w||'';};",ctx);

  ctx.set(Date.now()-3000); ctx.paint();
  assert.match(el.textContent,/3s ago/,"the age must be stated, not just the timestamp");
  assert.strictEqual(el.style.color,"","fresh is unstyled");
  ctx.set(Date.now()-25000); ctx.paint();
  assert.match(el.textContent,/25s ago/);
  assert.strictEqual(el.style.color,"#fbbf24","going stale must be amber");
  ctx.set(Date.now()-90000,"browser feed failing, using server"); ctx.paint();
  assert.strictEqual(el.style.color,"var(--sell)","properly stale must be red");
  assert.match(el.textContent,/browser feed failing/,"and it must say WHY when it knows");
});

test("EVERY $ conversion names the rate it is dividing by",()=>{
  /* THE CLASS THIS CLOSES. cryptoPrice(v) with one argument silently falls back to the shared
     global rate, which is only correct when that happens to be the reading that BUILT the ₹ it is
     dividing. #20 fixed the main scanner and left every other panel on the bare call — so the
     🔎 Research card went on showing a coin at a price no venue was quoting, with T1 and T2 sitting
     at or BELOW its own live price on a BUY. The omission and the correct call looked identical in
     review, so the rule is now mechanical: pass the rate, always, even when the answer is "the
     shared one". */
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  // one non-empty argument and no comma. `cryptoPrice()` with no args only ever appears in prose.
  const bare=[...script.matchAll(/cryptoPrice\((?:[^,()]|\([^()]*\))+\)/g)].map(m=>m[0]);
  assert.deepStrictEqual(bare,[],
    "a one-argument cryptoPrice() silently divides by the shared rate — pass the build-rate explicitly");
  /* scalpPrice is the SAME hazard on the other six panels — Quick Trades, Volume Movers,
     🎢 Dump & Bounce, Position Watch and the tracked-setup rows. Its comment claimed it divided by
     "the SAME rate the server used to build these ₹ values" while it actually read the shared
     global: an invariant asserted and never enforced. */
  const bareScalp=[...script.matchAll(/scalpPrice\((?:[^,()]|\([^()]*\))+\)/g)].map(m=>m[0]);
  assert.deepStrictEqual(bareScalp,[],
    "scalpPrice needs the row's own rate — every panel but the scanner was missing it");
});

test("every crypto ROW carries the rate that built its ₹, so caching cannot split the pair",()=>{
  /* A payload-level rate is re-stamped live on every cache hit (withLiveRate), so a cached ₹ would
     be divided by a rate from a different moment. Movers cache for 40s and 🎢 Dump & Bounce for
     THIRTY MINUTES. Row and rate have to travel together. */
  const src=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","server.js"),"utf8");
  assert.match(src,/const builtWith=priceRate\(\);/,"movers rows must capture the rate at BUILD time");
  assert.match(src,/x\.cls==='Crypto'&&builtWith>0\)x\.rateUsed=builtWith/);
  assert.match(src,/rateUsed:priceRate\(\)\|\|undefined,\n\s*\.\.\.p,fwd/,"dump & bounce rows too");
  assert.match(src,/const setupRate=priceRate\(\)\|\|undefined;/,"tracked setups");
  assert.match(src,/const posRate=priceRate\(\)\|\|undefined;/,"and open positions");
});

test("the research consensus carries the rate that built its ₹ figures",()=>{
  const src=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","server.js"),"utf8");
  const fn=src.slice(src.indexOf("function blendResearch(per)"),src.indexOf("async function researchCoin"));
  assert.match(fn,/rateUsed:last\.rateUsed/,"without it the panel divides by whatever the page happens to hold");
  assert.match(fn,/priceUsd:last\.sig\.priceUsd/,"and the live price should be the venue's own number");
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  assert.match(html,/P=v=>cryptoPrice\(v,c\.rateUsed\)/,"the research renderer must actually use it");
});

test("the research card says when its targets are already behind the market",()=>{
  /* From a real card: CONSENSUS BUY, live $0.1875, T1 $0.1785, T2 $0.1880 — the first target
     already below the market and the second level with it, both labelled as upside (+9.1%,
     +15.0%) because the percentages are measured from the AVERAGED ENTRY, which sat 12.8% away.
     Nothing on the card said so. */
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const fn=html.slice(html.indexOf("function renderResearchResult(d)"),html.indexOf("function renderTrades()"));
  assert.match(fn,/const passed=/,"it must notice when live has passed T1");
  assert.match(fn,/already behind the market/,"and say so, prominently");
  assert.match(fn,/already there/,"individual targets the price has passed must be marked");
  assert.match(fn,/pullback|bounce/,"an entry far from the market must be named as a wait, not a buy-now");
  assert.match(fn,/measured from the <b>entry<\/b>/,"and the % figures must state what they are measured from");

  // the arithmetic the card now performs, on the exact numbers from that screenshot
  const c={dir:1,price:0.1875,entry:0.1635,targets:[0.1785,0.1880,0.1988]};
  const gapPct=(c.entry/c.price-1)*100;
  assert.ok(Math.abs(gapPct+12.8)<0.1,"entry sat 12.8% below live");
  assert.strictEqual(c.price>=c.targets[0],true,"T1 was already behind the market");
  assert.strictEqual(c.price>=c.targets[2],false,"T3 was not — only the passed ones get struck through");
});

test("levels come from CoinDCX's own USDT market, not the INR pair rescaled",()=>{
  /* Candles used to come from the thin I-<BASE>_INR pair, rescaled so only the LAST bar matched
     the liquid USDT market. Everything below that bar — entry, stop, every target — was the INR
     market's shape, and the $ view then divided it by a rate to get back to dollars. Two
     conversions where the right answer is none. Reading the USDT market's own candles means the
     series IS the exchange's series, and ₹ is one multiplication by CoinDCX's own USDT/INR —
     exactly what the CoinDCX app does — so the round trip is lossless rather than approximate. */
  const src=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","server.js"),"utf8");
  const fn=src.slice(src.indexOf("async function loadCoinDCX"),src.indexOf("async function loadBinance"));
  assert.match(fn,/cdxMarketPairs\(\)/,"the USDT pair id must be looked up, not guessed");
  assert.match(fn,/pairUsed:"usdt"/,"and the USDT market must be the preferred source");
  assert.match(fn,/pairUsed:"inr"/,"with the INR pair still available as a labelled fallback");
  // the pair id is read from markets_details rather than assembled from a template
  assert.ok(!/["'`]B-\$\{|["'`]B-"\+/.test(fn),"a guessed pair id fails silently into the old path");

  // ₹ built as usdt × rate divides back EXACTLY — that is the whole point
  const rate=89.0, usdt=[0.1875,0.1902,0.1861];
  const inr=usdt.map(v=>v*rate);
  inr.forEach((v,i)=>assert.ok(Math.abs(v/rate-usdt[i])<1e-12,
    "₹ ÷ the scalar that built it must return the venue's own dollar figure"));
});

test("markets_details is parsed into per-coin USDT and INR pair ids",async()=>{
  const S2=require("../server.js");
  assert.strictEqual(typeof S2.cdxMarketPairs,"function","the lookup must be exported to be testable");
  const src=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","server.js"),"utf8");
  const fn=src.slice(src.indexOf("async function cdxMarketPairs"),src.indexOf("// Binance fallback"));
  assert.match(fn,/target_currency_short_name/,"the coin is the TARGET currency in a CoinDCX market");
  assert.match(fn,/base_currency_short_name/,"and the quote is the BASE — getting these backwards maps nothing");
  assert.match(fn,/quote==="USDT"/);
  assert.match(fn,/3600e3/,"the list barely changes; it should not be refetched per scan");
});

test("the browser path also reads the USDT market, not just the server",()=>{
  /* The Crypto tab fetches its own candles when this machine can reach CoinDCX, so fixing only
     the server would have left the deployed behaviour unchanged. */
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const fn=script.slice(script.indexOf("async function fetchCoinDCXCrypto"),script.indexOf("let cdxPairCache"));
  assert.match(fn,/cdxPairMap\(\)/,"it must look the pair id up rather than template it");
  assert.match(fn,/pairUsed:"usdt"/);
  assert.match(fn,/pairUsed:"inr"/,"the thin pair stays as a labelled fallback");
  assert.ok(fn.indexOf('pairUsed:"usdt"')<fn.indexOf('pairUsed:"inr"'),"USDT must be tried first");
  const map=script.slice(script.indexOf("async function cdxPairMap"),script.indexOf("async function getStatus"));
  assert.match(map,/target_currency_short_name/);
  assert.match(map,/3600e3/,"cached — one extra request per hour, not per scan");
  assert.match(map,/cdxPairCache=cdxPairCache\|\|\{\}/,"an unreachable list must degrade, not throw");
});

test("several USDT books for one coin: the deepest ACTIVE one wins, not the last listed",()=>{
  /* A coin can be listed on several USDT books at once, one per ecode — B- (Binance-backed and
     deep), HB-, I-. Taking whichever appeared last in markets_details is how a live coin ends up
     pointed at a delisted or illiquid book whose candles come back empty; that throws, and the
     caller falls back to the INR pair with nothing to say about why. This is the most likely
     reason a coin that plainly HAS a USDT market was showing "CoinDCX INR pair". */
  const src=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","server.js"),"utf8");
  const fn=src.slice(src.indexOf("async function cdxMarketPairs"),src.indexOf("// Binance fallback"));
  assert.match(fn,/RANK=\{B:3/,"the Binance-backed book must outrank the rest");
  assert.match(fn,/status\|\|"active"\)==="active"\?10:0/,"and an active market must outrank an inactive one");
  assert.match(fn,/if\(best\[k\]!=null&&best\[k\]>=s\)continue;/,"a weaker listing must not overwrite a stronger one");

  /* AND THE BROWSER MAP MUST RANK TOO. I fixed the server's map and left the browser's on
     last-one-wins — the same server-only mistake as #20, and the browser is the map that actually
     runs on the Crypto tab. The reproduction caught it: the app asked HB-COW_USDT, got an empty
     array, and fell back to the INR pair for a coin with a perfectly good B- book. */
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const bm=script.slice(script.indexOf("async function cdxPairMap"),script.indexOf("async function getStatus"));
  assert.match(bm,/RANK=\{B:3/,"the browser map must rank by ecode as well");
  assert.match(bm,/status\|\|'active'\)==='active'\?10:0/,"and by active status");
  assert.match(bm,/if\(best\[k\]!=null&&best\[k\]>=sc\)continue;/,"last-one-wins on either side reopens this");
});

test("falling back to the INR pair records WHY, on both loaders",()=>{
  /* Four causes — no listing, no rate, dead candles, no pair list at all — are indistinguishable
     on screen unless each says so. Not knowing which one fired is exactly why this question could
     not be answered from either the app or the code. */
  const src=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","server.js"),"utf8");
  const fn=src.slice(src.indexOf("async function loadCoinDCX"),src.indexOf("async function loadBinance"));
  for(const cause of [/no USDT market listed/,/markets_details unreachable/,/no USDT\/INR rate yet/,/candles failed/])
    assert.match(fn,cause,"server loader must name this cause");
  assert.match(fn,/inrWhy:inrWhy\|\|undefined/,"and carry it out with the series");

  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const bf=script.slice(script.indexOf("async function fetchCoinDCXCrypto"),script.indexOf("let cdxPairCache"));
  for(const cause of [/markets_details unavailable/,/no USDT market listed/,/no USDT\/INR rate yet/,/under 41 bars at/,/candles failed/])
    assert.match(bf,cause,"browser loader must name this cause too — it is the one that runs in deployment");
  assert.match(bf,/inrWhy:inrWhy\|\|undefined/);
  assert.match(script,/function paintPairNote\(\)/,"and the page must summarise coverage rather than requiring a hover on every card");
  assert.match(script,/coins on CoinDCX's USDT market/);
});

test("the card names which CoinDCX market its numbers came from",()=>{
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const vm=require("node:vm");
  const i=script.indexOf("function venueNote(r)");
  const ctx=vm.createContext({});
  vm.runInContext(script.slice(i,script.indexOf("// Currency-aware input conversion"))+";globalThis.venueNote=venueNote;",ctx);
  const mk=tag=>({asset:{cls:"Crypto"},priceTag:tag});
  assert.match(ctx.venueNote(mk("live · CoinDCX USDT market")),/USDT market/,
    "the good path must be identifiable, or a downgrade is invisible");
  assert.match(ctx.venueNote(mk("live · CoinDCX INR pair")),/INR pair/,
    "and the thinner fallback must say so");
  assert.match(ctx.venueNote(mk("live · global ₹")),/not<\/b> CoinDCX/);
});

test("the page never claims a global-feed $ price matches CoinDCX",()=>{
  /* It used to end the global-feed notice with "and $ USDT values are exact". Exact against the
     GLOBAL market — not against CoinDCX. The India premium explains only the ₹ gap; the coin's own
     price also differs between venues, and on a thin alt that dwarfs the premium. PROM read $3.43
     in the app against $3.21 on CoinDCX — 6.85% apart, which no rate can produce, because the rate
     cancels: ₹ = price×rate, so $ = ₹÷rate = price. A wrong claim in the UI sent someone hunting a
     bug that was never in the code. */
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  // only what the user is SHOWN — the comment above it quotes the old wording on purpose
  const g=html.indexOf("mode==='global'");
  assert.ok(g>0,"could not find the global-feed branch");
  const seg=html.slice(g,html.indexOf("} else {",g));
  const note=seg.slice(seg.indexOf("cn.innerHTML="));
  assert.ok(!/\$ USDT values are exact/.test(note),
    "the global feed cannot promise CoinDCX-exact $ prices");
  assert.match(note,/not CoinDCX/,"it must name the venue plainly");
  assert.match(note,/several percent/,"and size the gap, since 'small' is what misled");
  assert.match(note,/ratios/,"while still saying what DOES survive the gap");
});

test("every crypto price is stamped with the exchange it came from",()=>{
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const vm=require("node:vm");
  const i=script.indexOf("function venueNote(r)");
  assert.ok(i>0,"venueNote must exist");
  const ctx=vm.createContext({});
  vm.runInContext(script.slice(i,script.indexOf("// Currency-aware input conversion"))+
    ";globalThis.venueNote=venueNote;",ctx);
  const mk=tag=>({asset:{cls:"Crypto"},priceTag:tag});
  assert.match(ctx.venueNote(mk("live · CoinDCX ₹")),/CoinDCX/);
  assert.ok(!/not<\/b> CoinDCX/.test(ctx.venueNote(mk("live · CoinDCX ₹"))),"a real CoinDCX price is not disclaimed");
  assert.match(ctx.venueNote(mk("live · global ₹")),/not<\/b> CoinDCX/,"a global price must say so on the number itself");
  assert.strictEqual(ctx.venueNote({asset:{cls:"Stock"},priceTag:"LIVE (broker)"}),"","stocks have no venue ambiguity");
  assert.match(script,/Current Price\$\{venueNote\(r\)\}/,"and it must be rendered beside the price");
});

test("the page says so when the $ toggle cannot convert, instead of quietly showing ₹",()=>{
  // cryptoPrice() falls back to ₹ when there is no rate. The number and its symbol are both
  // right — the TOGGLE is what is lying, and it used to lie silently.
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.match(html,/id="ccyWarn"/,"there must be somewhere to say it");
  assert.match(script,/function updateCcyWarn\(\)/);
  assert.match(script,/cryptoCcy==='USDT'\s*&&\s*!canConvert/,"it must trigger on exactly the silent-fallback case");
  assert.match(script,/const canConvert\s*=\s*usdtInr>0\s*\|\|/,
    "convertible means a shared rate OR a per-result one — a per-result rate must not raise a false alarm");
  // it has to be refreshed wherever the rate or the tab can change, not just defined
  const body=name=>{const i=script.indexOf("function "+name+"(");assert.ok(i>0,name+" not found");
    return script.slice(i,i+1400);};
  for(const fn of ["applyQuotes","render"])
    assert.ok(body(fn).includes("updateCcyWarn()"),fn+" must refresh the warning");
  assert.ok(script.includes("await ensureRate();updateCcyWarn();"),"and the toggle itself must refresh it");
});

test("a weaker rate source cannot displace a live one, but does take over when it goes quiet",()=>{
  /* $ is only right when it divides a ₹ price by the rate that BUILT it. When the browser reaches
     CoinDCX but the server cannot, both sources are live at once; ordering purely by freshness
     made them alternate every few seconds, which on screen looks like a wandering price. */
  const c=rateGuard();
  c.usdtInr=89.0; c.markRateNow('coindcx');
  c.setRate({usdtInr:86.4,rateSrc:"fx",rateAge:0});
  assert.strictEqual(c.usdtInr,89.0,"FX must not displace a live CoinDCX rate");
  c.setRate({usdtInr:89.4,rateSrc:"coindcx",rateAge:0});
  assert.strictEqual(c.usdtInr,89.4,"CoinDCX keeps updating itself");
  // CoinDCX stops responding: after the staleness window, FX is better than nothing.
  c.usdtInr=89.4; c.markRateNow('coindcx');
  c.__advance(6*60*1000);
  c.setRate({usdtInr:86.4,rateSrc:"fx",rateAge:0});
  assert.strictEqual(c.usdtInr,86.4,"FX must take over once CoinDCX has gone quiet");
});

/* The card's "is this still tradeable?" logic, lifted out of index.html and RUN. It decides
   whether you are shown a green BUY or a warning, so it is worth executing rather than reading. */
function staleGuard(){
  const vm=require("node:vm");
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  const from=script.indexOf("const PENDING_ENTRY="), to=script.indexOf("let _staleSig=");
  assert.ok(from>0&&to>from,"could not locate the staleness block in index.html");
  const ctx=vm.createContext({});
  vm.runInContext(script.slice(from,to)+
    ";globalThis.liveStale=liveStale;globalThis.missedEntry=missedEntry;globalThis.liveRoomR=liveRoomR;",ctx);
  return ctx;
}
// long: zone 100–102, entry 101, stop 96, T1 110 -> advertised R:R 1.8
const LONG={dir:1,entry:101,entryLo:100,entryHi:102,stop:96,targets:[110,115,120],rrr:1.8,atr:2};
// short: zone 98–100, entry 99, stop 104, T1 90 -> advertised R:R 1.8
const SHORT={dir:-1,entry:99,entryLo:98,entryHi:100,stop:104,targets:[90,85,80],rrr:1.8,atr:2};
// action.kind matters: a setup you were told to act on can be missed, one you are WAITING on cannot
const long=(px,kind="buybreak")=>({sig:{price:px,verdict:"BUY"},setup:LONG,action:{kind}});
const short=(px,kind="sellbreak")=>({sig:{price:px,verdict:"SELL"},setup:SHORT,action:{kind}});

test("a setup whose price has already run PAST the entry is flagged, not shown as a live BUY",()=>{
  /* THE REGRESSION THIS PINS. liveStale only ever measured room to the STOP, so it caught a trade
     going wrong and completely missed a trade already being over. Reproduced in a browser: with
     the coin at ₹12,350 the card still read "🟢 BUY the breakout — ₹8,725–₹8,776" — past all three
     targets — because 30R of room to the stop sailed through the check. */
  const c=staleGuard();
  assert.strictEqual(c.liveStale(long(101)),false,"inside the entry zone is tradeable");
  assert.strictEqual(c.missedEntry(long(103)),false,
    "just above the zone is the setup WORKING — a breakout zone starts at the last close");
  assert.strictEqual(c.missedEntry(long(108)),true,"2 up against 12 down is not the trade advertised");
  assert.strictEqual(c.missedEntry(long(111)),true,"past Target 1 — this card's trade is over");
  assert.strictEqual(c.liveStale(long(108)),true,"and that must grey the card");
  assert.ok(c.liveRoomR(long(108))>2,
    "fixture check: room to the stop is still wide, which is exactly why this slipped through before");
  // and the mirror image for a short
  assert.strictEqual(c.missedEntry(short(97)),false,"just below the zone is the breakdown working");
  assert.strictEqual(c.missedEntry(short(92)),true,"a short whose price has already collapsed is done");
  assert.strictEqual(c.missedEntry(short(89)),true,"past Target 1");
  assert.strictEqual(c.liveStale(short(92)),true);
  assert.strictEqual(c.missedEntry(short(99)),false,"inside the zone is still the trade");
});

test("the miss is judged against the card's OWN advertised R:R, not a fixed ratio",()=>{
  /* A fixed cutoff would declare every naturally tight setup "missed" the moment it left its zone,
     while letting a wide one bleed most of its edge unflagged. The test is proportional: two very
     different setups, each priced so the SAME fraction of their advertised edge remains, must be
     judged the same way. */
  const c=staleGuard();
  const mk=(lo,hi,t1,rrr)=>px=>({sig:{price:px,verdict:"BUY"},action:{kind:"buybreak"},
    setup:{dir:1,entry:101,entryLo:lo,entryHi:hi,stop:96,targets:[t1,t1+5,t1+10],rrr,atr:2}});
  const wide=mk(100,102,110,1.8), tight=mk(100.5,101.5,104,0.6);
  //                        price   remaining R:R   as a share of advertised
  assert.strictEqual(c.missedEntry(wide(102.73)),false,  // 1.08 of 1.8  -> 60% left
    "60% of a wide setup's edge remains — still the trade on the card");
  assert.strictEqual(c.missedEntry(tight(101.88)),false, // 0.36 of 0.6  -> 60% left
    "60% of a tight setup's edge remains — it must not be punished for being tight");
  assert.strictEqual(c.missedEntry(wide(104.14)),true,   // 0.72 of 1.8  -> 40% left
    "only 40% of the edge left — chasing this is a different trade");
  assert.strictEqual(c.missedEntry(tight(102.45)),true,  // 0.24 of 0.6  -> 40% left
    "the same 40% must read the same way on a tight setup");
});

test("WAITING is not MISSING — a pullback entry below price is the plan working",()=>{
  /* THE REGRESSION THIS PINS. A pullback setup puts its entry at support, deliberately BELOW the
     price: "⏳ WAIT for the dip — set a buy limit at ₹X, ~2% below now". Price sitting above that
     zone is the plan working as intended, and such a setup's T1 can legitimately be on the near
     side of the current price too. Judging those by distance-from-zone greyed almost the entire
     board — measured clean=0 actionable setups on all six timeframes — which looks exactly like
     the scanner having gone dead. Only a setup that was LIVE at scan time can be missed. */
  const c=staleGuard();
  // identical price and levels; only the entry style differs
  assert.strictEqual(c.missedEntry(long(108,"buybreak")),true,"a breakout you were told to take: missed");
  assert.strictEqual(c.missedEntry(long(108,"waitdip")),false,"the same numbers as a pending dip buy: NOT missed");
  assert.strictEqual(c.liveStale(long(108,"waitdip")),false,"and it must stay on the board, ungreyed");
  assert.strictEqual(c.missedEntry(short(92,"sellbreak")),true);
  assert.strictEqual(c.missedEntry(short(92,"waitbounce")),false,"a short waiting for a bounce is pending, not late");
  // a card that WAS live and has run past is still caught
  assert.strictEqual(c.missedEntry(long(108,"buynow")),true,"price was in the zone at scan time and has left it");
  // and with no action at all we must not guess
  assert.strictEqual(c.missedEntry({sig:{price:108,verdict:"BUY"},setup:LONG}),false,
    "unknown entry style must not grey a card");
});

test("running toward the stop is still caught, and HOLD is never flagged",()=>{
  const c=staleGuard();
  assert.strictEqual(c.liveStale(long(97)),true,"<½R from the stop");
  assert.strictEqual(c.liveStale(long(99)),true,"broke below the entry zone");
  assert.strictEqual(c.liveStale({sig:{price:108,verdict:"HOLD"},setup:LONG,action:{kind:"buybreak"}}),false,
    "HOLD has no setup to be late for");
});

test("the card never shows a green BUY above a ribbon saying the entry is gone",()=>{
  const html=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","index.html"),"utf8");
  const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.match(script,/const actLine\s*=\s*missed/,"the action line must be overridden when the entry is missed");
  assert.match(script,/class="action \$\{actCls\}">\$\{actLine\}/,"the card must render the overridden line, not the scan-time one");
  assert.ok(!/class="action \$\{action\.cls\}">\$\{actionText/.test(script),"the raw scan-time action must no longer be rendered directly");
});

test("withLiveRate reports the rate's AGE, which survives a clock difference",()=>{
  S.__setMode("binance");
  S.__setFx(88.5);
  const p=S.withLiveRate({x:1});
  assert.ok(typeof p.rateAge==="number"&&p.rateAge>=0,"every priced payload must carry rateAge");
  assert.ok(p.rateAge<5000,"__setFx just ran — the reading is seconds old, not hours");
});

test("browser-fetched crypto is stamped with the FETCH time, not the forming candle's open",()=>{
  /* On the Crypto tab the candles come from the user's own browser, and that payload carried no
     read-time. processAsset then fell back to times[last] — the OPEN of the still-forming bar — so
     on the 30m tab a card whose price was 8 seconds old was labelled "📡" up to 30 minutes ago, and
     the label drifted older until the bar rolled. The longer the timeframe the worse it looked,
     which is why it showed on 30m and not on 5m. */
  const now=Date.now(), BAR=30*60*1000, n=300;
  const close=[],high=[],low=[],times=[],vol=[];
  let x=100;
  for(let i=0;i<n;i++){x*=1.001;close.push(x);high.push(x*1.004);low.push(x*0.996);vol.push(1000);
    times.push(now-29*60*1000-(n-1-i)*BAR);}    // last bar opened 29 minutes ago
  const out=S.cryptoSignalsFrom({tf:"30m",assets:[{sym:"PROMINR",tk:"PROM",name:"PROM",close,high,low,times,vol,price:x}]});
  assert.strictEqual(out.results.length,1);
  const server=S.processAsset({sym:"PROMINR",tk:"PROM",name:"PROM",cls:"Crypto",src:"cg"},
    {close,high,low,times,vol,price:x,mtime:now},"30m");
  assert.strictEqual(out.results[0].asof,server.asof,
    "the browser path must timestamp like the server path — the read time, not the bar's open");
});
