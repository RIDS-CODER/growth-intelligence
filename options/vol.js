/* ============================================================
   Options Radar — VOL MATH CORE
   Black-76 pricing / IV solve / greeks, and the smile fit that the
   mispricing signals are measured against.

   Everything is on the FORWARD, never spot: INR-margined crypto options carry a
   real basis, and fitting in ln(K/spot) smears that basis into apparent skew —
   manufacturing "mispricing" that is really just carry.

   Zero dependencies. Node 18+.
   ============================================================ */
"use strict";

/* ---------- normal distribution ----------
   Hart/West rational approximation, accurate to ~1e-15 — deliberately not the usual
   Abramowitz & Stegun 7.1.26 (|err| ~1.5e-7). This engine's whole job is measuring
   sub-vol-point residuals, so approximation error must sit far below the signal. */
function NORM_CDF(x){
  if(!isFinite(x))return x>0?1:0;
  const z=Math.abs(x); let c;
  if(z>37)c=0;
  else{
    const e=Math.exp(-z*z/2);
    if(z<7.07106781186547){
      let b=3.52624965998911e-02*z+0.700383064443688;
      b=b*z+6.37396220353165; b=b*z+33.912866078383; b=b*z+112.079291497871;
      b=b*z+221.213596169931; b=b*z+220.206867912376;
      let d=8.83883476483184e-02*z+1.75566716318264;
      d=d*z+16.064177579207; d=d*z+86.7807322029461; d=d*z+296.564248779674;
      d=d*z+637.333633378831; d=d*z+793.826512519948; d=d*z+440.413735824752;
      c=e*b/d;
    }else{
      let f=z+0.65; f=z+4/f; f=z+3/f; f=z+2/f; f=z+1/f;
      c=e/(f*2.506628274631);
    }
  }
  return x>0?1-c:c;
}
const NORM_PDF=x=>Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI);
const erf=x=>2*NORM_CDF(x*Math.SQRT2)-1;

/* ============================================================
   BLACK-76 — European options on a forward, cash settled.
   F forward, K strike, T years, sigma annualized vol, df discount factor to expiry.
   Returns the premium in the same currency as F/K.
   ============================================================ */
function black76(kind,F,K,T,sigma,df){
  df=df==null?1:df;
  const call=kind==='call'||kind==='C'||kind==='c';
  if(!(F>0)||!(K>0))return NaN;
  // At/!past expiry, or a zero-vol quote, the option is worth its intrinsic.
  if(!(T>0)||!(sigma>0)){
    const intr=call?Math.max(0,F-K):Math.max(0,K-F);
    return df*intr;
  }
  const v=sigma*Math.sqrt(T);
  const d1=(Math.log(F/K)+0.5*v*v)/v, d2=d1-v;
  return call ? df*(F*NORM_CDF(d1)-K*NORM_CDF(d2))
              : df*(K*NORM_CDF(-d2)-F*NORM_CDF(-d1));
}

/* Greeks (Black-76). delta/gamma are w.r.t. the FORWARD.
   theta is per DAY and already includes the 1/365 scaling — the screener quotes theta/day. */
function greeks(kind,F,K,T,sigma,df){
  df=df==null?1:df;
  const call=kind==='call'||kind==='C'||kind==='c';
  const out={delta:0,gamma:0,vega:0,theta:0};
  if(!(F>0)||!(K>0)||!(T>0)||!(sigma>0))return out;
  const v=sigma*Math.sqrt(T);
  const d1=(Math.log(F/K)+0.5*v*v)/v, d2=d1-v;
  const pdf=NORM_PDF(d1);
  out.delta = df*(call?NORM_CDF(d1):NORM_CDF(d1)-1);
  out.gamma = df*pdf/(F*v);
  out.vega  = df*F*pdf*Math.sqrt(T);                 // per 1.00 of vol (i.e. 100 vol points)
  out.theta = (-df*F*pdf*sigma/(2*Math.sqrt(T)))/365; // per calendar day
  return out;
}

/* ============================================================
   IMPLIED VOL — Newton on vega with a bracketed bisection fallback.
   Returns null (never a garbage number) when no solution exists, e.g. a quote
   below intrinsic or above the forward. A null propagates as "no IV" rather
   than silently becoming 0 and poisoning a z-score downstream.
   ============================================================ */
const IV_LO=0.01, IV_HI=5.00;       // 1% .. 500% annualized
function impliedVol(kind,price,F,K,T,df,opts){
  opts=opts||{}; df=df==null?1:df;
  const tol=opts.tol||1e-7, maxIter=opts.maxIter||60;
  if(!(price>0)||!(F>0)||!(K>0)||!(T>0))return null;
  const call=kind==='call'||kind==='C'||kind==='c';
  const intrinsic=df*(call?Math.max(0,F-K):Math.max(0,K-F));
  const upper=df*(call?F:K);                       // absolute no-arb ceiling
  if(price<intrinsic-1e-9)return null;             // below intrinsic — unquotable
  if(price>=upper)return null;                     // at/above the ceiling — IV is unbounded
  // price exactly at intrinsic → zero time value → vol is (effectively) zero, not solvable
  if(price<=intrinsic+1e-12)return null;

  const f=s=>black76(kind,F,K,T,s,df)-price;
  let lo=IV_LO, hi=IV_HI, flo=f(lo), fhi=f(hi);
  if(flo>0)return null;                            // even 1% vol overprices it
  if(fhi<0)return null;                            // even 500% vol underprices it

  // Newton from a Brenner-Subrahmanyam style seed, guarded to stay in the bracket.
  let s=Math.min(IV_HI,Math.max(IV_LO,Math.sqrt(2*Math.PI/T)*price/(df*F)));
  for(let i=0;i<maxIter;i++){
    const diff=f(s);
    if(Math.abs(diff)<tol*Math.max(1,price))return s;
    if(diff>0)hi=s;else lo=s;                      // keep the bracket tight as we go
    const vg=greeks(kind,F,K,T,s,df).vega;
    let next = vg>1e-12 ? s-diff/vg : NaN;
    if(!(next>lo&&next<hi)||!isFinite(next))next=0.5*(lo+hi);   // fall back to bisection
    if(Math.abs(next-s)<1e-12)return next;
    s=next;
  }
  return s;
}

/* ============================================================
   SMILE FIT — total variance w(k) = a + b·k + c·k²
     k = ln(K/F)   log-moneyness on the forward
     w = σ²·T      total implied variance
   3 parameters by design: after the hard filters a CoinDCX expiry leaves ~6-15
   usable strikes, and a 5-param SVI on 8 points drives residuals to zero — which
   would silently delete the smile-residual signal while still reporting a number.
   ============================================================ */

// Weighted least squares for a quadratic, via 3x3 normal equations (Cramer).
// Returns null if the system is singular (e.g. all points at one strike).
function wlsQuadratic(k,w,wt){
  let S0=0,S1=0,S2=0,S3=0,S4=0,T0=0,T1=0,T2=0;
  for(let i=0;i<k.length;i++){
    const x=k[i],y=w[i],p=wt[i];
    if(!isFinite(x)||!isFinite(y)||!(p>0))continue;
    const x2=x*x;
    S0+=p; S1+=p*x; S2+=p*x2; S3+=p*x2*x; S4+=p*x2*x2;
    T0+=p*y; T1+=p*x*y; T2+=p*x2*y;
  }
  const M=[[S0,S1,S2],[S1,S2,S3],[S2,S3,S4]], v=[T0,T1,T2];
  const det3=m=>m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
                -m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
                +m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  const D=det3(M);
  if(!isFinite(D)||Math.abs(D)<1e-18)return null;
  const sub=(col)=>{const m=M.map(r=>r.slice());for(let r=0;r<3;r++)m[r][col]=v[r];return det3(m)/D;};
  return {a:sub(0),b:sub(1),c:sub(2)};
}
// Same machinery restricted to lower orders, for thin chains.
function wlsLinear(k,w,wt){
  let S0=0,S1=0,S2=0,T0=0,T1=0;
  for(let i=0;i<k.length;i++){const x=k[i],y=w[i],p=wt[i];if(!isFinite(x)||!isFinite(y)||!(p>0))continue;
    S0+=p;S1+=p*x;S2+=p*x*x;T0+=p*y;T1+=p*x*y;}
  const D=S0*S2-S1*S1;
  if(!isFinite(D)||Math.abs(D)<1e-18)return null;
  return {a:(T0*S2-T1*S1)/D, b:(S0*T1-S1*T0)/D, c:0};
}
function wlsFlat(w,wt){
  let sw=0,sy=0;for(let i=0;i<w.length;i++){if(!(wt[i]>0)||!isFinite(w[i]))continue;sw+=wt[i];sy+=wt[i]*w[i];}
  return sw>0?{a:sy/sw,b:0,c:0}:null;
}
const median=arr=>{const a=arr.filter(isFinite).slice().sort((x,y)=>x-y);if(!a.length)return NaN;
  const m=a.length>>1;return a.length%2?a[m]:(a[m-1]+a[m])/2;};

/* All p-sized index subsets of 0..n-1, capped; beyond the cap we sample deterministically
   (fixed LCG) so a scan is reproducible and a backtest replays identically. */
function subsetsOf(n,p,cap){
  const out=[];
  const total=(()=>{let c=1;for(let i=0;i<p;i++)c=c*(n-i)/(i+1);return Math.round(c);})();
  if(total<=cap){
    const idx=new Array(p).fill(0).map((_,i)=>i);
    while(true){
      out.push(idx.slice());
      let i=p-1;
      while(i>=0&&idx[i]===n-p+i)i--;
      if(i<0)break;
      idx[i]++; for(let j=i+1;j<p;j++)idx[j]=idx[j-1]+1;
    }
    return out;
  }
  let s=12345;const rnd=()=>{s=(s*1103515245+12345)&0x7fffffff;return s/0x7fffffff;};
  for(let t=0;t<cap;t++){
    const pick=new Set();
    while(pick.size<p)pick.add(Math.floor(rnd()*n));
    out.push([...pick].sort((a,b)=>a-b));
  }
  return out;
}

/* LEAST TRIMMED SQUARES seed — a high-breakdown starting point for the IRLS.
   Without this, robust reweighting is vulnerable to MASKING: the mispriced contract is
   usually ATM, which also carries the most vega and so the largest fit weight. It drags
   the least-squares curve toward itself, the residual smears across every strike, and the
   outlier's own residual is then no bigger than its neighbours' — so reweighting cannot
   tell them apart. Fitting exact p-point subsets and scoring each by the sum of its h
   SMALLEST squared residuals finds a curve built only from consensus quotes, from which
   the dislocation is finally visible. */
function ltsSeed(k,w,order,fitBy,coverage){
  const n=k.length,p=order+1;
  if(n<p+2)return null;
  // Coverage 0.75, not the textbook n/2. Classic LTS maximizes breakdown against adversarial
  // contamination, but an options chain carries one or two stale quotes — not half. Trimming
  // to n/2 would reject ~44% of a merely NOISY chain, and every rejected quote then reads as
  // a dislocation. 25% breakdown is ample here and keeps the scale estimate representative
  // of real quote dispersion instead of collapsing it onto the retained cluster.
  const h=Math.max(p+1,Math.ceil((coverage==null?0.75:coverage)*n));
  let best=null,bestCost=Infinity;
  for(const sub of subsetsOf(n,p,400)){
    const wt=new Array(n).fill(0); sub.forEach(i=>wt[i]=1);
    const cf=fitBy(order,wt);
    if(!cf)continue;
    const sq=[];
    for(let i=0;i<n;i++){const r=w[i]-(cf.a+cf.b*k[i]+cf.c*k[i]*k[i]);sq.push(r*r);}
    sq.sort((a,b)=>a-b);
    let cost=0;for(let i=0;i<h;i++)cost+=sq[i];
    if(cost<bestCost){bestCost=cost;best=cf;}
  }
  return best;
}
// Median absolute deviation, scaled to be a consistent estimator of sigma for normal data.
function madSigma(res){
  const m=median(res); if(!isFinite(m))return NaN;
  const d=res.filter(isFinite).map(r=>Math.abs(r-m));
  const mad=median(d);
  return isFinite(mad)?1.4826*mad:NaN;
}

/* Leverage h_ii for weighted least squares: h = w_i · x_iᵀ (XᵀWX)⁻¹ x_i.
   Needed for leave-one-out residuals — with ~10 points and 3 params a contract
   meaningfully bends the very curve it is then scored against, so a raw residual
   lets a mispriced contract partly validate its own price. */
function leverages(k,wt,order){
  const n=k.length, p=order===2?3:order===1?2:1;
  // Build XᵀWX and invert (small, explicit).
  const X=i=>p===3?[1,k[i],k[i]*k[i]]:p===2?[1,k[i]]:[1];
  const A=Array.from({length:p},()=>new Array(p).fill(0));
  for(let i=0;i<n;i++){ if(!(wt[i]>0))continue; const x=X(i);
    for(let r=0;r<p;r++)for(let c=0;c<p;c++)A[r][c]+=wt[i]*x[r]*x[c]; }
  const inv=invertSmall(A,p);
  if(!inv)return new Array(n).fill(0);
  const h=new Array(n).fill(0);
  for(let i=0;i<n;i++){
    if(!(wt[i]>0))continue;
    const x=X(i); let s=0;
    for(let r=0;r<p;r++)for(let c=0;c<p;c++)s+=x[r]*inv[r][c]*x[c];
    h[i]=Math.min(0.999,Math.max(0,wt[i]*s));    // clamp: h→1 means the point defines the fit
  }
  return h;
}
function invertSmall(A,p){
  // Gauss-Jordan with partial pivoting on a p×p (p ≤ 3) matrix.
  const M=A.map((r,i)=>r.concat(Array.from({length:p},(_,j)=>i===j?1:0)));
  for(let col=0;col<p;col++){
    let piv=col;
    for(let r=col+1;r<p;r++)if(Math.abs(M[r][col])>Math.abs(M[piv][col]))piv=r;
    if(Math.abs(M[piv][col])<1e-18)return null;
    if(piv!==col){const t=M[piv];M[piv]=M[col];M[col]=t;}
    const d=M[col][col];
    for(let c=0;c<2*p;c++)M[col][c]/=d;
    for(let r=0;r<p;r++){
      if(r===col)continue;
      const f=M[r][col]; if(!f)continue;
      for(let c=0;c<2*p;c++)M[r][c]-=f*M[col][c];
    }
  }
  return M.map(r=>r.slice(p));
}

/**
 * Fit one expiry's smile.
 * points: [{ k, iv, vega, spread }]  — k = ln(K/F), spread in premium terms
 * Returns { a,b,c, n, order, rmseVol, madSigma, hat, resid, residLOO, z, degraded, arb }
 * where z[i] is the leave-one-out studentized residual in TOTAL VARIANCE space,
 * scaled by a robust sigma. Negative z = quoted below the curve = cheap.
 */
function fitSmile(points,T,opts){
  opts=opts||{};
  const pts=(points||[]).filter(p=>p&&isFinite(p.k)&&isFinite(p.iv)&&p.iv>0);
  const n=pts.length;
  const out={a:NaN,b:0,c:0,n,order:0,rmseVol:NaN,madSigma:NaN,hat:[],resid:[],residLOO:[],z:[],
             degraded:true,arb:[],T};
  if(!n||!(T>0))return out;

  const k=pts.map(p=>p.k), w=pts.map(p=>p.iv*p.iv*T);
  // Weight by vega² / spread: ATM carries the most vega and the tightest spreads, so it
  // anchors the curve and a wide wing quote cannot drag it.
  const wt=pts.map(p=>{
    const vg=isFinite(p.vega)&&p.vega>0?p.vega:1;
    const sp=isFinite(p.spread)&&p.spread>0?p.spread:1;
    return (vg*vg)/(sp+1e-9);
  });
  // Normalize weights so madSigma/rmse are comparable across chains.
  const wmax=Math.max(...wt); if(isFinite(wmax)&&wmax>0)for(let i=0;i<wt.length;i++)wt[i]/=wmax;

  const order = n>=5?2 : n>=3?1 : 0;
  const fitBy=(o,weights)=>o===2?wlsQuadratic(k,w,weights):o===1?wlsLinear(k,w,weights):wlsFlat(w,weights);
  let coef=fitBy(order,wt);
  if(!coef)coef=wlsFlat(w,wt);
  if(!coef)return out;

  // ROBUSTIFY — iterated reweighting with Tukey's bisquare.
  // A single Huber pass is not enough here: the mispriced contract is often ATM, which
  // also carries the most vega and therefore the LARGEST fit weight. It drags the curve
  // toward itself, the residual smears across every strike, and the dislocation we are
  // hunting hides inside its own distortion. Bisquare redescends to exactly zero beyond
  // ~4.685σ, so a gross outlier is fully excluded from the curve it is then measured against.
  const wEval=(cf,x)=>cf.a+cf.b*x+cf.c*x*x;
  // Seed from LTS (breakdown-resistant) rather than from the weighted least-squares fit,
  // which a high-vega outlier can already have captured. Falls back to the LS fit when the
  // chain is too thin for subset fitting.
  const seed=ltsSeed(k,w,order,fitBy,opts.ltsCoverage);
  if(seed)coef=seed;
  let res=w.map((y,i)=>y-wEval(coef,k[i]));
  let wt2=wt.slice();
  const minEff=order+2;                       // keep enough real points to identify the fit

  // ONE noise floor governs both rejection and significance. Quotes carry finite tick size
  // and the 3-param model has its own error, so deviations below ~half a vol point are not
  // information: they must neither eject a quote from the fit nor score as a mispricing.
  // Converting the vol-point floor into total variance:  w = σ²T  ⇒  dw ≈ 2σT·dσ.
  const ivTypical=median(pts.map(p=>p.iv));
  const volFloor=opts.minVolNoise==null?0.005:opts.minVolNoise;      // 0.5 vol point
  const sigFloor=2*(isFinite(ivTypical)&&ivTypical>0?ivTypical:0.5)*T*volFloor;

  for(let iter=0;iter<8;iter++){
    const s=Math.max(madSigma(res)||0,sigFloor);
    if(!isFinite(s)||s<=0)break;              // already an exact fit — nothing to robustify
    const cT=4.685*s;
    const cand=wt.map((p,i)=>{
      const u=res[i]/cT;
      return Math.abs(u)<1 ? p*(1-u*u)*(1-u*u) : 0;
    });
    if(cand.filter(x=>x>1e-12).length<minEff)break;
    const re=fitBy(order,cand);
    if(!re)break;
    const nres=w.map((y,i)=>y-wEval(re,k[i]));
    const moved=Math.max(...nres.map((r,i)=>Math.abs(r-res[i])));
    coef=re; res=nres; wt2=cand;
    if(moved<1e-14)break;                     // converged
  }

  // Butterfly sanity: negative curvature in total variance is not a tradeable smile.
  if(order===2&&coef.c<0){
    const re=wlsLinear(k,w,wt2);
    if(re){coef=re;out.arb.push('convexity_violation');res=w.map((y,i)=>y-wEval(coef,k[i]));}
  }

  const usedOrder = coef.c!==0?2:coef.b!==0?1:0;
  const hat=leverages(k,wt2,usedOrder);
  const residLOO=res.map((r,i)=>r/(1-hat[i]));      // studentized: removes self-influence
  const rmseW=Math.sqrt(res.reduce((s,r)=>s+r*r,0)/n);

  // Same floor as the rejection threshold above: on a chain that fits almost perfectly the
  // raw MAD collapses toward zero, and every sub-tick residual would read as a multi-sigma
  // "mispricing" — the screener firing hardest exactly where nothing is wrong.
  const sigRaw=madSigma(residLOO);
  const sig=Math.max(isFinite(sigRaw)?sigRaw:0,sigFloor);

  out.a=coef.a; out.b=coef.b; out.c=coef.c; out.order=usedOrder;
  out.hat=hat; out.resid=res; out.residLOO=residLOO;
  out.madSigma=sig; out.madSigmaRaw=sigRaw; out.sigmaFloored=sig>((isFinite(sigRaw)?sigRaw:0)+1e-18);
  // report rmse in VOL points (interpretable) rather than variance
  out.rmseVol = T>0 ? Math.sqrt(Math.max(0,rmseW)/T) : NaN;
  out.z = (isFinite(sig)&&sig>0) ? residLOO.map(r=>r/sig) : residLOO.map(()=>0);
  // n<5 means we could not fit curvature; the smile-residual signal must be
  // zero-weighted rather than emitting a confident-looking noise number.
  out.degraded = n<5;
  return out;
}

/* Evaluate a fit: total variance and IV at a given log-moneyness. */
function fitVariance(fit,k){ return fit.a+fit.b*k+fit.c*k*k; }
function fitIV(fit,k,T){
  const w=fitVariance(fit,k), t=T||fit.T;
  return (isFinite(w)&&w>0&&t>0)?Math.sqrt(w/t):NaN;
}

/* Invert delta → log-moneyness on a fitted smile, so bucket IV can be sampled at a
   FIXED delta (25Δ call, ATM, ...). Sampling "nearest contract" instead makes the 90d
   percentile series jump every strike/expiry roll, and those jumps read as fake extremes. */
function kForDelta(fit,targetDelta,kind,T,df){
  df=df==null?1:df;
  const call=kind==='call'||kind==='C'||kind==='c';
  const want=Math.abs(targetDelta);
  // delta is monotonic in k, so bisect.
  let lo=-3, hi=3;
  const deltaAt=k=>{
    const iv=fitIV(fit,k,T); if(!(iv>0))return NaN;
    const F=1, K=Math.exp(k);
    return Math.abs(greeks(call?'call':'put',F,K,T,iv,df).delta);
  };
  let dlo=deltaAt(lo), dhi=deltaAt(hi);
  if(!isFinite(dlo)||!isFinite(dhi))return NaN;
  // For calls delta falls as k rises; for puts |delta| rises. Orient the search.
  const rising = dhi>dlo;
  for(let i=0;i<80;i++){
    const mid=0.5*(lo+hi), dm=deltaAt(mid);
    if(!isFinite(dm))return NaN;
    if(Math.abs(dm-want)<1e-6)return mid;
    if((dm<want)===rising)lo=mid;else hi=mid;
  }
  return 0.5*(lo+hi);
}

/* Realized volatility — close-to-close, annualized. Used for signal #1 (IV − RV). */
function realizedVol(closes,periodsPerYear){
  if(!Array.isArray(closes)||closes.length<3)return NaN;
  const r=[];
  for(let i=1;i<closes.length;i++){
    const a=closes[i-1],b=closes[i];
    if(a>0&&b>0)r.push(Math.log(b/a));
  }
  if(r.length<2)return NaN;
  const m=r.reduce((s,x)=>s+x,0)/r.length;
  const v=r.reduce((s,x)=>s+(x-m)*(x-m),0)/(r.length-1);
  return Math.sqrt(v*(periodsPerYear||365));
}

/* ---------- probability the market itself is implying ----------
   Under Black-76 the forward price is the risk-neutral mean, so
     S_T = F·exp(σ√T·Z − σ²T/2),  Z ~ N(0,1)
   giving P(S_T > B) = N(d2) evaluated at B. This is the MARKET'S OWN ODDS implied by the
   option's price — not a forecast, and not a real-world probability (the two differ by the
   risk premium). It is the right number to quote as "what you are being offered", and it
   should always be cross-checked against what the coin has actually done. */
function probAbove(F,B,T,sigma){
  if(!(F>0)||!(B>0))return NaN;
  if(!(T>0)||!(sigma>0))return F>B?1:0;          // no time or no vol left: it is already decided
  const v=sigma*Math.sqrt(T);
  return NORM_CDF((Math.log(F/B)-0.5*v*v)/v);
}
const probBelow=(F,B,T,sigma)=>{const p=probAbove(F,B,T,sigma);return isFinite(p)?1-p:NaN;};

/* Percentile of `value` within `history` (0..100). The IV-percentile signal. */
function percentileOf(value,history){
  const h=(history||[]).filter(isFinite);
  if(!h.length||!isFinite(value))return NaN;
  let below=0;for(const x of h)if(x<value)below++;
  return 100*below/h.length;
}

module.exports={erf,NORM_CDF,NORM_PDF,black76,greeks,impliedVol,probAbove,probBelow,
  fitSmile,fitVariance,fitIV,kForDelta,realizedVol,percentileOf,
  madSigma,median,leverages,wlsQuadratic,wlsLinear,IV_LO,IV_HI};
