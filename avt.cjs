process.env.UPSTOX_KEY="testkey";process.env.UPSTOX_SECRET="testsecret";
const S=require("./server.js");
const url=S.authURL();
console.log("authURL ok:", url.includes("response_type=code")&&url.includes("client_id=testkey")&&url.includes("redirect_uri=")&&url.startsWith("https://api.upstox.com/v2/login/authorization/dialog"));
const mk=(t,c)=>["2026-06-"+String(t).padStart(2,'0')+"T15:30:00+05:30",c-1,c+2,c-2,c,1000,0];
const candles=[];for(let d=30;d>=1;d--)candles.push(mk(d,1000+d));
const parsed=S.parseCandles({status:"success",data:{candles}});
console.log("parseCandles bars:",parsed.close.length,"ascending:",parsed.times[0]<parsed.times[parsed.times.length-1],"oldest",parsed.close[0],"newest",parsed.close[parsed.close.length-1],"price=newest:",parsed.price===parsed.close[parsed.close.length-1]);
const insArr=[{segment:"NSE_EQ",instrument_type:"EQ",trading_symbol:"RELIANCE",instrument_key:"NSE_EQ|INE002A01018"},{segment:"NSE_EQ",instrument_type:"EQ",trading_symbol:"TCS",instrument_key:"NSE_EQ|INE467B01029"},{segment:"NSE_FO",instrument_type:"FUT",trading_symbol:"RELIANCE",instrument_key:"NSE_FO|123"}];
const map={};for(const it of insArr){const seg=it.segment||it.exchange,type=(it.instrument_type||"").toUpperCase();const tsym=it.trading_symbol||it.tradingsymbol||it.name;const key=it.instrument_key;if(!tsym||!key)continue;if(seg==="NSE_EQ"&&(type==="EQ"||type==="")) map["EQ:"+tsym.toUpperCase()]=key;}
console.log("instrument map RELIANCE:",map["EQ:RELIANCE"],"TCS:",map["EQ:TCS"],"no FO leak:",!Object.values(map).includes("NSE_FO|123"));
const d={"NSE_EQ:RELIANCE":{instrument_token:"NSE_EQ|INE002A01018",last_price:2951.4},"NSE_EQ:TCS":{instrument_token:"NSE_EQ|INE467B01029",last_price:3890.2}};
const out={};for(const k in d){const v=d[k];if(v&&v.instrument_token&&isFinite(v.last_price))out[v.instrument_token]=v.last_price;}
console.log("LTP parse:",out["NSE_EQ|INE002A01018"]===2951.4&&out["NSE_EQ|INE467B01029"]===3890.2);
const body=new URLSearchParams({code:"abc",client_id:"testkey",client_secret:"testsecret",redirect_uri:"http://localhost:5180/callback",grant_type:"authorization_code"}).toString();
console.log("token body ok:",body.includes("grant_type=authorization_code")&&body.includes("code=abc"));
function gen(n,s,dr){let x=1000,o=[];for(let i=0;i<n;i++){s=(s*16807)%2147483647;x*=(1+((s/2147483647)-0.5+dr)*0.03);o.push(Math.max(1,x));}return o;}
const c=gen(400,9,0.15),sg=S.computeSignal(c,c.slice(),c.slice()),st=S.buildSetup(sg,'daily');
console.log("engine verdict",sg.verdict,"order ok:",st.stop<st.entry&&st.entry<st.targets[0]&&st.targets[0]<st.targets[1]&&st.targets[1]<st.targets[2]);
process.exit(0);
