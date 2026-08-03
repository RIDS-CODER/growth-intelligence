/* Guardrail + scoring tests. Run: node --test options/*.test.js */
"use strict";
const test=require("node:test");
const assert=require("node:assert");
const S=require("./score.js");
const A=require("./adapters.js");
const V=require("./vol.js");

const DAY=86400000;
/* Build a synthetic but realistic chain: known smile, wide strike ladder, live-ish quotes. */
function chain(opts){
  opts=opts||{};
  const now=opts.now||Date.now();
  const F=opts.F||8500000, dte=opts.dte||7;
  const expiry=now+dte*DAY, T=(expiry-now)/(365*DAY);
  const baseIv=opts.baseIv||0.55;
  const quotes=[];
  // Strike ladder sized to the tenor. A 7-day 55-vol option has a 1σ move of ~7.6%, so a
  // ±20% ladder would sit at 0.06 and 0.89 delta and be correctly thrown out by the
  // 0.15–0.70 filter. Real short-dated chains cluster near the forward.
  const ladder=opts.ladder||[0.92,0.94,0.96,0.98,1.00,1.02,1.04,1.06,1.08];
  for(const mult of ladder){
    const K=Math.round(F*mult), k=Math.log(K/F);
    for(const kind of ["call","put"]){
      let iv=baseIv+0.35*k*k-0.05*k;                     // smile with slight skew
      if(opts.bump&&opts.bump.strike===K&&opts.bump.kind===kind)iv+=opts.bump.dv;
      const mark=V.black76(kind,F,K,T,iv,1);
      const sp=(opts.spreadPct==null?3:opts.spreadPct)/100*mark;
      quotes.push({id:`BTC-${dte}D-${K}-${kind==="call"?"C":"P"}`,kind,strike:K,expiry_ms:expiry,
        bid:mark-sp/2,ask:mark+sp/2,mark,oi:opts.oi==null?500:opts.oi,vol24h:100,
        iv:opts.publishIv===false?null:iv});
    }
  }
  return A.buildSnapshot({venue:"coindcx",underlying:"BTC",ts_ms:now,spot:F,quote_ccy:"INR",
    forwards:[{expiry_ms:expiry,F}],rvol30:opts.rvol30===undefined?0.55:opts.rvol30,
    funding_rate:opts.funding||0,basis_bps:opts.basis||0,quotes});
}
const noHistory=()=>null;

/* ---------------- adapter normalization ---------------- */
test("adapter solves IV when the venue does not publish it",()=>{
  const snap=chain({publishIv:false});
  assert.ok(snap.quotes.length>0,"quotes normalized");
  assert.ok(snap.quotes.every(q=>q.iv>0),"all have IV");
  assert.ok(snap.quotes.every(q=>q.iv_src==="computed"),"marked as computed");
});
test("adapter rejects malformed rows instead of emitting undefined",()=>{
  const snap=A.buildSnapshot({venue:"coindcx",underlying:"BTC",ts_ms:Date.now(),spot:100,
    forwards:[{expiry_ms:Date.now()+7*DAY,F:100}],
    quotes:[{id:"ok",kind:"call",strike:100,expiry_ms:Date.now()+7*DAY,bid:4,ask:5},
            {id:"nostrike",kind:"call",expiry_ms:Date.now()+7*DAY,bid:1,ask:2},
            {id:"expired",kind:"call",strike:100,expiry_ms:Date.now()-DAY,bid:1,ask:2},
            {id:"nomark",kind:"call",strike:100,expiry_ms:Date.now()+7*DAY}]});
  assert.strictEqual(snap.quotes.length,1,"only the good row survives");
  assert.strictEqual(snap.rejects.length,3,"three rejects recorded");
  assert.ok(snap.rejects.every(r=>r.reason&&r.id),"each reject names the row and the reason");
});
test("Deribit instrument names parse to the right contract",()=>{
  const p=A.parseDeribitName("BTC-26DEC25-90000-C");
  assert.strictEqual(p.underlying,"BTC"); assert.strictEqual(p.strike,90000);
  assert.strictEqual(p.kind,"call");
  assert.strictEqual(new Date(p.expiry_ms).toISOString(),"2025-12-26T08:00:00.000Z");
  assert.strictEqual(A.parseDeribitName("garbage"),null);
});

/* ---------------- hard filters ---------------- */
test("each hard filter rejects with the measured value and the limit",()=>{
  const f=S.DEFAULTS.filters, now=Date.now();
  const base={expiry_ms:now+7*DAY,spread_pct:2,oi:500,greeks:{delta:0.4},bid:1,ask:1.04,mark:1};
  assert.strictEqual(S.applyFilters(base,f,now),null,"clean contract passes");
  const near=S.applyFilters({...base,expiry_ms:now+3600000},f,now);
  assert.match(near.reason,/expiry/); assert.strictEqual(near.detail.limit,f.minHoursToExpiry);
  const wide=S.applyFilters({...base,spread_pct:11.2},f,now);
  assert.match(wide.reason,/spread/); assert.strictEqual(wide.detail.spread_pct,11.2);
  const thin=S.applyFilters({...base,oi:3},f,now);
  assert.match(thin.reason,/open interest/); assert.strictEqual(thin.detail.oi,3);
  for(const d of [0.05,0.95]){
    const bad=S.applyFilters({...base,greeks:{delta:d}},f,now);
    assert.match(bad.reason,/delta/,`delta ${d} rejected`);
  }
  assert.match(S.applyFilters({...base,spread_pct:null},f,now).reason,/two-sided/);
});
test("filtered-out contracts are answerable by the why-isn't-X lookup",()=>{
  const r=S.scoreSnapshot(chain({spreadPct:30}),{history:noHistory},{});
  assert.strictEqual(r.counts.passed,0,"all rejected on spread");
  assert.ok(r.rejections.length>0);
  const one=r.rejections.find(x=>x.stage==="filter");
  assert.match(one.reason,/spread/); assert.ok(one.detail.limit===8);
});

/* ---------------- GUARDRAIL: never a naked short ---------------- */
test("every surfaced SELL is a defined-risk vertical with a capped max loss",()=>{
  const r=S.scoreSnapshot(chain({rvol30:0.20}),{history:noHistory},{}); // IV >> RV → sell side
  assert.ok(r.sells.length>0,"produced sell signals");
  for(const s of r.sells){
    assert.ok(s.structure,`${s.id} carries a spread structure`);
    assert.ok(s.structure.long_leg&&s.structure.short_leg,"two legs");
    assert.ok(s.structure.max_loss_inr>0,"max loss is finite and positive");
    assert.ok(s.econ.max_loss_inr>0&&isFinite(s.econ.max_loss_inr),"capped max loss in econ");
  }
});
test("a SELL with no liquid protective wing is suppressed, not downgraded",()=>{
  // Only two strikes exist, so the outermost short has nothing further OTM to buy.
  const now=Date.now(),F=100,expiry=now+7*DAY,T=7/365;
  const mk=(K,kind)=>{const iv=0.9,mark=V.black76(kind,F,K,T,iv,1);
    return {id:`X-${K}-${kind}`,kind,strike:K,expiry_ms:expiry,bid:mark*0.99,ask:mark*1.01,mark,oi:900,iv};};
  const snap=A.buildSnapshot({venue:"coindcx",underlying:"BTC",ts_ms:now,spot:F,
    forwards:[{expiry_ms:expiry,F}],rvol30:0.10,   // very rich vs RV → strong sell
    quotes:[mk(95,"call"),mk(105,"call"),mk(95,"put"),mk(105,"put")]});
  const r=S.scoreSnapshot(snap,{history:noHistory},{});
  for(const s of r.sells)assert.ok(s.structure,"anything surfaced has a structure");
  const suppressed=r.rejections.filter(x=>x.stage==="structure");
  assert.ok(suppressed.length>0,"the unhedgeable short was suppressed");
  assert.match(suppressed[0].reason,/naked short is never surfaced/);
});

/* ---------------- GUARDRAIL: why_not is never blank ---------------- */
test("every signal carries a non-empty WHY and WHY NOT",()=>{
  for(const opts of [{rvol30:0.20},{rvol30:0.95},{},{publishIv:false},{oi:60}]){
    const r=S.scoreSnapshot(chain(opts),{history:noHistory},{});
    for(const s of [...r.buys,...r.sells]){
      assert.ok(s.why&&s.why.trim().length>10,`why present for ${s.id}`);
      assert.ok(s.why_not&&s.why_not.trim().length>10,`why_not present for ${s.id}`);
      assert.notStrictEqual(s.why,s.why_not,"they say different things");
    }
  }
});
test("why_not still speaks when every signal agrees",()=>{
  // No opposing contribution exists → must fall back to a quality/structural caveat.
  const txt=S.buildWhyNot("buy",{iv_rv:-0.5,smile_resid:-0.4},{oi:500},
    {backfilled:true,iv_src:"venue",spread_pct:1},null);
  assert.match(txt,/backfill/i,"falls back to the data-quality caveat");
  const txt2=S.buildWhyNot("buy",{iv_rv:-0.5},{oi:500},
    {backfilled:false,degraded_fit:false,iv_src:"computed",spread_pct:1},null);
  assert.match(txt2,/solved from the mark/i);
});
test("WHY names the dominant contribution, not an arbitrary signal",()=>{
  const why=S.buildWhy("buy",{iv_rv:-0.1,smile_resid:-0.9,term_slope:0.2});
  assert.match(why,/vol curve/,"smile residual dominates and is named");
  const why2=S.buildWhy("sell",{iv_rv:0.8,smile_resid:0.1});
  assert.match(why2,/realized vol/,"iv-rv dominates on the sell side");
});

/* ---------------- signal behaviour ---------------- */
test("a cheap strike is ranked BUY and a rich one SELL",()=>{
  // 0.32-delta strike: enough headroom that a 12-vol-point bump in either direction keeps
  // the contract inside the 0.15–0.70 delta band rather than being filtered out by it.
  const F=8500000, K=Math.round(F*1.04);
  const cheap=S.scoreSnapshot(chain({bump:{strike:K,kind:"call",dv:-0.12}}),{history:noHistory},{});
  const c=cheap.all.find(s=>s.strike===K&&s.kind==="call");
  assert.ok(c,"contract scored"); assert.strictEqual(c.side,"buy");
  assert.ok(c.z.smile_resid<-1.5,`flagged by the smile residual, z=${c.z.smile_resid}`);
  const rich=S.scoreSnapshot(chain({bump:{strike:K,kind:"call",dv:+0.12}}),{history:noHistory},{});
  const rr=rich.all.find(s=>s.strike===K&&s.kind==="call");
  assert.strictEqual(rr.side,"sell");
  assert.ok(rr.z.smile_resid>1.5);
});
test("IV vs realized vol drives the side when the smile is flat",()=>{
  const rich=S.scoreSnapshot(chain({rvol30:0.20}),{history:noHistory},{});
  assert.ok(rich.all.every(s=>s.z.iv_rv>0),"IV above RV reads rich everywhere");
  const cheap=S.scoreSnapshot(chain({rvol30:0.95}),{history:noHistory},{});
  assert.ok(cheap.all.every(s=>s.z.iv_rv<0),"IV below RV reads cheap everywhere");
});
test("signals abstain rather than guess when data is missing",()=>{
  const r=S.scoreSnapshot(chain({rvol30:null}),{history:noHistory},{});
  const s=r.all[0];
  assert.strictEqual(s.z.iv_rv,null,"no realized vol → signal abstains");
  assert.strictEqual(s.z.iv_pctile,null,"no history → abstains");
  assert.strictEqual(s.z.funding_tilt,null,"funding tilt off by default");
  assert.ok(s.quality.signals_used>0,"but something still scored it");
  assert.ok(!('iv_rv' in s.contrib),"an abstaining signal contributes nothing");
});
test("funding tilt stays off unless explicitly enabled",()=>{
  const off=S.scoreSnapshot(chain({funding:0.001}),{history:noHistory},{});
  assert.strictEqual(off.all[0].z.funding_tilt,null);
  const on=S.scoreSnapshot(chain({funding:0.001}),{history:noHistory},
    {fundingTiltEnabled:true,weights:{funding_tilt:0.2}});
  assert.ok(on.all[0].z.funding_tilt!==null,"enabled → speaks");
});
test("weights are honoured from config, not hardcoded",()=>{
  const snap=chain({bump:{strike:Math.round(8500000*1.04),kind:"call",dv:-0.12}});
  const only=S.scoreSnapshot(snap,{history:noHistory},
    {weights:{iv_rv:0,iv_pctile:0,smile_resid:1,term_slope:0,theta_eff:0,funding_tilt:0}});
  const s=only.all.find(x=>x.kind==="call"&&x.strike===Math.round(8500000*1.04));
  assert.deepStrictEqual(Object.keys(s.contrib),["smile_resid"],"only the weighted signal contributes");
});
test("IV percentile uses bucket history and flags backfilled baselines",()=>{
  const hist=()=>({iv:Array.from({length:60},(_,i)=>0.40+i*0.002),backfilled:true,n:60,nativeN:0});
  const r=S.scoreSnapshot(chain(),{history:hist},{});
  const s=r.all[0];
  assert.ok(s.z.iv_pctile!==null,"percentile computed");
  assert.strictEqual(s.quality.backfilled,true,"flagged as scored on backfilled data");
  const thin=S.scoreSnapshot(chain(),{history:()=>({iv:[0.5,0.51],backfilled:false,n:2,nativeN:2})},{});
  assert.strictEqual(thin.all[0].z.iv_pctile,null,"too little history → abstains");
});

/* ---------------- economics + tax ---------------- */
test("economics are coherent and expressed in INR",()=>{
  const r=S.scoreSnapshot(chain(),{history:noHistory,contractSize:0.01,toInr:v=>v},{});
  for(const s of [...r.buys,...r.sells]){
    assert.ok(s.econ.premium_inr>0,"premium positive");
    assert.ok(s.econ.max_loss_inr>0,"max loss positive and finite");
    assert.ok(s.econ.theta_day_inr<=0,"theta is a cost");
    assert.ok(s.econ.req_move_pct>=0,"required move defined");
    assert.ok(s.econ.dte_days>0,"days to expiry positive");
    if(s.side==="buy")assert.ok(Math.abs(s.econ.max_loss_inr-s.econ.premium_inr)<1e-6,
      "a long option's max loss IS the premium");
  }
});
test("VDA tax drag applies to gains only — losses get no offset",()=>{
  const tax={gainsRatePct:30,cessPct:4,tdsPct:0,applyTds:false};
  assert.ok(Math.abs(S.taxDrag(1000,tax)-312)<1e-9,"30% + 4% cess = 31.2%");
  assert.strictEqual(S.taxDrag(-1000,tax),0,"a loss produces no negative tax — it is simply not offsettable");
  assert.strictEqual(S.taxDrag(0,tax),0);
});
test("the tax note travels with every card",()=>{
  const r=S.scoreSnapshot(chain(),{history:noHistory},{});
  for(const s of [...r.buys,...r.sells]){
    assert.ok(s.econ.tax_note&&/losses not offsettable/.test(s.econ.tax_note));
    assert.ok(s.econ.tax_drag_inr>=0);
  }
});

/* ---------------- ranking + accountability ---------------- */
test("top 3 per side, ranked by score",()=>{
  const r=S.scoreSnapshot(chain(),{history:noHistory},{});
  assert.ok(r.buys.length<=3&&r.sells.length<=3,"top 3 each way");
  for(const list of [r.buys,r.sells])
    for(let i=1;i<list.length;i++)
      assert.ok(list[i-1].score_10>=list[i].score_10,"descending by score");
});
test("scored-but-not-surfaced contracts still get an explanation",()=>{
  const r=S.scoreSnapshot(chain(),{history:noHistory},{});
  const ranked=r.rejections.filter(x=>x.stage==="rank");
  if(r.all.length>r.buys.length+r.sells.length)
    assert.ok(ranked.length>0,"rank-stage rejections recorded");
  for(const x of ranked)assert.match(x.reason,/outside the top/);
});
test("bucket points sample the fitted curve at fixed deltas",()=>{
  const snap=chain();
  const r=S.scoreSnapshot(snap,{history:noHistory},{});
  const fits={}; r.fits.forEach(f=>{});
  // rebuild fits map the way the service does
  const byExp={}; snap.quotes.forEach(q=>{(byExp[q.expiry_ms]=byExp[q.expiry_ms]||[]).push(q);});
  const fitMap={};
  for(const [e,qs] of Object.entries(byExp)){
    const f=V.fitSmile(qs.map(q=>({k:q.k,iv:q.iv,vega:q.greeks.vega,spread:q.spread})),qs[0].T);
    f.expiry_ms=+e; f.T=qs[0].T; fitMap[e]=f;
  }
  const pts=S.bucketPoints(snap,fitMap,{});
  assert.ok(pts.length>0,"produced bucket points");
  assert.ok(pts.every(p=>p.iv>0&&p.tenor&&p.delta_bucket),"well formed");
  assert.ok(pts.some(p=>p.delta_bucket==="atm"),"includes ATM");
  assert.ok(pts.every(p=>p.src==="coindcx"),"source recorded for the backfill badge");
});
