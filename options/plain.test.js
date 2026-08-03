/* Plain-English layer + direction gate. Run: node --test options/*.test.js */
"use strict";
const test=require("node:test");
const assert=require("node:assert");
const P=require("./plain.js");
const S=require("./score.js");
const A=require("./adapters.js");
const V=require("./vol.js");

const DAY=86400000;
const longCall={underlying:"BTC",kind:"call",strike:9000000,expiry_ms:Date.now()+10*DAY,
  side:"buy",score_10:6.5,structure:null,
  econ:{premium_inr:12000,breakeven:9012000,max_loss_inr:12000,theta_day_inr:-900,
        req_move_pct:6.0,dte_days:10,tax_drag_inr:3744},quality:{}};
const creditSpread={underlying:"BTC",kind:"call",strike:8800000,expiry_ms:Date.now()+10*DAY,
  side:"sell",score_10:5.5,
  structure:{short_leg:"a",long_leg:"b",short_strike:8800000,long_strike:9000000,
             width:200000,net_credit_inr:60000,max_loss_inr:140000},
  econ:{premium_inr:80000,breakeven:8860000,max_loss_inr:140000,theta_day_inr:1200,
        req_move_pct:2.0,dte_days:10,tax_drag_inr:18720},quality:{}};

/* ---------------- payoff arithmetic a beginner could check by hand ---------------- */
test("long call payoff is exactly intrinsic minus premium",()=>{
  const at=(S_)=>P.payoffAtExpiry(longCall,S_,1);
  assert.strictEqual(at(8500000).value,0,"below strike → worthless");
  assert.strictEqual(at(8500000).pnl,-12000,"…and you lose the whole premium");
  assert.strictEqual(at(9000000).value,0,"at the strike → still worthless");
  assert.strictEqual(at(9100000).value,100000,"100k above strike → worth 100k");
  assert.strictEqual(at(9100000).pnl,88000,"…minus the 12k paid");
});
test("credit spread loss is capped at the width minus the credit",()=>{
  const at=(S_)=>P.payoffAtExpiry(creditSpread,S_,1);
  assert.strictEqual(at(8000000).pnl,60000,"well below the short strike → keep the full credit");
  assert.strictEqual(at(8800000).pnl,60000,"at the short strike → still keep it");
  assert.strictEqual(at(9000000).pnl,60000-200000,"at/above the long strike → maximum loss");
  assert.strictEqual(at(99000000).pnl,60000-200000,"far beyond → NO worse. The cap holds.");
});
test("payoff table spans loss and profit and marks total loss",()=>{
  const rows=P.payoffTable(longCall,8500000,1);
  assert.ok(rows.length>=5);
  assert.ok(rows.some(r=>r.pnl<0)&&rows.some(r=>r.pnl>0),"shows both outcomes");
  const worst=rows.find(r=>r.move_pct===-15);
  assert.strictEqual(worst.pnl,-12000,"a big adverse move loses exactly the premium, no more");
  assert.ok(worst.total_loss,"flagged as a total loss");
  for(let i=1;i<rows.length;i++)assert.ok(rows[i].pnl>=rows[i-1].pnl,"call payoff rises with price");
});

/* ---------------- the honest base rate ---------------- */
test("move frequency counts real historical windows",()=>{
  // +1% per step compounding: EVERY 10-step window gains ~10.5%
  const up=[100]; for(let i=0;i<200;i++)up.push(up[up.length-1]*1.01);
  const f=P.moveFrequency(up,10,10,1);
  assert.strictEqual(f.rate,1,"a +10% move always happened in this series");
  const hard=P.moveFrequency(up,50,10,1);
  assert.strictEqual(hard.rate,0,"a +50% move never did");
  const dn=P.moveFrequency(up,10,10,-1);
  assert.strictEqual(dn.rate,0,"and it never fell 10%");
  assert.strictEqual(P.moveFrequency([1,2,3],10,10,1),null,"too little history → null, not a guess");
});
test("the odds line reports the base rate without predicting",()=>{
  const flat=[]; for(let i=0;i<200;i++)flat.push(100+(i%2));
  const f=P.moveFrequency(flat,6,10,1);
  const line=P.oddsLine(f,longCall);
  assert.match(line,/0 of the last/,"states the count");
  assert.match(line,/not a prediction/i,"explicitly disclaims prediction");
});

/* ---------------- language: no jargon in user-facing strings ---------------- */
test("no options jargon reaches the user-facing text",()=>{
  const closes=[]; for(let i=0;i<200;i++)closes.push(8500000*(1+0.01*Math.sin(i/7)));
  for(const sig of [longCall,creditSpread]){
    const e=P.explainSignal(sig,{spot:8500000,contractSize:1,closes,candidates:42});
    const blob=[e.thesis,e.action,e.win,e.loss,e.decay,e.odds,e.why_this_one,...e.cautions].join(" ");
    for(const jargon of [/\btheta\b/i,/\bvega\b/i,/\bgamma\b/i,/\bdelta\b/i,/implied vol/i,
                         /\bz-score\b/i,/\bskew\b/i,/\bsmile\b/i,/σ/,/\bIV\b/])
      assert.ok(!jargon.test(blob),`"${jargon}" must not appear in user-facing copy: ${blob.slice(0,160)}`);
  }
});
test("every plain block states action, cost, win, loss and a deadline",()=>{
  for(const sig of [longCall,creditSpread]){
    const e=P.explainSignal(sig,{spot:8500000,contractSize:1});
    assert.ok(/buy|sell/i.test(e.action),"action tells you what to do");
    assert.ok(e.max_loss_inr>0,"max loss always stated");
    assert.ok(e.win&&e.win.length>20,"win condition stated");
    assert.ok(e.loss&&e.loss.length>20,"loss condition stated");
    assert.match(e.action,/\d/,"names a concrete strike/date");
    assert.ok(e.cautions.length>0,"never zero warnings");
    assert.ok(e.payoff.length>0,"payoff table present");
  }
});
test("the two-leg warning appears on spreads and not on simple buys",()=>{
  const spread=P.explainSignal(creditSpread,{spot:8500000});
  assert.ok(spread.cautions.some(c=>/both legs/i.test(c)),"spread warns to place both legs");
  const simple=P.explainSignal(longCall,{spot:8500000});
  assert.ok(!simple.cautions.some(c=>/both legs/i.test(c)),"a simple buy does not");
});
test("a long-shot trade is called out as a long shot",()=>{
  const flat=[]; for(let i=0;i<300;i++)flat.push(100+0.05*Math.sin(i/3));   // barely moves
  const e=P.explainSignal(longCall,{spot:8500000,closes:flat});
  assert.ok(e.odds_pct!=null&&e.odds_pct<20,"base rate is low");
  assert.ok(e.cautions.some(c=>/expires worthless|only happened/i.test(c)),
    "warns that it usually expires worthless");
});
test("thesis names the direction in words, not option-speak",()=>{
  assert.match(P.thesisLine(longCall),/goes UP/);
  assert.match(P.thesisLine({...longCall,kind:"put"}),/goes DOWN/);
  // A credit spread is a "stays below" bet, not a directional buy — say that.
  assert.match(P.thesisLine(creditSpread),/stays below/);
});

/* ---------------- DIRECTION GATE ---------------- */
function chain(opts){
  opts=opts||{};
  const now=Date.now(),F=8500000,dte=7,expiry=now+dte*DAY,T=dte/365;
  const quotes=[];
  for(const m of [0.92,0.94,0.96,0.98,1.00,1.02,1.04,1.06,1.08]){
    const K=Math.round(F*m),k=Math.log(K/F);
    for(const kind of ["call","put"]){
      const iv=0.55+0.35*k*k-0.05*k;
      const mark=V.black76(kind,F,K,T,iv,1),sp=0.03*mark;
      quotes.push({id:`BTC-${K}-${kind}`,kind,strike:K,expiry_ms:expiry,
        bid:mark-sp/2,ask:mark+sp/2,mark,oi:500,iv});
    }
  }
  return A.buildSnapshot({venue:"coindcx",underlying:"BTC",ts_ms:now,spot:F,
    forwards:[{expiry_ms:expiry,F}],rvol30:opts.rvol30==null?0.55:opts.rvol30,quotes});
}
test("no clear direction means NO cards at all",()=>{
  const r=S.scoreSnapshot(chain(),{history:()=>null,view:{score:4,label:"no clear direction"}},{});
  assert.strictEqual(r.buys.length,0);
  assert.strictEqual(r.sells.length,0);
  assert.strictEqual(r.noView,true);
  const rej=r.rejections.find(x=>x.stage==="direction");
  assert.match(rej.reason,/No trade suggested/,"and it says why in plain terms");
});
test("a missing view also means no cards, rather than an unexplained bet",()=>{
  const r=S.scoreSnapshot(chain(),{history:()=>null},{});
  assert.strictEqual(r.noView,true);
  assert.strictEqual(r.buys.length+r.sells.length,0);
});
test("bullish view surfaces only positions that profit when it rises",()=>{
  const r=S.scoreSnapshot(chain({rvol30:0.95}),{history:()=>null,view:{score:25,label:"clearly rising"}},{});
  for(const s of r.buys)assert.strictEqual(s.kind,"call","bullish buys are calls");
  for(const s of r.sells)assert.strictEqual(s.kind,"put","bullish income trades are put spreads");
  const wrongWay=r.rejections.filter(x=>x.stage==="direction"&&/wrong way/.test(x.reason));
  assert.ok(wrongWay.length>0,"contracts betting the other way are rejected with a reason");
});
test("bearish view mirrors it exactly",()=>{
  const r=S.scoreSnapshot(chain({rvol30:0.95}),{history:()=>null,view:{score:-25,label:"clearly falling"}},{});
  for(const s of r.buys)assert.strictEqual(s.kind,"put");
  for(const s of r.sells)assert.strictEqual(s.kind,"call");
});
test("pure relative-value mode can still be enabled for expert use",()=>{
  const r=S.scoreSnapshot(chain({rvol30:0.20}),{history:()=>null},{requireDirectionalView:false});
  assert.ok(r.buys.length+r.sells.length>0,"no view required when the gate is off");
  assert.strictEqual(r.noView,false);
});
test("the direction gate never lets a naked short through",()=>{
  const r=S.scoreSnapshot(chain({rvol30:0.20}),{history:()=>null,view:{score:25}},{});
  for(const s of r.sells)assert.ok(s.structure&&s.econ.max_loss_inr>0,"still defined-risk");
});
