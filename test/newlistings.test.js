/* 🎢 New Listings — cycle detector.
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

test("listingProfile flags a series that hit the fetch cap — we cannot call that a new listing",()=>{
  const short=S.listingProfile(listingSeries(100));
  assert.strictEqual(short.truncated,false);
  const long=S.listingProfile(listingSeries(420));
  assert.strictEqual(long.truncated,true,"400 bars back could be a mid-life window, not the listing");
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

test("freshListings returns ranked rows with everything a card needs",async()=>{
  const d=await S.freshListings(true);
  assert.ok(d.rows.length>0,"DEMO ships synthetic listings so the panel demonstrates itself");
  assert.ok(d.scanned>0);
  for(let i=1;i<d.rows.length;i++)assert.ok(d.rows[i-1].score>=d.rows[i].score,"ranked by pattern fit");
  for(const r of d.rows){
    assert.ok(r.tk&&r.name&&r.sym);
    assert.ok(r.ageDays>=21&&!r.truncated,"only coins whose history provably starts at the listing");
    assert.ok(r.ddPct>=40,"a coin still near its listing price is not in this regime");
    assert.ok(r.peakPos<=0.6,"peaked late = a recent runner, not a listed-then-bled coin");
    assert.ok(r.cycles>=1&&r.rally.medPct>=15,"needs bounces big enough to be worth trading");
    assert.ok(r.phaseInfo&&r.phaseInfo.label&&r.phaseInfo.what);
    assert.ok(r.fwd&&r.fwd.baseN>0,"every row carries its own base rate");
    assert.ok(Array.isArray(r.spark)&&r.spark.length>1);
  }
});

test("freshListings caches, and every row's phase agrees with its own leg",async()=>{
  const a=await S.freshListings(true), b=await S.freshListings();
  assert.strictEqual(b.cached,true);
  assert.strictEqual(a.rows.length,b.rows.length);
  for(const r of a.rows){
    if(r.phase==="unclear")continue;
    const up=r.leg.dir>0;
    assert.strictEqual(up,r.phase==="rallying"||r.phase==="mature","an up-leg cannot be 'falling'");
  }
});
