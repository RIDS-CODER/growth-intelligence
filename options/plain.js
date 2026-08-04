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
  // S and the strikes are in the VENUE's currency; premiums and credits are already in ₹.
  // fx_rate converts the intrinsic across, so the two sides of every subtraction match. Without
  // it a USDT intrinsic was being subtracted from a rupee credit — arithmetic that only looked
  // right while the venue happened to quote in INR.
  const fx=(sig.fx_rate!=null&&sig.fx_rate>0)?sig.fx_rate:1;
  const intr=(kind,K)=>kind==="call"?Math.max(0,S-K):Math.max(0,K-S);
  if(sig.structure){
    const shortK=sig.structure.short_strike, longK=sig.structure.long_strike;
    const owed=Math.max(0,intr(sig.kind,shortK)-intr(sig.kind,longK));   // capped by the width
    const credit=(sig.structure.net_credit_inr||0);                       // ₹, already banked
    const owedInr=owed*size*fx;
    return {value:credit-owedInr, pnl:credit-owedInr};
  }
  const value=intr(sig.kind,sig.strike)*size*fx;                          // → ₹
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

/* ---------- what this exact trade would have DONE, historically ----------
   Replays the position's real payoff across every overlapping window of the same length in
   the coin's own price history. This is the number that matters most, because it collapses
   probability AND payoff into one honest figure.

   Why both are needed: a credit spread can win 8 times out of 10 and still lose money, if the
   two losses cost more than the eight wins. A win rate quoted on its own sells exactly that
   trade as "high probability". The average return is what exposes it. */
function historicalOutcome(sig,spot,closes,days,contractSize){
  if(!Array.isArray(closes)||!(days>0)||!(spot>0))return null;
  const d=Math.max(1,Math.round(days));
  if(closes.length<d+10)return null;                 // too little history to say anything
  const stake=sig.econ&&sig.econ.max_loss_inr>0?sig.econ.max_loss_inr:null;
  if(!stake)return null;
  let wins=0,n=0,sum=0,worst=Infinity,best=-Infinity;
  const rets=[];
  for(let i=0;i+d<closes.length;i++){
    const a=closes[i],b=closes[i+d];
    if(!(a>0)||!(b>0))continue;
    const S_T=spot*(b/a);                            // apply the historical MOVE to today's price
    const {pnl}=payoffAtExpiry(sig,S_T,contractSize||1);
    n++; sum+=pnl; if(pnl>0)wins++;
    worst=Math.min(worst,pnl); best=Math.max(best,pnl);
    rets.push(100*pnl/stake);
  }
  if(!n)return null;
  rets.sort((x,y)=>x-y);
  return {
    n, wins, win_rate:wins/n,
    avg_pnl:sum/n,
    avg_return_pct:+(100*(sum/n)/stake).toFixed(2),   // as a % of the money you put at risk
    median_return_pct:+rets[rets.length>>1].toFixed(2),
    worst_pnl:worst, best_pnl:best, days:d
  };
}

/* ---------- the sentences ---------- */
const MONTH=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function dateLabel(ms){const d=new Date(ms);return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;}
/** Exchange-style expiry label, matching the tab on the venue's own chain screen ("06 Aug"). */
function expiryTab(ms){const d=new Date(ms);
  return `${String(d.getUTCDate()).padStart(2,"0")} ${MONTH[d.getUTCMonth()]}`;}

/* MONEY you put at risk — always your funding currency. */
const inr=v=>"₹"+Math.round(v).toLocaleString("en-IN");

/* PRICE LEVELS — strikes, breakevens, the coin's price — are quoted in the VENUE's currency.
   CoinDCX lists BTC options against USDT, so its strikes read 64000, not ₹88,40,000. Printing a
   rupee symbol on those made the numbers unfindable on the exchange's own screen. */
const CCY_SYM={INR:"₹",USDT:"$",USD:"$"};
function px(v,ccy){
  if(v==null||!isFinite(v))return "—";
  const sym=CCY_SYM[ccy]||"";
  const dp=Math.abs(v)<100?2:0;
  return sym+Number(v).toLocaleString(ccy==="INR"?"en-IN":"en-US",
    {minimumFractionDigits:dp,maximumFractionDigits:dp});
}
/** Bare number in the venue's own formatting — for matching a row on the exchange screen. */
const bare=v=>v==null||!isFinite(v)?"—":Number(v).toLocaleString("en-US",{maximumFractionDigits:2});

/** Everything needed to FIND this trade on the exchange's chain screen and place it. */
function locator(sig){
  const ccy=sig.quote_ccy||"USD";
  const tab=expiryTab(sig.expiry_ms);
  if(sig.structure){
    const isCall=sig.kind==="call";
    return {
      expiry_tab:tab, quote_ccy:ccy, two_legs:true,
      side_label:isCall?"CALL side (left of the strike column)":"PUT side (right of the strike column)",
      legs:[
        {do:"SELL",strike:sig.structure.short_strike,kind:sig.kind,
         price:sig.structure.short_bid,price_label:"you receive about"},
        {do:"BUY",strike:sig.structure.long_strike,kind:sig.kind,
         price:sig.structure.long_ask,price_label:"you pay about"}
      ],
      note:`Both legs are on the ${isCall?"CALL":"PUT"} side of the ${tab} chain. Place them together — the BUY leg is what caps your loss.`
    };
  }
  const isCall=sig.kind==="call";
  return {
    expiry_tab:tab, quote_ccy:ccy, two_legs:false,
    side_label:isCall?"CALL side (left of the strike column)":"PUT side (right of the strike column)",
    legs:[{do:"BUY",strike:sig.strike,kind:sig.kind,price:sig.ask,price_label:"you pay about"}],
    note:`On the ${tab} chain, find the row where the middle Strike column reads ${bare(sig.strike)}, then take the ${isCall?"CALL price on the LEFT":"PUT price on the RIGHT"}. Buy at the Ask.`
  };
}

/** One line naming the bet in the user's terms. */
function thesisLine(sig,view){
  const u=sig.underlying, ccy=sig.quote_ccy;
  if(sig.structure){
    // A credit spread is a "stays above/below" bet, not a "goes up" bet — say so.
    const dirn=sig.kind==="call"?"stays below":"stays above";
    return `${u} ${dirn} ${px(sig.structure.short_strike,ccy)} until ${dateLabel(sig.expiry_ms)}`;
  }
  return sig.kind==="call"
    ? `${u} goes UP before ${dateLabel(sig.expiry_ms)}`
    : `${u} goes DOWN before ${dateLabel(sig.expiry_ms)}`;
}

/** The literal instruction. */
function actionLine(sig){
  // Strikes are named exactly as the exchange lists them, so the row is findable.
  if(sig.structure){
    return `Sell the ${bare(sig.structure.short_strike)} ${sig.kind} and buy the ${bare(sig.structure.long_strike)} ${sig.kind}, both expiring ${expiryTab(sig.expiry_ms)} (one trade, two legs)`;
  }
  return `Buy the ${sig.underlying} ${bare(sig.strike)} ${sig.kind.toUpperCase()}, ${expiryTab(sig.expiry_ms)} expiry`;
}

/** What has to happen for this to pay. */
function winLine(sig){
  const by=dateLabel(sig.expiry_ms), ccy=sig.quote_ccy;
  if(sig.structure){
    const side=sig.kind==="call"?"below":"above";
    return `You keep the full ${inr(sig.structure.net_credit_inr)} if ${sig.underlying} is ${side} ${px(sig.structure.short_strike,ccy)} on ${by}.`;
  }
  const dirn=sig.kind==="call"?"above":"below";
  return `You make money if ${sig.underlying} is ${dirn} ${px(sig.econ.breakeven,ccy)} on ${by} — a ${sig.econ.req_move_pct}% move from here.`;
}

/** What losing looks like, stated without euphemism. */
function lossLine(sig){
  if(sig.structure){
    const side=sig.kind==="call"?"above":"below";
    return `If ${sig.underlying} finishes well ${side} ${px(sig.structure.long_strike,sig.quote_ccy)} you lose the most you can lose: ${inr(sig.structure.max_loss_inr)}. That is capped — it cannot get worse than that.`;
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

/** Difficulty framing from the real base rate.
    Driven by the position's actual WIN CONDITION, not by "did it move X%". Those are the same
    question for a long option but opposite ones for a credit spread, which wins precisely when
    the move does NOT happen — quoting move frequency there produced a card reading "70% chance
    it pays" directly above "has happened 0% of the time". */
function oddsLine(hist,sig){
  if(!hist||!hist.n)return null;
  const p=Math.round(hist.win_rate*100);
  const verdict=p>=70?"it has usually worked":p>=50?"it has worked slightly more often than not"
    :p>=25?"it has usually not worked":"it has rarely worked";
  let s=`Taking this exact trade at every point in ${sig.underlying}'s past, it would have made money in ${hist.wins} of ${hist.n} ${hist.days}-day stretches (${p}%) — ${verdict}. A base rate from the past, not a prediction.`;
  // Reconcile with the headline when the two estimates disagree, or the card reads as if it
  // contradicts itself ("70% chance it pays" above "worked 100% of the time").
  const mkt=sig.odds&&sig.odds.market!=null?Math.round(sig.odds.market*100):null;
  if(mkt!=null&&Math.abs(mkt-p)>=10){
    s+= mkt<p
      ? ` The market is pricing it nearer ${mkt}%; the headline shows that lower figure, because the past being kind is not a promise that it stays kind.`
      : ` The market is pricing it nearer ${mkt}%, but the headline shows the lower ${p}% that history actually delivered.`;
  }
  return s;
}

/** How confident, said without a decimal score. */
function confidenceWord(score){
  return score>=7?"Strong":score>=5?"Moderate":score>=3?"Weak":"Marginal";
}

/** The headline: odds as "wins about X times in 10", which people reason about far better than %. */
function oddsHeadline(odds){
  if(!odds||odds.win_prob==null)return null;
  const p=odds.win_prob, inTen=Math.round(p*10);
  const word=p>=0.75?"Very likely":p>=0.6?"Likely":p>=0.45?"Roughly a coin flip":p>=0.25?"Unlikely":"Long shot";
  return {pct:Math.round(p*100), in_ten:inTen, word,
    text:`Wins about ${inTen} times in 10`};
}

/** The single most important sentence on a high-win-rate trade. */
function payoffBalanceLine(odds){
  if(!odds)return null;
  const avg=odds.hist_avg_return_pct;
  // A high win rate with a negative average return is the premium-selling trap: many small
  // wins funding a few outsized losses. Say it before the win rate can mislead.
  if(odds.win_prob>=0.6&&avg!=null&&avg<0)
    return {bad:true,text:`⚠ It wins often, but it has still LOST money on average — about ${avg}% per trade across ${odds.history_n} similar past stretches. The occasional loss is bigger than all the small wins. A high win rate is not the same as a profitable trade.`};
  if(odds.loss_to_win>1.5&&odds.breakeven_win_rate!=null)
    return {bad:false,text:`A loss costs ${odds.loss_to_win}× what a win pays, so this needs to win more than ${Math.round(odds.breakeven_win_rate*100)}% of the time just to break even${odds.win_prob!=null?` — and it is running at about ${Math.round(odds.win_prob*100)}%`:''}.`};
  if(avg!=null&&avg>0)
    return {bad:false,text:`Across ${odds.history_n} similar past stretches this trade averaged ${avg>0?'+':''}${avg}% on the money at risk.`};
  return null;
}

/** Beginner-appropriate warnings, strongest first. Always at least one. */
function cautions(sig,hist,view){
  const out=[];
  if(sig.structure)
    out.push("This is a two-leg trade. Place both legs — the second one is what caps your loss. Without it your downside is open-ended.");
  if(hist&&hist.n&&hist.win_rate<0.25)
    out.push(`Taken at every point in the past, this trade made money only ${Math.round(hist.win_rate*100)}% of the time. Most of the time it expires worthless.`);
  // A trade that wins often but has still lost money historically is the trap this screener
  // exists to catch — say it plainly and near the top.
  if(hist&&hist.n&&hist.win_rate>=0.55&&hist.avg_return_pct<0)
    out.push(`It wins most of the time but has still averaged ${hist.avg_return_pct}% per trade historically — the occasional loss is bigger than all the small wins put together.`);
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
  // One source of truth for "has this worked before": the position's own payoff replayed over
  // history. Everything that talks about odds on the card reads from this.
  const hist=opts.hist||(opts.closes
    ? historicalOutcome(sig,spot,opts.closes,Math.max(1,Math.round(sig.econ.dte_days||1)),size)
    : null);
  const odds=sig.odds||null;
  return {
    odds_headline: oddsHeadline(odds),
    payoff_balance: payoffBalanceLine(odds),
    thesis: thesisLine(sig,opts.view),
    action: actionLine(sig),
    cost_inr: sig.structure?null:sig.econ.premium_inr,
    credit_inr: sig.structure?sig.structure.net_credit_inr:null,
    max_loss_inr: sig.econ.max_loss_inr,
    win: winLine(sig),
    loss: lossLine(sig),
    decay: decayLine(sig),
    odds: oddsLine(hist,sig),
    odds_pct: hist?Math.round(hist.win_rate*100):null,
    confidence_word: confidenceWord(sig.score_10),
    payoff: payoffTable(sig,spot,size),
    price_ccy: sig.quote_ccy||null,
    locator: locator(sig),
    cautions: cautions(sig,hist,opts.view),
    // The mispricing edge, said as a reason for choosing THIS contract rather than as the trade thesis.
    why_this_one: opts.candidates>1
      ? `Of the ${opts.candidates} contracts that fit this view, this one is priced most attractively versus what the rest of the chain implies it should cost.`
      : "This is the contract that best fits the view at a fair price.",
    days_left: sig.econ.dte_days
  };
}

module.exports={explainSignal,payoffAtExpiry,payoffTable,moveFrequency,historicalOutcome,locator,px,bare,expiryTab,
  thesisLine,actionLine,winLine,lossLine,decayLine,oddsLine,oddsHeadline,payoffBalanceLine,
  cautions,confidenceWord,dateLabel,inr};
