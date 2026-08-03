/* Unit tests for the Options Radar vol math.
   Run:  node --test options/
   Uses only the built-in node:test runner — no dependencies. */
"use strict";
const test=require("node:test");
const assert=require("node:assert");
const V=require("./vol.js");

const close=(a,b,tol,msg)=>assert.ok(Math.abs(a-b)<=tol,`${msg||''} expected ${b}, got ${a} (tol ${tol})`);

/* ---------------- normal distribution ---------------- */
test("NORM_CDF matches known values",()=>{
  close(V.NORM_CDF(0),0.5,1e-9,"N(0)");
  close(V.NORM_CDF(1.959963985),0.975,1e-6,"N(1.96)");
  close(V.NORM_CDF(-1.959963985),0.025,1e-6,"N(-1.96)");
  close(V.NORM_CDF(1),0.8413447,1e-6,"N(1)");
});
test("NORM_CDF is symmetric and monotone",()=>{
  for(let x=-3;x<=3;x+=0.25) close(V.NORM_CDF(x)+V.NORM_CDF(-x),1,1e-6,`symmetry at ${x}`);
  let prev=-1;
  for(let x=-4;x<=4;x+=0.1){const v=V.NORM_CDF(x);assert.ok(v>=prev,"monotone");prev=v;}
});

/* ---------------- Black-76 ---------------- */
test("Black-76 satisfies put-call parity",()=>{
  const F=8500000,T=0.25,s=0.55,df=0.99;
  for(const K of [6000000,8000000,8500000,9000000,12000000]){
    const c=V.black76('call',F,K,T,s,df), p=V.black76('put',F,K,T,s,df);
    close(c-p, df*(F-K), 1e-6*F, `parity at K=${K}`);
  }
});
test("Black-76 respects no-arbitrage bounds",()=>{
  const F=100,T=0.5,s=0.6;
  for(const K of [50,80,100,120,200]){
    const c=V.black76('call',F,K,T,s,1), p=V.black76('put',F,K,T,s,1);
    assert.ok(c>=Math.max(0,F-K)-1e-9,`call >= intrinsic K=${K}`);
    assert.ok(c<=F+1e-9,`call <= F K=${K}`);
    assert.ok(p>=Math.max(0,K-F)-1e-9,`put >= intrinsic K=${K}`);
    assert.ok(p<=K+1e-9,`put <= K K=${K}`);
  }
});
test("Black-76 ATM has the known closed form ~0.3989·F·σ√T",()=>{
  const F=100,T=1,s=0.2;                       // ATM-forward call ≈ F·σ√T/√(2π)
  const c=V.black76('call',F,F,T,s,1);
  close(c, F*s*Math.sqrt(T)/Math.sqrt(2*Math.PI), 0.02, "ATM approx");
});
test("Black-76 degenerates to intrinsic at T=0 or sigma=0",()=>{
  close(V.black76('call',120,100,0,0.5,1),20,1e-12,"T=0 call");
  close(V.black76('put',80,100,0,0.5,1),20,1e-12,"T=0 put");
  close(V.black76('call',120,100,0.5,0,1),20,1e-12,"sigma=0 call");
});
test("Black-76 price rises monotonically with vol",()=>{
  let prev=-1;
  for(let s=0.05;s<=3;s+=0.05){
    const c=V.black76('call',100,110,0.3,s,1);
    assert.ok(c>prev,`monotone in sigma at ${s}`); prev=c;
  }
});

/* ---------------- greeks ---------------- */
test("delta sits in the right range and call-put delta differ by ~1",()=>{
  const F=100,T=0.4,s=0.5;
  for(const K of [70,90,100,115,140]){
    const dc=V.greeks('call',F,K,T,s,1).delta, dp=V.greeks('put',F,K,T,s,1).delta;
    assert.ok(dc>0&&dc<1,`call delta in (0,1) K=${K}`);
    assert.ok(dp>-1&&dp<0,`put delta in (-1,0) K=${K}`);
    close(dc-dp,1,1e-9,`delta parity K=${K}`);
  }
});
test("vega matches a numerical derivative of price wrt vol",()=>{
  const F=100,K=105,T=0.5,s=0.45,h=1e-5;
  const num=(V.black76('call',F,K,T,s+h,1)-V.black76('call',F,K,T,s-h,1))/(2*h);
  const an=V.greeks('call',F,K,T,s,1).vega;
  // central-difference truncation error is O(h²)·f''' — compare relatively, not absolutely
  close(an/num,1,1e-7,"vega vs numerical");
});
test("theta is negative and expressed per day",()=>{
  const F=100,K=100,T=0.5,s=0.5;
  const th=V.greeks('call',F,K,T,s,1).theta;
  assert.ok(th<0,"theta negative for a long option");
  // a per-year theta would be ~365x bigger; assert we are in per-day territory
  assert.ok(Math.abs(th)<1,`per-day magnitude, got ${th}`);
});
test("ATM vega is the largest across strikes",()=>{
  const F=100,T=0.5,s=0.5;
  const atm=V.greeks('call',F,100,T,s,1).vega;
  for(const K of [60,80,125,160]) assert.ok(V.greeks('call',F,K,T,s,1).vega<atm,`ATM vega max vs K=${K}`);
});

/* ---------------- implied vol ---------------- */
test("IV round-trips price → vol → price wherever time value is resolvable",()=>{
  const F=8500000,df=0.998; let solved=0;
  for(const T of [0.002,0.02,0.25,1]){
    for(const K of [F*0.7,F*0.9,F,F*1.1,F*1.4]){
      for(const s of [0.15,0.4,0.85,1.8]){
        for(const kind of ['call','put']){
          const px=V.black76(kind,F,K,T,s,df);
          const intrinsic=df*(kind==='call'?Math.max(0,F-K):Math.max(0,K-F));
          // Deep ITM + very short dated: time value underflows to nothing, so IV is not
          // recoverable from the price at all. Asserted separately below.
          if(px-intrinsic < 1e-6*F) continue;
          const iv=V.impliedVol(kind,px,F,K,T,df);
          assert.ok(iv!=null,`solved ${kind} K=${K} T=${T} s=${s}`);
          close(iv,s,1e-4,`IV round trip ${kind} K=${K} T=${T}`);
          solved++;
        }
      }
    }
  }
  assert.ok(solved>100,`exercised a real surface, solved ${solved}`);
});
test("deep-ITM short-dated options report no IV rather than a fabricated one",()=>{
  // 70% ITM call with ~17h to expiry: the price IS the intrinsic to floating precision.
  const F=8500000,K=F*0.7,T=0.002,df=0.998;
  const px=V.black76('call',F,K,T,0.15,df);
  assert.strictEqual(V.impliedVol('call',px,F,K,T,df),null,"no resolvable time value → null");
  // These are excluded by the |delta| 0.15–0.70 hard filter anyway:
  assert.ok(Math.abs(V.greeks('call',F,K,T,0.15,df).delta)>0.9,"such a contract is ~1 delta");
});
test("IV returns null rather than a garbage number for unquotable prices",()=>{
  const F=100,K=90,T=0.5;
  assert.strictEqual(V.impliedVol('call',5,F,K,T,1),null,"below intrinsic (10) → null");
  assert.strictEqual(V.impliedVol('call',100,F,K,T,1),null,"at/above forward ceiling → null");
  assert.strictEqual(V.impliedVol('call',0,F,K,T,1),null,"zero price → null");
  assert.strictEqual(V.impliedVol('call',12,F,K,0,1),null,"expired → null");
  assert.strictEqual(V.impliedVol('call',10,F,K,T,1),null,"exactly intrinsic → null (no time value)");
});
test("IV solves at the extreme ends of the bracket",()=>{
  const F=100,K=100,T=0.25;
  for(const s of [0.011,4.9]){
    const px=V.black76('call',F,K,T,s,1);
    const iv=V.impliedVol('call',px,F,K,T,1);
    assert.ok(iv!=null&&Math.abs(iv-s)<1e-3,`extreme vol ${s} → ${iv}`);
  }
});

/* ---------------- smile fit ---------------- */
// Build a synthetic chain from a known quadratic in total variance.
function synth(T,a,b,c,ks,noise){
  noise=noise||[];
  return ks.map((k,i)=>{
    const w=a+b*k+c*k*k;
    const iv=Math.sqrt(w/T)+(noise[i]||0);
    const F=1,K=Math.exp(k);
    const g=V.greeks('call',F,K,T,iv,1);
    return {k,iv,vega:g.vega,spread:0.01};
  });
}
const KS=[-0.30,-0.20,-0.12,-0.05,0,0.05,0.12,0.20,0.30];

test("smile fit recovers the generating quadratic on clean data",()=>{
  const T=0.08,a=0.02,b=-0.004,c=0.05;
  const f=V.fitSmile(synth(T,a,b,c,KS),T);
  close(f.a,a,1e-6,"a"); close(f.b,b,1e-6,"b"); close(f.c,c,1e-6,"c");
  assert.strictEqual(f.degraded,false,"9 points is not degraded");
  assert.strictEqual(f.order,2,"quadratic order used");
  assert.ok(f.rmseVol<1e-4,`near-zero rmse, got ${f.rmseVol}`);
});
test("a genuinely cheap contract gets a large negative z, its neighbours do not",()=>{
  const T=0.08;
  const noise=new Array(KS.length).fill(0); noise[6]=-0.06;    // one strike 6 vol points cheap
  const f=V.fitSmile(synth(T,0.02,-0.004,0.05,KS,noise),T);
  assert.ok(f.z[6]<-2,`cheap strike flagged, z=${f.z[6]}`);
  f.z.forEach((z,i)=>{ if(i!==6) assert.ok(Math.abs(z)<1.5,`neighbour ${i} not dragged, z=${z}`); });
});
test("a clean chain produces NO signals — residual sigma is floored, not collapsed",()=>{
  // Regression guard. Without a noise floor the MAD of an almost-perfect fit tends to 0,
  // so every sub-tick residual becomes a multi-sigma "mispricing" and the screener fires
  // hardest precisely where nothing is wrong.
  const T=0.08;
  const jitter=KS.map((_,i)=>((i%3)-1)*2e-4);        // ±0.02 vol point — pure quote noise
  const f=V.fitSmile(synth(T,0.02,-0.004,0.05,KS,jitter),T);
  assert.ok(f.sigmaFloored,"floor engaged on a near-perfect fit");
  f.z.forEach((z,i)=>assert.ok(Math.abs(z)<1,`no false signal at ${i}, z=${z}`));
});
test("the floor does not mute a real dislocation",()=>{
  const T=0.08;
  const noise=new Array(KS.length).fill(0); noise[4]=-0.05;   // ATM 5 vol points cheap
  const f=V.fitSmile(synth(T,0.02,-0.004,0.05,KS,noise),T);
  assert.ok(f.z[4]<-3,`real dislocation still flagged, z=${f.z[4]}`);
});
test("a noisy chain uses the measured sigma, not the floor, and stays quiet",()=>{
  const T=0.08;
  // Non-systematic scatter. A linear or quadratic pattern would be absorbed into the fitted
  // slope/curvature — that is signal to the model, not noise — so the perturbation must not
  // be expressible by the curve itself.
  const noisy=[+0.012,-0.009,+0.011,-0.013,+0.008,-0.011,+0.013,-0.008,+0.010];
  const f=V.fitSmile(synth(T,0.02,-0.004,0.05,KS,noisy),T);
  assert.ok(!f.sigmaFloored,"measured dispersion exceeds the floor");
  // The whole chain is uniformly noisy, so nothing in it is anomalous relative to the rest.
  const flagged=f.z.filter(z=>Math.abs(z)>3).length;
  assert.strictEqual(flagged,0,`uniform noise must not manufacture signals, ${flagged} flagged`);
});
test("retained quotes carry leverage and are LOO-corrected",()=>{
  const T=0.08;
  // mild dispersion only, so nothing is fully rejected and every point still influences the fit
  const jitter=KS.map((_,i)=>((i*7919)%11-5)*0.0015);
  const f=V.fitSmile(synth(T,0.02,-0.004,0.05,KS,jitter),T);
  const retained=f.hat.map((h,i)=>({h,i})).filter(x=>x.h>0);
  assert.ok(retained.length>=5,`most quotes retained, got ${retained.length}`);
  for(const {i} of retained){
    assert.ok(Math.abs(f.residLOO[i])>=Math.abs(f.resid[i])-1e-15,
      `LOO never shrinks a residual (i=${i})`);
  }
});
test("a fully rejected quote has zero leverage, so LOO equals its raw residual",()=>{
  const T=0.08;
  const noise=new Array(KS.length).fill(0); noise[0]=-0.05;
  const f=V.fitSmile(synth(T,0.02,-0.004,0.05,KS,noise),T);
  // Bisquare redescends to 0 for a gross outlier: it never influenced the curve, so there
  // is no self-influence left to remove.
  assert.strictEqual(f.hat[0],0,"outlier excluded from the fit");
  close(f.residLOO[0],f.resid[0],1e-15,"LOO == raw for an excluded point");
  assert.ok(f.z[0]<-3,`still flagged as cheap, z=${f.z[0]}`);
});
test("LOO residual matches an explicit refit-without-the-point",()=>{
  const T=0.08;
  // Mild perturbation: the point stays in the fit, so LOO has real work to do and we can
  // check the closed form against an actual leave-one-out refit.
  const pts=synth(T,0.02,-0.004,0.05,KS,[0,0,0,0.004,0,0,0,0,0]);
  const f=V.fitSmile(pts,T);
  const i=3;
  assert.ok(f.hat[i]>0,"point is in the fit");
  const g=V.fitSmile(pts.filter((_,j)=>j!==i),T);
  const bruteResid=pts[i].iv*pts[i].iv*T-V.fitVariance(g,pts[i].k);
  assert.strictEqual(Math.sign(bruteResid),Math.sign(f.residLOO[i]),"LOO sign matches brute force");
  assert.ok(Math.abs(f.residLOO[i])>=Math.abs(f.resid[i]),"LOO >= in-sample residual");
});
test("one fat-fingered quote does not bend the curve (Huber robustness)",()=>{
  const T=0.08,a=0.02,b=-0.004,c=0.05;
  const clean=V.fitSmile(synth(T,a,b,c,KS),T);
  const noise=new Array(KS.length).fill(0); noise[8]=0.60;     // absurd 60-vol-point wing print
  const dirty=V.fitSmile(synth(T,a,b,c,KS,noise),T);
  close(dirty.a,clean.a,5e-3,"level barely moved");
  assert.ok(dirty.z[8]>2,`the bad print itself is flagged, z=${dirty.z[8]}`);
});
test("negative curvature is refit away and flagged",()=>{
  const T=0.08;
  const f=V.fitSmile(synth(T,0.02,0,-0.05,KS),T);          // concave = butterfly-arb shape
  assert.ok(f.arb.includes('convexity_violation'),"flagged");
  assert.ok(f.c>=0,"curvature not left negative");
});
test("thin chains degrade instead of inventing curvature",()=>{
  const T=0.08;
  const four=V.fitSmile(synth(T,0.02,-0.004,0.05,[-0.1,0,0.1,0.2]),T);
  assert.strictEqual(four.degraded,true,"n=4 is degraded");
  assert.ok(four.order<=1,"no curvature fitted from 4 points");
  const two=V.fitSmile(synth(T,0.02,0,0,[-0.1,0.1]),T);
  assert.strictEqual(two.degraded,true,"n=2 degraded");
  assert.strictEqual(two.order,0,"flat fallback");
  const none=V.fitSmile([],T);
  assert.strictEqual(none.n,0); assert.strictEqual(none.degraded,true);
});
test("fit evaluation and delta inversion are consistent",()=>{
  const T=0.08, f=V.fitSmile(synth(T,0.02,-0.004,0.05,KS),T);
  const k=V.kForDelta(f,0.25,'call',T,1);
  assert.ok(isFinite(k),"solved a k for 25Δ");
  const iv=V.fitIV(f,k,T);
  const d=Math.abs(V.greeks('call',1,Math.exp(k),T,iv,1).delta);
  close(d,0.25,1e-3,"25 delta round trip");
});

/* ---------------- helpers ---------------- */
test("realized vol recovers the vol of a known generator",()=>{
  // deterministic alternating log-returns of ±sigma_daily → annualized ≈ sigma_daily·√365
  const dailySigma=0.03, closes=[100];
  for(let i=0;i<400;i++)closes.push(closes[closes.length-1]*Math.exp(i%2?dailySigma:-dailySigma));
  close(V.realizedVol(closes,365), dailySigma*Math.sqrt(365), 0.02, "annualized RV");
  assert.ok(!isFinite(V.realizedVol([100],365)),"too short → NaN");
});
test("percentileOf places values correctly",()=>{
  const h=[10,20,30,40,50];
  close(V.percentileOf(5,h),0,1e-9); close(V.percentileOf(35,h),60,1e-9);
  close(V.percentileOf(99,h),100,1e-9);
  assert.ok(!isFinite(V.percentileOf(5,[])),"empty history → NaN");
});
test("madSigma is not moved by a single outlier the way stdev is",()=>{
  const base=[0.01,-0.01,0.02,-0.02,0.005,-0.005];
  const withOutlier=base.concat([5]);
  const sd=a=>{const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));};
  assert.ok(sd(withOutlier)>10*sd(base),"stdev blows up");
  assert.ok(V.madSigma(withOutlier)<3*V.madSigma(base),"MAD stays stable");
});
