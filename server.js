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
const TTL_DAILY = 10*60*1000, TTL_INTRA = 90*1000;
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
function computeSignal(close,high,low){
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
  const score=wsum?Math.round(ssum/wsum*100):0,verdict=score>=20?'BUY':score<=-20?'SELL':'HOLD';
  return {score,verdict,components:out,price,rsiV:rsi[n],s50:s50[n],s200:s200[n],atr:IND.atr(close,high,low)[n],hi20,lo20,brkUp:price>=hi20,brkDn:price<=lo20};
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
  let eLo,eHi;
  if(type==='Breakout'){eLo=price;eHi=price+dir*0.45*atr;}else if(type==='Intraday'){eLo=price-0.2*atr;eHi=price+0.2*atr;}else{eLo=price-dir*0.5*atr;eHi=price+dir*0.2*atr;}
  if(eLo>eHi){const t=eLo;eLo=eHi;eHi=t;}
  const entry=(eLo+eHi)/2,R=P.stopMult*atr,stop=entry-dir*R,targets=P.t.map(m=>entry+dir*m*R),ret=targets.map(t=>dir*(t-entry)/entry*100);
  return {type,hold:P.hold,dir,entryLo:eLo,entryHi:eHi,entry,stop,targets,ret,rrr:P.t[0],atr,riskPct:Math.abs(dir*(stop-entry)/entry*100)};
}
function actionNow(sig,setup,since,fmt){
  const dir=setup.dir,p=sig.price,t=fmt(since.sinceTime),ago=since.barsAgo;
  const s=since.sinceTime?`Signal active since ${t} (${ago} bar${ago===1?'':'s'} ago)`:'';
  if(sig.verdict==='HOLD')return{cls:'wait',txt:'⏸ NO TRADE — signals mixed, stay flat',since:s};
  if(dir>0){if(p>=setup.entryLo&&p<=setup.entryHi)return{cls:'now',txt:'🟢 BUY NOW — price in entry zone',since:s};
    if(p<setup.entryLo)return{cls:'wait',txt:`⏳ WAIT to BUY — limit ₹${setup.entryLo.toFixed(2)}–${setup.entryHi.toFixed(2)}`,since:s};
    return{cls:'wait',txt:`⏳ DON'T CHASE — buy a dip to ₹${setup.entryLo.toFixed(2)}–${setup.entryHi.toFixed(2)}`,since:s};}
  if(p<=setup.entryHi&&p>=setup.entryLo)return{cls:'exit',txt:'🔴 SELL / EXIT NOW — price in sell zone',since:s};
  if(p>setup.entryHi)return{cls:'exit',txt:`⏳ WAIT to SELL — trigger near ₹${setup.entryHi.toFixed(2)}`,since:s};
  return{cls:'exit',txt:'🔴 SELL signal — already below zone',since:s};
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
RECLTD SAIL SBICARD SBILIFE SRF TATAPOWER TRENT TVSMOTOR`.split(/\s+/).filter(Boolean);
const STOCKS=STOCK_SYMS.map(s=>({sym:s+".NS",ts:s,name:s,cls:"Stock",src:"upstox"}));
const ETF_SYMS=["NIFTYBEES","BANKBEES","GOLDBEES","JUNIORBEES","ITBEES","SILVERBEES"];
const ETFS=ETF_SYMS.map(s=>({sym:s+".NS",ts:s,name:s,cls:"ETF/Index",src:"upstox"}));
// indices: stable Upstox instrument keys
const INDICES=[
  {sym:"^NSEI",name:"NIFTY 50",key:"NSE_INDEX|Nifty 50",cls:"ETF/Index",src:"upstox",isIndex:true},
  {sym:"^NSEBANK",name:"Bank NIFTY",key:"NSE_INDEX|Nifty Bank",cls:"ETF/Index",src:"upstox",isIndex:true},
  {sym:"^BSESN",name:"SENSEX",key:"BSE_INDEX|SENSEX",cls:"ETF/Index",src:"upstox",isIndex:true},
];
const CRYPTO=[["bitcoin","Bitcoin","BTC"],["ethereum","Ethereum","ETH"],["solana","Solana","SOL"],["ripple","XRP","XRP"],
 ["binancecoin","BNB","BNB"],["dogecoin","Dogecoin","DOGE"],["cardano","Cardano","ADA"],["tron","TRON","TRX"],
 ["chainlink","Chainlink","LINK"],["polkadot","Polkadot","DOT"],["matic-network","Polygon","POL"],["litecoin","Litecoin","LTC"]
].map(([sym,name,tk])=>({sym,tk,name,cls:"Crypto",src:"cg"}));
function universeFor(tab){
  const stocks=STOCKS, etfidx=[...ETFS,...INDICES];
  if(tab==="Stocks")return stocks;
  if(tab==="ETFs / Indices")return etfidx;
  if(tab==="Crypto")return CRYPTO;
  return [...stocks,...etfidx,...CRYPTO];
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
  if(asset.key)return asset.key;                 // indices preset
  return (insMap&&insMap["EQ:"+asset.ts.toUpperCase()])||null;
}
async function upstoxCandles(key,tf){
  // tf 'intraday' -> 30minute over ~30d ; 'daily' -> day over ~1y
  const today=new Date(), to=ymd(today);
  if(tf==="intraday"){
    const from=ymd(new Date(today.getTime()-35*864e5));
    const url=`https://api.upstox.com/v2/historical-candle/${encodeURIComponent(key)}/30minute/${to}/${from}`;
    return parseCandles(await getJSON(url,authHeaders()));
  }else{
    const from=ymd(new Date(today.getTime()-400*864e5));
    const url=`https://api.upstox.com/v2/historical-candle/${encodeURIComponent(key)}/day/${to}/${from}`;
    return parseCandles(await getJSON(url,authHeaders()));
  }
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

/* ---------- CoinGecko (crypto) ---------- */
let cgCache=null,cgAt=0;
async function cryptoBatch(){
  if(DEMO){const m={};CRYPTO.forEach(c=>{let h=0;for(const ch of c.sym)h=(h*31+ch.charCodeAt(0))>>>0;m[c.sym]=synth(h,168,0.02);});return m;}
  if(cgCache&&Date.now()-cgAt<50000)return cgCache;
  const ids=CRYPTO.map(c=>c.sym).join(",");
  const arr=await getJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=inr&ids=${ids}&sparkline=true&price_change_percentage=24h`,{});
  const map={},now=Date.now();
  arr.forEach(it=>{let close=((it.sparkline_in_7d&&it.sparkline_in_7d.price)||[]).slice();
    const last=close[close.length-1];if(last>0&&it.current_price>0){const f=it.current_price/last;close=close.map(v=>v*f);}
    if(close.length)close[close.length-1]=it.current_price;
    map[it.id]={close,high:close.slice(),low:close.slice(),times:close.map((_,i)=>now-(close.length-1-i)*36e5),price:it.current_price};});
  cgCache=map;cgAt=Date.now();return map;
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

function processAsset(asset,data,tf){
  if(!data||!data.close||data.close.length<60)throw new Error("no data");
  const sig=computeSignal(data.close,data.high,data.low);
  const setup=buildSetup(sig,tf);
  const since=signalSince(data.close,data.high,data.low,data.times);
  const action=actionNow(sig,setup,since,fmtTime);
  const reasons=buildReasons(sig,setup,marketOpen(),asset.src==='cg');
  const dec=asset.src==='cg'&&data.price<5?4:2;
  const isIndex=!!asset.isIndex||asset.sym.startsWith('^');
  return {asset,sig,setup,since,action,reasons,dec,isIndex,asof:fmtTime(data.times?data.times[data.times.length-1]:Date.now()),
    priceTag:asset.src==='cg'?'live':(marketOpen()?'LIVE (broker)':'prev close'),series:data.close.slice(-80)};
}
async function scan(tab,tf){
  const ck="scan:"+tab+":"+tf;const hit=cGet(ck,tf==='intraday'?TTL_INTRA:TTL_DAILY);if(hit)return{...hit,cached:true};
  const uni=universeFor(tab);
  if(!DEMO)await ensureInstruments();
  // crypto batch
  let cmap=null;if(uni.some(a=>a.src==='cg')){try{cmap=await cryptoBatch();}catch(e){cmap={};}}
  // resolve upstox keys + fetch candles
  const stockAssets=uni.filter(a=>a.src==='upstox');
  const keyOf={};stockAssets.forEach(a=>{keyOf[a.sym]=DEMO?("DEMO|"+a.sym):keyForAsset(a);});
  const res=await mapLimit(uni,6,async asset=>{
    let data;
    if(asset.src==='cg'){data=cmap[asset.sym];}
    else{const key=keyOf[asset.sym];if(!key)throw new Error("no instrument key");
      data=DEMO?synth(hashStr(asset.sym),tf==='intraday'?400:300,0.04):await upstoxCandles(key,tf);}
    return processAsset(asset,data,tf);
  });
  const ok=res.filter(r=>r&&!r.__err);
  // pin live LTP for upstox names
  if(!DEMO){const keys=stockAssets.map(a=>keyOf[a.sym]).filter(Boolean);
    try{const ltp=await upstoxLTP(keys);
      ok.forEach(r=>{if(r.asset.src==='upstox'){const k=keyOf[r.asset.sym];if(k&&ltp[k]){r.sig.price=ltp[k];/* refresh action vs live price */r.action=actionNow(r.sig,r.setup,r.since,fmtTime);}}});}catch(e){}
  }
  const out={tab,tf,analyzed:ok.length,total:uni.length,results:ok,ts:Date.now(),demo:DEMO,keyOf};
  cSet(ck,out);return out;
}
function hashStr(s){let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))>>>0;return h;}

/* live quotes endpoint (cheap, frequent) */
async function liveQuotes(tab){
  const uni=universeFor(tab),out={};
  const cryptoIds=uni.filter(a=>a.src==='cg');
  if(cryptoIds.length){try{const m=DEMO?{}:await getJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${cryptoIds.map(c=>c.sym).join(",")}&vs_currency=inr`,{});cryptoIds.forEach(c=>{if(m[c.sym])out[c.sym]=m[c.sym].inr;});}catch(e){}}
  if(!DEMO){await ensureInstruments();const stocks=uni.filter(a=>a.src==='upstox');const keyOf={};stocks.forEach(a=>keyOf[a.sym]=keyForAsset(a));
    const keys=stocks.map(a=>keyOf[a.sym]).filter(Boolean);
    try{const ltp=await upstoxLTP(keys);stocks.forEach(a=>{const k=keyOf[a.sym];if(k&&ltp[k])out[a.sym]=ltp[k];});}catch(e){}}
  return out;
}

/* ============================================================
   HTTP
   ============================================================ */
async function getJSON(url,headers){const r=await fetch(url,{headers});if(!r.ok)throw new Error("HTTP "+r.status+" "+url.slice(0,60));return r.json();}
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
    if(p==="/api/scan"){if(!loggedIn())return sendJSON(res,{error:"login_required"},401);
      const data=await scan(u.searchParams.get("tab")||"Stocks",u.searchParams.get("tf")||"intraday");return sendJSON(res,data);}
    if(p==="/api/quotes"){if(!loggedIn())return sendJSON(res,{error:"login_required"},401);
      return sendJSON(res,{quotes:await liveQuotes(u.searchParams.get("tab")||"Stocks"),ts:Date.now()});}
    // static
    let file=p==="/"?"/index.html":p;
    const fp=path.join(__dirname,"public",path.normalize(file).replace(/^(\.\.[/\\])+/,""));
    if(fs.existsSync(fp)&&fs.statSync(fp).isFile()){res.writeHead(200,{"Content-Type":MIME[path.extname(fp)]||"application/octet-stream"});return fs.createReadStream(fp).pipe(res);}
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
module.exports={IND,computeSignal,buildSetup,buildReasons,signalSince,actionNow,parseCandles,authURL,scan,universeFor,fmtTime};
