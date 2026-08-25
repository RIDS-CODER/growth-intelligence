/* ============================================================
   Growth Intelligence Platform — PRO (Upstox real-time)
   Zero npm dependencies. Node 18+ (global fetch). Built to Upstox API v2.
   Start:  double-click START-HERE.command   (or:  node server.js)
   Then open the URL it prints and click "Login with Upstox" once per day.
   ============================================================ */
"use strict";
const http=require("http"), fs=require("fs"), path=require("path"), zlib=require("zlib");

/* ---------- config (works locally AND when hosted on Render/any host) ---------- */
const CFG=(()=>{try{return JSON.parse(fs.readFileSync(path.join(__dirname,"config.json"),"utf8"));}catch{return{};}})();
const clean=v=>(!v||/PASTE_/i.test(v))?"":v;            // ignore placeholder values
const API_KEY   = clean(process.env.UPSTOX_KEY    || CFG.upstoxApiKey);
const API_SECRET= clean(process.env.UPSTOX_SECRET || CFG.upstoxApiSecret);
const PORT      = process.env.PORT || CFG.port || 5180;
// public base URL: env REDIRECT_URI > Render's auto URL > config > localhost
const PUBLIC_URL=(process.env.REDIRECT_URI ? process.env.REDIRECT_URI.replace(/\/callback\/?$/,"")
  : (process.env.RENDER_EXTERNAL_URL || CFG.publicUrl || `http://localhost:${PORT}`)).replace(/\/$/,"");
const REDIRECT  = PUBLIC_URL+"/callback";
// live whenever real API keys exist; demo only if explicitly set or no keys at all
const DEMO      = process.env.DEMO==="1" ? true : (API_KEY ? false : (CFG.demo===true));
const COINGECKO_KEY = clean(process.env.COINGECKO_KEY || CFG.coingeckoKey);   // free demo key → reliable server-side crypto
const TTL_DAILY = 5*60*1000, TTL_INTRA = 45*1000, TTL_CRYPTO = 40*1000;
const TOK_FILE  = path.join(__dirname,"token.json");
const INS_FILE  = path.join(__dirname,"instruments.json");

/* ============================================================
   INDICATOR ENGINE (verified)
   ============================================================ */
const IND={
  sma(a,p){const o=[];for(let i=0;i<a.length;i++){if(i<p-1){o.push(null);continue;}let s=0;for(let j=i-p+1;j<=i;j++)s+=a[j];o.push(s/p);}return o;},
  ema(a,p){const o=[];const k=2/(p+1);let prev=null;for(let i=0;i<a.length;i++){if(i<p-1){o.push(null);continue;}if(prev===null){let s=0;for(let j=i-p+1;j<=i;j++)s+=a[j];prev=s/p;}else{prev=a[i]*k+prev*(1-k);}o.push(prev);}return o;},
  rsi(a,p=14){const o=[];let g=0,l=0;for(let i=1;i<a.length;i++){const d=a[i]-a[i-1];if(i<=p){if(d>=0)g+=d;else l-=d;if(i===p){g/=p;l/=p;o[0]=null;for(let k=1;k<p;k++)o[k]=null;o[p]=100-100/(1+(l===0?100:g/l));}}else{const up=d>0?d:0,dn=d<0?-d:0;g=(g*(p-1)+up)/p;l=(l*(p-1)+dn)/p;o[i]=100-100/(1+(l===0?100:g/l));}}while(o.length<a.length)o.push(null);return o;},
  macd(a,f=12,s=26,sig=9){const ef=this.ema(a,f),es=this.ema(a,s);const line=a.map((_,i)=>(ef[i]!=null&&es[i]!=null)?ef[i]-es[i]:null);const valid=line.map(v=>v==null?0:v);const sg=this.ema(valid,sig).map((v,i)=>line[i]==null?null:v);const hist=line.map((v,i)=>(v!=null&&sg[i]!=null)?v-sg[i]:null);return{line,signal:sg,hist};},
  bollinger(a,p=20,m=2){const ma=this.sma(a,p);const up=[],lo=[];for(let i=0;i<a.length;i++){if(i<p-1){up.push(null);lo.push(null);continue;}let s=0;for(let j=i-p+1;j<=i;j++)s+=Math.pow(a[j]-ma[i],2);const sd=Math.sqrt(s/p);up.push(ma[i]+m*sd);lo.push(ma[i]-m*sd);}return{mid:ma,upper:up,lower:lo};},
  stoch(close,high,low,p=14,sm=3){const k=[];for(let i=0;i<close.length;i++){if(i<p-1){k.push(null);continue;}let hh=-Infinity,ll=Infinity;for(let j=i-p+1;j<=i;j++){hh=Math.max(hh,high[j]);ll=Math.min(ll,low[j]);}k.push(hh===ll?50:Math.max(0,Math.min(100,100*(close[i]-ll)/(hh-ll))));}const d=this.sma(k.map(v=>v==null?0:v),sm).map((v,i)=>k[i]==null?null:v);return{k,d};},
  roc(a,p=12){return a.map((v,i)=>i<p?null:100*(a[i]-a[i-p])/a[i-p]);},
  atr(close,high,low,p=14){const tr=[];for(let i=0;i<close.length;i++){if(i===0){tr.push(high[i]-low[i]);continue;}tr.push(Math.max(high[i]-low[i],Math.abs(high[i]-close[i-1]),Math.abs(low[i]-close[i-1])));}return this.ema(tr,p);},
  highest(a,p){const n=a.length;let h=-Infinity;for(let i=Math.max(0,n-p);i<n;i++)h=Math.max(h,a[i]);return h;},
  lowest(a,p){const n=a.length;let l=Infinity;for(let i=Math.max(0,n-p);i<n;i++)l=Math.min(l,a[i]);return l;},
  // ADX (Wilder) — trend strength. High (>~22) = trending; low = choppy/range. Returns array aligned to close.
  adx(close,high,low,p=14){const n=close.length,out=new Array(n).fill(null);
    if(n<2*p+2)return out;
    const tr=new Array(n).fill(0),pdm=new Array(n).fill(0),ndm=new Array(n).fill(0);
    for(let i=1;i<n;i++){const up=high[i]-high[i-1],dn=low[i-1]-low[i];
      tr[i]=Math.max(high[i]-low[i],Math.abs(high[i]-close[i-1]),Math.abs(low[i]-close[i-1]));
      pdm[i]=(up>dn&&up>0)?up:0; ndm[i]=(dn>up&&dn>0)?dn:0;}
    let atr=0,ap=0,an=0; const dx=new Array(n).fill(null);
    for(let i=1;i<n;i++){
      if(i<=p){atr+=tr[i];ap+=pdm[i];an+=ndm[i];continue;}
      atr=atr-atr/p+tr[i]; ap=ap-ap/p+pdm[i]; an=an-an/p+ndm[i];
      const pdi=atr?100*ap/atr:0, ndi=atr?100*an/atr:0, sum=pdi+ndi;
      dx[i]=sum?100*Math.abs(pdi-ndi)/sum:0;}
    let adxv=null,cnt=0,acc=0;
    for(let i=1;i<n;i++){if(dx[i]==null)continue;
      if(adxv===null){acc+=dx[i];cnt++; if(cnt===p){adxv=acc/p; out[i]=adxv;}}
      else {adxv=(adxv*(p-1)+dx[i])/p; out[i]=adxv;}}
    return out;},
};
function computeSignal(close,high,low,thr,vol,ctx){
  thr=thr||20;
  const n=close.length-1,price=close[n],out=[];
  const add=(name,detail,score,weight,raw)=>out.push({name,detail,score,weight,raw,tag:score>0.15?'BUY':score<-0.15?'SELL':'HOLD'});
  const len=close.length,slow=len>=210?200:Math.min(100,Math.floor(len/2));
  const s50=IND.sma(close,50),s200=IND.sma(close,slow);
  if(s50[n]!=null&&s200[n]!=null)add("Trend (50/"+slow+")","Long-term trend",Math.max(-1,Math.min(1,(s50[n]-s200[n])/s200[n]*15)),1.4,s50[n]>s200[n]?"up":"down");
  const e12=IND.ema(close,12),e26=IND.ema(close,26);
  if(e12[n]!=null&&e26[n]!=null)add("EMA 12/26","Momentum",Math.max(-1,Math.min(1,(e12[n]-e26[n])/e26[n]*25)),1.2,e12[n]>e26[n]?"bullish":"bearish");
  const rsi=IND.rsi(close,14);
  if(rsi[n]!=null){let r=rsi[n],sc=r<30?(30-r)/30:r>70?-(r-70)/30:(50-r)/50*0.4;add("RSI (14)","Overbought/oversold",Math.max(-1,Math.min(1,sc)),1.1,r.toFixed(1));}
  const m=IND.macd(close);
  if(m.hist[n]!=null)add("MACD","Trend strength",Math.max(-1,Math.min(1,m.hist[n]/price*200)),1.2,m.hist[n]>0?"+ve":"-ve");
  const bb=IND.bollinger(close);
  if(bb.upper[n]!=null){const pos=(price-bb.mid[n])/((bb.upper[n]-bb.lower[n])/2||1);add("Bollinger","Mean reversion",Math.max(-1,Math.min(1,-pos*0.7)),0.8,pos>1?"at upper":pos<-1?"at lower":"mid");}
  const st=IND.stoch(close,high,low);
  if(st.k[n]!=null){let k=st.k[n],sc=k<20?(20-k)/20:k>80?-(k-80)/20:(50-k)/50*0.3;if(st.d[n]!=null)sc+=(st.k[n]-st.d[n])/100;add("Stochastic","Oscillator",Math.max(-1,Math.min(1,sc)),0.7,k.toFixed(0));}
  const roc=IND.roc(close,12);
  if(roc[n]!=null)add("ROC (12)","Rate of change",Math.max(-1,Math.min(1,roc[n]/10)),0.9,roc[n].toFixed(1)+"%");
  // Trend regime: are we above the long-term line? (buy dips in uptrends, not downtrends)
  const s200n=s200[n];
  if(s200n!=null)add("Trend regime","Above/below the 200-line",price>s200n?1:-1,1.1,price>s200n?"above 200":"below 200");
  // Momentum turn: is the bounce actually starting? (MACD histogram rising AND stochastic %K back above %D)
  const turnUp = m.hist[n]!=null&&m.hist[n-1]!=null&&st.k[n]!=null&&st.d[n]!=null && m.hist[n]>m.hist[n-1] && st.k[n]>=st.d[n];
  const turnDn = m.hist[n]!=null&&m.hist[n-1]!=null&&st.k[n]!=null&&st.d[n]!=null && m.hist[n]<m.hist[n-1] && st.k[n]<=st.d[n];
  if(m.hist[n]!=null&&m.hist[n-1]!=null&&st.k[n]!=null&&st.d[n]!=null)add("Momentum turn","Bounce/rejection confirmation",turnUp?1:turnDn?-1:0,1.0,turnUp?"turning up":turnDn?"turning down":"flat");
  const prior=close.slice(0,n),hi20=IND.highest(prior,20),lo20=IND.lowest(prior,20);
  let wsum=0,ssum=0;out.forEach(o=>{wsum+=o.weight;ssum+=o.score*o.weight;});
  const score=wsum?Math.round(ssum/wsum*100):0;
  const brkUp=price>=hi20, brkDn=price<=lo20;
  const regimeUp = s200n!=null ? price>s200n : (s50[n]!=null&&s200[n]!=null ? s50[n]>s200[n] : true);
  const adxV = IND.adx(close,high,low,14)[n];              // trend strength
  const ADX_MIN = 20;                                      // below = choppy/range → skip pullback trades
  const confirmed = close[n]>close[n-1];                   // latest CLOSED bar ticked up = bounce confirmation (down for shorts)
  // Volume: is participation there? (only meaningful when volume data is available)
  const volMA = vol ? IND.sma(vol,20) : null;
  const volRatio = (volMA && volMA[n]>0 && vol && vol[n]!=null) ? vol[n]/volMA[n] : null;
  const volWeak = volRatio!=null && volRatio < 1.2;       // breakout needs ≥1.2× average volume; thin = fakeout
  // (REMOVED the BTC-weak "correction short" promotion: lowering the SELL bar forced a one-directional short bias that
  //  lost money across multiple days. Shorts and longs now clear the SAME threshold and quality gates — no forced side.)
  let verdict=score>=thr?'BUY':score<=-thr?'SELL':'HOLD';
  // TRADER GATES — buy the dip only in an uptrend, in a real trend, once the bounce confirms. Breakouts exempt (momentum).
  if(verdict==='BUY'  && !brkUp && !regimeUp) verdict='HOLD';                              // don't catch a falling knife
  if(verdict==='SELL' && !brkDn &&  regimeUp) verdict='HOLD';                              // don't short into strength
  if(verdict==='BUY'  && !brkUp && adxV!=null && adxV<ADX_MIN) verdict='HOLD';             // chop filter — no trade in a range
  if(verdict==='SELL' && !brkDn && adxV!=null && adxV<ADX_MIN) verdict='HOLD';
  if(verdict==='BUY'  && !brkUp && !confirmed && !turnUp) verdict='HOLD';                  // wait for a confirming up-close
  if(verdict==='SELL' && !brkDn && confirmed && !turnDn) verdict='HOLD';
  if(verdict==='BUY'  && brkUp && volWeak) verdict='HOLD';                                 // breakout on thin volume = fakeout
  if(verdict==='SELL' && brkDn && volWeak) verdict='HOLD';
  const btcWeakShort = false;                                                              // (correction-short promotion removed)
  const _sw=swingLevels(high,low,2,6);   // recent swing highs/lows for chart-level targets
  return {score,verdict,btcWeakShort,components:out,price,rsiV:rsi[n],s50:s50[n],s200:s200[n],atr:IND.atr(close,high,low)[n],hi20,lo20,regimeUp,turnUp,adx:adxV,volRatio,brkUp:price>=hi20,brkDn:price<=lo20,
    bbL:bb.lower[n],bbU:bb.upper[n],ema20:IND.ema(close,20)[n],lo10:IND.lowest(low,10),hi10:IND.highest(high,10),swHi:_sw.hs,swLo:_sw.ls};
}
// nearest support below price (for buy-the-dip entries) / resistance above (for shorts)
function nearestLevel(dir,price,atr,cands){
  if(dir>0){const c=cands.filter(v=>v!=null&&v<price);let s=c.length?Math.max(...c):price-0.8*atr;
    return Math.min(Math.max(s,price-3*atr), price-0.12*atr);}          // strictly below, not absurdly far
  const c=cands.filter(v=>v!=null&&v>price);let r=c.length?Math.min(...c):price+0.8*atr;
  return Math.max(Math.min(r,price+3*atr), price+0.12*atr);
}
// recent SWING highs/lows (k-bar fractal pivots), newest first — these are the real levels price reacts to
function swingLevels(high,low,k,keep){
  k=k||2; keep=keep||6; const n=high.length, hs=[], ls=[];
  for(let i=n-1-k;i>=k && (hs.length<keep||ls.length<keep);i--){
    let isH=true,isL=true;
    for(let j=1;j<=k;j++){ if(!(high[i]>high[i-j]&&high[i]>high[i+j])) isH=false; if(!(low[i]<low[i-j]&&low[i]<low[i+j])) isL=false; }
    if(isH&&hs.length<keep) hs.push(high[i]);
    if(isL&&ls.length<keep) ls.push(low[i]);
  }
  return {hs,ls};
}
// TARGETS at real chart levels: nearest structural levels in the trade direction (swings, range edges, bands, mean),
// within a reachable window, deduped and strictly progressing. Falls back to ATR steps only where structure is missing.
function structTargets(dir,entry,atr,sig,fbMults,R){
  const minD=0.4*atr, maxD=4.5*atr;                                   // near enough to matter, not absurdly far
  let cands=(dir>0
      ? [sig.ema20,sig.bbU,sig.hi10,sig.hi20,sig.s50].concat(sig.swHi||[])
      : [sig.ema20,sig.bbL,sig.lo10,sig.lo20,sig.s50].concat(sig.swLo||[]))
    .filter(v=>v!=null&&isFinite(v)&&(dir>0? (v-entry>=minD && v-entry<=maxD) : (entry-v>=minD && entry-v<=maxD)));
  cands.sort((a,b)=> dir>0 ? a-b : b-a);                              // nearest first
  const picked=[];
  for(const v of cands){ if(picked.every(p=>Math.abs(p-v)>=0.3*atr)) picked.push(v); if(picked.length>=3) break; }
  const step=Math.max(0.6*R,0.4*atr), out=[];
  for(let i=0;i<3;i++){
    let t = picked[i]!=null ? picked[i] : ((out.length?out[out.length-1]:entry) + dir*step);
    if(i>0 && (dir>0 ? t<=out[i-1] : t>=out[i-1])) t = out[i-1] + dir*step;   // enforce strict progression
    out.push(t);
  }
  return out;
}
function signalSince(close,high,low,times){
  const e12=IND.ema(close,12),e26=IND.ema(close,26),rsi=IND.rsi(close,14),mh=IND.macd(close).hist;
  const v=i=>{if(e12[i]==null||e26[i]==null||rsi[i]==null||mh[i]==null)return 'HOLD';if(e12[i]>e26[i]&&rsi[i]>=50&&mh[i]>0)return 'BUY';if(e12[i]<e26[i]&&rsi[i]<50&&mh[i]<0)return 'SELL';return 'HOLD';};
  const n=close.length-1,cur=v(n);let since=n;
  for(let i=n;i>=1;i--){if(v(i)!==cur){since=i+1;break;}if(i===1)since=1;}
  return {cur,sinceTime:times?times[Math.min(since,times.length-1)]:null,barsAgo:n-since};
}
const TYPE={Intraday:{stopMult:1.0,t:[1.0,1.8,2.6],hold:"Same session"},Scalp:{stopMult:0.7,t:[0.7,1.2,1.7],hold:"Minutes–a few hours (range)"},Swing:{stopMult:1.5,t:[1.5,2.8,4.5],hold:"3–15 trading days"},Breakout:{stopMult:1.3,t:[2.0,3.5,6.0],hold:"1–6 weeks"}};
/* ROUND-TRIP TRADING FRICTION — ONE OWNER.
   CoinDCX charges 0.5% taker each way and 10bps of slippage is generous on the liquid pairs, so a
   round trip costs 1.2% of notional before direction is even considered. The paper bot has always
   enforced this; the Breakout list needs the identical number, and a second copy in the browser
   would be a third place for it to drift. It ships in the scan payload instead, and a test asserts
   it matches paper.js's DEFAULTS. */
const TRADE_COST={feeBps:50,slipBps:10};
const roundTripPct=()=>2*(TRADE_COST.feeBps/10000+TRADE_COST.slipBps/10000)*100;
const ADX_SCALP=26;   // pullback with ADX below this = choppy/range → scalp small & tight, don't set trend-width targets
function buildSetup(sig,tf){
  const dir=sig.verdict==='SELL'?-1:1;
  // entryType decides WHERE we enter: Breakout = on the break near current price; else = pullback into support/resistance.
  let entryType;
  if(tf==='intraday')entryType=((sig.verdict==='BUY'&&sig.brkUp)||(sig.verdict==='SELL'&&sig.brkDn))?'Breakout':'Intraday';
  else entryType=(sig.verdict==='BUY'&&sig.brkUp)||(sig.verdict==='SELL'&&sig.brkDn)?'Breakout':'Swing';
  // GEOMETRY (stop/targets) is decided separately, so it can be quick-SCALP even on a breakout entry:
  //  • a BTC-led correction short → always scalp (bank the correction fast, don't ride it), even on a breakdown;
  //  • an intraday pullback while trend strength is weak (ADX < 26) = the coin is oscillating, not trending → scalp.
  // Strong trends (ADX ≥ 26) keep the wider targets so winners can run.
  const isBreak = entryType==='Breakout';
  const corrShort = !!sig.btcWeakShort && dir<0;
  const scalp = corrShort || (entryType==='Intraday' && (sig.adx==null || sig.adx < ADX_SCALP));
  const type = (scalp && !isBreak) ? 'Scalp' : entryType;   // label/entry-flag (breakout entries keep 'Breakout' for actionNow)
  const P=TYPE[scalp?'Scalp':entryType],atr=sig.atr,price=sig.price;   // scalp geometry when scalp, else the entry type's
  let eLo,eHi,anchor;
  if(isBreak){
    // momentum: enter on the break, near current price
    eLo=price;eHi=price+dir*0.45*atr;if(eLo>eHi){const t=eLo;eLo=eHi;eHi=t;}anchor=(eLo+eHi)/2;
  }else{
    // pullback: buy the DIP into support (long) / rally into resistance (short) — not the current price
    const cands = dir>0 ? [sig.lo10,sig.bbL,sig.ema20,sig.s50] : [sig.hi10,sig.bbU,sig.ema20,sig.s50];
    anchor = nearestLevel(dir,price,atr,cands);
    eLo=anchor-0.25*atr;eHi=anchor+0.25*atr;
  }
  const entry=anchor, R=P.stopMult*atr, stop=anchor-dir*R;   // stop sits BELOW support → accounts for a deeper fall
  // targets snap to the real chart levels price will actually react to (swings/range/bands), not arbitrary ATR points
  const targets=structTargets(dir,entry,atr,sig,P.t,R), ret=targets.map(t=>dir*(t-entry)/entry*100);
  const gap=dir*(entry-price)/price*100;                     // how far the ideal entry is from current price (−ve = below)
  const riskPct=Math.abs(dir*(stop-entry)/entry*100);
  // Suggested leverage CEILING: leverage so a stop-out costs ~15% of the margin blocked, capped by volatility.
  const volPct=atr/price*100;
  const cap = volPct>4 ? 3 : volPct>2 ? 4 : 5;               // more volatile → lower ceiling
  const suggestedLev = Math.max(1, Math.min(cap, Math.floor(15/Math.max(riskPct,0.1))));
  return {type,hold:P.hold,dir,entryLo:eLo,entryHi:eHi,entry,stop,targets,ret,rrr:(Math.abs(targets[0]-entry)/(Math.abs(entry-stop)||1)),atr,
    riskPct,entryGapPct:gap,support:dir>0?anchor:null,resistance:dir<0?anchor:null,suggestedLev,
    regime: corrShort?'correction':(scalp?'range':(isBreak?'breakout':'trend')),
    note: corrShort?'₿ Bitcoin is weak — QUICK SHORT to fade the correction: small targets, tight stop, bank fast. Don’t hold for a trend.':(scalp?'Small targets — this is ranging/choppy (weak trend), so scalp the swing and bank quick with a tight stop. Don’t hold for a big move.':null)};
}
function actionNow(sig,setup,since,fmt){
  const dir=setup.dir,p=sig.price,t=fmt(since.sinceTime),ago=since.barsAgo;
  const s=since.sinceTime?`Signal active since ${t} (${ago} bar${ago===1?'':'s'} ago)`:'';
  const d=v=>v<5?v.toFixed(4):v.toFixed(2);                       // price-appropriate decimals (crypto vs stocks)
  const gapN=Math.abs(setup.entryGapPct||0), gap=gapN.toFixed(1);
  const lo=setup.entryLo, hi=setup.entryHi, brk=setup.type==='Breakout';
  // Returns BOTH structured fields (so the client can render in ₹ or $) AND a ₹ text fallback (used for stocks).
  const R=(cls,kind,txt)=>({cls,kind,lo,hi,gap:gapN,brk,since:s,txt});
  if(sig.verdict==='HOLD')return R('wait','hold','⏸ NO TRADE — signals mixed, stay flat');
  if(dir>0){
    if(p>=lo&&p<=hi)return R('now','buynow',`🟢 BUY NOW — price is at the support/dip zone (₹${d(lo)}–${d(hi)})`);
    if(p>hi)return R('wait',brk?'buybreak':'waitdip',brk
      ? `🟢 BUY the breakout — ₹${d(lo)}–${d(hi)}`
      : `⏳ WAIT for the dip — set a buy limit at ₹${d(lo)}–${d(hi)} (support, ~${gap}% below now). Don't chase.`);
    return R('wait','belowsup',`⚠ Below support — price already broke the dip zone; let it stabilize, it may keep falling to the stop`);
  }
  if(p<=hi&&p>=lo)return R('exit','sellnow',`🔴 SELL / SHORT NOW — price is at the resistance zone (₹${d(lo)}–${d(hi)})`);
  if(p<lo)return R('exit',brk?'sellbreak':'waitbounce',brk
    ? `🔴 SELL the breakdown — ₹${d(hi)}–${d(lo)}`
    : `⏳ WAIT for the bounce — sell/short into ₹${d(lo)}–${d(hi)} (resistance, ~${gap}% above now)`);
  return R('exit','aboveres',`⚠ Above resistance — extended; wait for a pullback into the zone`);
}
// Setup CONFIDENCE — a 0–100 quality gauge (NOT a probability of profit). Blends how strong the signal is,
// how many higher timeframes agree, and how the setup graded historically; small bonus for a BTC-down macro
// (extra confirmation for a correction short) or a breakout on real volume.
function confidenceOf(sig,mtf,bt,setup){
  const conv  = Math.min(1, Math.abs(sig.score)/35);                 // signal strength (scores rarely exceed ~35)
  const agree = (mtf && mtf.total) ? mtf.agree/mtf.total : 0;        // multi-timeframe agreement
  const grade = (bt && bt.score!=null) ? bt.score/100 : 0.4;        // historical backtest grade (neutral 0.4 if none)
  let pct = 100*(0.45*conv + 0.30*agree + 0.25*grade);
  if(setup && setup.regime==='correction') pct += 6;                 // BTC-down macro = extra confirmation for the short
  if((sig.brkUp||sig.brkDn) && sig.volRatio!=null && sig.volRatio>=1.2) pct += 4;   // breakout on above-average volume
  pct = Math.max(3, Math.min(97, Math.round(pct)));
  return { pct, label: pct>=68?'High' : pct>=45?'Medium' : 'Low' };
}
function buildReasons(sig,setup,marketOpen,isCrypto){
  const dir=setup.dir,f=v=>v==null?'n/a':(+v).toFixed(2),forR=[],against=[],inval=[];
  sig.components.filter(c=>dir>0?c.tag==='BUY':c.tag==='SELL').forEach(c=>forR.push(`${c.name}: ${c.detail.toLowerCase()} (${c.raw??c.tag})`));
  if(dir>0&&sig.brkUp)forR.push(`Broke above the 20-bar high (momentum breakout)`);
  if(dir<0&&sig.brkDn)forR.push(`Broke below the 20-bar low (momentum breakdown)`);
  if(!forR.length)forR.push("Mixed signals — modest conviction.");
  sig.components.filter(c=>dir>0?c.tag==='SELL':c.tag==='BUY').forEach(c=>against.push(`${c.name} disagrees (${c.raw??c.tag})`));
  if(dir>0&&sig.rsiV>70)against.push(`RSI ${sig.rsiV.toFixed(0)} — overbought`);
  if(dir<0&&sig.rsiV<30)against.push(`RSI ${sig.rsiV.toFixed(0)} — oversold`);
  if(sig.atr/sig.price*100>4)against.push(`High volatility (ATR ${(sig.atr/sig.price*100).toFixed(1)}%)`);
  if(!isCrypto&&!marketOpen)against.push("Cash market closed — entry next session, gap risk.");
  if(!against.length)against.push("No major opposing indicator currently.");
  inval.push(`Close ${dir>0?'below':'above'} the Stop Loss (shown above)`);
  inval.push(`EMA 12 crosses ${dir>0?'below':'above'} EMA 26`);
  inval.push(dir>0?`RSI falls under 45`:`RSI rises above 55`);
  return {forR,against,inval};
}

/* ============================================================
   UNIVERSE
   ============================================================ */
const STOCK_SYMS=`RELIANCE TCS HDFCBANK INFY ICICIBANK SBIN BHARTIARTL ITC LT HINDUNILVR KOTAKBANK AXISBANK
BAJFINANCE MARUTI SUNPHARMA TATAMOTORS TITAN ULTRACEMCO NTPC POWERGRID WIPRO ADANIENT ADANIPORTS ASIANPAINT
HCLTECH TATASTEEL JSWSTEEL COALINDIA ONGC NESTLEIND TECHM BAJAJFINSV GRASIM HINDALCO DRREDDY CIPLA
EICHERMOT BPCL TATACONSUM INDUSINDBK VEDL DLF IRCTC DMART PIDILITIND SIEMENS BEL APOLLOHOSP BRITANNIA
CANBK DABUR HAVELLS HEROMOTOCO INDIGO IOC JINDALSTEL LICI LTIM LUPIN MARICO MOTHERSON NMDC PFC PNB
RECLTD SAIL SBICARD SBILIFE SRF TATAPOWER TRENT TVSMOTOR
ABB AMBUJACEM AUROPHARMA BAJAJ-AUTO BANKBARODA BERGEPAINT BIOCON BOSCHLTD CHOLAFIN COLPAL CONCOR
COFORGE CUMMINSIND DIVISLAB GAIL GODREJCP GODREJPROP HDFCAMC HDFCLIFE ICICIGI ICICIPRULI IDFCFIRSTB
IGL INDHOTEL INDUSTOWER JUBLFOOD MFSL MUTHOOTFIN NAUKRI OBEROIRLTY OFSS PAGEIND PEL PERSISTENT
PETRONET PIIND POLYCAB SHREECEM SHRIRAMFIN TORNTPHARM UBL UPL VBL ZYDUSLIFE ABBOTINDIA ACC ALKEM
ASHOKLEY ASTRAL AUBANK BALKRISIND BHARATFORG BHEL CGPOWER CROMPTON ESCORTS EXIDEIND FEDERALBNK HAL
IPCALAB IRFC JSWENERGY LTTS MAXHEALTH MRF NHPC OIL SUPREMEIND TATACOMM TATAELXSI TORNTPOWER YESBANK`.split(/\s+/).filter(Boolean);
const STOCKS=STOCK_SYMS.map(s=>({sym:s+".NS",ts:s,name:s,cls:"Stock",src:"upstox"}));
const ETF_SYMS=["NIFTYBEES","BANKBEES","JUNIORBEES","ITBEES","GOLDBEES","SILVERBEES","MON100","MAFANG","PSUBNKBEES","PHARMABEES"];
const ETFS=ETF_SYMS.map(s=>({sym:s+".NS",ts:s,name:s,cls:"ETF/Index",src:"upstox"}));
// indices: stable Upstox instrument keys
const INDICES=[
  {sym:"^NSEI",name:"NIFTY 50",key:"NSE_INDEX|Nifty 50",cls:"ETF/Index",src:"upstox",isIndex:true},
  {sym:"^NSEBANK",name:"Bank NIFTY",key:"NSE_INDEX|Nifty Bank",cls:"ETF/Index",src:"upstox",isIndex:true},
  {sym:"^BSESN",name:"SENSEX",key:"BSE_INDEX|SENSEX",cls:"ETF/Index",src:"upstox",isIndex:true},
];
// Commodities: gold/silver ETF proxies (reliable, NSE equity segment) + MCX near-month futures (resolved live)
const COMMODITY_ETF=[["GOLDBEES","Gold ETF (GOLDBEES)"],["SILVERBEES","Silver ETF (SILVERBEES)"]]
  .map(([ts,name])=>({sym:ts+".NS",ts,name,cls:"Commodity",src:"upstox"}));
const MCX_LIST=["GOLD","GOLDM","SILVER","SILVERM","CRUDEOIL","CRUDEOILM","NATURALGAS","NATGASMINI","COPPER","ZINC","ALUMINIUM","NICKEL","LEAD"];
let COMMODITIES=[...COMMODITY_ETF];   // replaced with [...MCX, ...ETF] once MCX is resolved
// Crypto via Binance public market data (no key, native OHLC at every timeframe). Fallback list for DEMO / first load.
let CRYPTO=[["BTCUSDT","BTC"],["ETHUSDT","ETH"],["SOLUSDT","SOL"],["XRPUSDT","XRP"],["BNBUSDT","BNB"],["DOGEUSDT","DOGE"],
 ["ADAUSDT","ADA"],["TRXUSDT","TRX"],["LINKUSDT","LINK"],["DOTUSDT","DOT"],["MATICUSDT","POL"],["LTCUSDT","LTC"]
].map(([sym,tk])=>({sym,binance:sym,tk,name:tk,cls:"Crypto",src:"cg"}));
// exclude stablecoins / fiat / leveraged tokens (pegged or synthetic — no tradeable signal)
const STABLE_TK=new Set(["USDT","USDC","FDUSD","TUSD","BUSD","DAI","USDP","USDD","PYUSD","EUR","GBP","AEUR","USDE","USD1","EURI","XUSD"]);
function universeFor(tab){
  const stocks=STOCKS, etfidx=[...ETFS,...INDICES];
  if(tab==="Stocks")return stocks;
  if(tab==="ETFs / Indices")return etfidx;
  if(tab==="Commodities")return COMMODITIES;
  if(tab==="Crypto")return CRYPTO;
  const all=[...stocks,...etfidx,...COMMODITIES,...CRYPTO],seen=new Set();
  return all.filter(a=>seen.has(a.sym)?false:(seen.add(a.sym),true));   // dedupe (gold/silver appear in ETFs + Commodities)
}

/* ============================================================
   UPSTOX: auth, instruments, candles, quotes
   ============================================================ */
function loadToken(){const today=istDate();try{const t=JSON.parse(fs.readFileSync(TOK_FILE,"utf8"));return t.date===today?t:null;}catch{return null;}}
function saveToken(tok){fs.writeFileSync(TOK_FILE,JSON.stringify({access_token:tok,date:istDate()}));}
function loggedIn(){return DEMO||!!loadToken();}
function authURL(){return `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${encodeURIComponent(API_KEY)}&redirect_uri=${encodeURIComponent(REDIRECT)}`;}
async function exchangeCode(code){
  const body=new URLSearchParams({code,client_id:API_KEY,client_secret:API_SECRET,redirect_uri:REDIRECT,grant_type:"authorization_code"});
  const r=await fetch("https://api.upstox.com/v2/login/authorization/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json"},body});
  const j=await r.json();
  if(!j.access_token)throw new Error("Token exchange failed: "+JSON.stringify(j).slice(0,200));
  return j.access_token;
}
function authHeaders(){const t=loadToken();return {"Authorization":"Bearer "+(t?t.access_token:""),"Accept":"application/json"};}

let insMap=null, insDate=null;
async function ensureInstruments(){
  if(DEMO)return {};
  const today=istDate();
  if(insMap&&insDate===today)return insMap;
  try{const c=JSON.parse(fs.readFileSync(INS_FILE,"utf8"));if(c.date===today){insMap=c.map;insDate=today;return insMap;}}catch{}
  const r=await fetch("https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz");
  if(!r.ok)throw new Error("instrument download failed");
  const buf=Buffer.from(await r.arrayBuffer());
  const arr=JSON.parse(zlib.gunzipSync(buf).toString());
  const map={};
  for(const it of arr){
    const seg=it.segment||it.exchange, type=(it.instrument_type||"").toUpperCase();
    const tsym=it.trading_symbol||it.tradingsymbol||it.name;
    const key=it.instrument_key;
    if(!tsym||!key)continue;
    if(seg==="NSE_EQ"&&(type==="EQ"||type==="")) map["EQ:"+tsym.toUpperCase()]=key;
  }
  insMap=map;insDate=today;
  try{fs.writeFileSync(INS_FILE,JSON.stringify({date:today,map}));}catch{}
  return map;
}
function keyForAsset(asset){
  if(asset.key)return asset.key;                 // indices / MCX preset
  return (insMap&&insMap["EQ:"+asset.ts.toUpperCase()])||null;
}
// MCX: resolve the nearest-expiry futures contract per commodity (auto-rolls each month)
let mcxCache=null,mcxDate=null;
async function ensureMcx(){
  if(DEMO)return MCX_LIST.slice(0,8).map(u=>({sym:'MCX:'+u,name:u+' (MCX)',key:'DEMO|'+u,cls:'Commodity',src:'upstox',isCommodity:true}));
  const today=istDate();
  if(mcxCache&&mcxDate===today)return mcxCache;
  try{
    const r=await fetch("https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz");
    if(!r.ok)throw new Error("mcx http");
    const arr=JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString());
    const now=Date.now(),best={};
    for(const it of arr){
      const type=(it.instrument_type||"").toUpperCase();
      if(!type.startsWith("FUT"))continue;
      const asset=(it.asset_symbol||it.underlying_symbol||it.name||"").toUpperCase();
      if(!MCX_LIST.includes(asset))continue;
      const exp=Number(it.expiry)||Date.parse(it.expiry)||0;
      if(exp&&exp<now-864e5)continue;                 // skip already-expired
      if(!best[asset]||(exp&&exp<best[asset].exp)) best[asset]={key:it.instrument_key,exp:exp||Infinity,name:asset};
    }
    const list=Object.values(best).map(b=>({sym:'MCX:'+b.name,name:b.name+' (MCX)',key:b.key,cls:'Commodity',src:'upstox',isCommodity:true,expiry:b.exp}));
    if(list.length){mcxCache=list;mcxDate=today;}
    return mcxCache||[];
  }catch(e){return mcxCache||[];}    // MCX data not accessible → empty; ETF proxies still fill the tab
}
async function ensureCommodities(){
  let mcx=[];try{mcx=await ensureMcx();}catch(e){}
  COMMODITIES=[...mcx,...COMMODITY_ETF];
  return COMMODITIES;
}
// Upstox API V3 timeframes. hours max 5 → 6h/12h are resampled from 1h.
// Higher timeframes used to CONFIRM a signal (resampled from the same candles — no extra fetch). [label, ×factor]
const CONFIRM={
  "5m":[["15m",3],["30m",6]],
  "15m":[["30m",2],["1h",4]],
  "30m":[["1h",2],["4h",8]],
  "1h":[["4h",4],["6h",6]],
  "4h":[["12h",3],["1D",6]],
  "daily":[]
};
const TF_MAP={
  "5m" :{unit:"minutes",interval:5, days:12},
  "15m":{unit:"minutes",interval:15,days:30},
  "30m":{unit:"minutes",interval:30,days:50},
  "1h" :{unit:"hours",  interval:1, days:100},
  "4h" :{unit:"hours",  interval:4, days:300},
  "6h" :{unit:"hours",  interval:1, days:180,resample:6},
  "12h":{unit:"hours",  interval:1, days:200,resample:12},
  "daily":{unit:"days", interval:1, days:500},
  // legacy aliases
  "intraday":{unit:"minutes",interval:30,days:50},
};
function tfCfg(tf){return TF_MAP[tf]||TF_MAP["30m"];}
function resampleSeries(d,f){
  if(!f||f<=1)return d;
  const close=[],high=[],low=[],times=[],vol=[]; const hv=d.vol&&d.vol.length===d.close.length;
  for(let i=0;i<d.close.length;i+=f){const end=Math.min(i+f,d.close.length);let hi=-Infinity,lo=Infinity,vv=0;
    for(let j=i;j<end;j++){hi=Math.max(hi,d.high[j]);lo=Math.min(lo,d.low[j]);if(hv)vv+=(+d.vol[j]||0);}
    close.push(d.close[end-1]);high.push(hi);low.push(lo);times.push(d.times[end-1]);if(hv)vol.push(vv);}
  return {close,high,low,times,vol:hv?vol:undefined,price:close[close.length-1],mtime:d.mtime};
}
async function upstoxCandles(key,tf){
  const cfg=tfCfg(tf), to=ymd(new Date()), from=ymd(new Date(Date.now()-cfg.days*864e5));
  const url=`https://api.upstox.com/v3/historical-candle/${encodeURIComponent(key)}/${cfg.unit}/${cfg.interval}/${to}/${from}`;
  let d=parseCandles(await getJSON(url,authHeaders()));
  if(cfg.resample)d=resampleSeries(d,cfg.resample);
  return d;
}
function parseCandles(j){
  const c=j&&j.data&&j.data.candles||[];
  // Upstox returns most-recent-first: [ts,o,h,l,c,vol,oi]
  const rows=c.slice().reverse();
  const close=[],high=[],low=[],times=[],vol=[];
  for(const r of rows){const cl=+r[4];if(!isFinite(cl))continue;close.push(cl);high.push(+r[2]);low.push(+r[3]);times.push(Date.parse(r[0]));vol.push(+r[5]||0);}
  return {close,high,low,times,vol,price:close[close.length-1]};
}
async function upstoxLTP(keys){
  // batched live last-traded price; keys = array of instrument_key
  const out={};
  for(let i=0;i<keys.length;i+=80){
    const chunk=keys.slice(i,i+80);
    const url=`https://api.upstox.com/v2/market-quote/ltp?instrument_key=${chunk.map(encodeURIComponent).join(",")}`;
    try{const j=await getJSON(url,authHeaders());const d=j&&j.data||{};
      for(const k in d){const v=d[k];if(v&&v.instrument_token&&isFinite(v.last_price))out[v.instrument_token]=v.last_price;}}catch(e){}
  }
  return out;
}

/* ---------- Crypto: CoinDCX (INR-native, no key) primary · Binance (USDT×FX) fallback ---------- */
const CG_TOP=parseInt(process.env.CRYPTO_TOP)||parseInt(CFG.cryptoTop)||120;
let cgOk=false, cryptoMode="binance";   // set to 'coindcx' when CoinDCX is reachable
// CoinDCX public endpoints (no auth)
const CDX_INT={"5m":"5m","15m":"15m","30m":"30m","1h":"1h","4h":"4h","6h":"6h","12h":"12h","daily":"1d","intraday":"30m"};
let cdxTicker={},cdxTickerAt=0;
async function cdxGetTicker(){const t=await getJSON("https://api.coindcx.com/exchange/ticker",{});if(!Array.isArray(t))throw new Error("cdx ticker");
  const snap={};t.forEach(x=>{if(x.market)snap[x.market]=+x.last_price;});cdxTicker=snap;cdxTickerAt=Date.now();
  /* Feed the momentum detector from the request we were making anyway. This ONE call carries every
     market on the exchange, and it already runs every few seconds to price live quotes — so
     recording it gives sub-minute momentum across the whole book at zero additional API cost, and
     without the forming-bar lag or the top-120 universe limit the candle path has. Wrapped because
     a fault in a secondary feature must never break quote pricing. */
  try{ intel.momentum.record(t); }catch(e){}
  return t;}
// Ensure the live CoinDCX ticker is recent before we pin prices (prevents stale prices on fast-moving coins)
async function ensureCdxFresh(maxMs=12000){if(Date.now()-cdxTickerAt>maxMs){try{await cdxGetTicker();}catch(e){}}}
// CoinDCX's own USDT→INR rate (what its app uses to price coins)
function cdxUsdtInr(){const u=cdxTicker["USDTINR"];if(u>0)return u;const bi=cdxTicker["BTCINR"],bu=cdxTicker["BTCUSDT"];return (bi>0&&bu>0)?bi/bu:0;}
/* The exchange's OWN USDT price for a coin — the number on its USDT screen, untouched.
   $ used to be reconstructed as ₹ ÷ rate. That is only exact while the rate dividing is the same
   rate that multiplied, and it was not: this server reads USDTINR first and falls back to the BTC
   ratio, while the browser did the opposite. Two formulas, both labelled 'coindcx', both writing
   one shared rate — so ₹ built by one got divided by the other and the cancellation broke.
   Carrying the real number means no rate can corrupt it. */
function cdxLiveUsd(base){const u=cdxTicker[base+"USDT"];return u>0?u:0;}
/* THE EXCHANGE'S OWN USDT MARKET, BY NAME.
   Candles used to come from the thin I-<BASE>_INR pair and then get rescaled so only the LAST bar
   matched the liquid USDT market. Every level below that bar — entry, stop, every target — was
   therefore the INR market's shape, and the $ view divided it by a rate to get back to dollars:
   two conversions where the right answer is none. CoinDCX publishes the USDT market's candles
   under its own pair id, so we read that instead and nothing has to be reconstructed.
   The pair string comes from markets_details rather than being guessed, because a guessed id
   fails silently into the old behaviour and looks like nothing happened. */
let cdxPairs=null,cdxPairsAt=0;
async function cdxMarketPairs(){
  if(cdxPairs&&Date.now()-cdxPairsAt<3600e3)return cdxPairs;
  const j=await getJSON("https://api.coindcx.com/exchange/v1/markets_details",{});
  if(!Array.isArray(j))throw new Error("markets_details");
  /* A coin can be listed on SEVERAL USDT books at once, one per ecode: B- (Binance-backed, deep),
     HB-, I- and so on. Taking whichever appeared last in the list is how a live coin ends up
     pointed at a delisted or illiquid book whose candles come back empty — which then throws, and
     the caller falls back to the INR pair with nothing to say about why. Rank instead: an active
     market beats an inactive one, and B beats everything else. */
  const RANK={B:3,HB:2,I:1};
  const score=m=>(String(m.status||"active")==="active"?10:0)+(RANK[String(m.pair||"").split("-")[0]]||0);
  const map={},best={};
  for(const m of j){
    const base=m.target_currency_short_name, quote=m.base_currency_short_name, pair=m.pair;
    if(!base||!quote||!pair)continue;
    if(quote!=="USDT"&&quote!=="INR")continue;
    const k=base+"|"+quote, s=score(m);
    if(best[k]!=null&&best[k]>=s)continue;
    best[k]=s; map[base]=map[base]||{};
    map[base][quote==="USDT"?"usdt":"inr"]=pair;
  }
  cdxPairs=map;cdxPairsAt=Date.now();return map;
}
// The live ₹ price the CoinDCX APP shows: liquid USDT market × CoinDCX USDT/INR. Falls back to the INR last-trade.
function cdxLiveInr(base){const u=cdxTicker[base+"USDT"],r=cdxUsdtInr();if(u>0&&r>0)return u*r;const i=cdxTicker[base+"INR"];return i>0?i:0;}
// Binance fallback
const BN_HOSTS=["https://data-api.binance.vision","https://api.binance.com","https://api-gcp.binance.com"];
const BN_INT={"5m":"5m","15m":"15m","30m":"30m","1h":"1h","4h":"4h","6h":"6h","12h":"12h","daily":"1d","intraday":"30m"};
async function binanceGet(pathq){let last;for(const h of BN_HOSTS){try{return await getJSON(h+pathq,{});}catch(e){last=e;}}throw last||new Error("binance unreachable");}
let fxRate=null,fxAt=0;
async function usdInr(){
  if(fxRate&&Date.now()-fxAt<6*3600e3)return fxRate;
  const tries=[async()=>{const j=await getJSON("https://open.er-api.com/v6/latest/USD",{});return j&&j.rates&&j.rates.INR;},
    async()=>{const j=await getJSON("https://api.frankfurter.app/latest?from=USD&to=INR",{});return j&&j.rates&&j.rates.INR;}];
  for(const t of tries){try{const r=await t();if(r>0){fxRate=r;fxAt=Date.now();return r;}}catch(e){}}
  return fxRate||86;
}
// THE rate this server used to build the ₹ prices it is serving. The UI divides by exactly this to show $ USDT,
// so the round trip is lossless: coindcx mode → CoinDCX's own USDT/INR; global mode → the FX rate used by loadBinance.
// Reporting 0 here (as this used to in global mode) made the UI substitute CoinDCX's rate against Binance-derived ₹,
// which understated every $ price by the India premium (~1–4%).
function priceRate(){
  if(cryptoMode==='coindcx'){const r=cdxUsdtInr(); if(r>0)return r;}
  return fxRate||0;
}
// 'coindcx' = ₹ and $ both exact vs CoinDCX · 'fx' = $ exact vs the global market, ₹ runs ~1–4% under CoinDCX (India premium)
function priceRateSrc(){return (cryptoMode==='coindcx'&&cdxUsdtInr()>0)?'coindcx':'fx';}
/* HOW OLD this rate reading is, in milliseconds — a DURATION, not a timestamp.
   The browser used to order rate updates by comparing our `rateAt` (this machine's clock) against
   stamps it had written with its own Date.now(). Two clocks feeding one variable: a browser running
   even slightly ahead of the server judged every later server reading "older" and dropped it for
   good, freezing the rate while ₹ kept ticking — the exact drift the ordering exists to prevent.
   An age survives the clock difference: the browser subtracts it from its own now. */
function priceRateAge(){
  const t=(cryptoMode==='coindcx'&&cdxUsdtInr()>0)?cdxTickerAt:fxAt;
  return t?Math.max(0,Date.now()-t):0;
}
/* THE RATE IS NEVER CACHED, even when the payload around it is.
   Every heavy endpoint is cached — scan and movers for 40s, the backtest for 10 min, 🎢 Dump &
   Bounce for 30 MINUTES — and each used to bake `usdtInr` into the cached object. The browser
   keeps ONE global rate on last-writer-wins, so a Dump & Bounce refresh could overwrite it with a
   rate half an hour old, and every panel then divided a FRESH ₹ price by a STALE rate: ₹ looked
   correct while $ drifted. Reading the rate costs nothing, so it is re-stamped on the way out —
   cache hit or not — and carries `rateAge` so the browser can reject an out-of-order update
   without having to trust that our clock and its clock agree. */
function withLiveRate(o){ return {...o, usdtInr:priceRate(), rateSrc:priceRateSrc(), rateAge:priceRateAge(), rateAt:Date.now()}; }
const isStableBase=b=>STABLE_TK.has(b)||/(UP|DOWN|BULL|BEAR)$/.test(b)||/^\d/.test(b);
// CoinGecko fallback — works from ANY server region (incl. US), INR native. Uses your demo key if set.
const cgHeaders=()=>COINGECKO_KEY?{"x-cg-demo-api-key":COINGECKO_KEY}:{};
let geckoMap={};
async function geckoLoadUniverse(){
  const per=Math.min(250,CG_TOP);
  const arr=await getJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=inr&order=market_cap_desc&per_page=${per}&page=1&sparkline=true&price_change_percentage=24h`,cgHeaders());
  if(!Array.isArray(arr))throw new Error("gecko markets");
  const list=[],map={};
  arr.forEach(it=>{
    if(isStableBase((it.symbol||"").toUpperCase()))return;
    let close=((it.sparkline_in_7d&&it.sparkline_in_7d.price)||[]).slice();
    if(close.length<60||!(it.current_price>0))return;
    // sparkline may come back in USD even when vs_currency=inr → normalize the WHOLE series to end at the live INR price
    const lastSp=close[close.length-1];
    if(lastSp>0){const f=it.current_price/lastSp; close=close.map(v=>v*f);}
    close[close.length-1]=it.current_price;
    const mtime=it.last_updated?Date.parse(it.last_updated):Date.now();
    list.push({sym:it.id,tk:(it.symbol||"").toUpperCase(),name:it.name,cls:"Crypto",src:"cg"});
    map[it.id]={close,price:it.current_price,mtime};
  });
  if(list.length>=8){CRYPTO=list;geckoMap=map;}
  return list;
}
function loadGecko(asset,tf){
  const d=geckoMap[asset.sym]; if(!d)throw new Error("no gecko data");
  const f={"4h":4,"6h":4,"12h":4}[tf]||1;                        // 7d hourly base → cap coarse frames at 4h
  const close=d.close.slice(), now=d.mtime;
  const s={close,high:close.slice(),low:close.slice(),times:close.map((_,i)=>now-(close.length-1-i)*36e5),price:d.price,mtime:now};
  return f>1?resampleSeries(s,f):s;
}
let cryUniAt=0;
async function ensureCryptoUniverse(){
  if(DEMO){cgOk=true;cryptoMode="binance";return CRYPTO;}
  if(cryUniAt&&Date.now()-cryUniAt<600000)return CRYPTO;
  // 1) Prefer CoinDCX — real INR prices, no key
  try{
    const t=await cdxGetTicker();
    const rows=t.filter(x=>x.market&&x.market.endsWith("INR"))
      .map(x=>{const base=x.market.slice(0,-3);return {market:x.market,base,last:+x.last_price,vol:(+x.volume||0)*(+x.last_price||0)};})
      .filter(r=>r.last>0&&!isStableBase(r.base)).sort((a,b)=>b.vol-a.vol).slice(0,CG_TOP);
    if(rows.length>=8){
      CRYPTO=rows.map(r=>({sym:r.market,pair:"I-"+r.base+"_INR",binance:r.base+"USDT",tk:r.base,name:r.base,cls:"Crypto",src:"cg"}));
      cryptoMode="coindcx";cryUniAt=Date.now();cgOk=true;return CRYPTO;
    }
  }catch(e){/* CoinDCX unreachable (geo?) → next source */}
  // 2) Binance (only works if the server is NOT in a US region)
  try{
    const arr=await binanceGet("/api/v3/ticker/24hr");if(!Array.isArray(arr))throw new Error("bad ticker");
    const rows=arr.filter(t=>t.symbol&&t.symbol.endsWith("USDT")).map(t=>({sym:t.symbol,tk:t.symbol.slice(0,-4),qv:+t.quoteVolume||0}))
      .filter(r=>!isStableBase(r.tk)).sort((a,b)=>b.qv-a.qv).slice(0,CG_TOP);
    if(rows.length>=8){CRYPTO=rows.map(r=>({sym:r.sym,binance:r.sym,tk:r.tk,name:r.tk,cls:"Crypto",src:"cg"}));cryUniAt=Date.now();}
    cryptoMode="binance";cgOk=true;
  }catch(e){cgOk=false;}
  return CRYPTO;
}
// dispatcher
async function loadCrypto(asset,tf){
  if(DEMO){let h=0;for(const ch of asset.sym)h=(h*31+ch.charCodeAt(0))>>>0;return synth(h,300,0.03);}
  if(cryptoMode==="coindcx" && asset.pair){
    try{ return await loadCoinDCX(asset,tf); }
    catch(e){ if(asset.binance) return await loadBinance(asset,tf); throw e; }
  }
  return loadBinance(asset,tf);
}
async function cdxRawCandles(pair,interval){
  const j=await getJSON(`https://public.coindcx.com/market_data/candles?pair=${encodeURIComponent(pair)}&interval=${interval}&limit=1000`,{});
  if(!Array.isArray(j)||!j.length)throw new Error("no candles");
  const rows=j.slice().reverse();  // CoinDCX returns newest-first → ascending
  const close=[],high=[],low=[],times=[],vol=[];
  for(const k of rows){const c=+k.close;if(!isFinite(c))continue;close.push(c);high.push(+k.high);low.push(+k.low);times.push(+k.time);vol.push(+k.volume||0);}
  if(!close.length)throw new Error("no candles");
  return {close,high,low,times,vol};
}
/* NOT ENOUGH HISTORY IS NOT A REASON TO CHANGE MARKET.
   The engine needs 41 closed bars. A young listing does not have 41 of them at 4h or 1D yet — ten
   days old is ~336 bars at 1h but only 60 at 4h and 10 at 1D — so the same coin took the USDT
   market on fast timeframes and fell to the INR pair on slow ones. Swapping markets "fixes" the
   bar count by moving to a different price curve, which is the very thing the USDT market was
   adopted to avoid. Roll the SAME book up from a finer interval instead.
   The browser demanded 41 bars while this loader demanded only 1 — two rules for one decision, and
   the browser's is the one that runs on the Crypto tab. They agree now. */
const CDX_FINER={"15m":["5m",3],"30m":["5m",6],"1h":["15m",4],"4h":["1h",4],"6h":["1h",6],"12h":["1h",12],"1d":["4h",6]};
async function cdxCandles(pair,interval){
  let d=null;
  try{ d=await cdxRawCandles(pair,interval); }catch(e){}
  if(d&&d.close.length>=41)return d;
  const f=CDX_FINER[interval];
  if(f){
    try{ const fine=await cdxRawCandles(pair,f[0]);
      if(fine&&fine.close.length>=41*f[1]*0.5){
        const up=resampleSeries({...fine,mtime:Date.now()},f[1]);
        if(up&&up.close.length>=41)return {close:up.close,high:up.high,low:up.low,times:up.times,vol:up.vol||fine.vol};
      }
    }catch(e){}
  }
  if(d&&d.close.length>=41)return d;
  throw new Error("under 41 bars at "+interval+" (even rolled up from finer)");
}
async function loadCoinDCX(asset,tf){
  const interval=CDX_INT[tf]||"1h";
  const rate=cdxUsdtInr();
  /* PREFERRED: the coin's own USDT market on CoinDCX. The series then IS the exchange's series —
     nothing is rescaled, nothing is reconstructed, and ₹ is one multiplication by CoinDCX's own
     USDT/INR, exactly the arithmetic the CoinDCX app performs. Dividing that ₹ by the same scalar
     returns the venue's dollar figure precisely rather than approximately. */
  /* WHY the USDT market was not used, recorded rather than swallowed. Every branch below used to
     fall through into the INR pair silently, so a coin that plainly HAS a USDT market on CoinDCX
     would show "INR pair" with no way — from the app or from the code — to tell which step gave
     up. Four different causes look identical on screen unless they are named. */
  let usdtPair=null, inrWhy="";
  try{
    const m=await cdxMarketPairs();
    usdtPair=(m[asset.tk]||{}).usdt||null;
    if(!usdtPair)inrWhy="no USDT market listed for "+asset.tk;
  }catch(e){ inrWhy="markets_details unreachable: "+String(e.message||e).slice(0,60); }
  if(usdtPair&&!(rate>0))inrWhy="no USDT/INR rate yet";
  if(usdtPair&&rate>0){
    try{
      const s=await cdxCandles(usdtPair,interval);
      const liveUsd=cdxLiveUsd(asset.tk);
      if(liveUsd>0)s.close[s.close.length-1]=liveUsd;      // pin the forming bar to the live tick
      const close=s.close.map(v=>v*rate), high=s.high.map(v=>v*rate), low=s.low.map(v=>v*rate);
      return {close,high,low,times:s.times,vol:s.vol,
        price:close[close.length-1], priceUsd:s.close[s.close.length-1],
        rateUsed:rate, pairUsed:"usdt", mtime:Date.now()};
    }catch(e){ inrWhy=usdtPair+" candles failed: "+String(e.message||e).slice(0,60); }
  }
  /* FALLBACK: no USDT market for this coin (or markets_details unreachable). The INR pair is thin,
     so its last trade can be stale — pin the series to the USDT-derived live price as before, and
     say which pair was used so a silent downgrade is visible rather than assumed. */
  const s=await cdxCandles(asset.pair,interval);
  const {close,high,low}=s;
  const live=cdxLiveInr(asset.tk)||(cdxTicker[asset.sym]>0?cdxTicker[asset.sym]:0);
  const rawLast=close[close.length-1];
  if(live>0&&rawLast>0){const f=live/rawLast; if(f>0.2&&f<5){for(let i=0;i<close.length;i++){close[i]*=f;high[i]*=f;low[i]*=f;}} else {close[close.length-1]=live;}}
  return {close,high,low,times:s.times,vol:s.vol,price:close[close.length-1],
    priceUsd:cdxLiveUsd(asset.tk), rateUsed:rate||undefined, pairUsed:"inr",
    inrWhy:inrWhy||undefined, mtime:Date.now()};
}
async function loadBinance(asset,tf){
  const interval=BN_INT[tf]||"1h";
  const j=await binanceGet(`/api/v3/klines?symbol=${asset.binance}&interval=${interval}&limit=400`);
  if(!Array.isArray(j)||!j.length)throw new Error("no klines");
  const r=await usdInr();
  const close=[],high=[],low=[],times=[],vol=[];
  let lastUsd=0;
  for(const k of j){const c=+k[4];if(!isFinite(c))continue;lastUsd=c;close.push(c*r);high.push(+k[2]*r);low.push(+k[3]*r);times.push(+k[6]);vol.push(+k[5]||0);}
  return {close,high,low,times,vol,price:close[close.length-1],priceUsd:lastUsd,rateUsed:r,mtime:Date.now()};
}

/* ============================================================
   SCAN
   ============================================================ */
const cache=new Map();const cGet=(k,ttl)=>{const e=cache.get(k);return e&&Date.now()-e.t<ttl?e.v:null;};const cSet=(k,v)=>cache.set(k,{t:Date.now(),v});
async function mapLimit(items,limit,fn){const ret=[];let i=0;async function w(){while(i<items.length){const j=i++;try{ret[j]=await fn(items[j]);}catch(e){ret[j]={__err:e.message};}}}await Promise.all(Array.from({length:Math.min(limit,items.length)},w));return ret;}
function istDate(){return new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"})).toISOString().slice(0,10);}
function ymd(d){return d.toISOString().slice(0,10);}
function marketOpen(){const ist=new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Kolkata"}));const dy=ist.getDay(),m=ist.getHours()*60+ist.getMinutes();return dy>=1&&dy<=5&&m>=555&&m<=930;}
function fmtTime(ms){if(!ms)return"";const ist=new Date(new Date(ms).toLocaleString("en-US",{timeZone:"Asia/Kolkata"}));return ist.toLocaleString("en-IN",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",hour12:true});}
function synth(seed,n,drift){let x=500+seed%4000,o=[],s=seed||1;const r=()=>{s=(s*16807)%2147483647;return s/2147483647;};const d=drift==null?((seed%3)-1)*0.12:drift;const close=[],vol=[];for(let i=0;i<n;i++){const mv=(r()-0.5+d)*0.03;x*=(1+mv);x=Math.max(1,x);close.push(x);vol.push(1000*(1+Math.abs(mv)*20+r()));}const now=Date.now();return {close,high:close.map(v=>v*1.004),low:close.map(v=>v*0.996),vol,times:close.map((_,i)=>now-(n-1-i)*18e5),price:close[close.length-1]};}

// "does this trade have room beyond this bar?" — higher-timeframe confluence from the same series (no extra API call)
function scopeFlag(sig){
  const dir=sig.verdict==='SELL'?-1:sig.verdict==='BUY'?1:0;
  if(!dir)return null;
  const trendUp = (sig.s50!=null&&sig.s200!=null)?sig.s50>sig.s200:null;
  const nearHi = sig.hi20&&sig.price>=sig.hi20*0.995;
  const nearLo = sig.lo20&&sig.price<=sig.lo20*1.005;
  if(dir>0){
    if(trendUp===true&&!nearHi)return {good:true, txt:'🚀 Room to run — higher-timeframe trend agrees, can extend into a swing'};
    if(nearHi)return {good:false, txt:'⚠ Near recent high — limited upside, take profit quickly'};
    return {good:false, txt:'↔ Counter to the bigger trend — likely a short-lived bounce'};
  }else{
    if(trendUp===false&&!nearLo)return {good:true, txt:'🚀 Room to fall — higher-timeframe trend agrees, can extend'};
    if(nearLo)return {good:false, txt:'⚠ Near recent low — limited downside left'};
    return {good:false, txt:'↔ Counter to the bigger trend — likely a short-lived dip'};
  }
}
// ---- BTC regime filter: don't long alts while Bitcoin is risk-off (alts are highly correlated to BTC) ----
let BTC_STATE=null;   // {bull,verdict,regimeUp,tf,at}
function btcAsset(){return cryptoMode==='coindcx'
  ? {sym:'BTCINR',pair:'I-BTC_INR',binance:'BTCUSDT',tk:'BTC',name:'BTC',cls:'Crypto',src:'cg'}
  : {sym:'BTCUSDT',binance:'BTCUSDT',tk:'BTC',name:'BTC',cls:'Crypto',src:'cg'};}
function btcStateFromSeries(close,high,low,tf){
  if(!close||close.length<42)return null;
  const cl=close.slice(0,-1),hi=high.slice(0,-1),lo=low.slice(0,-1);
  const s=computeSignal(cl,hi,lo,tf==='daily'?20:12);
  return {bull:(s.regimeUp && s.verdict!=='SELL'), verdict:s.verdict, regimeUp:s.regimeUp, tf, at:Date.now()};
}
async function ensureBtcState(tf){
  if(BTC_STATE && BTC_STATE.tf===tf && Date.now()-BTC_STATE.at<90000) return BTC_STATE;
  try{ const d=await loadCrypto(btcAsset(),tf); BTC_STATE=btcStateFromSeries(d.close,d.high,d.low,tf)||BTC_STATE; }
  catch(e){ BTC_STATE={bull:true,verdict:'HOLD',regimeUp:true,tf,at:Date.now(),err:true}; }   // fail OPEN — never block on a data hiccup
  return BTC_STATE;
}
// Multi-timeframe confirmation: resample the SAME candles into 2 higher timeframes and see if they lean the
// same way as this signal. Returns {agree,total,frames:[{tf,ok}]} — no extra network calls. BUY/SELL only.
function multiTfConfirm(data,tf,verdict){
  const side = verdict==='SELL'?-1:verdict==='BUY'?1:0;
  if(!side) return null;
  const conf = CONFIRM[tf]||[];
  const frames=[{tf,ok:true}]; let agree=1, total=1;
  for(const [label,f] of conf){
    try{
      const rs=resampleSeries({close:data.close,high:data.high,low:data.low,times:data.times||data.close.map(()=>0)},f);
      if(!rs.close||rs.close.length<41){continue;}
      const cl=rs.close.slice(0,-1),hi=rs.high.slice(0,-1),lo=rs.low.slice(0,-1);
      if(cl.length<41)continue;
      const hs=computeSignal(cl,hi,lo,tf==='daily'?20:12);
      const ok = side>0 ? hs.score>0 : hs.score<0;      // same directional lean on the higher timeframe
      frames.push({tf:label,ok,score:hs.score}); total++; if(ok)agree++;
    }catch(e){}
  }
  return {agree,total,frames};
}
function processAsset(asset,data,tf){
  if(!data||!data.close||data.close.length<41)throw new Error("no data");
  const thr=tf==='daily'?20:12;             // looser threshold on all intraday frames = more opportunities
  const live=data.price;                    // current (live) price
  // Decide the signal on CLOSED candles only (drop the still-forming last bar) so a 15m call
  // doesn't wobble every minute — it only changes when a new candle closes.
  const cl=data.close.slice(0,-1),hi=data.high.slice(0,-1),lo=data.low.slice(0,-1),tm=data.times?data.times.slice(0,-1):null;
  const vl=data.vol&&data.vol.length===data.close.length?data.vol.slice(0,-1):null;   // closed-bar volume (aligned to cl)
  // Only pause alt LONGS when Bitcoin is ACTIVELY SELLING (a real down-move), not merely below its trend line — the
  // blanket "below trend → block all longs" was what left the bot short-only in a choppy tape. No forced shorts anymore.
  const btcSelling = asset.src==='cg' && asset.tk!=='BTC' && BTC_STATE && BTC_STATE.tf===tf && BTC_STATE.verdict==='SELL';
  const sig=computeSignal(cl,hi,lo,thr,vl);
  if(btcSelling && sig.verdict==='BUY'){ sig.verdict='HOLD'; sig.btcBlocked=true; }   // pause alt-longs only during a genuine BTC dump
  const setup=buildSetup(sig,tf==='daily'?'daily':'intraday');   // entry/stop/targets anchored to the closed bar (stable)
  sig.closedPrice=sig.price; sig.price=live;                     // now use LIVE price for the action + the card's Current Price
  if(data.priceUsd>0)sig.priceUsd=data.priceUsd;                 // the venue's OWN $ number, so the UI never has to divide by a rate
  const since=signalSince(cl,hi,lo,tm);
  const action=actionNow(sig,setup,since,fmtTime);
  const reasons=buildReasons(sig,setup,marketOpen(),asset.src==='cg');
  const scope=scopeFlag(sig);
  const dec=asset.src==='cg'&&data.price<5?4:2;
  const isIndex=!!asset.isIndex||asset.sym.startsWith('^');
  const asofMs=data.mtime||(data.times?data.times[data.times.length-1]:Date.now());
  const btRaw = cl.length>=120 ? backtestSeries(cl,hi,lo,tf,costFor(asset),{vol:vl}) : null;   // net-of-cost historical, both directions
  const bt = btRaw ? assetBtScore(btRaw) : null;
  // per-DIRECTION historical edge, so the bot can require a coin's LONGS (or SHORTS) to have actually made money before taking that side
  const btSide = btRaw ? {long:{trades:btRaw.longs.trades,winRate:btRaw.longs.winRate,avgRet:btRaw.longs.avgRet},short:{trades:btRaw.shorts.trades,winRate:btRaw.shorts.winRate,avgRet:btRaw.shorts.avgRet}} : null;
  const mtf = multiTfConfirm(data,tf,sig.verdict);   // higher-timeframe agreement (resampled, no extra fetch)
  const confidence = confidenceOf(sig,mtf,bt,setup);
  // Activity measured from the candles themselves, so EVERY asset class has it — crypto gets a
  // more accurate override from the exchange's 24h ticker, but stocks, indices and commodities
  // no longer depend on a crypto-only endpoint to be rankable by movement.
  const nBack=BARS_24H[tf]||24;
  const vv=data.vol||[]; let turnover=0,hasVol=false;
  for(let i=Math.max(0,cl.length-nBack);i<cl.length;i++){
    const q=+vv[i]||0; if(q>0)hasVol=true; turnover+=q*(cl[i]||0);
  }
  const iBack=Math.max(0,cl.length-1-nBack);
  const chgWin=cl[iBack]>0?(live/cl[iBack]-1)*100:null;
  return {asset,sig,setup,since,action,reasons,scope,bt,btSide,mtf,confidence,dec,isIndex,tf,asof:fmtTime(asofMs),
    rateUsed:(data.rateUsed>0)?data.rateUsed:undefined,   // the rate that BUILT these ₹ numbers — $ display divides by exactly this
    inrWhy:data.inrWhy||undefined,                       // why the USDT market was not used, when it wasn't
    turnover:hasVol?turnover:null, chgWin:chgWin!=null?+chgWin.toFixed(2):null,
    priceTag:asset.src==='cg'
      ? (cryptoMode==='coindcx'
          ? (data.pairUsed==='usdt' ? 'live · CoinDCX USDT market' : 'live · CoinDCX INR pair')
          : 'live · global ₹')
      : (marketOpen()?'LIVE (broker)':'prev close'),series:data.close.slice(-80),
    bars:{h:data.high.slice(-24),l:data.low.slice(-24),c:data.close.slice(-24)}};   // compact OHLC window for the Quick-tab mini candlesticks
}
/* ============================================================
   BACKTEST — lookahead-free, long-only, ATR stop / T1 target
   ============================================================ */
function scoreSeriesArr(close,high,low){
  const n=close.length;
  const s50=IND.sma(close,50),s200=IND.sma(close,200),e12=IND.ema(close,12),e26=IND.ema(close,26),
        rsi=IND.rsi(close,14),m=IND.macd(close),bb=IND.bollinger(close),st=IND.stoch(close,high,low),
        roc=IND.roc(close,12),atr=IND.atr(close,high,low);
  const scores=new Array(n).fill(0);
  for(let i=0;i<n;i++){
    let ws=0,ss=0;const add=(sc,w)=>{ws+=w;ss+=sc*w;};const price=close[i];
    if(s50[i]!=null&&s200[i]!=null)add(Math.max(-1,Math.min(1,(s50[i]-s200[i])/s200[i]*15)),1.4);
    if(e12[i]!=null&&e26[i]!=null)add(Math.max(-1,Math.min(1,(e12[i]-e26[i])/e26[i]*25)),1.2);
    if(rsi[i]!=null){const r=rsi[i];let sc=r<30?(30-r)/30:r>70?-(r-70)/30:(50-r)/50*0.4;add(Math.max(-1,Math.min(1,sc)),1.1);}
    if(m.hist[i]!=null)add(Math.max(-1,Math.min(1,m.hist[i]/price*200)),1.2);
    if(bb.upper[i]!=null){const pos=(price-bb.mid[i])/((bb.upper[i]-bb.lower[i])/2||1);add(Math.max(-1,Math.min(1,-pos*0.7)),0.8);}
    if(st.k[i]!=null){let k=st.k[i];let sc=k<20?(20-k)/20:k>80?-(k-80)/20:(50-k)/50*0.3;if(st.d[i]!=null)sc+=(st.k[i]-st.d[i])/100;add(Math.max(-1,Math.min(1,sc)),0.7);}
    if(roc[i]!=null)add(Math.max(-1,Math.min(1,roc[i]/10)),0.9);
    {const tr=s200[i]!=null?s200[i]:s50[i]; if(tr!=null)add(close[i]>tr?1:-1,1.1);}                // trend regime (200-line, 50-line until 200 exists)
    if(i>0&&m.hist[i]!=null&&m.hist[i-1]!=null&&st.k[i]!=null&&st.d[i]!=null){const up=m.hist[i]>m.hist[i-1]&&st.k[i]>=st.d[i];const dn=m.hist[i]<m.hist[i-1]&&st.k[i]<=st.d[i];add(up?1:dn?-1:0,1.0);}  // momentum turn
    scores[i]=ws?Math.round(ss/ws*100):0;
  }
  return {scores,atr};
}
// per-FILL cost (brokerage + STT + GST + exchange + slippage). Round-trip ≈ 2×. Configurable.
const BT_COST_EQ=(parseFloat(process.env.BT_COST_BPS_EQ)||parseFloat(CFG.backtestCostBpsEquity)||12)/10000;
const BT_COST_CR=(parseFloat(process.env.BT_COST_BPS_CRYPTO)||parseFloat(CFG.backtestCostBpsCrypto)||40)/10000;
const costFor=asset=>asset.cls==='Crypto'?BT_COST_CR:BT_COST_EQ;
// Realistic exit: scale out 1/3 at each of T1/T2/T3, ratchet the stop up (breakeven after T1, T1 after T2).
// Net of trading costs. Long-only, lookahead-free.
function backtestSeries(close,high,low,tf,cost,opts){
  cost = cost==null ? BT_COST_EQ : cost;
  opts = opts||{}; const useAdx = opts.adx!==false, useConfirm = opts.confirm!==false, useVol = opts.volume!==false && !!opts.vol, useShorts = opts.shorts!==false;   // default ON = matches live; A/B toggles
  const {scores,atr}=scoreSeriesArr(close,high,low);
  const thr=tf==='daily'?20:12;
  const P=TYPE[tf==='daily'?'Swing':'Intraday'], stopMult=P.stopMult, T=P.t;   // T = [t1,t2,t3] R-multiples
  const ema20=IND.ema(close,20), sma50=IND.sma(close,50), s200b=IND.sma(close,200), bb=IND.bollinger(close), adxArr=IND.adx(close,high,low,14), volMA=useVol?IND.sma(opts.vol,20):null, n=close.length;
  const lo10=new Array(n).fill(null), hi10=new Array(n).fill(null), prevHi20=new Array(n).fill(null), prevLo20=new Array(n).fill(null);
  for(let i=0;i<n;i++){
    if(i>=9){let mn=Infinity,mx=-Infinity;for(let j=i-9;j<=i;j++){mn=Math.min(mn,low[j]);mx=Math.max(mx,high[j]);}lo10[i]=mn;hi10[i]=mx;}
    if(i>=20){let mx=-Infinity,mn=Infinity;for(let j=i-20;j<i;j++){mx=Math.max(mx,high[j]);mn=Math.min(mn,low[j]);}prevHi20[i]=mx;prevLo20[i]=mn;}
  }
  let pos=0,dir=1,entry=0,R=0,stop=0,t1=0,t2=0,t3=0,rem=0,taken=0,gross=0,entryIdx=-1,pending=null;
  const rets=[],longR=[],shortR=[]; let eq=1,peak=1,mdd=0; const FILLWIN=6;
  // direction-aware: dir=+1 long (stop below, targets above), dir=-1 short (stop above, targets below)
  const enter=(px,r,idx,Tset,d)=>{const TT=Tset||T;dir=d||1;entry=px;R=r;stop=px-dir*r;t1=px+dir*TT[0]*r;t2=px+dir*TT[1]*r;t3=px+dir*TT[2]*r;rem=1;taken=0;gross=0;pos=dir;entryIdx=idx;};
  const finish=()=>{const net=gross-2*cost;rets.push(net);(dir>0?longR:shortR).push(net);eq*=(1+net);peak=Math.max(peak,eq);mdd=Math.min(mdd,eq/peak-1);pos=0;gross=0;rem=0;taken=0;};
  for(let i=50;i<n;i++){
    if(pos!==0 && i>entryIdx){
      const rr = px => dir*(px/entry-1);                                    // realized fraction of a unit exited at px (works both ways)
      const stopHit = dir>0 ? low[i]<=stop : high[i]>=stop;
      if(stopHit && rem>0){ gross+=rem*rr(stop); rem=0; finish(); }          // stop the remainder (conservative: checked first)
      else{
        const hit = t => dir>0 ? high[i]>=t : low[i]<=t;
        if(rem>0 && taken<1 && hit(t1)){ gross+=(1/3)*rr(t1); rem-=1/3; taken=1; stop=entry; }  // → breakeven
        if(rem>0 && taken<2 && hit(t2)){ gross+=(1/3)*rr(t2); rem-=1/3; taken=2; stop=t1; }     // → lock T1
        if(rem>0 && taken<3 && hit(t3)){ gross+=rem*rr(t3); rem=0; finish(); }                  // final third at T3
        else if(pos!==0 && rem>0 && (dir>0?scores[i]<=-thr:scores[i]>=thr)){ gross+=rem*rr(close[i]); rem=0; finish(); }   // signal died → exit rest
      }
    }
    if(pos===0 && pending && i>pending.sig){
      const pd=pending.dir||1;
      // LONG fills on a dip to support (close back ABOVE the limit = bounce held); SHORT fills on a rally to resistance (close back BELOW = rejection held)
      const reached = pd>0 ? (low[i]<=pending.limit && (!useConfirm || close[i]>pending.limit))
                           : (high[i]>=pending.limit && (!useConfirm || close[i]<pending.limit));
      if(reached){ enter(pending.limit,pending.R,i,pending.T,pd); pending=null; }
      else if(i>=pending.exp) pending=null;   // the level never came / never confirmed → no trade
    }
    if(pos===0 && !pending && atr[i]>0){
      const trendRef = s200b[i]!=null ? s200b[i] : sma50[i];   // fall back to the 50-line until 200 bars exist
      const trending = !useAdx || adxArr[i]==null || adxArr[i]>=20;   // chop filter (both sides)
      const scalp = tf!=='daily' && (adxArr[i]==null || adxArr[i] < ADX_SCALP);   // choppy/range → scalp geometry (mirrors buildSetup)
      const rr = (scalp?TYPE.Scalp.stopMult:stopMult)*atr[i], Tset = scalp?TYPE.Scalp.t:T, r=stopMult*atr[i];
      const volBase = !useVol || !volMA || volMA[i]<=0;   // no volume gate available → treat as OK
      if(scores[i]>=thr){                                  // ---- LONG side: buy dip in an uptrend / breakout up ----
        const regimeUp = trendRef==null || close[i]>trendRef, brk = prevHi20[i]!=null && close[i]>=prevHi20[i];
        if(brk){ if(volBase || (opts.vol[i]/volMA[i])>=1.2) enter(close[i],r,i,null,1); }
        else if(regimeUp && trending){ const sup=nearestLevel(1,close[i],atr[i],[lo10[i],bb.lower[i],ema20[i],sma50[i]]); pending={limit:sup,R:rr,sig:i,exp:i+FILLWIN,T:Tset,dir:1}; }
      } else if(useShorts && scores[i]<=-thr){             // ---- SHORT side (mirror): short rally into resistance in a downtrend / breakdown ----
        const regimeDn = trendRef==null || close[i]<trendRef, brk = prevLo20[i]!=null && close[i]<=prevLo20[i];
        if(brk){ if(volBase || (opts.vol[i]/volMA[i])>=1.2) enter(close[i],r,i,null,-1); }
        else if(regimeDn && trending){ const res=nearestLevel(-1,close[i],atr[i],[hi10[i],bb.upper[i],ema20[i],sma50[i]]); pending={limit:res,R:rr,sig:i,exp:i+FILLWIN,T:Tset,dir:-1}; }
      }
    }
  }
  if(pos!==0){ gross+=rem*dir*(close[n-1]/entry-1); rem=0; finish(); }
  const wins=rets.filter(r=>r>0),losses=rets.filter(r=>r<=0);
  const sumW=wins.reduce((a,b)=>a+b,0),sumL=losses.reduce((a,b)=>a+b,0);
  const bh=close[50]>0?close[n-1]/close[50]-1:0;
  const sideStat=arr=>{const w=arr.filter(x=>x>0).length;return {trades:arr.length,wins:w,winRate:arr.length?w/arr.length*100:0,avgRet:arr.length?arr.reduce((a,b)=>a+b,0)/arr.length*100:0};};
  return {trades:rets.length,wins:wins.length,
    winRate:rets.length?wins.length/rets.length*100:0,
    avgRet:rets.length?(rets.reduce((a,b)=>a+b,0)/rets.length)*100:0,
    avgWin:wins.length?sumW/wins.length*100:0,
    avgLoss:losses.length?sumL/losses.length*100:0,
    profitFactor:sumL<0?sumW/Math.abs(sumL):(sumW>0?99:0),
    totalRet:(eq-1)*100,maxDD:mdd*100,buyHold:bh*100,
    longs:sideStat(longR), shorts:sideStat(shortR)};   // per-side breakdown so shorts get their own grade
}
// one-asset 0–100 backtest grade (same idea as the aggregate score)
function assetBtScore(b){
  if(!b || b.trades<5) return {score:null,trades:b?b.trades:0};
  const edge=Math.max(0,Math.min(1,(b.totalRet-b.buyHold)/40+0.5));       // vs buy-and-hold
  const pfN =Math.max(0,Math.min(1,((b.profitFactor>=99?2.5:b.profitFactor)-1)/1.5));
  const wrN =Math.max(0,Math.min(1,b.winRate/100));
  const ddN =Math.max(0,Math.min(1,1-Math.abs(b.maxDD)/50));
  let s=Math.round(40*edge+25*pfN+15*wrN+20*ddN);
  if(b.trades<15) s=Math.min(s,50);                                        // small sample → capped
  return {score:s,trades:b.trades,totalRet:b.totalRet,buyHold:b.buyHold,winRate:b.winRate};
}
async function backtest(tab,tf){
  const ck="bt:"+tab+":"+tf;const hit=cGet(ck,10*60*1000);if(hit)return withLiveRate({...hit,cached:true});
  if(tab==='Crypto'||tab==='All')try{await ensureCryptoUniverse();}catch(e){}
  if(tab==='Commodities'||tab==='All')try{await ensureCommodities();}catch(e){}
  const uni=universeFor(tab).slice(0,250);     // cover the whole universe (single tabs are well under this)
  const li=loggedIn();
  if(!DEMO && uni.some(a=>a.src==='upstox') && li)await ensureInstruments();
  const per=await mapLimit(uni,10,async asset=>{
    let data;
    if(asset.src==='cg')data=await loadCrypto(asset,tf);
    else{if(!DEMO&&!li)throw new Error("login");const key=DEMO?("D|"+asset.sym):keyForAsset(asset);if(!key)throw new Error("nokey");
      data=DEMO?synth(hashStr(asset.sym),tf==='daily'?500:400,0.03):await upstoxCandles(key,tf);}
    if(!data||data.close.length<120)throw new Error("short");
    return {sym:asset.sym,name:asset.name,cls:asset.cls,...backtestSeries(data.close,data.high,data.low,tf,costFor(asset))};
  });
  const withData=per.filter(x=>x&&!x.__err);          // fetched + backtested (may have 0 trades)
  const failed=per.filter(x=>x&&x.__err).length;      // couldn't fetch (login/data)
  const ok=withData.filter(x=>x.trades>0);            // produced at least one trade
  const noSignal=withData.length-ok.length;           // valid data but strategy never fired
  let TT=0,TW=0,sumRet=0,sumBH=0,sumDD=0,pfW=0,pfL=0, TLt=0,TLw=0,TSt=0,TSw=0;   // TLt/TLw long trades/wins, TSt/TSw short
  ok.forEach(a=>{TT+=a.trades;TW+=a.wins;sumRet+=a.totalRet;sumBH+=a.buyHold;sumDD+=a.maxDD;
    const losses=a.trades-a.wins;pfW+=a.avgWin/100*a.wins;pfL+=Math.abs(a.avgLoss/100*losses);
    if(a.longs){TLt+=a.longs.trades;TLw+=a.longs.wins;} if(a.shorts){TSt+=a.shorts.trades;TSw+=a.shorts.wins;}});
  const winRate=TT?TW/TT*100:0, avgTotalRet=ok.length?sumRet/ok.length:0, avgBuyHold=ok.length?sumBH/ok.length:0,
        avgMaxDD=ok.length?sumDD/ok.length:0, profitFactor=pfL>0?pfW/pfL:(pfW>0?99:0), beatBuyHold=ok.filter(a=>a.totalRet>a.buyHold).length;
  // ---- one simple 0–100 Backtest Score (like the signal score) ----
  const edge = ok.length ? beatBuyHold/ok.length : 0;                       // fraction of assets that beat holding
  const pfN  = Math.max(0,Math.min(1,((profitFactor>=99?2.5:profitFactor)-1)/1.5));
  const wrN  = Math.max(0,Math.min(1,winRate/100));
  const ddN  = Math.max(0,Math.min(1,1-Math.abs(avgMaxDD)/50));
  let btScore = Math.round(40*edge + 25*pfN + 15*wrN + 20*ddN);             // weighted blend
  const lowSample = TT < 30;
  if(lowSample) btScore = Math.min(btScore, 40);                            // can't score high on too few trades
  const btVerdict = lowSample ? "Too few trades to judge — not enough data yet"
    : btScore>=70 ? "Strong in backtest — still confirm with small live trades first"
    : btScore>=55 ? "Promising — it beat buy-and-hold; validate forward with tiny size"
    : btScore>=40 ? "Mixed — only a marginal edge; paper-trade before risking money"
    : "Weak — it did NOT beat just holding; don't trade this as-is";
  const agg={assets:ok.length,attempted:uni.length,withData:withData.length,noSignal,failed,totalTrades:TT,
    winRate,avgTotalRet,avgBuyHold,avgMaxDD,profitFactor,beatBuyHold,btScore,btVerdict,lowSample,
    longTrades:TLt, longWinRate:TLt?TLw/TLt*100:0, shortTrades:TSt, shortWinRate:TSt?TSw/TSt*100:0};   // per-side split
  const out={tab,tf,agg,perAsset:ok.sort((a,b)=>b.totalRet-a.totalRet),ts:Date.now(),demo:DEMO,loggedIn:li};
  if(ok.length)cSet(ck,out);
  return out;
}
async function scan(tab,tf){
  const ttl = tab==='Crypto' ? TTL_CRYPTO : (tf==='intraday'?TTL_INTRA:TTL_DAILY);
  const ck="scan:"+tab+":"+tf;const hit=cGet(ck,ttl);if(hit)return withLiveRate({...hit,cached:true});
  // crypto universe (Binance) + commodities resolved FIRST so the universe reflects them
  if(tab==="Crypto"||tab==="All"){try{await ensureCryptoUniverse();}catch(e){}if(cryptoMode==="coindcx")await ensureCdxFresh();if(!DEMO)try{await ensureBtcState(tf);}catch(e){}}
  if(tab==="Commodities"||tab==="All"){try{await ensureCommodities();}catch(e){}}
  const uni=universeFor(tab);
  const li=loggedIn();
  const hasUpstox=uni.some(a=>a.src==='upstox');
  if(!DEMO && hasUpstox && li) await ensureInstruments();
  const stockAssets=uni.filter(a=>a.src==='upstox');
  const keyOf={};stockAssets.forEach(a=>{keyOf[a.sym]=DEMO?("DEMO|"+a.sym):keyForAsset(a);});
  const res=await mapLimit(uni,10,async asset=>{
    let data;
    if(asset.src==='cg'){data=await loadCrypto(asset,tf);}        // crypto: CoinDCX INR (or Binance fallback), never needs login
    else{
      if(!DEMO && !li) throw new Error("login");                  // skip Upstox instantly when not logged in
      const key=keyOf[asset.sym];if(!key)throw new Error("no instrument key");
      data=DEMO?synth(hashStr(asset.sym),tf==='intraday'?400:300,0.04):await upstoxCandles(key,tf);
    }
    return processAsset(asset,data,tf);
  });
  const ok=res.filter(r=>r&&!r.__err);
  // pin live LTP for upstox names (only when logged in)
  if(!DEMO && li){const keys=stockAssets.map(a=>keyOf[a.sym]).filter(Boolean);
    try{const ltp=await upstoxLTP(keys);
      ok.forEach(r=>{if(r.asset.src==='upstox'){const k=keyOf[r.asset.sym];if(k&&ltp[k]){r.sig.price=ltp[k];/* refresh action vs live price */r.action=actionNow(r.sig,r.setup,r.since,fmtTime);}}});}catch(e){}
  }
  // attach the 🔥 volume/activity metrics to EVERY result, whatever the asset class, so both
  // panels show the same score for stocks, indices and commodities as they do for coins
  try{
    const needT24=(tab==='Crypto'||tab==='All')&&!DEMO;
    const t24=needT24?await ticker24():{};
    ok.forEach(r=>{const v=volMetrics(r,r.asset.src==='cg'?t24:{},tf);if(v)r.vol=v;});
  }catch(e){}
  // setup tracker: register the scalps this scan surfaces + update statuses with these live prices.
  // Runs for every asset class — an index or commodity setup deserves the same follow-through
  // as a coin, so a trade you took never disappears without an outcome.
  try{
    trackSetups(ok,tf,'quick');
    markReversals(ok,tf);        // flag filled trades whose signal has flipped against them
    const pm={};ok.forEach(r=>{if(r.sig.price>0)pm[r.asset.sym]=r.sig.price;});
    sweepSetups(pm);
  }catch(e){}
  const cryptoAssets=uni.filter(a=>a.src==='cg');
  const cryptoFailed = cryptoAssets.length>0 && !DEMO && !ok.some(r=>r.asset.src==='cg');
  const out={tab,tf,analyzed:ok.length,total:uni.length,results:ok,ts:Date.now(),demo:DEMO,loggedIn:li,keyOf,cryptoMode,usdtInr:priceRate(),rateSrc:priceRateSrc(),
    costs:{...TRADE_COST,roundTripPct:roundTripPct()},
    btc:((tab==='Crypto'||tab==='All')&&BTC_STATE)?{bull:BTC_STATE.bull,verdict:BTC_STATE.verdict}:null,
    note: cryptoFailed?"Crypto unreachable — this server's region can't reach CoinDCX. For exact CoinDCX ₹, host in an India region (e.g. DigitalOcean Bangalore/BLR); otherwise the global ₹ feed is used.":undefined};
  if(ok.length>0 && !cryptoFailed) cSet(ck,out);   // never cache an empty/failed scan
  return withLiveRate(out);
}
function hashStr(s){let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))>>>0;return h;}

/* live quotes endpoint (cheap, frequent) */
/* Two parallel maps, never one derived from the other: `inr` is ₹, `usd` is the venue's OWN USDT
   number. The UI shows $ from `usd` directly instead of computing ₹ ÷ rate, so a wrong or
   mismatched rate can no longer move a dollar price. */
let cgPriceCache=null,cgUsdCache=null,cgPriceAt=0;
async function liveQuotesFull(tab){
  const uni=universeFor(tab),out={},usd={};
  const cryptoIds=uni.filter(a=>a.src==='cg');
  if(cryptoIds.length && !DEMO){
    /* 3s, not 8s. This cache and the browser's poll are INDEPENDENT clocks that stack: an 8s cache
       behind an 8s poll means a quote can be 16s old on screen in the worst case, and the two
       never line up. The upstream call is one ticker request covering every market, shared by all
       pages this server serves, so 20/min costs nothing and halves the worst case. */
    if(cgPriceCache && Date.now()-cgPriceAt<3000){Object.assign(out,cgPriceCache);Object.assign(usd,cgUsdCache||{});}
    else if(cryptoMode==="coindcx"){
      try{await cdxGetTicker();const c={},u={};cryptoIds.forEach(x=>{const p=cdxLiveInr(x.tk)||(cdxTicker[x.sym]>0?cdxTicker[x.sym]:0);if(p>0)c[x.sym]=p;const d=cdxLiveUsd(x.tk);if(d>0)u[x.sym]=d;});
        cgPriceCache=c;cgUsdCache=u;cgPriceAt=Date.now();Object.assign(out,c);Object.assign(usd,u);}
      catch(e){if(cgPriceCache){Object.assign(out,cgPriceCache);Object.assign(usd,cgUsdCache||{});}}
    }else{
      try{const arr=await binanceGet("/api/v3/ticker/price");const r=await usdInr();
        const bySym={};if(Array.isArray(arr))arr.forEach(x=>{bySym[x.symbol]=+x.price;});
        const c={},u={};cryptoIds.forEach(x=>{const p=bySym[x.binance];if(p>0){c[x.sym]=p*r;u[x.sym]=p;}});
        cgPriceCache=c;cgUsdCache=u;cgPriceAt=Date.now();Object.assign(out,c);Object.assign(usd,u);}
        catch(e){if(cgPriceCache){Object.assign(out,cgPriceCache);Object.assign(usd,cgUsdCache||{});}}
    }}
  if(!DEMO){await ensureInstruments();const stocks=uni.filter(a=>a.src==='upstox');const keyOf={};stocks.forEach(a=>keyOf[a.sym]=keyForAsset(a));
    const keys=stocks.map(a=>keyOf[a.sym]).filter(Boolean);
    try{const ltp=await upstoxLTP(keys);stocks.forEach(a=>{const k=keyOf[a.sym];if(k&&ltp[k])out[a.sym]=ltp[k];});}catch(e){}}
  return {inr:out,usd};
}
// ₹ only — every internal caller (position sweeps, setup tracker) keys a price map by symbol and wants nothing else
async function liveQuotes(tab){return (await liveQuotesFull(tab)).inr;}

/* ============================================================
   🔥 HIGH-VOLUME MOVERS — the coins moving the MOST right now on real volume,
   ranked for quick scalps. Reuses the cached scan (no extra candle fetches), so
   every mover arrives with the engine's actual entry/stop/target plan attached.
   ============================================================ */
const MOVERS_TOP=parseInt(process.env.MOVERS_TOP)||parseInt(CFG.moversTop)||20;
const BARS_24H={"5m":288,"15m":96,"30m":48,"1h":24,"4h":6,"6h":4,"12h":2,"daily":1,"intraday":48};
let tick24Cache=null,tick24At=0;
// 24h stats per coin {BASE:{chg,qv}} — chg = 24h % change, qv = 24h traded value in ₹ (from the active crypto source)
async function ticker24(){
  if(tick24Cache&&Date.now()-tick24At<60000)return tick24Cache;
  const out={};
  try{
    if(cryptoMode==="coindcx"){
      const t=await cdxGetTicker();
      t.forEach(x=>{ if(!x.market||!x.market.endsWith("INR"))return;
        const base=x.market.slice(0,-3); if(isStableBase(base))return;
        const last=+x.last_price||0, chg=+x.change_24_hour;
        const row={chg:isFinite(chg)?chg:null, qv:(+x.volume||0)*last};
        if(!out[base]||row.qv>out[base].qv)out[base]=row;
      });
    }else{
      const arr=await binanceGet("/api/v3/ticker/24hr"); const fx=await usdInr();
      if(Array.isArray(arr))arr.forEach(x=>{ if(!x.symbol||!x.symbol.endsWith("USDT"))return;
        const base=x.symbol.slice(0,-4); if(isStableBase(base))return;
        const chg=+x.priceChangePercent;
        out[base]={chg:isFinite(chg)?chg:null, qv:(+x.quoteVolume||0)*fx};
      });
    }
    if(Object.keys(out).length){tick24Cache=out;tick24At=Date.now();}
  }catch(e){ if(tick24Cache)return tick24Cache; }
  return out;
}
// VOLUME/ACTIVITY METRICS for one result — the 🔥 Mover Score plus the raw numbers behind it.
// Shared by Volume Movers and Quick Trades so both panels show the SAME score for the same coin.
// The score is an ACTIVITY gauge (is this coin actually moving, with a real crowd?) — NOT trade quality;
// setup quality stays the separate Confidence %.
// Per-asset-class calibration. A 3% day is routine for crypto and remarkable for an index,
// so one shared threshold would either flood the list with coins or never surface an index.
const VOL_CAL={
  Crypto:      {chgFull:12, hotChg:3.0, atrFull:3.0},
  Commodity:   {chgFull:5,  hotChg:1.5, atrFull:1.5},
  "ETF/Index": {chgFull:4,  hotChg:1.2, atrFull:1.2},
  Stock:       {chgFull:6,  hotChg:2.0, atrFull:1.8}
};
const volCal=cls=>VOL_CAL[cls]||VOL_CAL.Stock;

function volMetrics(r,stats,tf){
  if(!r||!r.sig)return null;
  const cal=volCal(r.asset&&r.asset.cls);
  const st=(stats&&stats[r.asset.tk||""])||{};
  // Exchange 24h stats when we have them (crypto); otherwise the value measured from this
  // asset's own candles in processAsset.
  let chg=st.chg; if(chg==null)chg=r.chgWin;
  const qv=st.qv||r.turnover||0;
  const surge=r.sig.volRatio!=null?+r.sig.volRatio:null;   // latest closed bar vs its own 20-bar average
  const atrPct=(r.sig.atr>0&&r.sig.price>0)?r.sig.atr/r.sig.price*100:0;
  // 55% size of the move · 30% volume surge vs normal · 15% per-bar range (scalp room)
  const mChg=Math.min(1,Math.abs(chg||0)/cal.chgFull);
  const mSurge=surge!=null?Math.min(1,surge/3):0.35;
  const mAtr=Math.min(1,atrPct/cal.atrFull);
  return {score:Math.round(100*(0.55*mChg+0.30*mSurge+0.15*mAtr)),
    chg24:chg!=null?+(+chg).toFixed(2):null, surge:surge!=null?+surge.toFixed(2):null,
    qv, atrPct:+atrPct.toFixed(2), cls:r.asset&&r.asset.cls,
    // "real participation" gate, scaled to what a big move means for THIS asset class.
    // Indices carry no volume in the candle feed, so they qualify on movement alone.
    hot:((surge!=null&&surge>=1.5)||(chg!=null&&Math.abs(chg)>=cal.hotChg))};
}
async function topMovers(tab,tf){
  tab=tab||"Crypto";
  const ck="movers:"+tab+":"+tf;
  const ttl = tab==='Crypto' ? TTL_CRYPTO : (marketOpen()?TTL_INTRA:TTL_DAILY);
  const hit=cGet(ck,ttl); if(hit)return withLiveRate({...hit,cached:true});
  const d=await scan(tab,tf);
  const rows=[],trackable=[];
  (d.results||[]).forEach(r=>{
    if(!r||!r.sig||!r.setup)return;
    const tk=r.asset.tk||"";
    const v=r.vol||volMetrics(r,{},tf);           // scan already attached these; recompute only as a safety net
    if(!v||!v.hot)return;                          // a mover needs REAL participation
    const {score,chg24,surge,qv,atrPct}=v;
    if(r.sig.verdict!=='HOLD'&&r.action&&SETUP_ACTIONABLE.has(r.action.kind))trackable.push(r);
    const s=r.setup;
    rows.push({sym:r.asset.sym,tk,name:r.asset.name||tk,cls:r.asset.cls,score,chg24,surge,qv,atrPct,
      live:r.sig.price,dec:r.dec,verdict:r.sig.verdict,tradeScore:r.sig.score,
      setup:{dir:s.dir,type:s.type,regime:s.regime,entryLo:s.entryLo,entryHi:s.entryHi,entry:s.entry,stop:s.stop,riskPct:s.riskPct,
        targets:s.targets,ret:s.ret,rrr:s.rrr,suggestedLev:s.suggestedLev,hold:s.hold,note:s.note},
      action:r.action?{kind:r.action.kind,cls:r.action.cls}:null,conf:r.confidence||null,bars:r.bars});
  });
  rows.sort((a,b)=>b.score-a.score);
  rows.length=Math.min(rows.length,MOVERS_TOP);
  /* Each ROW carries the rate that built its ₹, captured now and cached alongside it. A payload-
     level rate is re-stamped live on every cache hit, so a 40s-old (or, for 🎢 Dump & Bounce, a
     30-MINUTE-old) ₹ would be divided by a rate from a different moment. Row and rate travel
     together, so the pair stays consistent however long the payload sits in the cache. */
  const builtWith=priceRate();
  rows.forEach((x,i)=>{x.rank=i+1;if(x.cls==='Crypto'&&builtWith>0)x.rateUsed=builtWith;});
  try{const keep=new Set(rows.map(x=>x.sym));trackSetups(trackable.filter(r=>keep.has(r.asset.sym)),tf,'mover');}catch(e){}
  const out={tab,tf,movers:rows,scanned:(d.results||[]).length,ts:Date.now(),demo:DEMO,cryptoMode,
    btc:d.btc||null,usdtInr:d.usdtInr||priceRate(),rateSrc:d.rateSrc||priceRateSrc(),
    // Non-crypto needs a broker session and an open market to be actionable — say which is
    // missing rather than returning a silently empty list.
    loggedIn:d.loggedIn!==false, marketOpen:marketOpen(),
    needsLogin: tab!=='Crypto' && !DEMO && d.loggedIn===false};
  if(rows.length)cSet(ck,out);
  return withLiveRate(out);
}

/* ============================================================
   🎢 NEW LISTINGS — the post-listing cycle. A coin lists, sells off for months as
   unlock supply hits a thin book, and rallies hard in between. This finds coins
   currently INSIDE that regime, measures how big and how long their bounces have
   actually been, and says where in the cycle price sits right now.

   Why this is not called "fake coins": COOKIE, XAI and VANA are real projects. The
   shape comes from a small circulating float against a huge fully-diluted supply, so
   every unlock lands on a thin order book. Calling them fake would be an accusation
   this app cannot support, and it would hide the actual mechanism — which is the part
   you can trade.

   HONESTY, built into every row: these coins carry a structural DOWNWARD drift, and
   the rallies are counter-trend bounces inside it. So each card reports
     · what happened historically after a dip like today's (`fwd.win`), AND
     · what happened buying on ANY random day over the same horizon (`fwd.baseWin`).
   If those two numbers are the same, "buy the dip here" has no edge — it is just this
   coin's volatility, and the card says so. Both are computed causally (trailing highs
   only, never a future bar), and deliberately NOT from the zigzag pivots: every zigzag
   low is followed by a rally BY CONSTRUCTION, so scoring off pivots would make any
   coin look like a money printer.
   ============================================================ */
const NL_BAR_CAP=400;                                          // daily bars the crypto loaders request
const NL_TRUNC=NL_BAR_CAP-20;                                  // at/above this the series hit the cap — the listing is OLDER than what we can see
const NL_MIN_AGE=21;                                           // below this there is nothing measurable
const NL_MIN_PEAK_AGE=20;                                      // the high must be OLD — otherwise this is a pullback in an uptrend, not a bleed
const NL_ZZ_PCT=parseFloat(process.env.NL_ZIGZAG)||parseFloat(CFG.dumpBounceZigzag)||15;      // % reversal that defines one daily leg
const NL_MIN_DD=parseFloat(process.env.NL_MIN_DD)||parseFloat(CFG.dumpBounceMinDrawdown)||35; // % off the peak to qualify
const NL_MIN_QV=parseFloat(process.env.NL_MIN_QV)||parseFloat(CFG.dumpBounceMinQv)||1e7;      // ₹1 Cr / 24h liquidity floor
const NL_TOP=parseInt(process.env.NL_TOP)||parseInt(CFG.dumpBounceTop)||15;
/* RANK, DON'T GATE. An earlier cut also required a complete daily cycle and a ≥15% median daily
   bounce. Measured against a population of bleeding coins, the cycle test alone rejected HALF of
   them — and it rejected exactly the wrong half: coins in a near-monotonic bleed whose bumps are
   sharp and intraday, so they never form a 15% leg between two DAILY closes. That is the XAI /
   COOKIE shape precisely. Those tests are now score inputs and card stats; the only hard gates
   are the ones that define the regime (deep below an old high) plus a liquidity floor. */
const NL_TTL=30*60*1000;                                       // daily bars — pointless to refetch on the 45s panel timer
/* The BUMP pass runs on 4h bars. A squeeze in one of these coins runs and dies inside 24–72
   hours; on daily closes that whole event is one or two candles, so a daily-only view would
   quote "bounces run ~20 days" for a move that was over in two. 400 × 4h ≈ 66 days of history. */
const BUMP_TF="4h", BUMP_BAR_H=4;
const BUMP_ZZ=parseFloat(process.env.BUMP_ZIGZAG)||parseFloat(CFG.bumpZigzag)||12;   // % reversal on the fast series
const BUMP_MIN_PCT=parseFloat(process.env.BUMP_MIN_PCT)||parseFloat(CFG.bumpMinPct)||20;  // a bump worth the name
const BUMP_MAX_BARS=parseInt(process.env.BUMP_MAX_BARS)||parseInt(CFG.bumpMaxBars)||18;   // …and it has to be FAST (≤3 days)
const BUMP_STOP_ATR=parseFloat(process.env.BUMP_STOP_ATR)||parseFloat(CFG.bumpStopAtr)||1.1;  // stop this many ATR beyond the floor/roof
const med=a=>{if(!a||!a.length)return null;const s=a.slice().sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const avg=a=>a&&a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
// Drop bad bars from every series TOGETHER — filtering close alone silently misaligns volume
// (which the bump's crowd-confirmation is read from) and the highs/lows the levels are built on.
function cleanOHLC(close,high,low,vol){
  const c=[],h=[],l=[],v=[];
  for(let i=0;i<(close||[]).length;i++){
    const x=+close[i]; if(!(x>0&&isFinite(x)))continue;
    const hh=high?+high[i]:NaN, ll=low?+low[i]:NaN;
    c.push(x); h.push(hh>0&&isFinite(hh)?hh:x); l.push(ll>0&&isFinite(ll)?ll:x);
    v.push(vol&&isFinite(+vol[i])?+vol[i]:0);
  }
  return {c,h,l,v};
}
function cleanSeries(close,vol){const r=cleanOHLC(close,null,null,vol);return {c:r.c,v:r.v};}

// Alternating swing pivots. A leg only turns once price reverses `pct` from the running
// extreme, so noise inside a trend cannot manufacture fake cycles. Returns CONFIRMED pivots
// oldest-first ({i, px, k:1 high | -1 low}); the leg still in progress is excluded on purpose,
// because its end is not known yet — that leg is what the phase logic reads instead.
function zigzag(close,pct){
  const n=close.length; if(!(n>2))return [];
  const th=Math.max(0.005,(+pct||10)/100), piv=[];
  let dir=0, hi=close[0], hiI=0, lo=close[0], loI=0;
  for(let i=1;i<n;i++){
    const p=close[i]; if(!(p>0))continue;
    if(p>hi){hi=p;hiI=i;}
    if(p<lo){lo=p;loI=i;}
    if(dir>=0 && p<=hi*(1-th)){ piv.push({i:hiI,px:hi,k:1});  dir=-1; lo=p; loI=i; }
    else if(dir<=0 && p>=lo*(1+th)){ piv.push({i:loI,px:lo,k:-1}); dir=1; hi=p; hiI=i; }
  }
  return piv;
}
// Downsample a series to ~m points for the card sparkline (keeps first and last bar).
function sparkline(cl,m){
  m=m||64; if(cl.length<=m)return cl.map(v=>+v.toPrecision(6));
  const out=[]; for(let i=0;i<m;i++)out.push(+cl[Math.round(i*(cl.length-1)/(m-1))].toPrecision(6));
  return out;
}
// Shape of one coin's recent life, from daily closes.
// An exchange serves candles only from the listing date, so when the series is SHORTER than the
// fetch cap, bar 0 really is the listing (`verifiedListing`). When it hits the cap we are looking
// at a 400-day window of an older coin — which is not a reason to skip it. The regime that makes
// these coins tradeable (deep below an OLD high, still bleeding, punctuated by sharp bumps) long
// outlives the listing itself: XAI listed in early 2024 and was still trading that way years on.
// An age gate would have thrown out the very coins this feature exists to find.
function listingProfile(close,zzPct){
  const cl=(close||[]).filter(v=>v>0&&isFinite(v));
  const n=cl.length; if(n<NL_MIN_AGE)return null;
  const price=cl[n-1];
  let peak=cl[0],peakI=0,trough=cl[0],troughI=0;
  for(let i=1;i<n;i++){ if(cl[i]>peak){peak=cl[i];peakI=i;} if(cl[i]<trough){trough=cl[i];troughI=i;} }
  const piv=zigzag(cl,zzPct||NL_ZZ_PCT);
  const ups=[],downs=[];
  for(let k=1;k<piv.length;k++){
    const a=piv[k-1],b=piv[k],pct=(b.px/a.px-1)*100,days=b.i-a.i;
    if(!(days>0)||!isFinite(pct))continue;
    (b.k===1?ups:downs).push({pct,days});                       // a leg ENDING at a high is a rally
  }
  const rally={medPct:med(ups.map(x=>x.pct)),medDays:med(ups.map(x=>x.days)),n:ups.length};
  const drop={medPct:med(downs.map(x=>x.pct)),medDays:med(downs.map(x=>x.days)),n:downs.length};
  // Lower lows are the unlock-supply signature: every bounce fails from a lower base.
  const lows=piv.filter(p=>p.k===-1);
  let ll=0; for(let k=1;k<lows.length;k++) if(lows[k].px<lows[k-1].px) ll++;
  const lowerLows=lows.length>1?ll/(lows.length-1):0;
  const cycles=Math.min(ups.length,downs.length);
  // WHERE WE ARE NOW — the unfinished leg, measured from the last confirmed pivot.
  const last=piv.length?piv[piv.length-1]:null;
  const leg=last?{dir:last.k===-1?1:-1,days:(n-1)-last.i,pct:+((price/last.px-1)*100).toFixed(1),from:last.px}:null;
  let phase='unclear';
  if(leg&&leg.dir>0)                                            // rising off the last pivot low
    phase=((rally.medPct!=null&&leg.pct>=0.8*rally.medPct)||(rally.medDays!=null&&leg.days>=rally.medDays))?'mature':'rallying';
  else if(leg)                                                  // falling from the last pivot high
    phase=((drop.medPct!=null&&leg.pct<=0.8*drop.medPct)||(drop.medDays!=null&&leg.days>=drop.medDays))?'bounce':'falling';
  const ddPct=peak>0?(1-price/peak)*100:0;
  const peakPos=n>1?peakI/(n-1):0;                              // 0 = peaked on the first bar we can see
  const peakAgeDays=(n-1)-peakI;                                // how long ago the high was set — the real regime test
  const truncated=n>=NL_TRUNC;
  // How far above the RECENT floor price sits — the difference between "at the bottom of this
  // fall" and "already 20% into the bounce", which the leg % alone does not tell you.
  let lo30=cl[n-1]; for(let i=Math.max(0,n-30);i<n;i++) if(cl[i]<lo30)lo30=cl[i];
  // Pattern fit — how closely this matches "fell from an old high and never recovered".
  // NOT a buy signal: a high score describes a FALLING asset. peakPos only carries weight when
  // the series provably starts at the listing; on a truncated window it means nothing, because
  // bar 0 is an arbitrary date, so age-of-peak does that work instead.
  const score=Math.round(100*(0.25*Math.min(1,ddPct/70)+0.15*Math.min(1,peakAgeDays/120)
    +0.20*Math.min(1,cycles/3)+0.20*(rally.medPct!=null?Math.min(1,rally.medPct/40):0)
    +0.15*lowerLows+0.05*((!truncated&&peakPos<=0.35)?1:0)));
  return {ageDays:n,truncated,verifiedListing:!truncated,peakAgeDays,price,peak,peakI,peakPos:+peakPos.toFixed(2),trough,troughI,
    ddPct:+ddPct.toFixed(1), fromLow:trough>0?+((price/trough-1)*100).toFixed(1):null,
    off30:lo30>0?+((price/lo30-1)*100).toFixed(1):null,          // % above the lowest close of the last 30 bars
    driftPct:cl[0]>0?+((price/cl[0]-1)*100).toFixed(1):null,     // total return since the first served bar
    rally:{medPct:rally.medPct!=null?+rally.medPct.toFixed(1):null,medDays:rally.medDays!=null?Math.round(rally.medDays):null,n:rally.n},
    drop:{medPct:drop.medPct!=null?+drop.medPct.toFixed(1):null,medDays:drop.medDays!=null?Math.round(drop.medDays):null,n:drop.n},
    lowerLows:+lowerLows.toFixed(2),cycles,pivots:piv.length,leg,phase,score};
}
// THE HONESTY LAYER. For every past bar that looked like today — at least `dipPct` below its
// TRAILING `lookback`-day high, computed with past bars only — what did the next `horizon` days
// do? `base*` is the same horizon bought on ANY day. When win ≈ baseWin the dip is not an edge.
function forwardStats(close,dipPct,horizon,lookback){
  const cl=(close||[]).filter(v=>v>0&&isFinite(v));
  const n=cl.length,h=Math.max(1,Math.round(horizon||7)),lb=Math.max(5,Math.round(lookback||20)),th=(dipPct||20)/100;
  const dip=[],all=[];
  for(let i=lb;i+h<n;i++){
    const fwd=(cl[i+h]/cl[i]-1)*100; if(!isFinite(fwd))continue;
    all.push(fwd);
    let hh=0; for(let j=i-lb;j<=i;j++) if(cl[j]>hh)hh=cl[j];    // trailing high — no future bar is read
    if(hh>0 && cl[i]<=hh*(1-th)) dip.push(fwd);
  }
  const win=a=>a.length?Math.round(100*a.filter(v=>v>0).length/a.length):null;
  const r=a=>{const m=med(a);return m!=null?+m.toFixed(1):null;};
  return {n:dip.length,win:win(dip),med:r(dip),baseN:all.length,baseWin:win(all),baseMed:r(all),
    horizon:h,dipPct:+(+(dipPct||20)).toFixed(0),
    edge:(dip.length>=8&&win(dip)!=null&&win(all)!=null)?win(dip)-win(all):null};
}
/* ---- THE BUMP: the part you actually trade, measured on 4h bars ----
   In these coins the counter-trend rally is fast and violent — often a short squeeze, since a
   coin that has bled for months is heavily shorted — and it is usually given straight back. So a
   bump is defined as an up-leg that is BOTH big (≥20%) and FAST (≤3 days); a slow 20% grind is a
   different animal and is not counted. For every completed bump we then measure what happened
   AFTER it, over the same number of bars it took to form. That retracement is the whole reason
   this is a trade with an exit rather than a hope: if these moves round-trip, you take profit
   into strength or you give it all back. */
function bumpProfile(close,vol,opts){
  const o=opts||{}, {c:cl,v:vv}=cleanSeries(close,vol);
  const n=cl.length; if(n<40)return null;
  const minPct=o.minPct||BUMP_MIN_PCT, maxBars=o.maxBars||BUMP_MAX_BARS, barH=o.barH||BUMP_BAR_H;
  const piv=zigzag(cl,o.zz||BUMP_ZZ), bumps=[];
  for(let k=1;k<piv.length;k++){
    const a=piv[k-1],b=piv[k];
    if(b.k!==1)continue;                                        // up-legs only: swing low → swing high
    const pct=(b.px/a.px-1)*100, bars=b.i-a.i;
    if(!(pct>=minPct)||!(bars>0)||bars>maxBars)continue;         // big AND fast, or it is not a bump
    // Give-back over the same window it took to form. Only scored when that window has actually
    // elapsed — measuring a half-finished retrace would flatter every recent bump.
    const complete=b.i+bars<=n-1;
    let retrace=null;
    if(complete){
      let lo=cl[b.i]; for(let j=b.i;j<=b.i+bars;j++) if(cl[j]<lo)lo=cl[j];
      const span=b.px-a.px;
      if(span>0)retrace=+Math.max(0,Math.min(100,(b.px-lo)/span*100)).toFixed(0);
    }
    bumps.push({i:a.i,peakI:b.i,pct:+pct.toFixed(1),bars,hours:bars*barH,retrace,complete});
  }
  const done=bumps.filter(b=>b.complete&&b.retrace!=null);
  const medPct=med(bumps.map(b=>b.pct)), medBars=med(bumps.map(b=>b.bars));
  // WHERE WE ARE NOW on the fast series.
  const last=piv.length?piv[piv.length-1]:null, price=cl[n-1];
  let state="quiet",legPct=0,legBars=0;
  if(last){
    legBars=(n-1)-last.i; legPct=+((price/last.px-1)*100).toFixed(1);
    if(last.k===-1)                                             // rising off the last swing low
      state=((medPct!=null&&legPct>=0.85*medPct)||(medBars!=null&&legBars>=medBars))?"late"
           :(legPct>=minPct*0.4?"running":"building");
    else state="fading";                                        // rolling over off the last swing high
  }
  // Crowd confirmation: volume on the current leg vs the 20 bars before it started. A squeeze
  // with real volume behind it is a squeeze; a spike on nothing is a wick that gets given back.
  let volX=null;
  if(last&&n-last.i>=2){
    const base=avg(vv.slice(Math.max(0,last.i-20),last.i));
    if(base>0)volX=+(avg(vv.slice(last.i,n))/base).toFixed(2);
  }
  return {n:bumps.length,completed:done.length,
    medPct:medPct!=null?+medPct.toFixed(1):null,
    medHours:medBars!=null?Math.round(medBars*barH):null,
    retraceMed:med(done.map(b=>b.retrace)),
    fullRate:done.length?Math.round(100*done.filter(b=>b.retrace>=90).length/done.length):null,
    state,legPct,legHours:legBars*barH,volX,windowDays:Math.round(n*barH/24),
    bumps:bumps.slice(-6),tf:BUMP_TF};
}
/* ---- THE PLAN — the two trades this pattern actually offers, with levels ----
   The pattern is only useful if it ends in "buy here, stop there, sell there". So every card
   carries BOTH sides, because the shape offers both:

     LONG the bounce   — counter-trend. Fast, and it is the one that pays, but you are buying
                         into a falling asset, so the stop sits under the floor and the targets
                         are fractions of THIS coin's own measured bump, not a hope.
     SHORT the failure — with-trend. Entered where past bumps died, targeting the prior low.
                         Lower reward, better odds: it is the direction the coin is already going.

   Levels come from the coin's own 4h structure (recent floor, the swing high where the last bump
   rolled over, its ATR) and its own median bump size — never from a generic indicator. Exactly
   one side is live at a time; the other says what price to wait for. */
/* WHICH SIDE IS LIVE, for a given price. Split out because the LEVELS are structural and fine to
   be half an hour old, but the INSTRUCTION is not: price can leave the buy zone in minutes, and a
   card still saying "BUY NOW" off a stale price is worse than no card. The UI re-runs this rule
   against a fresh quote, so this function is the single source of truth for it — keep the copy in
   index.html (nlNow) in step, and see the enumerated test in test/dumpbounce.test.js.
   Exactly one instruction, always. "Mid-air" is a real answer and gets said out loud rather than
   dressed up as a signal. */
function planNowFor(price,plan){
  const buyHi=plan.long.entryHi, shLo=plan.short.entryLo;
  let now;
  if(price<=buyHi)now="buy";
  else if(price>=shLo)now="short";
  else now=(price-buyHi)<(shLo-price)?"wait_buy":"wait_short";
  return {now, toBuy:+((buyHi/price-1)*100).toFixed(1), toShort:+((shLo/price-1)*100).toFixed(1)};
}
function tradePlan(close,high,low,bump,opts){
  const o=opts||{}, {c:cl,h:hh,l:ll}=cleanOHLC(close,high,low,null);
  const n=cl.length; if(n<40)return null;
  const price=cl[n-1];
  const atrArr=IND.atr(cl,hh,ll,14);
  const atr=(atrArr[n-1]>0?atrArr[n-1]:price*0.04);
  const back=Math.min(n,o.lookback||45);
  let lo=Infinity,hi=0;
  for(let i=n-back;i<n;i++){ if(ll[i]<lo)lo=ll[i]; if(hh[i]>hi)hi=hh[i]; }
  if(!(lo>0)||!(hi>lo))return null;
  // This coin's typical bump. When it has no measured bump yet, fall back to a fraction of its
  // own recent range so a coin still gets levels rather than being silently useless.
  const bp=((bump&&bump.medPct>0)?bump.medPct:Math.max(15,Math.min(80,(hi/lo-1)*100*0.6)))/100;
  const fromBump=!!(bump&&bump.medPct>0);
  /* Targets are picked from real levels, not from a formula alone: the recent swing high (where
     bumps actually died) competes with the bump-size projection and takes its rightful place in
     the ladder. Sorting them means a target can never sit ABOVE known resistance while a nearer
     level goes unlisted — which is what happens if you project off the median bump and ignore
     the chart. Near-duplicates within 3% collapse, and the ladder is padded if levels run out. */
  const prog=(a,dir)=>{const out=[];for(const v of a){const p=out.length?out[out.length-1]:null;
    out.push(p==null?v:(dir>0?Math.max(v,p*1.004):Math.min(v,p*0.996)));}return out;};
  const ladder=(cands,base,dir,step)=>{
    const keep=[];
    for(const v of cands){
      if(!(v>0)||(dir>0?v<=base*1.02:v>=base*0.98))continue;
      if(keep.every(x=>Math.abs(x/v-1)>0.03))keep.push(v);
    }
    keep.sort((a,b)=>dir>0?a-b:b-a);                                   // nearest level first
    while(keep.length<3)keep.push((keep.length?keep[keep.length-1]:base)*(1+dir*step));
    return prog(keep.slice(0,3),dir);
  };
  // How far below the floor the stop sits, in ATR. Exposed as a knob because the backtest's
  // stop-out diagnostic can only tell you it is wrong — it must not be allowed to tune itself,
  // or the plan would be fitted to whatever history happened to be in the window.
  const stopAtr=o.stopAtr||BUMP_STOP_ATR;
  // LONG — buy the bounce, in the lower part of the base.
  const buyLo=lo, buyHi=Math.max(lo*1.05,lo+0.7*atr), buyMid=(buyLo+buyHi)/2;
  const buyStop=Math.min(lo-stopAtr*atr,lo*0.93);
  const buyT=ladder([hi,buyMid*(1+0.45*bp),buyMid*(1+0.9*bp),buyMid*(1+1.4*bp)],buyMid,1,0.4*bp);
  // SHORT — sell the failure, where past bumps died: the recent swing high, or the floor
  // projected up by one full typical bump, whichever is higher.
  const shRef=Math.max(hi,lo*(1+bp)), shLo=shRef*0.96, shHi=shRef*1.03, shMid=(shLo+shHi)/2;
  const shStop=Math.max(shHi+stopAtr*atr,shHi*1.07);
  const shT=ladder([lo,shMid-0.4*(shMid-lo),shMid-0.75*(shMid-lo)],shMid,-1,0.3*bp);
  const side=(dir,eLo,eHi,mid,stop,T)=>({dir,entryLo:eLo,entryHi:eHi,entry:mid,stop,targets:T,
    riskPct:+(Math.abs(mid-stop)/mid*100).toFixed(1),
    stopAtrX:+(Math.abs(mid-stop)/atr).toFixed(2),        // stop width in ATR — how much noise it tolerates
    ret:T.map(t=>+((dir>0?t/mid-1:1-t/mid)*100).toFixed(1)),
    rrr:+(Math.abs(T[1]-mid)/Math.max(1e-12,Math.abs(mid-stop))).toFixed(2)});
  const long=side(1,buyLo,buyHi,buyMid,buyStop,buyT);
  const short=side(-1,shLo,shHi,shMid,shStop,shT);
  return {...planNowFor(price,{long,short}),price,floor:lo,roof:hi,atr,
    bumpPct:+(bp*100).toFixed(1),fromBump,long,short};
}
/* ---- DID THE PLAN ACTUALLY WORK? ----
   The base-rate box answers "what did buying a dip on this coin return" — a generic question.
   It does NOT answer "if you had taken THIS buy zone, with THIS stop, for THESE targets, every
   time it fired, what happened?" Those are different questions and the second one is the one a
   trader is actually asking, so it gets measured here.

   Causality is structural, not asserted: the plan for bar i is produced by calling the SAME
   production tradePlan() on a strict prefix [0..i], and fills are only ever checked on bars
   AFTER i. The backtest therefore cannot drift from the live logic, and cannot see the future.

   Two conservative choices, both of which make the numbers worse and both of which are honest:
   a stop and a target inside the same bar is recorded as the STOP (intrabar order is unknowable
   from OHLC), and the exit plan is the app's own — a third banked at each target with the stop
   ratcheting — so these results are directly comparable to the tracker's forward record. */
const PB_WARMUP=100;          // bars of history before the first simulated decision
const PB_STEP=3;              // re-derive the plan every N bars; plans do not change bar to bar
const PB_MAX_HOLD=90;         // force-close after ~15 days on 4h — it is a bump trade, not an investment
const PB_MIN_TRADES=5;        // below this, report the sample and refuse to quote a win rate
function planPnl(dir,fill,targets,hitT,exit){
  let g=0,rem=1;
  for(let k=0;k<Math.min(hitT,3);k++){ if(targets[k]==null)break; g+=(1/3)*dir*(targets[k]-fill)/fill; rem-=1/3; }
  if(rem>0.001)g+=rem*dir*(exit-fill)/fill;
  return g*100;
}
function backtestPlan(close,high,low,vol,opts){
  const o=opts||{}, {c:cl,h:hh,l:ll,v:vv}=cleanOHLC(close,high,low,vol);
  const n=cl.length, warm=o.warmup||PB_WARMUP;
  if(n<warm+40)return null;
  // Derive each decision ONCE, on a strict prefix, and let both books read the same plans.
  // Nothing here can see past bar i, and fills below are only ever checked from i+1.
  const plans=[];
  for(let i=warm;i<n-1;i+=PB_STEP){
    let p=null;
    try{ p=tradePlan(cl.slice(0,i+1),hh.slice(0,i+1),ll.slice(0,i+1),
           bumpProfile(cl.slice(0,i+1),vv.slice(0,i+1))); }catch(e){ p=null; }
    plans.push({i,p});
  }
  /* The two sides run as SEPARATE books. Sharing one position slot let the long — whose zone sits
     at the floor, where a bleeding coin lives — fire constantly and crowd the short out to a
     one-trade sample. That was an artifact of the simulation, not a fact about the strategy. */
  const run=(want)=>{
    const trades=[]; let open=null, k=0;
    for(let i=warm;i<n-1;i++){
      while(k<plans.length-1&&plans[k+1].i<=i)k++;
      const plan=plans[k]&&plans[k].i<=i?plans[k].p:null;
      if(!open&&plan){
        const j=i+1;
        if(want>0&&ll[j]<=plan.long.entryHi){
          const fill=Math.min(plan.long.entryHi,hh[j]);
          if(fill>plan.long.stop)open={dir:1,fill,stop:plan.long.stop,
            targets:plan.long.targets.slice(),riskPct:plan.long.riskPct,hitT:0,bar:j};
        }else if(want<0&&hh[j]>=plan.short.entryLo){
          const fill=Math.max(plan.short.entryLo,ll[j]);
          if(fill<plan.short.stop)open={dir:-1,fill,stop:plan.short.stop,
            targets:plan.short.targets.slice(),riskPct:plan.short.riskPct,hitT:0,bar:j};
        }
      }
      if(!open)continue;
      for(let j=open.bar+1;j<n;j++){
        // STOP FIRST. With only OHLC we cannot know whether the stop or the target printed
        // first inside a bar, and assuming the target would flatter every result.
        const stopped = open.dir>0 ? ll[j]<=open.stop : hh[j]>=open.stop;
        if(stopped){
          /* DIAGNOSTIC — was it the stop that failed, or the idea? For a trade stopped before
             banking anything, keep reading the tape to the end of the hold window and record
             whether Target 1 arrived anyway. A high rate means the stop is sitting inside normal
             noise and getting picked off before the move; a low rate means price simply kept
             going and no stop placement would have saved it. This is an observation about the
             tape, NOT a tuned parameter — nothing downstream optimises against it. */
          let recovered=false;
          if(open.hitT===0){
            const t1=open.targets[0], end=Math.min(n-1,open.bar+(o.maxHold||PB_MAX_HOLD));
            for(let q=j;q<=end;q++){ if(open.dir>0?hh[q]>=t1:ll[q]<=t1){recovered=true;break;} }
          }
          trades.push({...open,exitBar:j,recovered,
            pnl:planPnl(open.dir,open.fill,open.targets,open.hitT,open.stop),why:open.hitT?"trail":"stop"}); }
        else{
          while(open.hitT<3){
            const t=open.targets[open.hitT];
            if(t==null||!(open.dir>0?hh[j]>=t:ll[j]<=t))break;
            open.hitT++;
            if(open.hitT===1)open.stop=open.fill;                // breakeven after T1
            else if(open.hitT===2)open.stop=open.targets[0];     // T1 after T2
          }
          if(open.hitT>=3)trades.push({...open,exitBar:j,
            pnl:planPnl(open.dir,open.fill,open.targets,3,open.targets[2]),why:"targets"});
          else if(j-open.bar>=(o.maxHold||PB_MAX_HOLD))trades.push({...open,exitBar:j,
            pnl:planPnl(open.dir,open.fill,open.targets,open.hitT,cl[j]),why:"timeout"});
          else if(j<n-1)continue;                                // still running
          // still open when the tape ends is NOT a result, so it is simply dropped
        }
        i=j; open=null; break;
      }
      if(open){i=n;open=null;}
    }
    return trades;
  };
  const trades=run(1).concat(run(-1));
  const summarise=(list)=>{
    if(!list.length)return {n:0,thin:true,winRate:null,medPct:null,avgR:null,best:null,worst:null,stops:0,full:0};
    const p=list.map(t=>t.pnl), wins=p.filter(v=>v>0).length;
    const R=list.map(t=>t.riskPct>0?t.pnl/t.riskPct:0);
    const thin=list.length<PB_MIN_TRADES;
    const stopped=list.filter(t=>t.why==="stop");
    const rec=stopped.filter(t=>t.recovered).length;
    return {n:list.length,thin,
      winRate:thin?null:Math.round(100*wins/list.length),
      medPct:+med(p).toFixed(1), avgR:+(avg(R)).toFixed(2),
      best:+Math.max(...p).toFixed(1), worst:+Math.min(...p).toFixed(1),
      stops:stopped.length, full:list.filter(t=>t.why==="targets").length,
      // of the stop-outs, how many reached Target 1 anyway inside the hold window
      stoppedEarly:rec, stoppedEarlyPct:stopped.length?Math.round(100*rec/stopped.length):null};
  };
  return {long:summarise(trades.filter(t=>t.dir>0)), short:summarise(trades.filter(t=>t.dir<0)),
    all:summarise(trades), bars:n, simBars:n-warm, tf:BUMP_TF};
}
const PLAN_NOW={
  buy:       {icon:'🟢',label:'BUY THE BOUNCE',col:'buy',
    lead:"Price is in the buy zone now. This is the counter-trend leg — fast, and the one that pays, but you are buying a falling coin: the stop is not optional."},
  short:     {icon:'🔴',label:'SHORT THE FAILURE',col:'sell',
    lead:"Price is where this coin's bumps have died before. This is the WITH-trend side — smaller reward, better odds, because it is the direction the coin is already going."},
  wait_buy:  {icon:'⏳',label:'WAIT — TO BUY',col:'muted',
    lead:"Above the buy zone and below where bumps fail — mid-air. Rest a limit at the buy zone and let it come to you; chasing here is how this pattern takes your money."},
  wait_short:{icon:'⏳',label:'WAIT — TO SHORT',col:'muted',
    lead:"Past the buy zone, not yet at the level where bumps roll over. The long is gone; the short is not on yet. Wait for the price below."}
};
/* WOULD THE PAPER BOT TAKE THIS PLAN?
   Defined HERE, next to the data, and handed to paper.js — so the rule has exactly one definition
   and the panel can never disagree with the bot about what it will trade.

   A live plan is not a trigger. The fast chart has to confirm the direction first:
     long  — the bump is `running` (a move is underway) or `building` (the fall has stopped and it
             is basing). Never while it is still fading; that is catching a knife.
     short — the bump is `late` (already matched its typical size) or `fading` (rolling over).
             That is what "the failure" means. */
const DUMP_TAKE={long:["running","building"],short:["late","fading"]};
function dumpBotTakes(r){
  const p=r&&r.plan;
  if(!p)return {take:false,why:"no levels"};
  if(p.now!=="buy"&&p.now!=="short")return {take:false,why:"waiting — price is not in either zone yet"};
  const st=(r.bump&&r.bump.state)||"quiet";
  const side=p.now==="buy"?"long":"short";
  if(DUMP_TAKE[side].includes(st))
    return {take:true,side,state:st,
      why:side==="long"?`long the rally — the bump is ${st}`:`short the failure — the bump is ${st}`};
  return {take:false,side,state:st,
    why:side==="long"
      ? `not yet — a long needs the bump running or basing, and it is ${st}`+(st==="fading"?" (that would be buying a floor that is still falling)":"")
      : `not yet — a short needs the bump late or rolling over, and it is ${st}`};
}
const BUMP_STATE={
  late:    {icon:'⚠️',label:'BUMP LATE',col:'sell',
    what:"The move up has already matched this coin's typical bump in size or in hours. Past bumps rolled over here."},
  running: {icon:'🔥',label:'BUMP RUNNING',col:'buy',
    what:"A fast counter-trend move is underway and has not yet reached this coin's typical size. This is the part that pays — and it is measured in hours, not days."},
  building:{icon:'🌱',label:'BASING',col:'muted',
    what:"Off the lows but not yet moving with any force. Nothing to chase; this is where you set an alert."},
  fading:  {icon:'📉',label:'FADING',col:'sell',
    what:"Rolling over off the last swing high — the give-back leg. The bump, if there was one, is behind you."},
  quiet:   {icon:'💤',label:'QUIET',col:'muted',
    what:"No confirmed swing on the fast chart yet."}
};
const NL_PHASE={
  bounce:  {icon:'👀',label:'BOUNCE ZONE',col:'buy',
    what:"The fall has already run as deep or as long as this coin's own typical down-leg. This is WHERE past bounces started — it is not proof one starts now."},
  rallying:{icon:'🚀',label:'RALLYING',col:'buy',
    what:"Up off the last low but still short of this coin's typical bounce. Past bounces from this point still had room left."},
  mature:  {icon:'⚠️',label:'RALLY MATURE',col:'sell',
    what:"This bounce has already matched this coin's typical size or length. This is WHERE past bounces ended and the next leg down began."},
  falling: {icon:'🩸',label:'STILL FALLING',col:'sell',
    what:"In a down-leg that has not yet run its usual course. Buying here has usually meant more downside first."},
  unclear: {icon:'•',label:'NO CLEAR LEG',col:'muted',
    what:"Not enough confirmed swings yet to say where in the cycle this sits."}
};
// DEMO only: a synthetic low-float listing — pump on day one, structural decay, periodic bounces.
function synthListing(seed){
  let s=Math.abs(seed||1)%2147483647||1; const r=()=>{s=(s*16807)%2147483647;return s/2147483647;};
  // A third of the demo coins run the full 400 bars, i.e. they hit the fetch cap — the
  // "older coin, listing not verifiable" case that the age gate used to throw away.
  const n=r()<0.35?NL_BAR_CAP:45+Math.floor(r()*220),close=[],high=[],low=[],vol=[];
  let x=40+r()*400,ph=r()*6.28,per=7+r()*10;
  for(let i=0;i<n;i++){
    const mv=(i<3?0.11:-0.013)+0.032*Math.sin(i/per+ph)+(r()-0.5)*0.05;
    x=Math.max(0.01,x*(1+mv));
    close.push(x);high.push(x*1.05);low.push(x*0.95);vol.push(1e6*(1+Math.abs(mv)*25+r()));
  }
  const now=Date.now();
  return {close,high,low,vol,times:close.map((_,i)=>now-(n-1-i)*864e5),price:close[close.length-1],mtime:now};
}
// DEMO only: a 4h bleeder that squeezes. Spike hard, fade hard, grind down — the shape of a
// short squeeze in a coin everyone is already short.
function synthBump(seed){
  let s=Math.abs(seed||1)%2147483647||1; const r=()=>{s=(s*16807)%2147483647;return s/2147483647;};
  const n=400,close=[],high=[],low=[],vol=[];
  let x=1+r()*4,sq=0,fade=0;
  for(let i=0;i<n;i++){
    let mv;
    if(sq>0){mv=0.055+(r()-0.5)*0.04;sq--;if(!sq)fade=6+Math.floor(r()*9);}
    else if(fade>0){mv=-0.042+(r()-0.5)*0.04;fade--;}
    else{mv=-0.004+(r()-0.5)*0.03;if(r()<0.014)sq=4+Math.floor(r()*7);}
    x=Math.max(1e-8,x*(1+mv));
    close.push(x);high.push(x*1.02);low.push(x*0.98);vol.push(1e5*(1+(sq>0?7:0)+r()*2));
  }
  const now=Date.now();
  return {close,high,low,vol,times:close.map((_,i)=>now-(n-1-i)*BUMP_BAR_H*36e5),price:close[n-1],mtime:now};
}
/* Adapt live plans into the shape the setup tracker already understands, so Dump & Bounce
   trades get followed to an outcome exactly like Quick Trades and Volume Movers do.
   Only plans that are LIVE NOW are tracked — price is already inside the zone, so the fill is
   immediate. A WAITING plan is deliberately left alone: the tracker expires unfilled setups
   after a fixed number of bars, and a buy zone can legitimately take days to be reached, so
   tracking those would manufacture a pile of fake "never filled" outcomes. */
function planTrackables(rows){
  const out=[];
  for(const r of rows||[]){
    const p=r.plan; if(!p||(p.now!=="buy"&&p.now!=="short"))continue;
    const s=p.now==="buy"?p.long:p.short;
    const bt=r.planBt&&(s.dir>0?r.planBt.long:r.planBt.short);
    out.push({
      asset:{sym:r.sym,tk:r.tk,name:r.name,cls:"Crypto",src:"cg"},
      sig:{price:p.price,verdict:s.dir>0?"BUY":"SELL"},
      action:{kind:s.dir>0?"buynow":"sellnow",cls:"now"},
      setup:{dir:s.dir,entryLo:s.entryLo,entryHi:s.entryHi,stop:s.stop,riskPct:s.riskPct,
        targets:s.targets,ret:s.ret,rrr:s.rrr,regime:"dumpbounce"},
      // The tracked record carries the BACKTESTED win rate, not an invented confidence score.
      confidence:(bt&&!bt.thin&&bt.winRate!=null)
        ?{label:bt.winRate>=50?"High":bt.winRate>=35?"Medium":"Low",pct:bt.winRate}:null,
      dec:(p.price<5?4:2)});
  }
  return out;
}
/* DEMO only. This panel builds its own synthetic tapes (a listing shape and a squeeze shape),
   which start from an arbitrary price — so BTC read ₹0.46 here while every other tab read
   ₹5,386.25 for the same coin. Scaling is affine, so every ratio the feature computes (drawdown,
   bump size, retrace %, R:R, the backtest) is untouched; only the absolute price moves onto the
   same scale the rest of the demo uses. LIVE mode never needed this — there all panels read the
   one feed. */
function demoRescale(d,sym){
  const ref=synth(hashStr(sym),300,0.03).price, last=d.close[d.close.length-1];
  if(!(ref>0)||!(last>0))return d;
  const f=ref/last;
  return {...d,close:d.close.map(v=>v*f),high:d.high.map(v=>v*f),low:d.low.map(v=>v*f),price:ref};
}
let nlInflight=null;
async function dumpBounce(force){
  const ck="dumpbounce";
  if(!force){const hit=cGet(ck,NL_TTL);if(hit)return withLiveRate({...hit,cached:true});}
  if(nlInflight)return nlInflight;                              // one scan at a time — 120 daily-candle fetches is not cheap
  nlInflight=(async()=>{
    try{
      if(!DEMO)try{await ensureCryptoUniverse();}catch(e){}
      const uni=universeFor("Crypto");
      let t24={};try{if(!DEMO)t24=await ticker24();}catch(e){}
      const haveQv=Object.keys(t24).length>0;
      // STAGE 1 — daily bars over the whole universe: which coins are in the regime at all.
      const res=await mapLimit(uni,6,async a=>({a,d:DEMO?demoRescale(synthListing(hashStr(a.sym)),a.sym):await loadCrypto(a,"daily")}));
      const rows=[],skip={err:0,short:0,shallow:0,freshPeak:0,illiquid:0};
      for(const r of res){
        if(!r||r.__err||!r.d){skip.err++;continue;}
        const cl=(r.d.close||[]).filter(v=>v>0&&isFinite(v));
        const p=listingProfile(cl);
        if(!p){skip.short++;continue;}
        // TWO GATES ONLY — they define the regime, and nothing else is allowed to hide a coin.
        // Deep below its high, and that high is OLD (40% off a high set last week is a pullback,
        // not a bleed). Cycle count, bounce size and peak position used to be gates too; they
        // rejected half the bleeding coins, so they are now score inputs and card stats instead.
        if(p.ddPct<NL_MIN_DD){skip.shallow++;continue;}
        if(p.peakAgeDays<NL_MIN_PEAK_AGE){skip.freshPeak++;continue;}
        const qv=(haveQv&&t24[r.a.tk]&&t24[r.a.tk].qv)||0;
        if(haveQv&&qv>0&&qv<NL_MIN_QV){skip.illiquid++;continue;}
        // Condition the base rate on a dip the size this coin actually makes, over the
        // horizon its bounces actually take — so the number answers THIS card's question.
        const dipTh=Math.min(35,Math.max(12,Math.abs(p.drop.medPct||20)*0.8));
        const fwd=forwardStats(cl,dipTh,Math.max(3,Math.min(30,p.rally.medDays||7)),20);
        // the rate that built these ₹, cached with the row — this payload lives for 30 MINUTES
        rows.push({a:r.a,sym:r.a.sym,tk:r.a.tk||"",name:r.a.name||r.a.tk||r.a.sym,cls:"Crypto",qv,
          rateUsed:priceRate()||undefined,
          ...p,fwd,spark:sparkline(cl),phaseInfo:NL_PHASE[p.phase]||NL_PHASE.unclear});
      }
      rows.sort((a,b)=>b.score-a.score);
      const keep=rows.slice(0,NL_TOP);
      // STAGE 2 — the fast pass, on the survivors only. Daily closes cannot time a move that
      // runs and dies inside 48 hours, and that move IS the trade. Running this on the whole
      // universe would double the fetch count to no purpose.
      await mapLimit(keep,5,async r=>{
        try{
          const fd=DEMO?demoRescale(synthBump(hashStr(r.sym)),r.sym):await loadCrypto(r.a,BUMP_TF);
          const b=bumpProfile(fd.close,fd.vol);
          if(b){r.bump=b;r.bumpInfo=BUMP_STATE[b.state]||BUMP_STATE.quiet;r.fastSpark=sparkline((fd.close||[]).filter(v=>v>0),80);}
          // The levels — built on the same fast series the bump was measured on.
          const pl=tradePlan(fd.close,fd.high,fd.low,b);
          if(pl){r.plan=pl;r.planInfo=PLAN_NOW[pl.now];}
          // …and what those exact levels have actually returned on this coin's own tape.
          const bt=backtestPlan(fd.close,fd.high,fd.low,fd.vol);
          if(bt)r.planBt=bt;
        }catch(e){r.bumpErr=String(e.message||e).slice(0,80);}
      });
      keep.forEach(r=>{delete r.a; r.botTake=dumpBotTakes(r);});
      // So you can see, on the data you actually run, how many of these the 🤖 desk would take —
      // without enabling it and waiting to find out.
      const botSummary={takeable:0,skipped:0,byState:{}};
      keep.forEach(r=>{ const b=r.botTake; b.take?botSummary.takeable++:botSummary.skipped++;
        const k=(b.side||"?")+" / "+(b.state||"-"); botSummary.byState[k]=(botSummary.byState[k]||0)+1; });
      // Follow these to an outcome like every other recommendation the app makes, so a
      // Dump & Bounce trade never vanishes off the panel mid-trade — and so the feature builds
      // a FORWARD record to set against the backtest above.
      try{ trackSetups(planTrackables(keep),BUMP_TF,"dumpbounce"); }catch(e){}
      const out={rows:keep,found:rows.length,scanned:res.length,skip,botSummary,ts:Date.now(),demo:DEMO,cryptoMode,
        usdtInr:priceRate(),rateSrc:priceRateSrc(),
        // The UI re-derives the instruction from a live quote, so it needs the copy for every
        // state — shipped once here rather than duplicated as prose in index.html.
        planCopy:PLAN_NOW,
        cfg:{minAgeDays:NL_MIN_AGE,minPeakAgeDays:NL_MIN_PEAK_AGE,minDrawdown:NL_MIN_DD,
          zigzag:NL_ZZ_PCT,minQv:NL_MIN_QV,bumpTf:BUMP_TF,bumpMinPct:BUMP_MIN_PCT,bumpMaxHours:BUMP_MAX_BARS*BUMP_BAR_H}};
      if(res.length)cSet(ck,out);
      return withLiveRate(out);
    }finally{nlInflight=null;}
  })();
  return nlInflight;
}

/* ============================================================
   📌 SETUP TRACKER — every scalp the panels recommend is snapshotted and then
   FOLLOWED to its outcome (filled → target/stop, or expired unfilled), even after
   it drops out of the live list. Fixes "I took the trade and the card vanished":
   the original levels stay available with a live status, and resolved outcomes
   build a real FORWARD hit-rate (measured, not backtested).
   ============================================================ */
const SETUPS_FILE=path.join(__dirname,"setups.json");
const SETUP_ACTIONABLE=new Set(["buynow","sellnow","buybreak","sellbreak","waitdip","waitbounce"]);
const TF_MIN={"5m":5,"15m":15,"30m":30,"1h":60,"4h":240,"6h":360,"12h":720,"daily":1440,"intraday":30};
const SETUP_FILL_BARS=6;        // same fill window the UI quotes: the entry zone must come within ~6 bars or the setup expires
const SETUP_MAX_HOLD_BARS=48;   // a filled scalp is force-closed after ~48 bars — it's a scalp, not a swing
let SETUPS={active:[],resolved:[]};
try{const j=JSON.parse(fs.readFileSync(SETUPS_FILE,"utf8"));if(Array.isArray(j.active)&&Array.isArray(j.resolved))SETUPS=j;}catch(e){}
let setupsDirty=false;
function saveSetups(){if(!setupsDirty)return;try{fs.writeFileSync(SETUPS_FILE,JSON.stringify(SETUPS));setupsDirty=false;}catch(e){}}
// register the setups a panel just displayed (src 'quick' tracks only scalp regimes — what Quick Trades shows)
function trackSetups(results,tf,src){
  const now=Date.now(),ms=(TF_MIN[tf]||30)*60000;
  for(const r of results){
    if(!r||!r.setup||!r.sig||!r.action||!r.asset)continue;
    if(r.sig.verdict==='HOLD'||!SETUP_ACTIONABLE.has(r.action.kind))continue;
    if(src==='quick' && !(r.setup.regime==='range'||r.setup.regime==='correction'))continue;
    const s=r.setup,id=r.asset.sym+'|'+tf+'|'+(s.dir>0?'L':'S');
    const ex=SETUPS.active.find(x=>x.id===id);
    if(ex){ex.seen=now;if(r.sig.price>0)ex.live=r.sig.price;if(src&&ex.src.indexOf(src)<0){ex.src+='+'+src;setupsDirty=true;}continue;}
    SETUPS.active.push({id,sym:r.asset.sym,tk:r.asset.tk||'',name:r.asset.name||r.asset.tk||r.asset.sym,tf,dir:s.dir,src:src||'scan',
      cls:r.asset.cls||'', tab:r.asset.src==='cg'?'Crypto':'All',   // which quote feed can price it later
      entryLo:Math.min(s.entryLo,s.entryHi),entryHi:Math.max(s.entryLo,s.entryHi),stop:s.stop,stop0:s.stop,
      targets:(s.targets||[]).slice(0,3),ret:(s.ret||[]).slice(0,3),rrr:s.rrr,regime:s.regime,dec:r.dec||2,
      conf:r.confidence?{label:r.confidence.label,pct:r.confidence.pct}:null,
      born:now,seen:now,expires:now+SETUP_FILL_BARS*ms,maxEnd:now+SETUP_MAX_HOLD_BARS*ms,
      status:'waiting',hitT:0,live:r.sig.price});
    setupsDirty=true;
  }
  if(SETUPS.active.length>400)SETUPS.active.splice(0,SETUPS.active.length-400);
}
// Realized return of the engine's own exit plan: 1/3 banked at each target hit, the remainder exited at `exit`.
// Mirrors the backtest's scale-out, so a tracked outcome is comparable to a backtested one. null = never filled.
function realizedPct(x,exit){
  if(x.fill==null||!(x.fill>0)||!(exit>0))return null;
  let gross=0,rem=1;
  for(let k=0;k<Math.min(x.hitT,3);k++){ if(x.targets[k]==null)break; gross+=(1/3)*x.dir*(x.targets[k]-x.fill)/x.fill; rem-=1/3; }
  if(rem>0.001)gross+=rem*x.dir*(exit-x.fill)/x.fill;
  return +(gross*100).toFixed(2);
}
function resolveSetup(x,status,px,now){x.status=status;x.resolvedAt=now;x.exit=px;x.pnlPct=realizedPct(x,px);
  SETUPS.resolved.push(x);setupsDirty=true;
  if(SETUPS.resolved.length>300)SETUPS.resolved.splice(0,SETUPS.resolved.length-300);}
// REVERSAL WATCH — a filled trade whose signal has since flipped to the opposite side. The thesis that justified
// the entry is gone, so the honest guidance is "exit at market", not "sit and wait for the stop to be hit".
// Cleared automatically if the signal comes back onside. Only ever a FLAG — the tracker never closes your trade for you.
function markReversals(results,tf){
  const now=Date.now(),v={};
  (results||[]).forEach(r=>{if(r&&r.asset&&r.sig)v[r.asset.sym]=r.sig.verdict;});
  SETUPS.active.forEach(x=>{
    if(x.tf!==tf||x.status!=='filled')return;
    const cur=v[x.sym]; if(!cur)return;
    const against = x.dir>0 ? cur==='SELL' : cur==='BUY';
    if(against&&!x.rev){x.rev=now;setupsDirty=true;}
    else if(!against&&x.rev){delete x.rev;setupsDirty=true;}
  });
}
// one status step against a live price. Prices are SAMPLED (~every minute), so an intrabar wick can be missed —
// statuses are honest but conservative; the resolved stats carry the same caveat.
function updateSetupWithPrice(x,px,now){
  if(!(px>0)){ if(x.status==='waiting'&&now>x.expires)resolveSetup(x,'expired',x.live||0,now); return; }
  x.live=px;
  if(x.status==='waiting'){
    const stopped = x.dir>0 ? px<=x.stop : px>=x.stop;
    if(stopped){resolveSetup(x,'invalid',px,now);return;}         // fell straight through the zone to the stop → never enter
    if(px>=x.entryLo&&px<=x.entryHi){x.status='filled';x.filledAt=now;x.fill=px;setupsDirty=true;return;}
    if(now>x.expires){resolveSetup(x,'expired',px,now);return;}   // the zone never came → no trade
    return;
  }
  if(x.status==='filled'){
    const stopped = x.dir>0 ? px<=x.stop : px>=x.stop;
    // Exit AT the stop price, not at the sampled price: a stop order fills at its level, and prices here are
    // sampled ~once a minute, so using the observed price would overstate the loss by the whole sampling gap.
    // (Matches how the backtest exits, keeping tracked and backtested results comparable. Real slippage not modelled.)
    if(stopped){resolveSetup(x, x.hitT>0?'banked':'stopped', x.stop, now);return;}   // after T1 the stop sits at entry → banked, not a loss
    while(x.hitT<3&&x.targets[x.hitT]!=null&&(x.dir>0?px>=x.targets[x.hitT]:px<=x.targets[x.hitT])){
      x.hitT++;setupsDirty=true;
      if(x.hitT===1)x.stop=x.fill!=null?x.fill:(x.entryLo+x.entryHi)/2;   // ratchet: breakeven after T1 (mirrors the engine)
      if(x.hitT===2)x.stop=x.targets[0];                                   // lock T1 after T2
    }
    if(x.hitT>=3){resolveSetup(x,'target',x.targets[2],now);return;}   // final third fills at T3, not the sampled overshoot
    if(now>x.maxEnd)resolveSetup(x, x.hitT>0?'banked':(x.dir*(px-(x.fill||px))>0?'timeout+':'timeout-'), px, now);
  }
}
function sweepSetups(prices,now){
  now=now||Date.now(); prices=prices||{};
  for(let i=SETUPS.active.length-1;i>=0;i--){
    const x=SETUPS.active[i];
    updateSetupWithPrice(x,prices[x.sym],now);
    if(x.status!=='waiting'&&x.status!=='filled')SETUPS.active.splice(i,1);
  }
  saveSetups();
}
// Sweep across EVERY asset class the tracker holds positions in, not just crypto — otherwise an
// index or commodity setup would sit at "waiting" forever because nothing ever priced it.
// 'All' covers stocks, ETFs/indices, commodities and crypto in a single quote call.
async function setupsSweep(){
  try{
    const tabs=new Set();
    for(const x of SETUPS.active)tabs.add(x.tab||'All');
    if(!tabs.size)return;
    const px={};
    for(const t of tabs){
      try{ Object.assign(px,await liveQuotes(t==='Crypto'?'Crypto':'All')); }catch(e){}
    }
    sweepSetups(px);
  }catch(e){}
}
// forward record: of the setups that actually FILLED and resolved, how many hit Target 1 before the stop?
const SETUP_FILLED_STATUS=['target','stopped','banked','timeout+','timeout-'];
function setupStats(){
  const done=SETUPS.resolved.filter(x=>SETUP_FILLED_STATUS.includes(x.status));
  const t1=done.filter(x=>x.hitT>0).length;
  const wins=done.filter(x=>x.hitT>0||x.status==='timeout+').length;
  const pnls=done.map(x=>x.pnlPct).filter(v=>v!=null);
  const sum=pnls.reduce((a,b)=>a+b,0);
  return {tracked:SETUPS.active.length,resolved:done.length,
    t1Rate:done.length?Math.round(100*t1/done.length):null,
    winRate:done.length?Math.round(100*wins/done.length):null,
    avgPnl:pnls.length?+(sum/pnls.length).toFixed(2):null,   // average realized % per filled trade (before fees)
    netPnl:pnls.length?+sum.toFixed(2):null,                 // sum of every filled trade, 1 unit each
    reversed:SETUPS.active.filter(x=>x.rev).length,
    noFill:SETUPS.resolved.filter(x=>x.status==='expired'||x.status==='invalid').length};
}

/* ============================================================
   HTTP
   ============================================================ */
async function getJSON(url,headers){const r=await fetch(url,{headers});if(!r.ok)throw new Error("HTTP "+r.status+" "+url.slice(0,60));return r.json();}
function readBody(req){return new Promise((resolve,reject)=>{let d="";req.on("data",c=>{d+=c;if(d.length>1.2e7)req.destroy();});req.on("end",()=>resolve(d));req.on("error",reject);});}
// Compute signals from BROWSER-supplied CoinDCX candles (browser is in India → correct ₹ prices). tf + assets[{sym,tk,name,close[],high[],low[],times[],price}]
function cryptoSignalsFrom(payload){
  const tf=payload.tf||"1h", results=[];
  /* WHEN these candles were read. The browser fetched them from CoinDCX a moment before POSTing,
     so "now" is accurate to a second or two — the same standard loadCoinDCX/loadBinance use.
     Without it processAsset falls back to the last candle's OPEN time, which on a 30m chart is up
     to 30 minutes in the past and drifts older until the bar rolls: the card read "📡 04:09 pm" at
     04:38 pm even though its price was 8 seconds old. Longer timeframe, worse it looked — which is
     exactly why this showed up on the 30m tab and not on 5m. Stamped here rather than trusted from
     the payload so a client can't backdate or post-date a card. */
  const fetchedAt=Date.now();
  // BTC regime from the browser-supplied candles, so the alt-long filter applies on the client path too
  const btc=(payload.assets||[]).find(a=>a.tk==='BTC'||a.sym==='BTCINR'||a.sym==='BTCUSDT');
  if(btc&&btc.close&&btc.close.length>41){const st=btcStateFromSeries(btc.close,btc.high,btc.low,tf); if(st)BTC_STATE=st;}
  (payload.assets||[]).forEach(a=>{
    try{
      if(!a.close||a.close.length<41)return;
      const asset={sym:a.sym,tk:a.tk,name:a.name||a.tk,cls:"Crypto",src:"cg"};
      const data={close:a.close,high:a.high,low:a.low,times:a.times,vol:a.vol,price:a.price,
        priceUsd:(+a.priceUsd>0)?+a.priceUsd:0,           // the venue's own $ number, from the browser's ticker read
        rateUsed:(+a.rateUsed>0)?+a.rateUsed:0,           // the rate the browser built its ₹ with
        pairUsed:(a.pairUsed==="usdt"||a.pairUsed==="inr")?a.pairUsed:undefined,
        inrWhy:typeof a.inrWhy==="string"?a.inrWhy.slice(0,120):undefined,
        mtime:fetchedAt};
      const r=processAsset(asset,data,tf);
      // browser-fetched from the Indian exchange — name the market, so a fallback to the thin
      // INR pair is visible on the card rather than blended into a generic "CoinDCX"
      r.priceTag = data.pairUsed==="usdt" ? "live · CoinDCX USDT market"
                 : data.pairUsed==="inr"  ? "live · CoinDCX INR pair"
                 : "live · CoinDCX ₹";
      results.push(r);
    }catch(e){}
  });
  // setup tracker works on the browser-fed path too (India users get their ₹ setups tracked the same way)
  try{ trackSetups(results,tf,'quick'); markReversals(results,tf);
    const pm={};results.forEach(r=>{if(r.sig&&r.sig.price>0)pm[r.asset.sym]=r.sig.price;});
    sweepSetups(pm);
  }catch(e){}
  return {results,tf,total:(payload.assets||[]).length,analyzed:results.length,source:"coindcx-client",
    btc:BTC_STATE?{bull:BTC_STATE.bull,verdict:BTC_STATE.verdict}:null};
}
/* ---------- Deep research: ONE coin across several timeframes → averaged consensus ----------
   Fixes the "each timeframe gives a different stop" risk by blending the frames that agree
   on direction into a single entry / stop / targets, so the risk is consistent. */
function blendResearch(per){
  const avg=arr=>arr.reduce((s,x)=>s+x,0)/arr.length;
  const votes={BUY:0,SELL:0,HOLD:0};
  per.forEach(r=>{votes[r.sig.verdict]=(votes[r.sig.verdict]||0)+1;});
  let verdict="HOLD";
  if(votes.BUY>votes.SELL&&votes.BUY>=votes.HOLD)verdict="BUY";
  else if(votes.SELL>votes.BUY&&votes.SELL>=votes.HOLD)verdict="SELL";
  const dir=verdict==="SELL"?-1:1;
  const agree=per.length?Math.round((votes[verdict]||0)/per.length*100):0;
  const price=per[per.length-1].sig.price;
  // blend only the frames whose verdict matches the consensus (all frames if HOLD)
  const match=verdict==="HOLD"?per:per.filter(r=>r.sig.verdict===verdict);
  let entry=null,stop=null,targets=[],ret=[],rrr=0,riskPct=0,stopSpreadPct=0;
  if(match.length){
    entry=avg(match.map(r=>r.setup.entry));
    stop =avg(match.map(r=>r.setup.stop));
    const nT=Math.max(...match.map(r=>r.setup.targets.length));
    for(let k=0;k<nT;k++){const v=match.map(r=>r.setup.targets[k]).filter(x=>isFinite(x));if(v.length)targets.push(avg(v));}
    ret=targets.map(t=>dir*(t-entry)/entry*100);
    const R=Math.abs(entry-stop)||1; rrr=targets.length?Math.abs(targets[0]-entry)/R:0;
    riskPct=Math.abs((entry-stop)/entry*100);
    const stops=match.map(r=>r.setup.stop);
    stopSpreadPct=stops.length>1?Math.abs(Math.max(...stops)-Math.min(...stops))/entry*100:0;   // how much the per-frame stops disagreed
  }
  const grades=per.map(r=>r.bt&&r.bt.score).filter(v=>v!=null);
  const btAvg=grades.length?Math.round(avg(grades)):null;
  /* The rate that BUILT these ₹ figures, and the venue's own $ for the live price. Without them
     the panel divided by whatever the shared global rate happened to hold, which is only correct
     when that is the same reading — the mismatch that put $3.43 on screen against CoinDCX's
     $3.21. Every crypto payload states its own rate now; none of them share one by accident. */
  const last=per[per.length-1];
  return {verdict,dir,agree,price,priceUsd:last.sig.priceUsd,rateUsed:last.rateUsed,
    entry,stop,targets,ret,rrr,riskPct,stopSpreadPct,btAvg,
    frames:per.map(r=>({tf:r.tf,verdict:r.sig.verdict,score:r.sig.score,entry:r.setup.entry,stop:r.setup.stop,t1:r.setup.targets[0],bt:r.bt&&r.bt.score}))};
}
async function researchCoin(rawSym,horizon){
  try{await ensureCryptoUniverse();}catch(e){}
  if(cryptoMode==="coindcx")await ensureCdxFresh();
  const base=(rawSym||"").toUpperCase().replace(/USDT$|INR$|_INR$|-INR$/,"").replace(/[^A-Z0-9]/g,"");
  if(!base)return {error:"Enter a coin symbol (e.g. SOL, DOGE, BTC)."};
  const uni=(typeof getCRYPTO==='function'?getCRYPTO():CRYPTO)||CRYPTO;
  let asset=uni.find(a=>a.tk===base);
  if(!asset)asset = cryptoMode==="coindcx"
    ? {sym:base+"INR",pair:"I-"+base+"_INR",binance:base+"USDT",tk:base,name:base,cls:"Crypto",src:"cg"}
    : {sym:base+"USDT",binance:base+"USDT",tk:base,name:base,cls:"Crypto",src:"cg"};
  const tfs = horizon==="long" ? ["4h","12h","daily"] : ["5m","15m","1h"];
  const per=[];
  for(const tf of tfs){try{const data=await loadCrypto(asset,tf);per.push(processAsset(asset,data,tf));}catch(e){}}
  if(!per.length)return {error:'No data for "'+base+'". Check the symbol — it may not trade on your exchange.'};
  return {sym:base,horizon,dec:per[0].dec,cryptoMode,consensus:blendResearch(per),ts:Date.now()};
}
// Paper-trading engine (simulation) — reuses this server's scan + live quotes. Never places real orders.
/* `macroGate` is a thunk, not the gate itself: `intel` is declared below this line and is only
   dereferenced later, at tick time. The bot therefore gets the live gate without the two modules
   having to be constructed in a particular order. */
const paper = require('./paper.js')({ scan, liveQuotes, dir:__dirname, rate:()=>cdxUsdtInr(), topMovers, dumpBounce, dumpRule:dumpBotTakes,
  macroGate:()=>intel.gate() });

/* Market-wide stress & correlation engine. Same injection pattern as the paper bot: it gets THIS
   server's candle loader and pivot detector rather than opening its own connection, so the Market
   Health panel can never disagree with the card next to it about what a coin just did. */
const intel = require('./intel')({
  loadCrypto, ensureCryptoUniverse, getCRYPTO:()=>CRYPTO, ticker24, resampleSeries, zigzag, IND,
  dir:__dirname, coingeckoKey:COINGECKO_KEY
});

/* ===== Telegram alerts — ping on a High-confidence quick scalp. Token lives ONLY on the server
   (env var or config.json); it is NEVER sent to the browser or committed to GitHub. Inert until set. ===== */
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || CFG.telegramBotToken || '';
// TELEGRAM_CHAT_ID accepts a SINGLE id OR a comma/space list for multiple recipients, e.g. "12345,67890,111213"
const TG_CHATS = (process.env.TELEGRAM_CHAT_ID || CFG.telegramChatId || '').split(/[,\s;]+/).map(s=>s.trim()).filter(Boolean);
let detectedChat = '';   // used only as a fallback when NO explicit chat IDs are configured
const alertState = { on:true, minConf:70, tfs:['5m','15m'], cooldownMin:45, maxPerScan:5, lastRun:0, sent:0, lastErr:null, recent:{} };
// auto-detect ONE personal chat (fallback when you set no chat IDs): most recent private, non-bot DM.
// Only a real person's PRIVATE DM — never a group/channel/bot (which causes "Forbidden: can't send messages to bots").
async function detectChat(force){
  if(detectedChat && !force) return detectedChat;
  if(!TG_TOKEN) return '';
  try{
    const r=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates`); const j=await r.json();
    if(j && j.ok && Array.isArray(j.result)){
      for(let i=j.result.length-1;i>=0;i--){ const u=j.result[i]||{}; const m=u.message||u.edited_message;
        if(m && m.chat && m.chat.type==='private' && m.chat.id!=null && !(m.from&&m.from.is_bot)){ detectedChat=String(m.chat.id); break; } }
      if(!detectedChat) alertState.lastErr='No personal message found yet — open the bot in Telegram, send it "hi", then re-detect.';
    } else if(j && j.ok===false){ alertState.lastErr=j.description||'getUpdates failed'; }
  }catch(e){ alertState.lastErr=String(e.message||e); }
  return detectedChat;
}
// the recipients: the explicit list if you set one (send to ALL of them), else the single auto-detected chat
async function resolveChats(force){
  if(TG_CHATS.length) return TG_CHATS.slice();
  const c=await detectChat(force); return c?[c]:[];
}
// list every distinct person who has DM'd the bot (id + name) so you can collect chat IDs for a group
async function listChats(){
  const out=[]; if(!TG_TOKEN) return out;
  try{ const r=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates`); const j=await r.json();
    if(j&&j.ok&&Array.isArray(j.result)){ const seen=new Set();
      for(const u of j.result){ const m=u.message||u.edited_message; if(m&&m.chat&&m.chat.type==='private'&&m.chat.id!=null&&!seen.has(m.chat.id)){ seen.add(m.chat.id);
        out.push({id:String(m.chat.id), name:[m.chat.first_name,m.chat.last_name].filter(Boolean).join(' ')||(m.chat.username?'@'+m.chat.username:'')}); } } }
  }catch(e){}
  return out;
}
/* ONE recipient list, used everywhere. Quick Trades alerts go to resolveChats() — the EXPLICIT
   TELEGRAM_CHAT_ID list when you have set one. listChats() is a different thing: only people whose
   DMs are still inside Telegram's getUpdates retention. Position Watch used to offer only the
   latter, so anyone who had configured chat IDs (which the Quick Trades panel actively tells you
   to do) saw working scan alerts and an EMPTY recipient dropdown. Configured recipients come
   first, so the watcher defaults to the same person Quick Trades already messages. */
async function allRecipients(){
  const named={};
  try{ (await listChats()).forEach(c=>{ if(c&&c.id!=null)named[String(c.id)]=c.name||""; }); }catch(e){}
  const out=[],seen=new Set();
  const push=(id,src)=>{ id=String(id||"").trim(); if(!id||seen.has(id))return; seen.add(id);
    out.push({id,name:named[id]||("chat …"+id.slice(-4)),src}); };
  let primary=[]; try{ primary=await resolveChats(); }catch(e){}
  primary.forEach(id=>push(id,"alerts"));            // exactly who Quick Trades sends to
  Object.keys(named).forEach(id=>push(id,"messaged"));
  return out;
}
async function tgSend(chat,text){
  const r=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({chat_id:chat,text,parse_mode:'HTML',disable_web_page_preview:true})});
  const j=await r.json().catch(()=>({}));
  const ok=r.ok && j.ok!==false; if(!ok) alertState.lastErr=(j&&j.description)||('HTTP '+r.status);
  return {ok, status:r.status, desc:j&&j.description};
}
async function sendTelegram(text){
  if(!TG_TOKEN) return {ok:false,reason:'No bot token set (TELEGRAM_BOT_TOKEN).'};
  const chats=await resolveChats();
  if(!chats.length) return {ok:false,reason:'No chat yet — open your bot in Telegram, send it a message, then Re-detect.'};
  let anyOk=false, lastDesc='';
  for(const chat of chats){
    let res=await tgSend(chat,text);
    // single auto-detect that landed on a bot id → clear & re-detect a real personal chat, retry once
    if(!res.ok && !TG_CHATS.length && /to (the |a )?bots?/i.test(res.desc||'')){ detectedChat=''; const c2=await detectChat(true); if(c2&&c2!==chat) res=await tgSend(c2,text); }
    if(res.ok) anyOk=true; else lastDesc=res.desc||res.reason||lastDesc;
  }
  return {ok:anyOk, recipients:chats.length, desc:anyOk?undefined:lastDesc};
}
// a result qualifies for an alert only if it's a scalp/correction setup, High-confidence, and actionable now
function alertEligible(r,minConf){
  if(!r||!r.setup||!r.confidence||r.confidence.pct==null) return false;
  const scalp = r.setup.regime==='range' || r.setup.regime==='correction';
  const actionable = r.action && ['buynow','sellnow','buybreak','sellbreak','waitdip','waitbounce'].includes(r.action.kind);
  return scalp && r.confidence.pct>=minConf && actionable;
}
function fmtAlert(r){
  const s=r.setup, isL=s.dir>0, dec=r.dec||((r.sig.price||0)<5?4:2), f=v=>'₹'+(+v).toFixed(dec);
  const tag = s.regime==='correction'?'₿ correction short':'⚡ range scalp';
  return `⚡ <b>Quick scalp — ${r.confidence.label} ${r.confidence.pct}%</b>\n`+
    `${isL?'🟢 LONG':'🔴 SHORT'} <b>${r.asset.tk||r.asset.sym}</b> · ${r._tf} · ${tag}\n`+
    `Entry ${f(s.entryLo)}–${f(s.entryHi)}\n`+
    `🎯 Target ${f(s.targets[0])} (+${Math.abs(s.ret[0]).toFixed(1)}%)   🛑 Stop ${f(s.stop)} (−${s.riskPct.toFixed(1)}%)\n`+
    `R:R ${s.rrr.toFixed(1)}:1 · live ${f(r.sig.price)}\n`+
    `<i>Simulation / not financial advice — verify on your platform before trading.</i>`;
}
/* 🎢 Dump & Bounce alerts. A bump runs and dies inside 24–72 hours, so a panel you have to be
   looking at is a panel that misses the trade. Fires on the TRANSITION into a live zone, not on
   every scan while price sits there, so a coin parked in its buy zone pings once, not hourly. */
let dbAlertLast={};
function fmtPlanAlert(r){
  const p=r.plan, s=p.now==="buy"?p.long:p.short, isL=s.dir>0;
  const dec=p.price<5?4:2, f=v=>"₹"+(+v).toFixed(dec);
  const bt=r.planBt&&(isL?r.planBt.long:r.planBt.short);
  const ev=(bt&&!bt.thin&&bt.winRate!=null)
    ? `Backtested on this coin: <b>${bt.winRate}%</b> win over ${bt.n} trades · avg <b>${bt.avgR}R</b>`
    : `Not enough history on this coin to backtest (${bt?bt.n:0} trades) — size accordingly`;
  return `🎢 <b>Dump &amp; Bounce — ${isL?"buy the bounce":"short the failure"}</b>\n`+
    `${isL?"🟢 LONG":"🔴 SHORT"} <b>${r.tk||r.sym}</b> · ${BUMP_TF} · ${isL?"counter-trend":"with-trend"}\n`+
    `Entry ${f(s.entryLo)}–${f(s.entryHi)}\n`+
    `🎯 T1 ${f(s.targets[0])} (+${s.ret[0]}%)   🛑 Stop ${f(s.stop)} (−${s.riskPct}%)\n`+
    `R:R ${s.rrr}:1 · live ${f(p.price)} · ${r.ddPct}% off a high set ${r.peakAgeDays}d ago\n`+
    `${ev}\n`+
    `<i>Simulation / not financial advice — verify on your platform before trading.</i>`;
}
async function dumpBounceAlerts(){
  let d; try{ d=await dumpBounce(); }catch(e){ return 0; }
  let sent=0;
  const seen={};
  for(const r of (d.rows||[])){
    const now=r.plan&&r.plan.now; if(!now)continue;
    seen[r.sym]=now;
    if(now!=="buy"&&now!=="short")continue;
    if(dbAlertLast[r.sym]===now)continue;                // already alerted this state — only the transition pings
    dbAlertLast[r.sym]=now;
    if(sent>=alertState.maxPerScan)continue;
    const res=await sendTelegram(fmtPlanAlert(r));
    if(res.ok){ alertState.sent++; sent++; }
  }
  dbAlertLast=seen;                                      // forget coins that dropped off the list
  return sent;
}
async function alertScan(){
  if(!alertState.on || !TG_TOKEN) return;   // chat is auto-resolved at send time
  alertState.lastRun=Date.now();
  const now=Date.now(), cd=alertState.cooldownMin*60000;
  for(const k in alertState.recent){ if(now-alertState.recent[k]>cd) delete alertState.recent[k]; }   // expire dedup entries
  const cands=[];
  for(const tf of alertState.tfs){
    let d; try{ d=await scan('Crypto',tf); }catch(e){ continue; }
    (d.results||[]).forEach(r=>{ if(alertEligible(r,alertState.minConf)){ r._tf=tf; cands.push(r); } });
  }
  cands.sort((a,b)=>b.confidence.pct-a.confidence.pct);
  let sent=0;
  for(const r of cands){
    if(sent>=alertState.maxPerScan) break;
    const key=r.asset.sym+'|'+r._tf+'|'+(r.setup.dir>0?'L':'S');
    if(alertState.recent[key]) continue;               // already alerted this setup recently
    alertState.recent[key]=now;
    const res=await sendTelegram(fmtAlert(r));
    if(res.ok){ alertState.sent++; sent++; }
  }
  try{ await dumpBounceAlerts(); }catch(e){}
}
/* ============================================================
   🔔 POSITION WATCH — trades YOU actually placed, watched server-side.

   Different from 📋 My Trades (browser-only, localStorage, dies with the tab) and from
   📌 Tracked setups (recommendations the app made). This is: "I bought X at Y — tell me if the
   reason to hold it disappears." It lives on the server so the watch keeps running with the
   browser closed, which is the only way a reversal alert is worth anything.

   Each position names ONE Telegram recipient — the person who actually placed the trade — and
   alerts go only to them, never to the broadcast list. Alerts fire on state TRANSITIONS
   (onside → reversed, reversed → back onside), never on a timer, so a trade that sits reversed
   pings once rather than every two minutes.
   ============================================================ */
const POS_FILE=path.join(__dirname,"positions.json");
const POS_SWEEP_MS=120000;
let POSITIONS=[];
try{const j=JSON.parse(fs.readFileSync(POS_FILE,"utf8"));if(Array.isArray(j))POSITIONS=j;}catch(e){}
let posDirty=false;
function savePositions(){if(!posDirty)return;try{fs.writeFileSync(POS_FILE,JSON.stringify(POSITIONS));posDirty=false;}catch(e){}}
// Find a tradeable instrument by symbol OR ticker, across every universe this server knows.
function resolveAsset(sym){
  const q=String(sym||"").trim().toUpperCase(); if(!q)return null;
  const all=[...CRYPTO,...STOCKS,...ETFS,...INDICES,...COMMODITIES];
  /* Three exact forms, because the universes label instruments differently: crypto carries `tk`
     (BTC) and Upstox names carry `ts` — the NSE trading symbol (RELIANCE) — while `sym` is the
     internal key (BTCUSDT / RELIANCE.NS). Missing `ts` here meant LT and ABB, both exact NSE
     symbols, were REFUSED as ambiguous prefixes of LTIM/LTTS and ABBOTINDIA. An exact ticker must
     always beat a prefix. */
  const exact = all.find(a=>String(a.sym).toUpperCase()===q)
             || all.find(a=>String(a.tk||"").toUpperCase()===q)
             || all.find(a=>String(a.ts||"").toUpperCase()===q);
  if(exact)return exact;
  /* Prefix matching is a convenience, but only when it is UNAMBIGUOUS. It used to return the
     first hit, so a half-typed "BT" silently bound to whatever happened to sort first — and a
     position quietly watching the wrong instrument is worse than one that refuses to be created.
     Quote-suffix variants of one coin (BTCUSDT / BTCINR) are the same asset, so they don't count
     as ambiguity; two different tickers do. */
  const hits=all.filter(a=>String(a.sym).toUpperCase().startsWith(q)
    ||String(a.tk||"").toUpperCase().startsWith(q)||String(a.ts||"").toUpperCase().startsWith(q));
  if(!hits.length)return null;
  const bases=new Set(hits.map(a=>String(a.tk||a.ts||a.sym).toUpperCase()));
  return bases.size===1?hits[0]:null;
}
async function positionData(asset,tf){
  if(asset.src==="cg")return await loadCrypto(asset,tf);
  if(DEMO)return synth(hashStr(asset.sym),tf==="daily"?500:400,0.03);
  if(!loggedIn())throw new Error("login");
  await ensureInstruments();
  const key=keyForAsset(asset); if(!key)throw new Error("no instrument key");
  return await upstoxCandles(key,tf);
}
// Current verdict + price for one position. Drops the forming bar, exactly like /api/signal.
async function positionSignal(pos){
  const asset=resolveAsset(pos.sym); if(!asset)throw new Error("unknown symbol");
  if(asset.src==="cg"&&!DEMO){
    try{await ensureCryptoUniverse();}catch(e){}
    // EVERY other crypto path refreshes this before pricing — scan(), researchCoin(), liveQuotes()
    // and ticker24() all do. This one did not, so loadCoinDCX rescaled its candles against a
    // cdxTicker snapshot that could be minutes or hours old, and Position Watch became the one
    // surface quoting a different number for the same coin.
    if(cryptoMode==="coindcx")await ensureCdxFresh();
  }
  const d=await positionData(asset,pos.tf||"1h");
  if(!d||!d.close||d.close.length<41)throw new Error("not enough history");
  const sig=computeSignal(d.close.slice(0,-1),d.high.slice(0,-1),d.low.slice(0,-1),(pos.tf==="daily")?20:12);
  return {asset,price:d.price||d.close[d.close.length-1],verdict:sig.verdict,score:sig.score};
}
const posPnl=(p,px)=>(p.entry>0&&px>0)?+((p.side>0?px/p.entry-1:1-px/p.entry)*100).toFixed(2):null;
function fmtPosAlert(p,kind,px,verdict){
  /* Quote crypto in BOTH currencies. This message arrives on a phone, away from the app, and a
     coin you bought on CoinDCX at $0.0067 is unrecognisable as "₹0.59" — showing one alone makes
     the alert useless at exactly the moment it matters. Everything else is ₹-native. */
  const r=priceRate(), dual=p.cls==="Crypto"&&r>0;
  const f=v=>{ if(v==null||!isFinite(v))return "—";
    const inr="₹"+(+v).toFixed(v<5?4:2);
    if(!dual)return inr;
    const u=v/r; return "$"+u.toFixed(u<5?4:2)+" ("+inr+")"; };
  const pnl=posPnl(p,px), side=p.side>0?"LONG":"SHORT";
  const pl=pnl==null?"":`\nP&L <b>${pnl>=0?"+":""}${pnl}%</b> from your ${f(p.entry)} entry`;
  if(kind==="watch"){
    // Say up front if this trade is already fighting the signal. That is a normal, deliberate way
    // to trade a bounce — but you should know it, and it explains why no alarm will follow.
    const counter=p.counterAtEntry
      ? `\n\n⚠️ <b>Heads up: the signal already says ${p.entryVerdict} on ${p.tf}</b>, so this is a counter-trend trade from the start. That is a choice, not a problem — but it does mean you have no signal behind you. You will NOT be pinged for this; only for a change.`
      : "";
    return `👀 <b>Now watching your ${side} ${p.tk||p.sym}</b>\n`+
      `Entry ${f(p.entry)} · ${p.tf} chart · live ${f(px)}${p.entryVerdict?` · signal now <b>${p.entryVerdict}</b>`:""}\n`+
      `You will get one message here if the signal turns against this trade, and one if it comes back. Nothing in between.${counter}`;
  }
  if(kind==="reversed"){
    // Only ever sent on a real flip. If the trade began counter-trend, the signal must have come
    // onside and gone again — so the wording has to hold in both cases without over-claiming.
    const lost=p.counterAtEntry
      ? `<b>The signal came onside and has now turned again.</b>`
      : `<b>The reason you entered is gone.</b>`;
    return `⚠️ <b>YOUR TRADE REVERSED — ${p.tk||p.sym}</b>\n`+
      `Your <b>${side}</b> is now against the signal (<b>${verdict}</b> on ${p.tf}).${pl}\n`+
      `Live ${f(px)}\n\n`+
      `${lost} Either close it, or move your stop to where you would admit you were wrong — do not widen it and hope.\n`+
      `<i>Simulation / not financial advice — verify on your platform.</i>`;
  }
  if(kind==="onside")
    return `✅ <b>Signal now agrees with you — ${p.tk||p.sym}</b>\n`+
      `It reads <b>${verdict}</b> on ${p.tf}, which backs your <b>${side}</b>.${pl}\nLive ${f(px)}`;
  return "";
}
async function positionsSweep(){
  const open=POSITIONS.filter(p=>p.status==="open");
  if(!open.length)return 0;
  let sent=0;
  /* Price from the SAME source every other panel uses. The signal has to come from candles, but
     the PRICE must not: in Binance mode loadBinance returns the last candle close × FX, while
     /api/quotes reports the live ticker, so the two disagree on any fast-moving coin. Pull the
     live book once per sweep (8s-cached) and overlay it, exactly as scan() pins Upstox LTPs.
     Same tab-routing as setupsSweep, so a stock position gets an Upstox quote and a coin gets a
     crypto one. */
  const px={};
  try{
    const tabs=new Set(open.map(p=>p.src==="cg"?"Crypto":"All"));
    for(const t of tabs){ try{ Object.assign(px,await liveQuotes(t)); }catch(e){} }
  }catch(e){}
  for(const p of open){
    let s; try{ s=await positionSignal(p); }catch(e){ p.err=String(e.message||e).slice(0,60); posDirty=true; continue; }
    delete p.err;
    const live=px[(s.asset&&s.asset.sym)||p.sym];
    p.price=(live>0)?live:s.price;          // live book wins; candle close is the fallback
    p.priceSrc=(live>0)?"live":"candle";
    p.verdict=s.verdict; p.pnlPct=posPnl(p,p.price); p.seen=Date.now(); posDirty=true;
    // HOLD is not a reversal — it means the engine has no opinion, which is not the same as
    // disagreeing with you. Only an explicitly opposite verdict counts.
    const against = p.side>0 ? s.verdict==="SELL" : s.verdict==="BUY";
    /* A REVERSAL IS A CHANGE, NOT A COMPARISON.
       This used to be a stateless test — "does the signal disagree with you right now?" — with no
       memory of what the signal said when you entered. So a deliberately counter-trend trade was
       branded REVERSED the instant it was added, under a message reading "the reason you entered
       is gone" when there had never been one. That is not an edge case for this app: 🎢 Dump &
       Bounce exists to buy bounces in coins whose signal is still SELL, so its own recommendations
       tripped it every time.
       The baseline is now recorded at entry and only a TRANSITION is an event. Entering against
       the signal is a choice; the signal turning on you afterwards is news. */
    const was = p.against;
    p.against = against;
    if(was===undefined) posDirty=true;                 // first sight (or a pre-upgrade record): seed, never alert
    else if(against&&!was){
      p.rev=Date.now(); p.alerts=(p.alerts||0)+1;
      if(TG_TOKEN&&p.chat){ const r=await tgSend(p.chat,fmtPosAlert(p,"reversed",s.price,s.verdict)); if(r.ok)sent++; }
    }else if(!against&&was){
      delete p.rev; p.alerts=(p.alerts||0)+1;
      if(TG_TOKEN&&p.chat){ const r=await tgSend(p.chat,fmtPosAlert(p,"onside",s.price,s.verdict)); if(r.ok)sent++; }
    }
  }
  savePositions();
  return sent;
}
async function addPosition(b){
  const asset=resolveAsset(b.sym); if(!asset)return {error:"Unknown symbol — pick one from the list."};
  const side=(String(b.side).toLowerCase()==="short"||+b.side<0)?-1:1;
  const entry=+b.entry;
  if(!(entry>0))return {error:"Entry price must be a positive number."};
  const tf=TF_MIN[b.tf]?b.tf:"1h";
  /* LEVERAGE FIELDS ARE OPTIONAL AND BACKWARD-COMPATIBLE.
     Every position saved before this existed has no lev/margin/liq, and must keep working exactly
     as it did — the watcher only ever needed side and entry. Supplying them unlocks the position
     stress score, the distance-to-liquidation read and the risk map; omitting them leaves those
     fields null and clearly marked unavailable rather than guessed at.
     `liq` is the venue's OWN liquidation price. When given it always wins over the estimate,
     because every exchange runs its own maintenance-margin ladder and ours is an approximation. */
  const lev=+b.lev>0?Math.min(125,+b.lev):null;
  const p={id:"p"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),
    sym:asset.sym,tk:asset.tk||"",name:asset.name||asset.tk||asset.sym,cls:asset.cls||"",src:asset.src||"",
    side,entry,qty:+b.qty>0?+b.qty:null,tf,
    lev, margin:+b.margin>0?+b.margin:null, liq:+b.liq>0?+b.liq:null,
    chat:String(b.chat||"").trim()||null, chatName:String(b.chatName||"").trim()||null,
    created:Date.now(),status:"open",alerts:0,note:String(b.note||"").slice(0,120)};
  POSITIONS.push(p); posDirty=true;
  try{ const s=await positionSignal(p);
       // Same live-book overlay the sweep uses, so the price you see the instant you add a trade
       // is the price every other panel is showing for that coin.
       let live=0; try{ live=(await liveQuotes(p.src==="cg"?"Crypto":"All"))[s.asset?s.asset.sym:p.sym]||0; }catch(e){}
       p.price=(live>0)?live:s.price; p.priceSrc=(live>0)?"live":"candle";
       p.verdict=s.verdict; p.pnlPct=posPnl(p,p.price);
       // Record the baseline instead of raising a flag. If the signal already disagrees, that is a
       // COUNTER-TREND entry — a legitimate deliberate choice, not a reversal — and it is said
       // plainly in the confirmation rather than dressed up as an alarm.
       p.entryVerdict=s.verdict;
       p.against = p.side>0 ? s.verdict==="SELL" : s.verdict==="BUY";
       p.counterAtEntry = p.against;
     }catch(e){ p.err=String(e.message||e).slice(0,60); }
  // Confirm to the chosen recipient immediately — it proves the alert route works before it matters.
  if(TG_TOKEN&&p.chat&&p.price>0){ try{ await tgSend(p.chat,fmtPosAlert(p,"watch",p.price)); }catch(e){} }
  savePositions();
  return {ok:true,position:p};
}
/* 🩺 One market-health iteration: refresh, record, deliver whatever just transitioned.
   Coin-level alerts are evaluated ONLY for coins the trader actually holds — a board-wide
   "underperforming" list would be forty pings nobody reads. */
const INTEL_SWEEP_MS=parseInt(process.env.INTEL_SWEEP_MS)||120000;
async function intelSweep(){
  const watched=Array.from(new Set(POSITIONS.filter(p=>p.status==="open"&&p.src==="cg").map(p=>p.tk).filter(Boolean)));
  let r; try{ r=await intel.tick({watchedCoins:watched}); }catch(e){ return {ok:false,err:String(e.message||e)}; }
  if(!r.ok||!r.alerts.length)return r;
  if(TG_TOKEN){
    for(const a of r.alerts){ try{ await sendTelegram(intel.formatTelegram(a)); }catch(e){} }
  }
  return r;
}
/* ⚡ MOMENTUM SWEEP — the alert path the platform never had.
   Runs on its OWN fast cadence, deliberately separate from every other loop: the market-health
   tick is 2 minutes and the scalp alert loop is 3, which is useless for a move that does most of
   its work inside five. This one reads the ticker buffer (no fetch of its own) so it can run at
   30s for almost nothing.

   It is NOT gated on the range/correction regime — that filter is precisely why a vertical move
   could never raise an alert before.

   FIRES ON IGNITION ONLY, and once per coin per cooldown. A coin running for twenty minutes is
   one event; alerting every sweep would train you to ignore the channel by the time it mattered.
   Deliberately silent on `extended` and `stalling`: paging someone about a move that already
   happened is how a detector becomes a chase button. */
const MOM_SWEEP_MS=parseInt(process.env.MOMENTUM_SWEEP_MS)||30000;
const MOM_COOLDOWN_MS=45*60*1000;
let momAlertLast={};
function fmtMomentumAlert(m,rate){
  const px = rate>0 ? '₹'+(m.price).toLocaleString('en-IN',{maximumFractionDigits:m.price<5?6:2}) : String(m.price);
  const pc=v=>v==null?'—':`${v>=0?'+':''}${(v*100).toFixed(1)}%`;
  return `⚡ <b>MOMENTUM — ${m.base} ${m.direction==='up'?'🟢 up':'🔴 down'}</b>\n`+
    `<b>${m.stageLabel}</b>${m.z!=null?` · ${m.zCapped?'over '+m.z:m.z}× its normal 5m move`:''}\n`+
    `1m ${pc(m.chg1m)} · 5m ${pc(m.chg5m)} · 15m ${pc(m.chg15m)} · 24h ${m.chg24h!=null?m.chg24h.toFixed(1)+'%':'—'}\n`+
    `Now ${px}${m.surge!=null?` · volume ${m.surge}× its 24h average rate`:''}\n`+
    `<i>Detected from the live ticker, not a completed candle. This is a MOVE notification, not a setup — there is no entry, stop or target attached, and a vertical move is where leveraged entries are most often liquidated. Verify on your platform.</i>`;
}
async function momentumSweep(){
  if(!TG_TOKEN||!alertState.on)return 0;
  let r; try{ if(cryptoMode==="coindcx")await ensureCdxFresh(6000); r=intel.momentum.scan({isStable:isStableBase,limit:40}); }catch(e){ return 0; }
  if(!r.ok)return 0;
  const now=Date.now(), rate=priceRate();
  for(const k in momAlertLast) if(now-momAlertLast[k]>MOM_COOLDOWN_MS) delete momAlertLast[k];
  let sent=0;
  for(const m of r.movers){
    if(m.stage!=='igniting')continue;                     // only the start of a move is actionable
    if(momAlertLast[m.base])continue;                     // one ping per coin per cooldown
    if(sent>=3)break;                                     // never flood: three coins a sweep, maximum
    momAlertLast[m.base]=now;
    try{ const res=await sendTelegram(fmtMomentumAlert(m,rate)); if(res.ok)sent++; }catch(e){}
  }
  return sent;
}
function sendJSON(res,o,c=200){const b=JSON.stringify(o);res.writeHead(c,{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"});res.end(b);}
const MIME={".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".svg":"image/svg+xml"};
async function handler(req,res){
  const u=new URL(req.url,"http://localhost"),p=u.pathname;
  try{
    if(p==="/api/status")return sendJSON(res,{hasCreds:!!(API_KEY&&API_SECRET),loggedIn:loggedIn(),demo:DEMO,marketOpen:marketOpen(),tokenDate:loadToken()?loadToken().date:null,broker:"Upstox"});
    if(p==="/auth/login"){if(!API_KEY)return sendJSON(res,{error:"Set upstoxApiKey in config.json first"},400);res.writeHead(302,{Location:authURL()});return res.end();}
    if(p==="/callback"){const code=u.searchParams.get("code");
      if(!code)return htmlMsg(res,"Login failed","No authorization code returned. Try again from the dashboard.");
      try{const tok=await exchangeCode(code);saveToken(tok);res.writeHead(302,{Location:"/"});return res.end();}
      catch(e){return htmlMsg(res,"Login failed",e.message);}}
    if(p==="/api/scan"){ // no login gate — crypto/commodity-ETF work without Upstox; stocks just skip until logged in
      const data=await scan(u.searchParams.get("tab")||"Stocks",u.searchParams.get("tf")||"intraday");return sendJSON(res,data);}
    if(p==="/api/quotes"){
      {const q=await liveQuotesFull(u.searchParams.get("tab")||"Stocks");return sendJSON(res,withLiveRate({quotes:q.inr,usd:q.usd,loggedIn:loggedIn(),ts:Date.now()}));}}
    if(p==="/api/backtest"){
      const data=await backtest(u.searchParams.get("tab")||"Stocks",u.searchParams.get("tf")||"daily");return sendJSON(res,data);}
    if(p==="/api/crypto-signals" && req.method==="POST"){
      const body=await readBody(req);let payload;try{payload=JSON.parse(body);}catch(e){return sendJSON(res,{error:"bad json"},400);}
      return sendJSON(res,cryptoSignalsFrom(payload));}
    if(p==="/api/movers"){   // 🔥 biggest volume-backed movement right now, scalp plan attached
      return sendJSON(res,await topMovers(u.searchParams.get("tab")||"Crypto",u.searchParams.get("tf")||"5m"));}
    if(p==="/api/dumpbounce"){   // 🎢 coins bleeding from an old high, with the 4h bump timed and its base rate
      return sendJSON(res,await dumpBounce(u.searchParams.get("force")==="1"));}
    if(p==="/api/setups"){   // 📌 tracked setups: every recommendation followed to its outcome + forward hit-rate
      const tfq=u.searchParams.get("tf")||null, lim=Math.min(200,parseInt(u.searchParams.get("limit"))||40);
      const setupRate=priceRate()||undefined;
      const active=SETUPS.active.filter(x=>!tfq||x.tf===tfq).slice().sort((a,b)=>b.born-a.born).slice(0,60)
        .map(x=>({...x,rateUsed:setupRate,pnlNow:x.status==='filled'?realizedPct(x,x.live):null}));   // live unrealized %, so you know where you stand
      const history=SETUPS.resolved.filter(x=>!tfq||x.tf===tfq).slice(-lim).reverse().map(x=>({...x,rateUsed:setupRate}));
      return sendJSON(res,withLiveRate({active,recent:history,history,stats:setupStats(),ts:Date.now(),demo:DEMO}));}
    if(p==="/api/research"){   // one coin, several timeframes, averaged consensus (short or long horizon)
      const sym=u.searchParams.get("sym")||"", horizon=u.searchParams.get("horizon")==="long"?"long":"short";
      return sendJSON(res,await researchCoin(sym,horizon));}
    /* ===== 🩺 MARKET HEALTH — market-wide stress & correlation engine ===== */
    if(p==="/api/intel"){   // full market pass: regime, breadth, correlation, transmission, leverage, liquidity
      return sendJSON(res,withLiveRate(await intel.get(u.searchParams.get("force")==="1")));}
    if(p==="/api/intel/why"){   // the one-click "why is everything falling?" diagnostic
      const d=await intel.get();
      if(!d.ok)return sendJSON(res,{ok:false,reason:d.reason});
      return sendJSON(res,{ok:true,ts:d.ts,regime:d.regime,why:d.why,dataQuality:d.dataQuality});}
    if(p==="/api/intel/position"){   // one open trade, fully contextualised against the market
      const id=u.searchParams.get("id");
      const pos=id?POSITIONS.find(x=>x.id===id):null;
      if(id&&!pos)return sendJSON(res,{ok:false,reason:"position not found"},404);
      // Ad-hoc mode: score a hypothetical position without saving it first.
      const adhoc=!pos?{tk:(u.searchParams.get("tk")||"").toUpperCase(),sym:u.searchParams.get("sym")||"",
        side:u.searchParams.get("side")==="short"?-1:1,entry:+u.searchParams.get("entry"),
        lev:+u.searchParams.get("lev")||null,liq:+u.searchParams.get("liq")||null}:null;
      const target=pos||adhoc;
      if(!target||!(target.entry>0))return sendJSON(res,{ok:false,reason:"need a saved position id, or tk+entry (+lev) for an ad-hoc check"},400);
      let live=0; try{ live=(await liveQuotes("Crypto"))[target.sym]||0; }catch(e){}
      return sendJSON(res,withLiveRate(await intel.position(target,{price:live||undefined})));}
    if(p==="/api/intel/coin"){   // one coin vs the market, for any card that wants context
      return sendJSON(res,await intel.coinContext((u.searchParams.get("tk")||"").toUpperCase()));}
    if(p==="/api/intel/backtest"){   // "when stress > 80, what happened next?" — from recorded snapshots only
      const sig=u.searchParams.get("signal");
      if(sig&&intel.history.SIGNALS[sig])return sendJSON(res,{...intel.history.backtest(sig,intel.history.SIGNALS[sig].test),label:intel.history.SIGNALS[sig].label});
      return sendJSON(res,{stats:intel.history.stats(),signals:intel.history.runAll()});}
    if(p==="/api/intel/history"){
      return sendJSON(res,{stats:intel.history.stats(),rows:intel.history.recent(Math.min(500,parseInt(u.searchParams.get("limit"))||100))});}
    if(p==="/api/intel/health"){   // which feeds are actually reachable from THIS server
      return sendJSON(res,{derivs:await intel.derivsHealth(),lastError:intel.lastError(),history:intel.history.stats()});}
    if(p==="/api/intel/gate"){   // the macro gate on its own — what is being blocked and degraded, and why
      return sendJSON(res,await intel.gate());}
    if(p==="/api/intel/calendar"){   // scheduled event risk, straight from macro-calendar.json
      return sendJSON(res,intel.calendar.eventRisk());}
    if(p==="/api/intel/momentum"){   // ⚡ vertical moves across the WHOLE exchange, from the live ticker
      if(cryptoMode==="coindcx")try{await ensureCdxFresh(4000);}catch(e){}
      return sendJSON(res,withLiveRate({...intel.momentum.scan({isStable:isStableBase,limit:Math.min(50,parseInt(u.searchParams.get("limit"))||25)}),
        buffer:intel.momentum.stats()}));}

    if(p==="/api/paper/state") return sendJSON(res,paper.getState());
    if(p==="/api/paper/control"){ const a=u.searchParams.get("action");
      if(a==="start")return sendJSON(res,paper.start());
      if(a==="stop")return sendJSON(res,paper.stop());
      if(a==="reset")return sendJSON(res,paper.reset());
      if(a==="tick")return sendJSON(res,await paper.tick());
      return sendJSON(res,{error:"bad action"},400); }
    if(p==="/api/paper/config" && req.method==="POST"){ const body=await readBody(req); let c={}; try{c=JSON.parse(body);}catch(e){} return sendJSON(res,paper.setConfig(c)); }
    if(p==="/api/signal"){   // current verdict for ONE Upstox instrument (used by the trade-reversal watcher)
      const sym=u.searchParams.get("sym"), tf=u.searchParams.get("tf")||"1h";
      if(sym&&sym.startsWith("MCX:")){try{await ensureCommodities();}catch(e){}}
      const asset=[...STOCKS,...ETFS,...INDICES,...COMMODITIES].find(a=>a.sym===sym);
      if(!asset)return sendJSON(res,{error:"unknown symbol"},404);
      if(!DEMO&&!loggedIn())return sendJSON(res,{error:"login"},401);
      if(!DEMO)await ensureInstruments();
      const key=DEMO?("D|"+sym):keyForAsset(asset); if(!key)return sendJSON(res,{error:"no key"},404);
      const data=DEMO?synth(hashStr(sym),tf==='daily'?500:400,0.03):await upstoxCandles(key,tf);
      if(!data||data.close.length<41)return sendJSON(res,{error:"short"},200);
      const cl=data.close.slice(0,-1),hi=data.high.slice(0,-1),lo=data.low.slice(0,-1);
      const sig=computeSignal(cl,hi,lo,tf==='daily'?20:12);
      return sendJSON(res,{sym,verdict:sig.verdict,score:sig.score});}
    if(p==="/api/positions"){   // 🔔 trades you placed, watched server-side for a reversal
      if(req.method==="POST"){ const body=await readBody(req); let b={}; try{b=JSON.parse(body);}catch(e){return sendJSON(res,{error:"bad json"},400);}
        if(b.action==="close"||b.action==="delete"){
          const i=POSITIONS.findIndex(x=>x.id===b.id); if(i<0)return sendJSON(res,{error:"not found"},404);
          const [gone]=POSITIONS.splice(i,1); posDirty=true; savePositions(); return sendJSON(res,{ok:true,removed:gone.id}); }
        if(!DEMO)try{await ensureCryptoUniverse();}catch(e){}
        return sendJSON(res,await addPosition(b)); }
      const chats=await allRecipients();
      const posRate=priceRate()||undefined;
      return sendJSON(res,withLiveRate({positions:POSITIONS.slice().sort((a,b)=>b.created-a.created).map(p=>({...p,rateUsed:posRate})),
        chats, hasToken:!!TG_TOKEN, explicit:!!TG_CHATS.length, ts:Date.now(), demo:DEMO})); }
    if(p==="/api/positions/sweep"){ return sendJSON(res,{sent:await positionsSweep(),positions:POSITIONS}); }
    if(p==="/api/universe"){    // symbols the watcher will accept, for the add-position picker
      if(!DEMO)try{await ensureCryptoUniverse();}catch(e){}
      const map=a=>({sym:a.sym,tk:a.tk||"",name:a.name||a.tk||a.sym,cls:a.cls||""});
      return sendJSON(res,{crypto:CRYPTO.map(map),other:[...STOCKS,...ETFS,...INDICES,...COMMODITIES].map(map)}); }
    if(p==="/api/alert/status"){ const chats=await resolveChats(); return sendJSON(res,{hasToken:!!TG_TOKEN,configured:!!(TG_TOKEN&&chats.length),recipients:chats.length,explicit:!!TG_CHATS.length,chat:chats.length?('…'+String(chats[0]).slice(-4)+(chats.length>1?' +'+(chats.length-1)+' more':'')):null,on:alertState.on,minConf:alertState.minConf,tfs:alertState.tfs,lastRun:alertState.lastRun,sent:alertState.sent,lastErr:alertState.lastErr}); }
    if(p==="/api/alert/detectchat"){ const c=await detectChat(true); return sendJSON(res,{hasToken:!!TG_TOKEN,found:!!c,chat:c?('…'+String(c).slice(-4)):null,lastErr:alertState.lastErr}); }
    if(p==="/api/alert/chats"){ return sendJSON(res,{hasToken:!!TG_TOKEN,chats:await allRecipients(),using:(TG_CHATS.length?TG_CHATS:(detectedChat?[detectedChat]:[])).map(String),explicit:!!TG_CHATS.length}); }
    if(p==="/api/alert/test"){ const rr=await sendTelegram('✅ <b>Test alert</b> — Growth Intelligence Telegram is connected. You will get a ping here when a High-confidence quick scalp appears.'); return sendJSON(res,{...rr}); }
    if(p==="/api/alert/config" && req.method==="POST"){ const body=await readBody(req); let c={}; try{c=JSON.parse(body);}catch(e){} if(c.on!=null)alertState.on=!!c.on; if(c.minConf!=null&&!isNaN(+c.minConf))alertState.minConf=Math.max(50,Math.min(95,+c.minConf)); return sendJSON(res,{on:alertState.on,minConf:alertState.minConf}); }
    // static — tolerate index.html living in /public OR the repo root
    let rel=path.normalize(p==="/"?"/index.html":p).replace(/^(\.\.[/\\])+/,"").replace(/^[/\\]+/,"");
    const candidates=[path.join(__dirname,"public",rel),path.join(__dirname,rel)];
    for(const fp of candidates){if(fs.existsSync(fp)&&fs.statSync(fp).isFile()){res.writeHead(200,{"Content-Type":MIME[path.extname(fp)]||"application/octet-stream"});return fs.createReadStream(fp).pipe(res);}}
    if(p==="/"){res.writeHead(200,{"Content-Type":"text/html"});return res.end('<body style="font-family:sans-serif;background:#0a0e14;color:#eaf1f8;padding:40px"><h2>◆ Server is LIVE ✅</h2><p>Your deploy worked — but <b>index.html</b> isn’t in the repo yet. Upload <span style="font-family:monospace">index.html</span> to your GitHub repo, wait ~2 min for Render to redeploy, then refresh this page.</p></body>');}
    res.writeHead(404);res.end("Not found");
  }catch(e){sendJSON(res,{error:String(e.message||e)},500);}
}
function htmlMsg(res,t,m){res.writeHead(200,{"Content-Type":"text/html"});res.end(`<body style="font-family:sans-serif;background:#0a0e14;color:#eaf1f8;padding:40px"><h2>${t}</h2><p>${m}</p><p><a style="color:#6366f1" href="/">← Back to dashboard</a></p></body>`);}

if(require.main===module){
  http.createServer(handler).listen(PORT,()=>{
    console.log(`\n  ◆ Growth Intelligence Platform — PRO`);
    console.log(`  Open:  http://localhost:${PORT}`);
    console.log(`  Mode:  ${DEMO?"DEMO (synthetic, no login needed)":"LIVE (Upstox)"}`);
    console.log(`  Upstox app key: ${API_KEY?"set":"MISSING — edit config.json"}  |  Logged in today: ${loggedIn()}\n`);
  });
  // Paper-bot control loop — one simulated iteration each minute (only acts when you've pressed Start).
  setInterval(()=>{ paper.tick().catch(()=>{}); }, 60000);
  // Setup-tracker sweep — follow every recommended scalp to its stop/target/expiry, once a minute.
  setInterval(()=>{ setupsSweep().catch(()=>{}); }, 60000);
  // 🔔 Position watch — re-read the signal behind every trade you told us you placed, and ping
  // its owner on Telegram the moment it turns against them. Runs regardless of the alert toggle:
  // you asked to be told about YOUR money, so it is not lumped in with scan broadcasts.
  setInterval(()=>{ positionsSweep().catch(()=>{}); }, POS_SWEEP_MS);
  /* 🩺 Market-health loop. Refreshes the market pass, appends a snapshot for the backtester, and
     emits any alert that just TRANSITIONED (never one that is merely still true — see alerts.js).
     Runs on its own 2-minute cadence regardless of the Telegram toggle: the snapshot history is
     what turns this module's thresholds from judgement into measurement, and it only accumulates
     if the loop runs. Telegram delivery is the part that stays gated on a token. */
  setInterval(()=>{ intelSweep().catch(()=>{}); }, INTEL_SWEEP_MS);
  setTimeout(()=>intelSweep().catch(()=>{}), 20000);
  /* ⚡ Momentum sweep on its own fast clock. Reads the ticker buffer rather than fetching, so 30s
     costs nothing — and 30s is the only cadence that is any use for a move that completes in five
     minutes. The 2-minute health tick and 3-minute scalp loop are both far too slow for it. */
  setInterval(()=>{ momentumSweep().catch(()=>{}); }, MOM_SWEEP_MS);
  /* Keep the ticker buffer filling even when nobody has the page open. liveQuotesFull only calls
     the ticker when a browser asks for quotes, so an idle server would have an empty buffer and
     miss exactly the overnight move this feature exists to catch. */
  if(!DEMO) setInterval(()=>{ ensureCdxFresh(9000).catch(()=>{}); }, 10000);
  // Telegram alert loop — scan for High-confidence quick scalps every 3 min (inert until a bot token is configured).
  if(TG_TOKEN){ console.log('  Telegram alerts: ON (chat auto-detected from whoever messages the bot)'); setInterval(()=>{ alertScan().catch(()=>{}); }, 180000); setTimeout(()=>alertScan().catch(()=>{}),15000); }
  else console.log('  Telegram alerts: off (set TELEGRAM_BOT_TOKEN to enable — chat ID optional)');
}
module.exports={IND,computeSignal,buildSetup,buildReasons,confidenceOf,alertEligible,fmtAlert,sendTelegram,signalSince,actionNow,parseCandles,authURL,scan,universeFor,fmtTime,
  loadBinance,loadCoinDCX,loadCrypto,cdxCandles,cdxMarketPairs,ensureCryptoUniverse,usdInr,resampleSeries,tfCfg,getCRYPTO:()=>CRYPTO,getMode:()=>cryptoMode,
  backtestSeries,scoreSeriesArr,backtest,processAsset,blendResearch,assetBtScore,cdxLiveInr,cdxUsdtInr,cdxLiveUsd,topMovers,ticker24,
  trackSetups,sweepSetups,updateSetupWithPrice,setupStats,markReversals,realizedPct,volMetrics,priceRate,priceRateSrc,priceRateAge,cryptoSignalsFrom,
  planTrackables,fmtPlanAlert,dumpBounceAlerts,
  resolveAsset,positionSignal,positionsSweep,addPosition,fmtPosAlert,posPnl,allRecipients,
  __getPositions:()=>POSITIONS,__resetPositions:()=>{POSITIONS=[];},
  zigzag,listingProfile,bumpProfile,tradePlan,planNowFor,backtestPlan,demoRescale,dumpBotTakes,DUMP_TAKE,withLiveRate,forwardStats,dumpBounce,sparkline,synthListing,synthBump,cleanSeries,cleanOHLC,
  __setFx:(r)=>{fxRate=r;fxAt=Date.now();},__setMode:(m)=>{cryptoMode=m;},
  __getSetups:()=>SETUPS,__resetSetups:()=>{SETUPS={active:[],resolved:[]};},
  btcStateFromSeries,__setBtc:(s)=>{BTC_STATE=s;},
  intel,intelSweep,momentumSweep,fmtMomentumAlert,TRADE_COST,roundTripPct,
  __setCdxTicker:(t)=>{cdxTicker=t;}};
