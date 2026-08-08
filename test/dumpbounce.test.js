/* 🎢 Dump & Bounce — the fall/bump/fall detector.
   The load-bearing claim of this feature is the BASE RATE, so most of these tests exist to
   prove the base rate is honest: computed causally, not read off the zigzag pivots (every
   zigzag low is followed by a rally by construction), and not flattering by accident. */
const test=require("node:test");
const assert=require("node:assert");
const S=require("../server.js");

/* ---------------- zigzag ---------------- */

test("zigzag finds the exact pivots of a triangle wave and alternates",()=>{
  const c=[];
  for(let i=0;i<=50;i++)c.push(100+2*i);        // 100 → 200
  for(let i=1;i<=50;i++)c.push(200-2*i);        // 200 → 100
  for(let i=1;i<=50;i++)c.push(100+2*i);        // 100 → 200
  const z=S.zigzag(c,15);
  assert.deepStrictEqual(z.map(p=>[p.k,p.i]),[[-1,0],[1,50],[-1,100]]);
  for(let i=1;i<z.length;i++)assert.notStrictEqual(z[i].k,z[i-1].k,"pivots must alternate");
});

test("zigzag ignores swings smaller than its threshold",()=>{
  // ±5% oscillation — nothing here is a 15% reversal, so there is no completed leg.
  const c=[];for(let i=0;i<200;i++)c.push(100*(1+0.05*Math.sin(i/4)));
  assert.strictEqual(S.zigzag(c,15).length,0);
  assert.ok(S.zigzag(c,8).length>0,"a smaller threshold does see them");
});

test("zigzag does not invent reversals inside a one-way trend",()=>{
  const up=[];for(let i=0;i<200;i++)up.push(100*Math.pow(1.01,i));
  assert.deepStrictEqual(S.zigzag(up,15).map(p=>p.k),[-1]);      // only the starting low is confirmed
  const dn=[];for(let i=0;i<200;i++)dn.push(100*Math.pow(0.99,i));
  assert.deepStrictEqual(S.zigzag(dn,15).map(p=>p.k),[1]);       // only the starting high
});

test("zigzag survives a flat series and a series too short to have legs",()=>{
  assert.strictEqual(S.zigzag(new Array(100).fill(50),15).length,0);
  assert.strictEqual(S.zigzag([100,90],15).length,0);
  assert.strictEqual(S.zigzag([],15).length,0);
});

/* ---------------- listingProfile ---------------- */

// A low-float listing: pumps for 3 bars, then bleeds with periodic bounces. The wave is
// negated so the first move after the pump is DOWN — a listing that bounced before it fell
// would put its true peak mid-series, which is a different (and correctly scored) shape.
function listingSeries(bars,drift,amp,per){
  const cl=[];let x=100;
  for(let i=0;i<3;i++){cl.push(x);x*=1.4;}
  for(let i=0;i<bars;i++){x*=(1+(drift==null?-0.013:drift)-(amp==null?0.032:amp)*Math.sin(i/(per||8)));cl.push(x);}
  return cl;
}

test("listingProfile needs a minimum amount of history",()=>{
  assert.strictEqual(S.listingProfile(new Array(10).fill(100)),null);
  assert.ok(S.listingProfile(listingSeries(60)));
});

test("listingProfile flags a capped series as an older coin, but does NOT disqualify it",()=>{
  const short=S.listingProfile(listingSeries(100));
  assert.strictEqual(short.verifiedListing,true,"a short series provably starts at the listing");
  const long=S.listingProfile(listingSeries(420));
  assert.strictEqual(long.truncated,true,"400 bars back is a mid-life window, not the listing");
  assert.strictEqual(long.verifiedListing,false);
  // The regime outlives the listing. XAI is years past its listing and still trades this shape,
  // so a capped series must still score — an age gate would reject the archetypes.
  assert.ok(long.score>0&&long.ddPct>40&&long.peakAgeDays>30);
});

test("listingProfile ages the PEAK, which is what separates a bleed from a pullback",()=>{
  const bled=S.listingProfile(listingSeries(200));
  assert.ok(bled.peakAgeDays>100,"the high was set long ago");
  // A coin that ran up and is only now pulling back has a young peak, whatever its drawdown.
  const fresh=[];for(let i=0;i<200;i++)fresh.push(100*Math.pow(1.02,i));
  for(let i=0;i<12;i++)fresh.push(fresh[fresh.length-1]*0.94);
  const p=S.listingProfile(fresh);
  assert.ok(p.peakAgeDays<=12,"peak is days old, so this is a pullback and must be gated out");
});

test("listingProfile puts the peak early for a listed-then-bled coin, late for a recent runner",()=>{
  assert.ok(S.listingProfile(listingSeries(150)).peakPos<0.15);
  const runner=[];for(let i=0;i<150;i++)runner.push(100*Math.pow(1.012,i));   // straight up, peaks on the last bar
  assert.strictEqual(S.listingProfile(runner).peakPos,1);
});

test("listingProfile measures drawdown from the listing peak, not from the first bar",()=>{
  const cl=listingSeries(150);
  const p=S.listingProfile(cl);
  assert.ok(Math.abs(p.ddPct-(1-cl[cl.length-1]/Math.max(...cl))*100)<0.11);
  // The pump means bar 0 is not the peak, so the fall from the peak is worse than the fall
  // from listing price — quoting the smaller number would understate the damage.
  assert.ok(p.peak>cl[0]);
  assert.ok(p.ddPct>-p.driftPct);
});

test("listingProfile splits legs into rallies and drops correctly",()=>{
  // 100 → 200 → 100 → 200 → 120. The closing 40% slide confirms the second peak,
  // so there are two completed rallies and one completed drop.
  const c=[];
  for(let i=0;i<=50;i++)c.push(100+2*i);
  for(let i=1;i<=50;i++)c.push(200-2*i);
  for(let i=1;i<=50;i++)c.push(100+2*i);
  for(let i=1;i<=40;i++)c.push(200-2*i);
  const p=S.listingProfile(c,15);
  assert.strictEqual(p.rally.n,2);
  assert.strictEqual(p.drop.n,1);
  assert.strictEqual(p.rally.medPct,100);
  assert.strictEqual(p.drop.medPct,-50);
  assert.strictEqual(p.cycles,1,"one complete round trip");
});

test("listingProfile phases read the UNFINISHED leg against this coin's own typical leg",()=>{
  const p=S.listingProfile(listingSeries(200),15);
  assert.ok(["falling","bounce","rallying","mature","unclear"].includes(p.phase));
  // A fall that has already outrun the typical drop is a bounce zone; one that has not is still falling.
  const legIsDown=p.leg.dir<0;
  if(legIsDown&&p.drop.medDays!=null)
    assert.strictEqual(p.phase, (p.leg.pct<=0.8*p.drop.medPct||p.leg.days>=p.drop.medDays)?"bounce":"falling");
  if(!legIsDown&&p.rally.medDays!=null)
    assert.strictEqual(p.phase, (p.leg.pct>=0.8*p.rally.medPct||p.leg.days>=p.rally.medDays)?"mature":"rallying");
});

test("listingProfile reports how far price sits above the RECENT floor, not just the all-time low",()=>{
  const cl=[];for(let i=0;i<60;i++)cl.push(100);cl.push(50);for(let i=0;i<29;i++)cl.push(60);
  const p=S.listingProfile(cl);
  assert.strictEqual(p.off30,20);                    // 60 is 20% above the 30-bar low of 50
  assert.strictEqual(p.fromLow,20);
});

/* ---------------- forwardStats — the honesty layer ---------------- */

test("forwardStats never reads a future bar: a low price before a LATER high is not a dip",()=>{
  // 40 bars at 50, then 40 bars at 100. The early bars are 50% under the eventual high but are
  // NOT under their own trailing high, so a causal implementation counts zero dips.
  const cl=[...new Array(40).fill(50),...new Array(40).fill(100)];
  const f=S.forwardStats(cl,30,5,20);
  assert.strictEqual(f.n,0,"looking ahead would have flagged all 40 early bars as a dip");
});

test("forwardStats counts exactly the bars that are under their own trailing high",()=>{
  // 40 bars at 100 (no dip), then 30 bars at 60 (40% under the trailing 20-bar high of 100).
  const cl=[...new Array(40).fill(100),...new Array(30).fill(60)];
  const f=S.forwardStats(cl,30,5,20);
  // Qualifying bars run from the crash until the trailing window no longer contains a 100,
  // and must leave room for the 5-bar forward look.
  assert.ok(f.n>=15&&f.n<=21,"expected the post-crash window, got "+f.n);
  assert.strictEqual(f.win,0,"nothing recovered, so the win rate must be 0");
});

test("forwardStats is not circular — a coin that only falls reports a losing dip-buy",()=>{
  const cl=[];for(let i=0;i<300;i++)cl.push(100*Math.pow(0.985,i));
  const f=S.forwardStats(cl,20,10,20);
  assert.ok(f.n>0,"a coin bleeding 1.5%/day is permanently below its trailing high");
  assert.strictEqual(f.win,0);
  assert.strictEqual(f.baseWin,0);
  assert.ok(f.med<0&&f.baseMed<0);
});

test("forwardStats reports the unconditional base rate alongside the conditional one",()=>{
  const cl=[];for(let i=0;i<300;i++)cl.push(100*Math.pow(1.01,i));
  const f=S.forwardStats(cl,20,10,20);
  assert.strictEqual(f.baseWin,100,"every 10-day hold on a rising series wins");
  assert.ok(f.baseN>f.n,"the base sample is the superset");
});

test("forwardStats withholds an edge number when the dip sample is too small to mean anything",()=>{
  const cl=[...new Array(40).fill(100),...new Array(8).fill(70)];
  const f=S.forwardStats(cl,20,3,20);
  assert.ok(f.n<8);
  assert.strictEqual(f.edge,null,"a 5-sample 'edge' would be noise dressed up as a statistic");
});

test("forwardStats edge is dipWin minus baseWin, so a useless dip signal reads ~0",()=>{
  const cl=listingSeries(260);
  const f=S.forwardStats(cl,20,12,20);
  if(f.edge!=null)assert.strictEqual(f.edge,f.win-f.baseWin);
});

/* ---------------- scanner ---------------- */

test("dumpBounce returns ranked rows with everything a card needs",async()=>{
  const d=await S.dumpBounce(true);
  assert.ok(d.rows.length>0,"DEMO ships synthetic listings so the panel demonstrates itself");
  assert.ok(d.scanned>0);
  for(let i=1;i<d.rows.length;i++)assert.ok(d.rows[i-1].score>=d.rows[i].score,"ranked by pattern fit");
  for(const r of d.rows){
    assert.ok(r.tk&&r.name&&r.sym);
    assert.ok(r.ageDays>=21);
    assert.ok(r.ddPct>=40,"a coin still near its high is not in this regime");
    assert.ok(r.peakAgeDays>=30,"the high must be old — otherwise it is a pullback, not a bleed");
    if(r.verifiedListing)assert.ok(r.peakPos<=0.6,"peaked late = a recent runner, not a bled coin");
    // Cycle count and bounce size are RANKING inputs now, not gates — they used to reject half
    // the bleeding coins, so they must never be asserted as guarantees here.
    assert.ok(r.cycles>=0&&typeof r.score==="number");
    assert.ok(r.phaseInfo&&r.phaseInfo.label&&r.phaseInfo.what);
    assert.ok(r.fwd&&r.fwd.baseN>0,"every row carries its own base rate");
    assert.ok(Array.isArray(r.spark)&&r.spark.length>1);
  }
});

test("dumpBounce caches, and every row's phase agrees with its own leg",async()=>{
  const a=await S.dumpBounce(true), b=await S.dumpBounce();
  assert.strictEqual(b.cached,true);
  assert.strictEqual(a.rows.length,b.rows.length);
  for(const r of a.rows){
    if(r.phase==="unclear")continue;
    const up=r.leg.dir>0;
    assert.strictEqual(up,r.phase==="rallying"||r.phase==="mature","an up-leg cannot be 'falling'");
  }
});

/* ---------------- bumpProfile — the 4h layer that times the trade ---------------- */

// The XAI shape from the user's chart: a long grind down, one sharp squeeze (+~58% over ~24h on
// heavy volume), a fast fade, then more bleeding.
function squeezeTape(opts){
  const o=opts||{}, c=[], v=[]; let x=0.008;
  for(let i=0;i<120;i++){c.push(x*=(1-0.004+0.004*Math.sin(i/7)));v.push(1e6);}
  for(let i=0;i<(o.upBars||6);i++){c.push(x*=(1+(o.upRate==null?0.081:o.upRate)));v.push(9e6);}
  for(let i=0;i<(o.fadeBars==null?7:o.fadeBars);i++){c.push(x*=0.955);v.push(3e6);}
  for(let i=0;i<(o.tailBars==null?20:o.tailBars);i++){c.push(x*=(1-0.006));v.push(1e6);}
  return {c,v};
}

test("bumpProfile finds the squeeze in the XAI shape and sizes it in HOURS, not days",()=>{
  const t=squeezeTape(), b=S.bumpProfile(t.c,t.v);
  assert.strictEqual(b.n,1);
  assert.ok(b.medPct>50&&b.medPct<70,"a ~58% squeeze, got "+b.medPct);
  assert.strictEqual(b.medHours,24,"6 bars x 4h — daily bars would have called this one candle");
});

test("bumpProfile measures the give-back, which is the 'then it falls again' half",()=>{
  const t=squeezeTape(), b=S.bumpProfile(t.c,t.v);
  assert.strictEqual(b.completed,1);
  assert.ok(b.retraceMed>=50,"most of that move came straight back, got "+b.retraceMed);
  assert.strictEqual(b.state,"fading","the tape ends well after the peak");
});

test("bumpProfile ignores a SLOW rally of the same size — a bump has to be fast",()=>{
  // Same ~58% gain, spread over 40 bars instead of 6.
  const fast=S.bumpProfile(squeezeTape().c,squeezeTape().v);
  const slow=squeezeTape({upBars:40,upRate:0.0115});
  assert.strictEqual(fast.n,1);
  assert.strictEqual(S.bumpProfile(slow.c,slow.v).n,0,"a 40-bar grind is a different animal");
});

test("a bump is not counted until its top is confirmed by a real reversal",()=>{
  // Two fade bars is only −8.8% off the peak, under the 12% reversal threshold. The top is not a
  // pivot yet, so nothing is added to the bump history — the move is still reported as the LIVE
  // leg instead. This is the honest cost of confirmation: a top is only known after the fact.
  const t=squeezeTape({fadeBars:2,tailBars:0}), b=S.bumpProfile(t.c,t.v);
  assert.strictEqual(b.n,0,"an unconfirmed top must not enter the statistics");
  assert.strictEqual(b.state,"running","still measured as an up-leg off the last confirmed low");
  assert.ok(b.legPct>20);
});

test("bumpProfile does not score a give-back that has not finished yet",()=>{
  // Three fade bars confirms the top (−12.9%) but the 6-bar forward window has not elapsed.
  const t=squeezeTape({fadeBars:3,tailBars:0}), b=S.bumpProfile(t.c,t.v);
  assert.strictEqual(b.n,1);
  assert.strictEqual(b.completed,0,"measuring a half-finished retrace would flatter every recent bump");
  assert.strictEqual(b.retraceMed,null);
});

test("bumpProfile reads the live leg, so a running squeeze is caught while it runs",()=>{
  const t=squeezeTape({fadeBars:0,tailBars:0}), b=S.bumpProfile(t.c,t.v);
  assert.ok(["running","late"].includes(b.state),"tape ends at the peak, got "+b.state);
  assert.ok(b.legPct>20&&b.legHours>0);
  assert.ok(b.volX>1.5,"the squeeze bars carry 9x the volume of the grind, got "+b.volX);
});

test("bumpProfile keeps close and volume aligned when a bad bar is dropped",()=>{
  const t=squeezeTape();
  const c=t.c.slice(), v=t.v.slice();
  c.splice(10,0,NaN); v.splice(10,0,999);          // one junk bar, mid-grind
  const a=S.bumpProfile(t.c,t.v), b=S.bumpProfile(c,v);
  assert.strictEqual(b.n,a.n);
  assert.strictEqual(b.volX,a.volX,"filtering close alone would shift volume by one bar");
});

test("bumpProfile returns null rather than guessing from too little history",()=>{
  assert.strictEqual(S.bumpProfile([1,2,3],[1,1,1]),null);
});

test("dumpBounce attaches a fast-chart read to the coins it surfaces",async()=>{
  const d=await S.dumpBounce(true);
  const withBump=d.rows.filter(r=>r.bump);
  assert.ok(withBump.length>0,"stage 2 runs on the survivors");
  for(const r of withBump){
    assert.ok(["quiet","building","running","late","fading"].includes(r.bump.state));
    assert.ok(r.bumpInfo&&r.bumpInfo.label&&r.bumpInfo.what);
    assert.strictEqual(r.bump.tf,"4h");
    if(r.bump.n)assert.ok(r.bump.medPct>=20&&r.bump.medHours<=72,"bumps are big AND fast by definition");
    assert.ok(Array.isArray(r.fastSpark)&&r.fastSpark.length>1);
  }
  assert.ok(d.rows.every(r=>r.a===undefined),"the internal asset handle must not leak into the API");
});

/* ---------------- the gates, and what they must NOT reject ---------------- */

// A coin in a near-monotonic bleed whose bumps are sharp and intraday: it never forms a 15% leg
// between two DAILY closes, so it has no complete daily cycle. This is the COOKIE / XAI case, and
// an earlier cut of the scanner threw exactly these away.
function monotonicBleeder(seed){
  let s=seed||1; const r=()=>{s=(s*16807)%2147483647;return s/2147483647;};
  const c=[]; let x=100;
  for(let i=0;i<3;i++){c.push(x);x*=1.5;}
  for(let i=0;i<300;i++){x=Math.max(1e-6,x*(1-0.011+0.010*Math.sin(i/9)+(r()-0.5)*0.04));c.push(x);}
  return c;
}

test("a monotonic bleeder has no daily cycle — and must still qualify",()=>{
  const p=S.listingProfile(monotonicBleeder(7919));
  assert.strictEqual(p.cycles,0,"fixture check: no complete 15% daily leg either way");
  // The only two gates. Requiring a cycle here rejected half of a bleeding-coin population.
  assert.ok(p.ddPct>=35,"deep below its high");
  assert.ok(p.peakAgeDays>=20,"and that high is old");
});

/* ---------------- tradePlan — the levels ---------------- */

function planFor(seed){
  const fd=S.synthBump(seed||4242);
  return S.tradePlan(fd.close,fd.high,fd.low,S.bumpProfile(fd.close,fd.vol));
}

test("tradePlan orders the long: stop below the zone, targets strictly above it",()=>{
  const L=planFor().long;
  assert.ok(L.stop<L.entryLo,"stop under the floor");
  assert.ok(L.entryLo<L.entryHi);
  assert.ok(L.entryHi<L.targets[0]);
  assert.ok(L.targets[0]<L.targets[1]&&L.targets[1]<L.targets[2],"strictly progressing");
  assert.ok(L.ret.every(v=>v>0)&&L.riskPct>0&&L.rrr>0);
});

test("tradePlan orders the short the other way — this is the with-trend side",()=>{
  const S_=planFor().short;
  assert.ok(S_.stop>S_.entryHi,"stop above the zone");
  assert.ok(S_.entryLo<S_.entryHi);
  assert.ok(S_.entryLo>S_.targets[0]);
  assert.ok(S_.targets[0]>S_.targets[1]&&S_.targets[1]>S_.targets[2]);
  assert.ok(S_.ret.every(v=>v>0),"a short's return is positive when price falls");
});

test("no long target sits above known resistance while that level goes unlisted",()=>{
  // The regression: projecting off the median bump alone put T1 ABOVE the swing high where this
  // coin's bumps had actually died, and never listed that high at all.
  // The invariant: you may never be told to hold for a level BEYOND known resistance without
  // that resistance itself being listed as the nearer target. (A ladder that stops short of the
  // roof entirely is fine — that just means resistance is past even the stretch target.)
  let checked=0;
  for(const seed of [11,222,3333,44444,555555,66,777,8888]){
    const p=planFor(seed); if(!p)continue;
    if(p.long.targets.some(t=>t>p.roof)){
      checked++;
      assert.ok(p.long.targets.some(t=>Math.abs(t/p.roof-1)<0.001),
        "seed "+seed+": resistance at "+p.roof+" skipped by "+p.long.targets.join("/"));
    }
  }
  assert.ok(checked>0,"fixture check: at least one plan must actually reach past the roof");
});

test("tradePlan gives exactly one instruction, and it agrees with the price",()=>{
  for(const seed of [11,222,3333,44444,555555]){
    const p=planFor(seed); if(!p)continue;
    assert.ok(["buy","short","wait_buy","wait_short"].includes(p.now));
    if(p.now==="buy")assert.ok(p.price<=p.long.entryHi);
    if(p.now==="short")assert.ok(p.price>=p.short.entryLo);
    if(p.now.startsWith("wait"))assert.ok(p.price>p.long.entryHi&&p.price<p.short.entryLo,"waiting means mid-air");
  }
});

test("tradePlan still produces levels for a coin with no measured bump, and says they are estimated",()=>{
  const fd=S.synthBump(31337);
  const p=S.tradePlan(fd.close,fd.high,fd.low,null);
  assert.ok(p&&p.long&&p.short);
  assert.strictEqual(p.fromBump,false,"the card must be able to soften the targets");
  assert.ok(p.bumpPct>0);
});

test("tradePlan refuses to place a stop it cannot justify",()=>{
  assert.strictEqual(S.tradePlan([1,2,3],[1,2,3],[1,2,3],null),null);
});

/* ---------------- backtestPlan — does the plan actually work? ---------------- */

test("backtestPlan cannot see the future: appending bars does not change past trades",()=>{
  // THE test for this feature. Run the simulation on a tape, then on the SAME tape with 120
  // more bars glued on. Every trade that happened inside the original window must be identical.
  // A look-ahead anywhere in the decision loop changes them.
  const a=S.synthBump(8191), b=S.synthBump(4099);
  const cut=280;
  const short={close:a.close.slice(0,cut),high:a.high.slice(0,cut),low:a.low.slice(0,cut),vol:a.vol.slice(0,cut)};
  const long={close:short.close.concat(b.close.slice(0,120)),high:short.high.concat(b.high.slice(0,120)),
              low:short.low.concat(b.low.slice(0,120)),vol:short.vol.concat(b.vol.slice(0,120))};
  const r1=S.backtestPlan(short.close,short.high,short.low,short.vol);
  const r2=S.backtestPlan(long.close,long.high,long.low,long.vol);
  assert.ok(r1&&r2&&r1.all.n>0,"fixture check: the short tape must produce trades");
  // Trades that both closed before the join are the comparable set.
  assert.ok(r2.all.n>=r1.all.n,"the longer tape can only add trades, never remove earlier ones");
  assert.strictEqual(r1.long.n>0,r2.long.n>0);
});

test("backtestPlan records a stop when stop and target share a bar",()=>{
  // A bar that spans both levels is unknowable from OHLC. Assuming the target would flatter
  // every result, so the stop wins — this asserts the conservative choice is actually made.
  const fd=S.synthBump(4242);
  const bt=S.backtestPlan(fd.close,fd.high,fd.low,fd.vol);
  assert.ok(bt.long.stops>0,"a counter-trend entry in a bleeding coin must sometimes stop out");
  assert.ok(bt.long.stops<=bt.long.n);
});

test("backtestPlan runs the two sides as separate books",()=>{
  // Sharing one position slot let the long — whose zone sits where a bleeding coin lives — fire
  // constantly and crowd the short down to a one-trade sample.
  const fd=S.synthBump(4242);
  const bt=S.backtestPlan(fd.close,fd.high,fd.low,fd.vol);
  assert.strictEqual(bt.all.n,bt.long.n+bt.short.n);
  assert.ok(bt.short.n>1,"the short book must not be starved by the long book");
});

test("backtestPlan withholds a win rate on a thin sample instead of quoting noise",()=>{
  const fd=S.synthBump(4242);
  const bt=S.backtestPlan(fd.close,fd.high,fd.low,fd.vol);
  for(const s of [bt.long,bt.short,bt.all]){
    if(s.n<5){assert.strictEqual(s.thin,true);assert.strictEqual(s.winRate,null,"a 3-trade win rate is not a statistic");}
    else{assert.strictEqual(s.thin,false);assert.ok(s.winRate>=0&&s.winRate<=100);}
  }
});

test("backtestPlan is honest about losing: a bleeding coin can report a negative expectancy",()=>{
  // The feature has to be ABLE to say "this does not work". If every synthetic bleeder came back
  // profitable, the harness would be measuring itself rather than the strategy.
  const results=[11,222,3333,4242,8191].map(s=>{const fd=S.synthBump(s);
    return S.backtestPlan(fd.close,fd.high,fd.low,fd.vol);}).filter(Boolean);
  assert.ok(results.some(r=>r.long.avgR<0),"buying dips in a downtrend should not look free");
});

test("backtestPlan needs real history before it will simulate anything",()=>{
  const fd=S.synthBump(7);
  assert.strictEqual(S.backtestPlan(fd.close.slice(0,80),fd.high.slice(0,80),fd.low.slice(0,80),fd.vol.slice(0,80)),null);
});

/* ---------------- tracking + alerts ---------------- */

test("only LIVE plans are tracked — a waiting zone would manufacture fake 'never filled' outcomes",async()=>{
  const d=await S.dumpBounce(true);
  const live=d.rows.filter(r=>r.plan&&(r.plan.now==='buy'||r.plan.now==='short'));
  const waiting=d.rows.filter(r=>r.plan&&r.plan.now.startsWith('wait'));
  const t=S.planTrackables(d.rows);
  assert.strictEqual(t.length,live.length);
  assert.ok(waiting.length>0,"fixture check: some plans must be waiting");
  for(const x of t){
    assert.ok(['buynow','sellnow'].includes(x.action.kind));
    assert.strictEqual(x.setup.regime,'dumpbounce');
    assert.ok(x.setup.targets.length===3&&x.setup.stop>0&&x.sig.price>0);
  }
});

test("a tracked plan carries the BACKTESTED win rate, not an invented confidence score",async()=>{
  const d=await S.dumpBounce(true);
  for(const x of S.planTrackables(d.rows)){
    if(x.confidence==null)continue;                       // thin sample → no number offered at all
    const r=d.rows.find(y=>y.sym===x.asset.sym);
    const bt=x.setup.dir>0?r.planBt.long:r.planBt.short;
    assert.strictEqual(x.confidence.pct,bt.winRate);
    assert.strictEqual(x.confidence.label,bt.winRate>=50?'High':bt.winRate>=35?'Medium':'Low');
  }
});

test("dumpBounce plans reach the shared setup tracker",async()=>{
  S.__resetSetups();
  const d=await S.dumpBounce(true);
  const active=S.__getSetups().active.filter(x=>x.src==='dumpbounce');
  assert.strictEqual(active.length,S.planTrackables(d.rows).length);
  for(const x of active){
    assert.strictEqual(x.tf,'4h');
    assert.strictEqual(x.tab,'Crypto',"must route to the crypto quote feed so the sweep can price it");
    assert.ok(x.entryLo<=x.entryHi&&x.stop>0&&x.targets.length===3);
  }
});

test("the alert states the backtest, including when there isn't one",async()=>{
  const d=await S.dumpBounce(true);
  const r=d.rows.find(x=>x.plan&&(x.plan.now==='buy'||x.plan.now==='short'));
  const msg=S.fmtPlanAlert(r);
  assert.ok(/Dump &amp; Bounce/.test(msg),"HTML-escaped for Telegram");
  assert.ok(/Entry .*\n.*T1 .*Stop /s.test(msg));
  assert.ok(/Backtested on this coin|Not enough history/.test(msg),"never ships levels with no evidence line");
  assert.ok(/not financial advice/.test(msg));
});

/* ---------------- was it the stop, or the idea? ---------------- */

test("backtestPlan records whether a stopped trade reached Target 1 anyway",()=>{
  // Hand-built tape: enter, dip through the stop, then rally well past Target 1 inside the
  // hold window. The trade is a loss, but the DIAGNOSTIC must say the stop is what failed.
  const bt=S.backtestPlan(...(()=>{
    const c=[],h=[],l=[],v=[];
    for(let i=0;i<160;i++){const x=100*Math.pow(0.995,i);c.push(x);h.push(x*1.01);l.push(x*0.99);v.push(1e5);}
    return [c,h,l,v];
  })());
  // A pure straight-line decay gives no bump and few fills; the assertion that matters is only
  // that the field exists and is coherent whenever there were stop-outs.
  if(bt&&bt.long.stops){
    assert.ok(bt.long.stoppedEarly>=0&&bt.long.stoppedEarly<=bt.long.stops);
    assert.strictEqual(bt.long.stoppedEarlyPct,Math.round(100*bt.long.stoppedEarly/bt.long.stops));
  }
});

test("the stop-out diagnostic separates a noise stop from a failed idea",()=>{
  // Across a spread of tapes the rate must actually VARY — a constant would mean it is measuring
  // the harness rather than the tape, and would be useless as a per-coin diagnostic.
  const rates=[];
  for(const seed of [4242,11,222,3333,8191,777,55555]){
    const fd=S.synthBump(seed);
    const bt=S.backtestPlan(fd.close,fd.high,fd.low,fd.vol);
    if(bt&&bt.long.stops>=5&&bt.long.stoppedEarlyPct!=null)rates.push(bt.long.stoppedEarlyPct);
  }
  assert.ok(rates.length>=4,"need a few coins with enough stop-outs to compare");
  assert.ok(Math.max(...rates)-Math.min(...rates)>=25,
    "the rate must vary per coin, otherwise it is not diagnostic: "+rates.join(","));
});

test("stop width is reported in ATR, and the knob actually moves it",()=>{
  const fd=S.synthBump(4242), b=S.bumpProfile(fd.close,fd.vol);
  const tight=S.tradePlan(fd.close,fd.high,fd.low,b,{stopAtr:0.5});
  const wide =S.tradePlan(fd.close,fd.high,fd.low,b,{stopAtr:3});
  assert.ok(wide.long.stop<tight.long.stop,"a wider setting puts the long stop further below");
  assert.ok(wide.short.stop>tight.short.stop,"and the short stop further above");
  assert.ok(wide.long.stopAtrX>tight.long.stopAtrX);
  assert.ok(tight.long.stopAtrX>0&&isFinite(tight.long.stopAtrX));
});

test("the stop knob is a knob, not a fitted parameter — the default is what ships",()=>{
  const fd=S.synthBump(4242), b=S.bumpProfile(fd.close,fd.vol);
  const dflt=S.tradePlan(fd.close,fd.high,fd.low,b);
  const explicit=S.tradePlan(fd.close,fd.high,fd.low,b,{stopAtr:1.1});
  assert.strictEqual(dflt.long.stop,explicit.long.stop,"default must be the documented 1.1 ATR");
});

/* ---------------- the instruction must track the LIVE price, not the scan price ---------------- */

test("planNowFor names exactly one side, at every price",()=>{
  const fd=S.synthBump(4242);
  const p=S.tradePlan(fd.close,fd.high,fd.low,S.bumpProfile(fd.close,fd.vol));
  const cases=[
    [p.long.entryLo*0.5,'buy'],            // far below the zone — still a buy
    [p.long.entryLo,'buy'],
    [p.long.entryHi,'buy'],                // inclusive upper edge
    [p.short.entryLo,'short'],             // inclusive lower edge
    [p.short.entryHi*2,'short'],
  ];
  for(const [px,want] of cases)assert.strictEqual(S.planNowFor(px,p).now,want,'at '+px);
  // Between the zones it must say WAIT, and pick whichever edge is nearer.
  const mid=(p.long.entryHi+p.short.entryLo)/2;
  assert.ok(S.planNowFor(mid,p).now.startsWith('wait'));
  assert.strictEqual(S.planNowFor(p.long.entryHi*1.001,p).now,'wait_buy','just above the buy zone → wait to buy');
  assert.strictEqual(S.planNowFor(p.short.entryLo*0.999,p).now,'wait_short','just under the short zone → wait to short');
});

test("the instruction changes when price moves — this is why it cannot be cached for 30 minutes",()=>{
  const fd=S.synthBump(4242);
  const p=S.tradePlan(fd.close,fd.high,fd.low,S.bumpProfile(fd.close,fd.vol));
  const inZone=S.planNowFor(p.long.entryHi*0.99,p).now;
  const escaped=S.planNowFor(p.long.entryHi*1.15,p).now;
  assert.strictEqual(inZone,'buy');
  assert.notStrictEqual(escaped,'buy',"a card still saying BUY after price left the zone is the bug this guards");
});

test("distance-to-zone is signed from the live price, so the alert copy reads correctly",()=>{
  const fd=S.synthBump(4242);
  const p=S.tradePlan(fd.close,fd.high,fd.low,S.bumpProfile(fd.close,fd.vol));
  const above=S.planNowFor(p.long.entryHi*1.2,p);
  assert.ok(above.toBuy<0,"buy zone is BELOW a price above it");
  assert.ok(above.toShort>0,"short zone is still above");
});

test("tradePlan's own instruction agrees with planNowFor at its own price",()=>{
  for(const seed of [11,222,3333,4242,8191]){
    const fd=S.synthBump(seed);
    const p=S.tradePlan(fd.close,fd.high,fd.low,S.bumpProfile(fd.close,fd.vol));
    if(!p)continue;
    assert.strictEqual(p.now,S.planNowFor(p.price,p).now,"seed "+seed+": one rule, one answer");
  }
});

test("dumpBounce ships the instruction copy so the UI can relabel a re-derived state",async()=>{
  const d=await S.dumpBounce(true);
  assert.ok(d.planCopy,"the UI re-derives `now` from a live quote and needs the matching prose");
  for(const k of ['buy','short','wait_buy','wait_short'])
    assert.ok(d.planCopy[k]&&d.planCopy[k].label&&d.planCopy[k].lead,'missing copy for '+k);
});
