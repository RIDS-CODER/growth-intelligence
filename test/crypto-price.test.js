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
  c.markRateNow('coindcx');                                     // browser fetch: local clock, age 0
  c.usdtInr=89.0;
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

test("a weaker rate source cannot displace a live one, but does take over when it goes quiet",()=>{
  /* $ is only right when it divides a ₹ price by the rate that BUILT it. When the browser reaches
     CoinDCX but the server cannot, both sources are live at once; ordering purely by freshness
     made them alternate every few seconds, which on screen looks like a wandering price. */
  const c=rateGuard();
  c.markRateNow('coindcx'); c.usdtInr=89.0;
  c.setRate({usdtInr:86.4,rateSrc:"fx",rateAge:0});
  assert.strictEqual(c.usdtInr,89.0,"FX must not displace a live CoinDCX rate");
  c.setRate({usdtInr:89.4,rateSrc:"coindcx",rateAge:0});
  assert.strictEqual(c.usdtInr,89.4,"CoinDCX keeps updating itself");
  // CoinDCX stops responding: after the staleness window, FX is better than nothing.
  c.markRateNow('coindcx'); c.usdtInr=89.4;
  c.__advance(6*60*1000);
  c.setRate({usdtInr:86.4,rateSrc:"fx",rateAge:0});
  assert.strictEqual(c.usdtInr,86.4,"FX must take over once CoinDCX has gone quiet");
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
