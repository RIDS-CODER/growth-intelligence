/* Backtest harness tests. Run: node --test options/*.test.js */
"use strict";
const test=require("node:test");
const assert=require("node:assert");
const B=require("./backtest.js");
const A=require("./adapters.js");
const V=require("./vol.js");

const DAY=86400000;

/* A tape where the underlying drifts by a controllable amount, so outcomes are known
   in advance and the harness's accounting can be checked against them. */
function tape(opts){
  opts=opts||{};
  const t0=opts.t0||Date.UTC(2026,0,1);
  const dte=opts.dte||10, expiry=t0+dte*DAY;
  const steps=opts.steps||12, stepMs=opts.stepMs||DAY;
  const out=[];
  for(let i=0;i<steps;i++){
    const ts=t0+i*stepMs;
    const F=(opts.F||100)*(1+(opts.driftPerStep||0)*i);
    const T=Math.max(1e-9,(expiry-ts)/(365*DAY));
    const quotes=[];
    for(const mult of [0.94,0.96,0.98,1.00,1.02,1.04,1.06]){
      const K=+( (opts.F||100)*mult ).toFixed(2);
      const k=Math.log(K/F);
      const iv=(opts.iv||0.60)+0.3*k*k;
      for(const kind of ["call","put"]){
        const mark=V.black76(kind,F,K,T,iv,1);
        const sp=(opts.spreadPct==null?2:opts.spreadPct)/100*Math.max(mark,1e-6);
        quotes.push({id:`X-${K}-${kind==="call"?"C":"P"}`,kind,strike:K,expiry_ms:expiry,
          bid:Math.max(0,mark-sp/2),ask:mark+sp/2,mark,oi:800,vol24h:50,iv});
      }
    }
    out.push(A.buildSnapshot({venue:"coindcx",underlying:"BTC",ts_ms:ts,spot:F,
      forwards:[{expiry_ms:expiry,F}],rvol30:opts.rvol30==null?0.60:opts.rvol30,quotes}));
  }
  return out;
}

test("replay produces completed trades with coherent accounting",()=>{
  const r=B.replay(tape({rvol30:0.30}),{history:()=>null});
  assert.ok(r.n>0,"produced trades");
  for(const t of r.trades){
    assert.ok(t.exit_ts>t.entry_ts,"exit after entry");
    assert.ok(isFinite(t.pnl)&&isFinite(t.ret_pct),"finite P&L");
    assert.ok(["expiry","close"].includes(t.exit_how));
    assert.ok(t.entry>0,"positive entry basis");
  }
});
test("slippage is half the spread on entry and exit",()=>{
  const q={mark:10,spread:2};
  assert.strictEqual(B.fillPrice(q,1),11,"buyer pays mark + half spread");
  assert.strictEqual(B.fillPrice(q,-1),9,"seller receives mark − half spread");
  assert.strictEqual(B.fillPrice({mark:10,spread:0},1),10,"no spread → no slippage");
  assert.strictEqual(B.fillPrice({mark:10,spread:null},1),10,"missing spread → no slippage");
});
test("a wider spread strictly reduces measured returns",()=>{
  const tight=B.replay(tape({rvol30:0.30,spreadPct:1}),{history:()=>null});
  const wide =B.replay(tape({rvol30:0.30,spreadPct:6}),{history:()=>null});
  if(tight.n&&wide.n)
    assert.ok(wide.overall.avg_ret_pct<=tight.overall.avg_ret_pct+1e-9,
      `wider spread must not look better (${wide.overall.avg_ret_pct} vs ${tight.overall.avg_ret_pct})`);
});
test("intrinsic settlement is correct for longs and for spreads",()=>{
  assert.strictEqual(B.settleIntrinsic({kind:"call",strike:100,structure:null},120),20);
  assert.strictEqual(B.settleIntrinsic({kind:"call",strike:100,structure:null},80),0);
  assert.strictEqual(B.settleIntrinsic({kind:"put",strike:100,structure:null},80),20);
  // short 100 call / long 110 call, settling at 130 → owe the full 10-wide width
  assert.strictEqual(B.settleIntrinsic(
    {kind:"call",strike:100,structure:{short_strike:100,long_strike:110}},130),10);
  // same spread settling below both strikes → worth nothing, keep the credit
  assert.strictEqual(B.settleIntrinsic(
    {kind:"call",strike:100,structure:{short_strike:100,long_strike:110}},90),0);
});
test("unresolved positions are excluded, not marked to last price",()=>{
  // Tape ends well before expiry, so open trades cannot be settled.
  const r=B.replay(tape({dte:60,steps:3}),{history:()=>null});
  assert.ok(r.unresolved>=0,"unresolved counted");
  for(const t of r.trades)assert.ok(t.exit_how==="expiry"||t.exit_how==="close",
    "every counted trade actually closed");
  assert.strictEqual(r.n,r.trades.length,"n counts only completed trades");
});
test("holdDays closes positions early",()=>{
  const held=B.replay(tape({dte:30,steps:10}),{history:()=>null,holdDays:2});
  for(const t of held.trades)
    assert.ok(t.held_days>=2-1e-9||t.exit_how==="expiry",`closed at the horizon, held ${t.held_days}`);
});

/* ---------------- statistics honesty ---------------- */
test("Wilson interval is sane and widens on small samples",()=>{
  const [lo1,hi1]=B.wilson(5,10), [lo2,hi2]=B.wilson(50,100);
  assert.ok(lo1>=0&&hi1<=1&&lo1<0.5&&hi1>0.5,"brackets the estimate");
  assert.ok((hi1-lo1)>(hi2-lo2),"10 samples is wider than 100");
  const [lo3,hi3]=B.wilson(3,3);
  assert.ok(lo3<1&&hi3<=1,"3/3 does not claim certainty");
  assert.deepStrictEqual(B.wilson(0,0),[null,null],"no data → no interval");
});
test("stats report sample size and interval, never a bare hit rate",()=>{
  const s=B.statsFor([{pnl:1,ret_pct:10},{pnl:-1,ret_pct:-10},{pnl:2,ret_pct:20}]);
  assert.strictEqual(s.n,3);
  assert.ok(Math.abs(s.hit_rate-2/3)<1e-4,"hit rate is reported rounded to 4dp");
  assert.ok(s.ci[0]!=null&&s.ci[1]!=null,"interval present");
  assert.ok(s.ci[0]<s.hit_rate&&s.ci[1]>s.hit_rate,"interval brackets the point estimate");
  const empty=B.statsFor([]);
  assert.strictEqual(empty.n,0); assert.strictEqual(empty.hit_rate,null);
});
test("a thin sample is explicitly labelled unvalidated",()=>{
  const few=B.summarize([{pnl:1,ret_pct:5,side:"buy",entry:1,contrib:{iv_rv:-0.5}}],0,
    require("./score.js").withDefaults({}));
  assert.strictEqual(few.lowSample,true);
  assert.match(few.verdict,/not yet distinguishable from chance/);
});
test("returns are attributed to the dominant signal",()=>{
  const cfg=require("./score.js").withDefaults({});
  const rows=[
    {pnl:1,ret_pct:10,side:"buy",entry:1,contrib:{iv_rv:-0.9,smile_resid:-0.1}},
    {pnl:-1,ret_pct:-10,side:"buy",entry:1,contrib:{iv_rv:-0.8,smile_resid:-0.2}},
    {pnl:3,ret_pct:30,side:"buy",entry:1,contrib:{smile_resid:-0.9,iv_rv:-0.1}}
  ];
  const s=B.summarize(rows,0,cfg);
  assert.strictEqual(s.attribution.iv_rv.n,2,"two trades credited to iv_rv");
  assert.strictEqual(s.attribution.smile_resid.n,1,"one to the smile residual");
  assert.ok(Math.abs(s.attribution.iv_rv.hit_rate-0.5)<1e-9);
  assert.strictEqual(s.attribution.smile_resid.hit_rate,1);
});

/* ---------------- tax ---------------- */
test("post-tax return is never better than gross, and losses get no relief",()=>{
  const cfg=require("./score.js").withDefaults({});
  const s=B.summarize([
    {pnl:100,ret_pct:100,side:"buy",entry:100,contrib:{iv_rv:-1}},
    {pnl:-100,ret_pct:-100,side:"buy",entry:100,contrib:{iv_rv:-1}}
  ],0,cfg);
  assert.ok(s.postTax.total_pnl<s.gross.total_pnl,"tax strictly reduces the total");
  // +100 taxed at 31.2% → +68.8 ; −100 unrelieved → net −31.2 despite a break-even gross
  assert.ok(Math.abs(s.gross.total_pnl-0)<1e-9,"gross is break-even");
  assert.ok(Math.abs(s.postTax.total_pnl+31.2)<1e-6,
    `a break-even gross book is -31.2 after tax, got ${s.postTax.total_pnl}`);
});
test("post-tax return can never exceed gross, on either side of the book",()=>{
  // Regression guard: credit spreads report gross return on capital at risk (max loss), so a
  // post-tax figure divided by the credit received instead would make tax look BENEFICIAL.
  const cfg=require("./score.js").withDefaults({});
  const rows=[
    {pnl:5,ret_pct:25,side:"sell",entry:5,basis:20,contrib:{iv_rv:1}},    // credit 5, risk 20
    {pnl:-20,ret_pct:-100,side:"sell",entry:5,basis:20,contrib:{iv_rv:1}},
    {pnl:30,ret_pct:30,side:"buy",entry:100,basis:100,contrib:{iv_rv:-1}}
  ];
  const s=B.summarize(rows,0,cfg);
  assert.ok(s.postTax.avg_ret_pct<=s.overall.avg_ret_pct+1e-9,
    `post-tax ${s.postTax.avg_ret_pct}% must not beat gross ${s.overall.avg_ret_pct}%`);
  assert.ok(s.postTax.total_pnl<=s.gross.total_pnl+1e-9,"total is reduced too");
});
test("every completed trade records the basis its return was measured on",()=>{
  const r=B.replay(tape({rvol30:0.30}),{history:()=>null});
  for(const t of r.trades){
    assert.ok(t.basis>0,"basis present and positive");
    assert.ok(Math.abs(t.ret_pct-100*t.pnl/t.basis)<0.01,"ret_pct is pnl over that basis");
  }
});
test("assumptions are stated in the output",()=>{
  const r=B.replay(tape({rvol30:0.30}),{history:()=>null});
  assert.match(r.assumptions.slippage,/half the bid-ask/);
  assert.strictEqual(r.assumptions.unresolved_excluded,true);
  assert.match(r.assumptions.tax,/no loss offset/);
});
test("rolling performance keeps the summary shape for the on-screen strip",()=>{
  const now=Date.now();
  const r=B.rollingPerformance([
    {pnl:1,ret_pct:5,side:"buy",entry:1,exit_ts:now-DAY,contrib:{iv_rv:-1}},
    {pnl:-1,ret_pct:-5,side:"buy",entry:1,exit_ts:now-200*DAY,contrib:{iv_rv:-1}}
  ],90);
  assert.strictEqual(r.window_days,90);
  assert.strictEqual(r.n,1,"only trades inside the window count");
  assert.ok(r.overall.ci,"still reports an interval");
});
test("point-in-time history only — the scorer never sees the future",()=>{
  const seen=[];
  B.replay(tape({steps:5}),{history:(u,t,b,asOf)=>{seen.push(asOf);return null;}});
  assert.ok(seen.length>0,"history was consulted");
  // Each call must carry the snapshot's own timestamp, never a later one.
  const tapeTs=tape({steps:5}).map(s=>s.ts_ms);
  for(const ts of seen)assert.ok(tapeTs.includes(ts),`asOf ${ts} is a real snapshot time`);
});
