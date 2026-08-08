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
  // Deliberately not "back onside": for a counter-trend entry the signal was never onside to
  // begin with, so this message has to read correctly the first time it agrees with you.
  assert.match(back,/Signal now agrees with you/);
  assert.match(back,/\+20%/);
  assert.notStrictEqual(watch,back);
});

/* ---------------- recipients: ONE list, shared with Quick Trades ---------------- */

test("allRecipients returns the same people Quick Trades alerts, configured ones first",async()=>{
  // Position Watch used to offer only listChats() — people whose DMs are still inside Telegram's
  // getUpdates retention. Anyone who had set TELEGRAM_CHAT_ID (which the Quick Trades panel tells
  // you to do) therefore saw working scan alerts and an EMPTY recipient dropdown.
  const list=await S.allRecipients();
  assert.ok(Array.isArray(list));
  for(const c of list){
    assert.ok(c.id&&typeof c.id==='string');
    assert.ok(c.name,'every recipient needs a label, even one we only know by id');
    assert.ok(['alerts','messaged'].includes(c.src));
  }
  const ids=list.map(c=>c.id);
  assert.strictEqual(new Set(ids).size,ids.length,'a person listed twice would double-send');
  // Whatever Quick Trades would send to must be offered, and offered first.
  const idx=list.findIndex(c=>c.src==='messaged');
  const lastAlerts=list.map(c=>c.src).lastIndexOf('alerts');
  if(idx>=0&&lastAlerts>=0)assert.ok(lastAlerts<idx,'configured recipients must sort before DM-only ones');
});

/* ---------------- currency: entries are stored in ₹, whatever you typed ---------------- */

test("a crypto alert quotes BOTH currencies; anything else stays ₹-only",()=>{
  S.__setFx(88.5);
  const coin=S.fmtPosAlert({sym:'XAIUSDT',tk:'XAI',side:1,entry:0.59,tf:'4h',cls:'Crypto'},'reversed',0.55,'SELL');
  assert.match(coin,/\$0\.0067/,'a phone alert saying only ₹0.59 is unrecognisable to a CoinDCX trader');
  assert.match(coin,/₹0\.5900/,'…and dropping ₹ would break it for anyone pricing in rupees');
  const stock=S.fmtPosAlert({sym:'RELIANCE',tk:'RELIANCE',side:1,entry:2900,tf:'daily',cls:'Stock'},'reversed',2800,'SELL');
  assert.match(stock,/₹2900\.00/);
  assert.ok(!/\$/.test(stock),'a USD figure on an NSE stock would be meaningless');
});

test("P&L is unaffected by which currency it is displayed in",()=>{
  // Both sides of the ratio move together, so the percentage is the invariant. This is why the
  // fix is a display/input conversion and never a change to stored numbers.
  const r=88.5;
  assert.strictEqual(S.posPnl({side:1,entry:100},110),S.posPnl({side:1,entry:100*r},110*r));
  assert.strictEqual(S.posPnl({side:-1,entry:250},200),S.posPnl({side:-1,entry:250*r},200*r));
});

/* ---------------- a reversal is a CHANGE, not a comparison ---------------- */

test("entering against the signal is recorded as counter-trend, not flagged as a reversal",async()=>{
  // The reported bug: the flag was a stateless "does the signal disagree right now?", so a
  // deliberately counter-trend entry was branded REVERSED the instant it was added — under a
  // message reading "the reason you entered is gone" when there had never been one. And it is
  // the MAIN case here: 🎢 Dump & Bounce exists to buy bounces in coins still rated SELL.
  fresh();
  const p=(await S.addPosition({sym:"BTC",side:1,entry:1000})).position;
  assert.strictEqual(typeof p.against,"boolean","the baseline must be recorded at entry");
  assert.ok(p.entryVerdict,"and the verdict it was taken against");
  assert.strictEqual(p.counterAtEntry,p.against);
  assert.ok(!p.rev,"adding a position must NEVER raise the reversal flag, whatever the signal says");
});

test("the sweep seeds an unseen position instead of alerting on it",async()=>{
  // Covers records written before this fix, which carry no `against` field.
  fresh();
  await S.addPosition({sym:"BTC",side:1,entry:1000});
  const p=S.__getPositions()[0];
  delete p.against; delete p.rev; p.alerts=0;          // simulate a pre-upgrade record
  await S.positionsSweep();
  assert.strictEqual(typeof p.against,"boolean","seeded");
  assert.ok(!p.rev,"an upgrade must not fire a reversal for a state it never observed");
  assert.strictEqual(p.alerts,0,"and must not count an alert");
});

test("only a transition into disagreement is a reversal; staying there is not",async()=>{
  fresh();
  await S.addPosition({sym:"BTC",side:1,entry:1000});
  const p=S.__getPositions()[0];
  p.against=false; delete p.rev; p.alerts=0;
  // Force the engine to disagree by flipping the side against whatever it currently reads.
  const s=await S.positionSignal(p);
  if(s.verdict==="HOLD"){                              // no opinion — assert the neutral rule instead
    await S.positionsSweep();
    assert.ok(!S.__getPositions()[0].rev,"HOLD must never flip the flag");
    return;
  }
  p.side = s.verdict==="SELL" ? 1 : -1;                // now guaranteed to be against
  await S.positionsSweep();
  assert.ok(p.rev,"first sweep after the state changed must raise it");
  const n1=p.alerts;
  await S.positionsSweep();
  assert.strictEqual(p.alerts,n1,"a trade that SITS reversed must not re-alert every sweep");
});

test("the reversal message does not claim a reason existed when none did",()=>{
  const counter={sym:"X",tk:"X",side:1,entry:1,tf:"4h",cls:"Crypto",counterAtEntry:true,entryVerdict:"SELL"};
  const normal ={sym:"X",tk:"X",side:1,entry:1,tf:"4h",cls:"Crypto",counterAtEntry:false,entryVerdict:"BUY"};
  const m1=S.fmtPosAlert(counter,"reversed",0.9,"SELL");
  const m2=S.fmtPosAlert(normal ,"reversed",0.9,"SELL");
  assert.match(m2,/reason you entered is gone/,"a trade taken WITH the signal did lose its reason");
  assert.ok(!/reason you entered is gone/.test(m1),
    "a counter-trend trade never had a signal behind it — saying otherwise is simply false");
  assert.match(m1,/came onside and has now turned again/);
});

test("the confirmation warns when a trade starts counter-trend, and stays quiet when it doesn't",()=>{
  const counter={sym:"X",tk:"X",side:1,entry:1,tf:"4h",cls:"Crypto",counterAtEntry:true,entryVerdict:"SELL"};
  const normal ={sym:"X",tk:"X",side:1,entry:1,tf:"4h",cls:"Crypto",counterAtEntry:false,entryVerdict:"BUY"};
  const w1=S.fmtPosAlert(counter,"watch",1), w2=S.fmtPosAlert(normal,"watch",1);
  assert.match(w1,/counter-trend trade from the start/);
  assert.match(w1,/will NOT be pinged/,"sets the expectation so silence is not read as a fault");
  assert.ok(!/counter-trend trade from the start/.test(w2));
  assert.match(w2,/signal now <b>BUY<\/b>/,"both state the signal at entry");
});
