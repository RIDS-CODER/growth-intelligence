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
};
function computeSignal(close,high,low,thr){
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
  const prior=close.slice(0,n),hi20=IND.highest(prior,20),lo20=IND.lowest(prior,20);
  let wsum=0,ssum=0;out.forEach(o=>{wsum+=o.weight;ssum+=o.score*o.weight;});
  const score=wsum?Math.round(ssum/wsum*100):0,verdict=score>=thr?'BUY':score<=-thr?'SELL':'HOLD';
  return {score,verdict,components:out,price,rsiV:rsi[n],s50:s50[n],s200:s200[n],atr:IND.atr(close,high,low)[n],hi20,lo20,brkUp:price>=hi20,brkDn:price<=lo20,
    bbL:bb.lower[n],bbU:bb.upper[n],ema20:IND.ema(close,20)[n],lo10:IND.lowest(low,10),hi10:IND.highest(high,10)};
}
// nearest support below price (for buy-the-dip entries) / resistance above (for shorts)
function nearestLevel(dir,price,atr,cands){
  if(dir>0){const c=cands.filter(v=>v!=null&&v<price);let s=c.length?Math.max(...c):price-0.8*atr;
    return Math.min(Math.max(s,price-3*atr), price-0.12*atr);}          // strictly below, not absurdly far
  const c=cands.filter(v=>v!=null&&v>price);let r=c.length?Math.min(...c):price+0.8*atr;
  return Math.max(Math.min(r,price+3*atr), price+0.12*atr);
}
function signalSince(close,high,low,times){
  const e12=IND.ema(close,12),e26=IND.ema(close,26),rsi=IND.rsi(close,14),mh=IND.macd(close).hist;
  const v=i=>{if(e12[i]==null||e26[i]==null||rsi[i]==null||mh[i]==null)return 'HOLD';if(e12[i]>e26[i]&&rsi[i]>=50&&mh[i]>0)return 'BUY';if(e12[i]<e26[i]&&rsi[i]<50&&mh[i]<0)return 'SELL';return 'HOLD';};
  const n=close.length-1,cur=v(n);let since=n;
  for(let i=n;i>=1;i--){if(v(i)!==cur){since=i+1;break;}if(i===1)since=1;}
  return {cur,sinceTime:times?times[Math.min(since,times.length-1)]:null,barsAgo:n-since};
}
const TYPE={Intraday:{stopMult:1.0,t:[1.0,1.8,2.6],hold:"Same session"},Swing:{stopMult:1.5,t:[1.5,2.8,4.5],hold:"3–15 trading days"},Breakout:{stopMult:1.3,t:[2.0,3.5,6.0],hold:"1–6 weeks"}};
function buildSetup(sig,tf){
  const dir=sig.verdict==='SELL'?-1:1;
  let type;
  if(tf==='intraday')type=((sig.verdict==='BUY'&&sig.brkUp)||(sig.verdict==='SELL'&&sig.brkDn))?'Breakout':'Intraday';
  else type=(sig.verdict==='BUY'&&sig.brkUp)||(sig.verdict==='SELL'&&sig.brkDn)?'Breakout':'Swing';
  const P=TYPE[type],atr=sig.atr,price=sig.price;
  let eLo,eHi,anchor;
  if(type==='Breakout'){
    // momentum: enter on the break, near current price
    eLo=price;eHi=price+dir*0.45*atr;if(eLo>eHi){const t=eLo;eLo=eHi;eHi=t;}anchor=(eLo+eHi)/2;
  }else{
    // pullback: buy the DIP into support (long) / rally into resistance (short) — not the current price
    const cands = dir>0 ? [sig.lo10,sig.bbL,sig.ema20,sig.s50] : [sig.hi10,sig.bbU,sig.ema20,sig.s50];
    anchor = nearestLevel(dir,price,atr,cands);
    eLo=anchor-0.25*atr;eHi=anchor+0.25*atr;
  }
  const entry=anchor, R=P.stopMult*atr, stop=anchor-dir*R;   // stop sits BELOW support → accounts for a deeper fall
  const targets=P.t.map(m=>entry+dir*m*R), ret=targets.map(t=>dir*(t-entry)/entry*100);
  const gap=dir*(entry-price)/price*100;                     // how far the ideal entry is from current price (−ve = below)
  const riskPct=Math.abs(dir*(stop-entry)/entry*100);
  // Suggested leverage CEILING: leverage so a stop-out costs ~15% of the margin blocked, capped by volatility.
  const volPct=atr/price*100;
  const cap = volPct>4 ? 3 : volPct>2 ? 4 : 5;               // more volatile → lower ceiling
  const suggestedLev = Math.max(1, Math.min(cap, Math.floor(15/Math.max(riskPct,0.1))));
  return {type,hold:P.hold,dir,entryLo:eLo,entryHi:eHi,entry,stop,targets,ret,rrr:P.t[0],atr,
    riskPct,entryGapPct:gap,support:dir>0?anchor:null,resistance:dir<0?anchor:null,suggestedLev};
}
function actionNow(sig,setup,since,fmt){
  const dir=setup.dir,p=sig.price,t=fmt(since.sinceTime),ago=since.barsAgo;
  const s=since.sinceTime?`Signal active since ${t} (${ago} bar${ago===1?'':'s'} ago)`:'';
  const d=v=>v<5?v.toFixed(4):v.toFixed(2);                       // price-appropriate decimals (crypto vs stocks)
  const gap=Math.abs(setup.entryGapPct||0).toFixed(1);
  if(sig.verdict==='HOLD')return{cls:'wait',txt:'⏸ NO TRADE — signals mixed, stay flat',since:s};
  if(dir>0){
    if(p>=setup.entryLo&&p<=setup.entryHi)return{cls:'now',txt:`🟢 BUY NOW — price is at the support/dip zone (₹${d(setup.entryLo)}–${d(setup.entryHi)})`,since:s};
    if(p>setup.entryHi)return{cls:'wait',txt:setup.type==='Breakout'
      ? `🟢 BUY the breakout — ₹${d(setup.entryLo)}–${d(setup.entryHi)}`
      : `⏳ WAIT for the dip — set a buy limit at ₹${d(setup.entryLo)}–${d(setup.entryHi)} (support, ~${gap}% below now). Don't chase.`,since:s};
    return{cls:'wait',txt:`⚠ Below support — price already broke the dip zone; let it stabilize, it may keep falling to the stop`,since:s};
  }
  if(p<=setup.entryHi&&p>=setup.entryLo)return{cls:'exit',txt:`🔴 SELL / SHORT NOW — price is at the resistance zone (₹${d(setup.entryLo)}–${d(setup.entryHi)})`,since:s};
  if(p<setup.entryLo)return{cls:'exit',txt:setup.type==='Breakout'
    ? `🔴 SELL the breakdown — ₹${d(setup.entryHi)}–${d(setup.entryLo)}`
    : `⏳ WAIT for the bounce — sell/short into ₹${d(setup.entryLo)}–${d(setup.entryHi)} (resistance, ~${gap}% above now)`,since:s};
  return{cls:'exit',txt:`⚠ Above resistance — extended; wait for a pullback into the zone`,since:s};
}
function buildReasons(sig,setup,marketOpen,isCrypto){
  const dir=setup.dir,f=v=>v==null?'n/a':(+v).toFixed(2),forR=[],against=[],inval=[];
  sig.components.filter(c=>dir>0?c.tag==='BUY':c.tag==='SELL').forEach(c=>forR.push(`${c.name}: ${c.detail.toLowerCase()} (${c.raw??c.tag})`));
  if(dir>0&&sig.brkUp)forR.push(`Broke above 20-bar high (₹${f(sig.hi20)})`);
  if(dir<0&&sig.brkDn)forR.push(`Broke below 20-bar low (₹${f(sig.lo20)})`);
  if(!forR.length)forR.push("Mixed signals — modest conviction.");
  sig.components.filter(c=>dir>0?c.tag==='SELL':c.tag==='BUY').forEach(c=>against.push(`${c.name} disagrees (${c.raw??c.tag})`));
  if(dir>0&&sig.rsiV>70)against.push(`RSI ${sig.rsiV.toFixed(0)} — overbought`);
  if(dir<0&&sig.rsiV<30)against.push(`RSI ${sig.rsiV.toFixed(0)} — oversold`);
  if(sig.atr/sig.price*100>4)against.push(`High volatility (ATR ${(sig.atr/sig.price*100).toFixed(1)}%)`);
  if(!isCrypto&&!marketOpen)against.push("Cash market closed — entry next session, gap risk.");
  if(!against.length)against.push("No major opposing indicator currently.");
  inval.push(`Close ${dir>0?'below':'above'} Stop Loss ₹${f(setup.stop)}`);
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
const TF_MAP={
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
  const close=[],high=[],low=[],times=[];
  for(let i=0;i<d.close.length;i+=f){const end=Math.min(i+f,d.close.length);let hi=-Infinity,lo=Infinity;
    for(let j=i;j<end;j++){hi=Math.max(hi,d.high[j]);lo=Math.min(lo,d.low[j]);}
    close.push(d.close[end-1]);high.push(hi);low.push(lo);times.push(d.times[end-1]);}
  return {close,high,low,times,price:close[close.length-1],mtime:d.mtime};
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
  const close=[],high=[],low=[],times=[];
  for(const r of rows){const cl=+r[4];if(!isFinite(cl))continue;close.push(cl);high.push(+r[2]);low.push(+r[3]);times.push(Date.parse(r[0]));}
  return {close,high,low,times,price:close[close.length-1]};
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
const CDX_INT={"15m":"15m","30m":"30m","1h":"1h","4h":"4h","6h":"6h","12h":"12h","daily":"1d","intraday":"30m"};
let cdxTicker={},cdxTickerAt=0;
async function cdxGetTicker(){const t=await getJSON("https://api.coindcx.com/exchange/ticker",{});if(!Array.isArray(t))throw new Error("cdx ticker");
  const snap={};t.forEach(x=>{if(x.market)snap[x.market]=+x.last_price;});cdxTicker=snap;cdxTickerAt=Date.now();return t;}
// Binance fallback
const BN_HOSTS=["https://data-api.binance.vision","https://api.binance.com","https://api-gcp.binance.com"];
const BN_INT={"15m":"15m","30m":"30m","1h":"1h","4h":"4h","6h":"6h","12h":"12h","daily":"1d","intraday":"30m"};
async function binanceGet(pathq){let last;for(const h of BN_HOSTS){try{return await getJSON(h+pathq,{});}catch(e){last=e;}}throw last||new Error("binance unreachable");}
let fxRate=null,fxAt=0;
async function usdInr(){
  if(fxRate&&Date.now()-fxAt<6*3600e3)return fxRate;
  const tries=[async()=>{const j=await getJSON("https://open.er-api.com/v6/latest/USD",{});return j&&j.rates&&j.rates.INR;},
    async()=>{const j=await getJSON("https://api.frankfurter.app/latest?from=USD&to=INR",{});return j&&j.rates&&j.rates.INR;}];
  for(const t of tries){try{const r=await t();if(r>0){fxRate=r;fxAt=Date.now();return r;}}catch(e){}}
  return fxRate||86;
}
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
async function loadCoinDCX(asset,tf){
  const interval=CDX_INT[tf]||"1h";
  const j=await getJSON(`https://public.coindcx.com/market_data/candles?pair=${encodeURIComponent(asset.pair)}&interval=${interval}&limit=400`,{});
  if(!Array.isArray(j)||!j.length)throw new Error("no candles");
  const rows=j.slice().reverse();  // CoinDCX returns newest-first → ascending
  const close=[],high=[],low=[],times=[];
  for(const k of rows){const c=+k.close;if(!isFinite(c))continue;close.push(c);high.push(+k.high);low.push(+k.low);times.push(+k.time);}
  if(cdxTicker[asset.sym]>0&&close.length)close[close.length-1]=cdxTicker[asset.sym];  // pin to live ticker
  return {close,high,low,times,price:close[close.length-1],mtime:Date.now()};
}
async function loadBinance(asset,tf){
  const interval=BN_INT[tf]||"1h";
  const j=await binanceGet(`/api/v3/klines?symbol=${asset.binance}&interval=${interval}&limit=400`);
  if(!Array.isArray(j)||!j.length)throw new Error("no klines");
  const r=await usdInr();
  const close=[],high=[],low=[],times=[];
  for(const k of j){const c=+k[4];if(!isFinite(c))continue;close.push(c*r);high.push(+k[2]*r);low.push(+k[3]*r);times.push(+k[6]);}
  return {close,high,low,times,price:close[close.length-1],mtime:Date.now()};
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
function synth(seed,n,drift){let x=500+seed%4000,o=[],s=seed||1;const r=()=>{s=(s*16807)%2147483647;return s/2147483647;};const d=drift==null?((seed%3)-1)*0.12:drift;const close=[];for(let i=0;i<n;i++){x*=(1+(r()-0.5+d)*0.03);x=Math.max(1,x);close.push(x);}const now=Date.now();return {close,high:close.map(v=>v*1.004),low:close.map(v=>v*0.996),times:close.map((_,i)=>now-(n-1-i)*18e5),price:close[close.length-1]};}

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
function processAsset(asset,data,tf){
  if(!data||!data.close||data.close.length<41)throw new Error("no data");
  const thr=tf==='daily'?20:12;             // looser threshold on all intraday frames = more opportunities
  const live=data.price;                    // current (live) price
  // Decide the signal on CLOSED candles only (drop the still-forming last bar) so a 15m call
  // doesn't wobble every minute — it only changes when a new candle closes.
  const cl=data.close.slice(0,-1),hi=data.high.slice(0,-1),lo=data.low.slice(0,-1),tm=data.times?data.times.slice(0,-1):null;
  const sig=computeSignal(cl,hi,lo,thr);
  const setup=buildSetup(sig,tf==='daily'?'daily':'intraday');   // entry/stop/targets anchored to the closed bar (stable)
  sig.closedPrice=sig.price; sig.price=live;                     // now use LIVE price for the action + the card's Current Price
  const since=signalSince(cl,hi,lo,tm);
  const action=actionNow(sig,setup,since,fmtTime);
  const reasons=buildReasons(sig,setup,marketOpen(),asset.src==='cg');
  const scope=scopeFlag(sig);
  const dec=asset.src==='cg'&&data.price<5?4:2;
  const isIndex=!!asset.isIndex||asset.sym.startsWith('^');
  const asofMs=data.mtime||(data.times?data.times[data.times.length-1]:Date.now());
  const bt = cl.length>=120 ? assetBtScore(backtestSeries(cl,hi,lo,tf,costFor(asset))) : null;   // net-of-cost historical grade (same data)
  return {asset,sig,setup,since,action,reasons,scope,bt,dec,isIndex,tf,asof:fmtTime(asofMs),
    priceTag:asset.src==='cg'?(cryptoMode==='coindcx'?'live · CoinDCX ₹':'live · global ₹'):(marketOpen()?'LIVE (broker)':'prev close'),series:data.close.slice(-80)};
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
function backtestSeries(close,high,low,tf,cost){
  cost = cost==null ? BT_COST_EQ : cost;
  const {scores,atr}=scoreSeriesArr(close,high,low);
  const thr=tf==='daily'?20:12;
  const P=TYPE[tf==='daily'?'Swing':'Intraday'], stopMult=P.stopMult, T=P.t;   // T = [t1,t2,t3] R-multiples
  const ema20=IND.ema(close,20), sma50=IND.sma(close,50), bb=IND.bollinger(close), n=close.length;
  const lo10=new Array(n).fill(null), prevHi20=new Array(n).fill(null);
  for(let i=0;i<n;i++){
    if(i>=9){let m=Infinity;for(let j=i-9;j<=i;j++)m=Math.min(m,low[j]);lo10[i]=m;}
    if(i>=20){let m=-Infinity;for(let j=i-20;j<i;j++)m=Math.max(m,high[j]);prevHi20[i]=m;}
  }
  let pos=0,entry=0,R=0,stop=0,t1=0,t2=0,t3=0,rem=0,taken=0,gross=0,entryIdx=-1,pending=null;
  const rets=[]; let eq=1,peak=1,mdd=0; const FILLWIN=6;
  const enter=(px,r,idx)=>{entry=px;R=r;stop=px-r;t1=px+T[0]*r;t2=px+T[1]*r;t3=px+T[2]*r;rem=1;taken=0;gross=0;pos=1;entryIdx=idx;};
  const finish=()=>{const net=gross-2*cost;rets.push(net);eq*=(1+net);peak=Math.max(peak,eq);mdd=Math.min(mdd,eq/peak-1);pos=0;gross=0;rem=0;taken=0;};
  for(let i=50;i<n;i++){
    if(pos===1 && i>entryIdx){
      if(low[i]<=stop && rem>0){ gross+=rem*(stop/entry-1); rem=0; finish(); }   // stop the remainder (conservative: checked first)
      else{
        if(rem>0 && taken<1 && high[i]>=t1){ gross+=(1/3)*(t1/entry-1); rem-=1/3; taken=1; stop=entry; }  // → breakeven
        if(rem>0 && taken<2 && high[i]>=t2){ gross+=(1/3)*(t2/entry-1); rem-=1/3; taken=2; stop=t1; }     // → lock T1
        if(rem>0 && taken<3 && high[i]>=t3){ gross+=rem*(t3/entry-1); rem=0; finish(); }                  // final third at T3
        else if(pos===1 && rem>0 && scores[i]<=-thr){ gross+=rem*(close[i]/entry-1); rem=0; finish(); }   // signal died → exit rest
      }
    }
    if(pos===0 && pending && i>pending.sig){
      if(low[i]<=pending.limit){ enter(pending.limit,pending.R,i); pending=null; }
      else if(i>=pending.exp) pending=null;   // the dip never came → no trade
    }
    if(pos===0 && !pending && scores[i]>=thr && atr[i]>0){
      const r=stopMult*atr[i], brk=prevHi20[i]!=null && close[i]>=prevHi20[i];
      if(brk) enter(close[i],r,i);            // breakout → market
      else{ const sup=nearestLevel(1,close[i],atr[i],[lo10[i],bb.lower[i],ema20[i],sma50[i]]); pending={limit:sup,R:r,sig:i,exp:i+FILLWIN}; }
    }
  }
  if(pos===1){ gross+=rem*(close[n-1]/entry-1); rem=0; finish(); }
  const wins=rets.filter(r=>r>0),losses=rets.filter(r=>r<=0);
  const sumW=wins.reduce((a,b)=>a+b,0),sumL=losses.reduce((a,b)=>a+b,0);
  const bh=close[50]>0?close[n-1]/close[50]-1:0;
  return {trades:rets.length,wins:wins.length,
    winRate:rets.length?wins.length/rets.length*100:0,
    avgRet:rets.length?(rets.reduce((a,b)=>a+b,0)/rets.length)*100:0,
    avgWin:wins.length?sumW/wins.length*100:0,
    avgLoss:losses.length?sumL/losses.length*100:0,
    profitFactor:sumL<0?sumW/Math.abs(sumL):(sumW>0?99:0),
    totalRet:(eq-1)*100,maxDD:mdd*100,buyHold:bh*100};
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
  const ck="bt:"+tab+":"+tf;const hit=cGet(ck,10*60*1000);if(hit)return{...hit,cached:true};
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
  let TT=0,TW=0,sumRet=0,sumBH=0,sumDD=0,pfW=0,pfL=0;
  ok.forEach(a=>{TT+=a.trades;TW+=a.wins;sumRet+=a.totalRet;sumBH+=a.buyHold;sumDD+=a.maxDD;
    const losses=a.trades-a.wins;pfW+=a.avgWin/100*a.wins;pfL+=Math.abs(a.avgLoss/100*losses);});
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
    winRate,avgTotalRet,avgBuyHold,avgMaxDD,profitFactor,beatBuyHold,btScore,btVerdict,lowSample};
  const out={tab,tf,agg,perAsset:ok.sort((a,b)=>b.totalRet-a.totalRet),ts:Date.now(),demo:DEMO,loggedIn:li};
  if(ok.length)cSet(ck,out);
  return out;
}
async function scan(tab,tf){
  const ttl = tab==='Crypto' ? TTL_CRYPTO : (tf==='intraday'?TTL_INTRA:TTL_DAILY);
  const ck="scan:"+tab+":"+tf;const hit=cGet(ck,ttl);if(hit)return{...hit,cached:true};
  // crypto universe (Binance) + commodities resolved FIRST so the universe reflects them
  if(tab==="Crypto"||tab==="All"){try{await ensureCryptoUniverse();}catch(e){}}
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
  const cryptoAssets=uni.filter(a=>a.src==='cg');
  const cryptoFailed = cryptoAssets.length>0 && !DEMO && !ok.some(r=>r.asset.src==='cg');
  const out={tab,tf,analyzed:ok.length,total:uni.length,results:ok,ts:Date.now(),demo:DEMO,loggedIn:li,keyOf,cryptoMode,
    note: cryptoFailed?"Crypto unreachable — this server's region can't reach CoinDCX. For exact CoinDCX ₹, host in an India region (e.g. DigitalOcean Bangalore/BLR); otherwise the global ₹ feed is used.":undefined};
  if(ok.length>0 && !cryptoFailed) cSet(ck,out);   // never cache an empty/failed scan
  return out;
}
function hashStr(s){let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))>>>0;return h;}

/* live quotes endpoint (cheap, frequent) */
let cgPriceCache=null,cgPriceAt=0;
async function liveQuotes(tab){
  const uni=universeFor(tab),out={};
  const cryptoIds=uni.filter(a=>a.src==='cg');
  if(cryptoIds.length && !DEMO){
    if(cgPriceCache && Date.now()-cgPriceAt<8000){Object.assign(out,cgPriceCache);}
    else if(cryptoMode==="coindcx"){
      try{await cdxGetTicker();const c={};cryptoIds.forEach(x=>{if(cdxTicker[x.sym]>0)c[x.sym]=cdxTicker[x.sym];});cgPriceCache=c;cgPriceAt=Date.now();Object.assign(out,c);}
      catch(e){if(cgPriceCache)Object.assign(out,cgPriceCache);}
    }else{
      try{const arr=await binanceGet("/api/v3/ticker/price");const r=await usdInr();
        const bySym={};if(Array.isArray(arr))arr.forEach(x=>{bySym[x.symbol]=+x.price*r;});
        const c={};cryptoIds.forEach(x=>{if(bySym[x.binance])c[x.sym]=bySym[x.binance];});cgPriceCache=c;cgPriceAt=Date.now();Object.assign(out,c);}
        catch(e){if(cgPriceCache)Object.assign(out,cgPriceCache);}
    }}
  if(!DEMO){await ensureInstruments();const stocks=uni.filter(a=>a.src==='upstox');const keyOf={};stocks.forEach(a=>keyOf[a.sym]=keyForAsset(a));
    const keys=stocks.map(a=>keyOf[a.sym]).filter(Boolean);
    try{const ltp=await upstoxLTP(keys);stocks.forEach(a=>{const k=keyOf[a.sym];if(k&&ltp[k])out[a.sym]=ltp[k];});}catch(e){}}
  return out;
}

/* ============================================================
   HTTP
   ============================================================ */
async function getJSON(url,headers){const r=await fetch(url,{headers});if(!r.ok)throw new Error("HTTP "+r.status+" "+url.slice(0,60));return r.json();}
function readBody(req){return new Promise((resolve,reject)=>{let d="";req.on("data",c=>{d+=c;if(d.length>1.2e7)req.destroy();});req.on("end",()=>resolve(d));req.on("error",reject);});}
// Compute signals from BROWSER-supplied CoinDCX candles (browser is in India → correct ₹ prices). tf + assets[{sym,tk,name,close[],high[],low[],times[],price}]
function cryptoSignalsFrom(payload){
  const tf=payload.tf||"1h", results=[];
  (payload.assets||[]).forEach(a=>{
    try{
      if(!a.close||a.close.length<41)return;
      const asset={sym:a.sym,tk:a.tk,name:a.name||a.tk,cls:"Crypto",src:"cg"};
      const data={close:a.close,high:a.high,low:a.low,times:a.times,price:a.price};
      const r=processAsset(asset,data,tf);
      r.priceTag="live · CoinDCX ₹";     // browser-fetched from the Indian exchange
      results.push(r);
    }catch(e){}
  });
  return {results,tf,total:(payload.assets||[]).length,analyzed:results.length,source:"coindcx-client"};
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
  return {verdict,dir,agree,price,entry,stop,targets,ret,rrr,riskPct,stopSpreadPct,btAvg,
    frames:per.map(r=>({tf:r.tf,verdict:r.sig.verdict,score:r.sig.score,entry:r.setup.entry,stop:r.setup.stop,t1:r.setup.targets[0],bt:r.bt&&r.bt.score}))};
}
async function researchCoin(rawSym,horizon){
  try{await ensureCryptoUniverse();}catch(e){}
  const base=(rawSym||"").toUpperCase().replace(/USDT$|INR$|_INR$|-INR$/,"").replace(/[^A-Z0-9]/g,"");
  if(!base)return {error:"Enter a coin symbol (e.g. SOL, DOGE, BTC)."};
  const uni=(typeof getCRYPTO==='function'?getCRYPTO():CRYPTO)||CRYPTO;
  let asset=uni.find(a=>a.tk===base);
  if(!asset)asset = cryptoMode==="coindcx"
    ? {sym:base+"INR",pair:"I-"+base+"_INR",binance:base+"USDT",tk:base,name:base,cls:"Crypto",src:"cg"}
    : {sym:base+"USDT",binance:base+"USDT",tk:base,name:base,cls:"Crypto",src:"cg"};
  const tfs = horizon==="long" ? ["4h","12h","daily"] : ["15m","30m","1h"];
  const per=[];
  for(const tf of tfs){try{const data=await loadCrypto(asset,tf);per.push(processAsset(asset,data,tf));}catch(e){}}
  if(!per.length)return {error:'No data for "'+base+'". Check the symbol — it may not trade on your exchange.'};
  return {sym:base,horizon,dec:per[0].dec,cryptoMode,consensus:blendResearch(per),ts:Date.now()};
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
      return sendJSON(res,{quotes:await liveQuotes(u.searchParams.get("tab")||"Stocks"),loggedIn:loggedIn(),ts:Date.now()});}
    if(p==="/api/backtest"){
      const data=await backtest(u.searchParams.get("tab")||"Stocks",u.searchParams.get("tf")||"daily");return sendJSON(res,data);}
    if(p==="/api/crypto-signals" && req.method==="POST"){
      const body=await readBody(req);let payload;try{payload=JSON.parse(body);}catch(e){return sendJSON(res,{error:"bad json"},400);}
      return sendJSON(res,cryptoSignalsFrom(payload));}
    if(p==="/api/research"){   // one coin, several timeframes, averaged consensus (short or long horizon)
      const sym=u.searchParams.get("sym")||"", horizon=u.searchParams.get("horizon")==="long"?"long":"short";
      return sendJSON(res,await researchCoin(sym,horizon));}
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
}
module.exports={IND,computeSignal,buildSetup,buildReasons,signalSince,actionNow,parseCandles,authURL,scan,universeFor,fmtTime,
  loadBinance,loadCoinDCX,loadCrypto,ensureCryptoUniverse,usdInr,resampleSeries,tfCfg,getCRYPTO:()=>CRYPTO,getMode:()=>cryptoMode,
  backtestSeries,scoreSeriesArr,backtest};
