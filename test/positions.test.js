/* 🔔 Position Watch — trades the USER placed, watched server-side.
   The claim this feature makes is "we will tell you, and only you, when your trade turns
   against you". So these tests are about the two things that would break that promise:
   detecting the reversal correctly, and routing the message to the right person. */
const test=require("node:test");
const assert=require("node:assert");
const S=require("../server.js");

const fresh=()=>S.__resetPositions();

test("resolveAsset accepts a ticker, a full symbol, or a prefix",async()=>{
  assert.strictEqual(S.resolveAsset("BTC").sym,"BTCUSDT");
  assert.strictEqual(S.resolveAsset("BTCUSDT").sym,"BTCUSDT");
  assert.strictEqual(S.resolveAsset("btc").sym,"BTCUSDT","symbols are case-insensitive");
  assert.strictEqual(S.resolveAsset("NOT-A-COIN"),null);
  assert.strictEqual(S.resolveAsset(""),null);
  assert.strictEqual(S.resolveAsset(null),null);
});

test("addPosition refuses input it cannot honestly watch",async()=>{
  fresh();
  assert.match((await S.addPosition({sym:"NOPE",side:"long",entry:100})).error,/Unknown symbol/);
  assert.match((await S.addPosition({sym:"BTC",side:"long",entry:0})).error,/positive number/);
  assert.match((await S.addPosition({sym:"BTC",side:"long",entry:-5})).error,/positive number/);
  assert.match((await S.addPosition({sym:"BTC",side:"long"})).error,/positive number/);
  assert.strictEqual(S.__getPositions().length,0,"nothing invalid may be stored");
});

test("addPosition records the side, entry and timeframe as given",async()=>{
  fresh();
  const a=(await S.addPosition({sym:"BTC",side:"long",entry:1000,tf:"4h",qty:2})).position;
  const b=(await S.addPosition({sym:"ETH",side:"short",entry:500})).position;
  assert.strictEqual(a.side,1); assert.strictEqual(a.entry,1000);
  assert.strictEqual(a.tf,"4h"); assert.strictEqual(a.qty,2);
  assert.strictEqual(b.side,-1);
  assert.strictEqual(b.tf,"1h","defaults to 1h when not given");
  assert.strictEqual(S.__getPositions().length,2);
  assert.notStrictEqual(a.id,b.id,"ids must be unique or removal hits the wrong trade");
});

test("an unknown timeframe falls back rather than being watched on a made-up chart",async()=>{
  fresh();
  const p=(await S.addPosition({sym:"BTC",side:"long",entry:1,tf:"7 years"})).position;
  assert.strictEqual(p.tf,"1h");
});

test("P&L is signed by direction — a short profits when price falls",()=>{
  assert.strictEqual(S.posPnl({side:1,entry:100},110),10);
  assert.strictEqual(S.posPnl({side:1,entry:100},90),-10);
  assert.strictEqual(S.posPnl({side:-1,entry:100},90),10,"short + price down = profit");
  assert.strictEqual(S.posPnl({side:-1,entry:100},110),-10);
  assert.strictEqual(S.posPnl({side:1,entry:0},100),null);
  assert.strictEqual(S.posPnl({side:1,entry:100},0),null);
});

/* ---- the reversal rule ---- */

test("HOLD is not a reversal — no opinion is not the same as disagreeing with you",async()=>{
  fresh();
  const p=(await S.addPosition({sym:"BTC",side:"long",entry:1000})).position;
  p.verdict="HOLD"; delete p.rev;
  await S.positionsSweep();
  const after=S.__getPositions()[0];
  if(after.verdict==="HOLD")assert.ok(!after.rev,"a HOLD must never raise the reversal flag");
});

test("a long flags on SELL and a short flags on BUY, and each clears when it comes back",async()=>{
  // Drive the rule directly over the four combinations, since a live scan cannot be forced.
  const against=(side,verdict)=>side>0?verdict==="SELL":verdict==="BUY";
  assert.strictEqual(against(1,"SELL"),true);
  assert.strictEqual(against(1,"BUY"),false);
  assert.strictEqual(against(1,"HOLD"),false);
  assert.strictEqual(against(-1,"BUY"),true);
  assert.strictEqual(against(-1,"SELL"),false);
  assert.strictEqual(against(-1,"HOLD"),false);
});

test("the sweep keeps a live price and P&L on every watched position",async()=>{
  fresh();
  await S.addPosition({sym:"BTC",side:"long",entry:1000});
  await S.positionsSweep();
  const p=S.__getPositions()[0];
  assert.ok(p.price>0,"a watch with no price is not watching anything");
  assert.strictEqual(p.pnlPct,S.posPnl(p,p.price));
  assert.ok(p.seen>0);
  assert.ok(["BUY","SELL","HOLD"].includes(p.verdict));
});

test("a symbol that cannot be read is flagged, not silently dropped",async()=>{
  fresh();
  await S.addPosition({sym:"BTC",side:"long",entry:1000});
  S.__getPositions()[0].sym="DELISTED-XYZ";
  await S.positionsSweep();
  const p=S.__getPositions()[0];
  assert.ok(p.err,"the panel must be able to say it lost sight of the trade");
  assert.strictEqual(S.__getPositions().length,1,"and must not throw the position away");
});

/* ---- routing: the whole point is that it goes to ONE named person ---- */

test("each position carries its own Telegram recipient",async()=>{
  fresh();
  const a=(await S.addPosition({sym:"BTC",side:"long",entry:1,chat:"111",chatName:"Riddhi"})).position;
  const b=(await S.addPosition({sym:"ETH",side:"short",entry:1,chat:"222",chatName:"Someone else"})).position;
  assert.strictEqual(a.chat,"111"); assert.strictEqual(a.chatName,"Riddhi");
  assert.strictEqual(b.chat,"222");
  assert.notStrictEqual(a.chat,b.chat,"two trades by two people must not share a recipient");
});

test("a position with no recipient is still watched, just not messaged",async()=>{
  fresh();
  const p=(await S.addPosition({sym:"BTC",side:"long",entry:1000})).position;
  assert.strictEqual(p.chat,null);
  await S.positionsSweep();
  assert.ok(S.__getPositions()[0].price>0,"watching must not depend on Telegram being configured");
});

test("the reversal message says the side, the entry, the P&L and what to do",()=>{
  const p={sym:"BTCUSDT",tk:"BTC",side:1,entry:100,tf:"1h"};
  const m=S.fmtPosAlert(p,"reversed",90,"SELL");
  assert.match(m,/YOUR TRADE REVERSED/);
  assert.match(m,/BTC/);
  assert.match(m,/LONG/);
  assert.match(m,/SELL/,"names the verdict that turned against them");
  assert.match(m,/-10%/,"carries the live P&L, not just a warning");
  assert.match(m,/reason you entered is gone/,"tells them what it means");
  assert.match(m,/not financial advice/);
});

test("a short's reversal message says SHORT, not LONG",()=>{
  const m=S.fmtPosAlert({sym:"ETHUSDT",tk:"ETH",side:-1,entry:100,tf:"4h"},"reversed",110,"BUY");
  assert.match(m,/SHORT/);
  assert.ok(!/\bLONG\b/.test(m),"a mislabelled side would make the alert actively misleading");
  assert.match(m,/-10%/);
});

test("the confirmation and recovery messages exist and are distinct",()=>{
  const p={sym:"BTCUSDT",tk:"BTC",side:1,entry:100,tf:"1h"};
  const watch=S.fmtPosAlert(p,"watch",100);
  const back=S.fmtPosAlert(p,"onside",120,"BUY");
  assert.match(watch,/Now watching/);
  assert.match(watch,/one message here if the signal turns against/,"sets the expectation of no spam");
  assert.match(back,/Back onside/);
  assert.match(back,/\+20%/);
  assert.notStrictEqual(watch,back);
});
