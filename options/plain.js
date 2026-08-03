/* ============================================================
   Options Radar — PLAIN ENGLISH LAYER
   Turns a scored contract into something a person who has never traded an option can act on.

   Design rule for everything in here: state what you DO, what it COSTS, what you WIN,
   what you LOSE, and BY WHEN. No greeks, no vol, no z-scores in any user-facing string —
   those live behind an "advanced" toggle.

   Payoffs are quoted AT EXPIRY. That is deliberate: an at-expiry payoff is arithmetic a
   beginner can verify (price minus strike), whereas a mid-life mark depends on vol and
   time decay and cannot be checked by eye. Undertstating early exits is the safer error.
   ============================================================ */
"use strict";

const DAY=86400000;
const pct=(a,b)=>b>0?100*(a-b)/b:0;

/* ---------- what the position is worth at expiry ---------- */
/** Long option: value = intrinsic. Credit spread: we keep the credit minus what we owe. */
function payoffAtExpiry(sig,S,contractSize){
  const size=contractSize||1;
  const intr=(kind,K)=>kind==="call"?Math.max(0,S-K):Math.max(0,K-S);
  if(sig.structure){
    const shortK=sig.structure.short_strike, longK=sig.structure.long_strike;
    const owed=Math.max(0,intr(sig.kind,shortK)-intr(sig.kind,longK));   // capped by the width
    const credit=(sig.structure.net_credit_inr||0);
    return {value:credit-owed*size, pnl:credit-owed*size};              // credit already banked
  }
  const value=intr(sig.kind,sig.strike)*size;
  return {value, pnl:value-(sig.econ.premium_inr||0)};
}

/** A ladder of "if the coin moves X%, you end up with Y" rows. */
function payoffTable(sig,spot,contractSize,moves){
  const list=moves||[-15,-10,-5,0,5,10,15];
  const rows=list.map(m=>{
    const S=spot*(1+m/100);
    const {value,pnl}=payoffAtExpiry(sig,S,contractSize);
    return {move_pct:m, price:Math.round(S), value:Math.round(value), pnl:Math.round(pnl),
            total_loss: pnl<0 && Math.abs(pnl-(-(sig.econ.max_loss_inr||0)))<1 };
  });
  return rows;
}

/* ---------- how often has this actually happened? ----------
   The single most useful honesty check for a beginner: the card asks for a +5.8% move in
   10 days, so how often has that actually occurred? Measured from real history, over
   overlapping windows of the same length. This is a base rate, NOT a prediction. */
function moveFrequency(closes,needPct,days,dir){
  if(!Array.isArray(closes)||closes.length<days+5||!(days>0))return null;
  let hit=0,tot=0;
  for(let i=0;i+days<closes.length;i++){
    const a=closes[i],b=closes[i+days];
    if(!(a>0)||!(b>0))continue;
    const mv=100*(b-a)/a;
    tot++;
    if(dir>0?mv>=needPct:mv<=-Math.abs(needPct))hit++;
  }
  if(!tot)return null;
  return {hit,total:tot,rate:hit/tot,days,need_pct:+needPct.toFixed(2)};
}

/* ---------- the sentences ---------- */
const MONTH=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function dateLabel(ms){const d=new Date(ms);return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;}
const inr=v=>"₹"+Math.round(v).toLocaleString("en-IN");

/** One line naming the bet in the user's terms. */
function thesisLine(sig,view){
  const u=sig.underlying;
  if(sig.structure){
    // A credit spread is a "stays above/below" bet, not a "goes up" bet — say so.
    const dirn=sig.kind==="call"?"stays below":"stays above";
    return `${u} ${dirn} ${inr(sig.structure.short_strike)} until ${dateLabel(sig.expiry_ms)}`;
  }
  return sig.kind==="call"
    ? `${u} goes UP before ${dateLabel(sig.expiry_ms)}`
    : `${u} goes DOWN before ${dateLabel(sig.expiry_ms)}`;
}

/** The literal instruction. */
function actionLine(sig){
  if(sig.structure){
    return `Sell the ${inr(sig.structure.short_strike)} ${sig.kind} and buy the ${inr(sig.structure.long_strike)} ${sig.kind}, both expiring ${dateLabel(sig.expiry_ms)} (one trade, two legs)`;
  }
  return `Buy the ${sig.underlying} ${inr(sig.strike)} ${sig.kind.toUpperCase()} expiring ${dateLabel(sig.expiry_ms)}`;
}

/** What has to happen for this to pay. */
function winLine(sig){
  const by=dateLabel(sig.expiry_ms);
  if(sig.structure){
    const side=sig.kind==="call"?"below":"above";
    return `You keep the full ${inr(sig.structure.net_credit_inr)} if ${sig.underlying} is ${side} ${inr(sig.structure.short_strike)} on ${by}.`;
  }
  const dirn=sig.kind==="call"?"above":"below";
  return `You make money if ${sig.underlying} is ${dirn} ${inr(sig.econ.breakeven)} on ${by} — a ${sig.econ.req_move_pct}% move from here.`;
}

/** What losing looks like, stated without euphemism. */
function lossLine(sig){
  if(sig.structure){
    const side=sig.kind==="call"?"above":"below";
    return `If ${sig.underlying} finishes well ${side} ${inr(sig.structure.long_strike)} you lose the most you can lose: ${inr(sig.structure.max_loss_inr)}. That is capped — it cannot get worse than that.`;
  }
  return `If ${sig.underlying} does not get there, the option expires worthless and you lose the whole ${inr(sig.econ.premium_inr)} you paid. That is the most you can lose.`;
}

/** Time decay, in money per day rather than "theta". */
function decayLine(sig){
  const perDay=Math.abs(sig.econ.theta_day_inr||0);
  if(!(perDay>0))return null;
  if(sig.structure)
    return `Time is on your side here: roughly ${inr(perDay)} a day works in your favour while ${sig.underlying} sits still.`;
  return `Waiting costs money: about ${inr(perDay)} a day melts away if ${sig.underlying} sits still. This is not a position to hold and forget.`;
}

/** Difficulty framing from the real base rate. */
function oddsLine(freq,sig){
  if(!freq)return null;
  const p=Math.round(freq.rate*100);
  const verdict=p>=45?"a fairly ordinary move":p>=25?"a decent-sized move":p>=10?"a big move":"a rare move";
  return `Historically, ${sig.underlying} has made that move in ${freq.hit} of the last ${freq.total} ${freq.days}-day stretches (${p}%) — ${verdict}. That is a base rate from the past, not a prediction.`;
}

/** How confident, said without a decimal score. */
function confidenceWord(score){
  return score>=7?"Strong":score>=5?"Moderate":score>=3?"Weak":"Marginal";
}

/** Beginner-appropriate warnings, strongest first. Always at least one. */
function cautions(sig,freq,view){
  const out=[];
  if(sig.structure)
    out.push("This is a two-leg trade. Place both legs — the second one is what caps your loss. Without it your downside is open-ended.");
  if(freq&&freq.rate<0.2)
    out.push(`The move this needs has only happened ${Math.round(freq.rate*100)}% of the time historically. Most of the time, this expires worthless.`);
  if(sig.econ.dte_days<3)
    out.push(`Only ${sig.econ.dte_days.toFixed(1)} days left — there is very little time for the move to happen, and the value drops fast now.`);
  const decayShare=Math.abs(sig.econ.theta_day_inr||0)/Math.max(sig.econ.premium_inr||1,1)*100;
  if(!sig.structure&&decayShare>6)
    out.push(`It loses about ${decayShare.toFixed(0)}% of its value per day to time alone. Being right slowly is the same as being wrong.`);
  if(sig.quality&&sig.quality.backfilled)
    out.push("Part of the pricing check uses reference data from another exchange, because this venue has not built up enough of its own history yet.");
  if(view&&view.agree===false)
    out.push(`The app's own ${sig.underlying} trend read does not currently agree with this direction — treat it as lower conviction.`);
  if(!out.length)
    out.push("Options can expire completely worthless. Only put in money you are prepared to lose entirely.");
  return out;
}

/**
 * Full plain-English block for one signal.
 * `view`   — the app's directional read on the underlying (see radar wiring)
 * `closes` — daily closes for the honest base-rate stat
 */
function explainSignal(sig,opts){
  opts=opts||{};
  const spot=opts.spot||sig.econ.breakeven;
  const size=opts.contractSize||1;
  const dir=sig.structure?(sig.kind==="call"?-1:1):(sig.kind==="call"?1:-1);
  const freq=opts.closes?moveFrequency(opts.closes,Math.abs(sig.econ.req_move_pct||0),
    Math.max(1,Math.round(sig.econ.dte_days||1)),dir):null;
  return {
    thesis: thesisLine(sig,opts.view),
    action: actionLine(sig),
    cost_inr: sig.structure?null:sig.econ.premium_inr,
    credit_inr: sig.structure?sig.structure.net_credit_inr:null,
    max_loss_inr: sig.econ.max_loss_inr,
    win: winLine(sig),
    loss: lossLine(sig),
    decay: decayLine(sig),
    odds: oddsLine(freq,sig),
    odds_pct: freq?Math.round(freq.rate*100):null,
    confidence_word: confidenceWord(sig.score_10),
    payoff: payoffTable(sig,spot,size),
    cautions: cautions(sig,freq,opts.view),
    // The mispricing edge, said as a reason for choosing THIS contract rather than as the trade thesis.
    why_this_one: opts.candidates>1
      ? `Of the ${opts.candidates} contracts that fit this view, this one is priced most attractively versus what the rest of the chain implies it should cost.`
      : "This is the contract that best fits the view at a fair price.",
    days_left: sig.econ.dte_days
  };
}

module.exports={explainSignal,payoffAtExpiry,payoffTable,moveFrequency,thesisLine,actionLine,
  winLine,lossLine,decayLine,oddsLine,cautions,confidenceWord,dateLabel,inr};
