/* ============================================================
   Options Radar — SCORING SERVICE
   Ranks contracts by MISPRICING vs fair value. This is not a directional forecast:
   a BUY means "cheap relative to the curve/history", not "the underlying will rise".

   Weights are injected (config), never hardcoded here.
   ============================================================ */
"use strict";
const V=require("./vol.js");
const P=require("./plain.js");

/* ---------- defaults (overridden by config.json → optionsRadar) ---------- */
const DEFAULTS={
  weights:{ iv_rv:0.30, iv_pctile:0.20, smile_resid:0.25, term_slope:0.10, theta_eff:0.15, funding_tilt:0.00 },
  filters:{ maxSpreadPct:8, minOI:50, minAbsDelta:0.15, maxAbsDelta:0.70, minHoursToExpiry:12,
            // SHORT-DATED ONLY. Nobody wants capital locked up for months in a decaying asset,
            // and long-dated contracts are also the illiquid end of a crypto chain.
            maxDaysToExpiry:14 },
  // A setup must clear this to be called a setup at all. Below it, it is a lottery ticket and
  // is either hidden or shown in a separate, clearly-labelled section.
  minWinRate:0.55,
  showLongShots:true,               // keep low-probability/high-payoff ideas visible but segregated
  fundingTiltEnabled:false,          // spec: default off, user-toggleable
  minScore:0,                        // cards below this are not surfaced
  topN:3,
  // DIRECTION GATE. The screener's edge is knowing WHICH CONTRACT is cheap; it is not a
  // forecast. But a contract on its own is not a trade a person can act on — they need to
  // know what they are betting on first. So the app's own directional read on the underlying
  // supplies the thesis, and mispricing then picks the cheapest way to express it.
  // Set requireDirectionalView:false for pure relative-value mode (no thesis, expert use).
  requireDirectionalView:true,
  minViewScore:12,                   // |signal score| below this = no clear view = no cards
  tax:{ gainsRatePct:30, cessPct:4, tdsPct:0, applyTds:false },   // India VDA; see README caveat
  tenorBuckets:[{name:"0-2d",maxDays:2},{name:"3-9d",maxDays:9},{name:"10-30d",maxDays:30},{name:"31-90d",maxDays:1e9}],
  holdingDays:null                   // null → hold to expiry for the theta/move ratio
};
function withDefaults(cfg){
  cfg=cfg||{};
  return {
    ...DEFAULTS,...cfg,
    weights:{...DEFAULTS.weights,...(cfg.weights||{})},
    filters:{...DEFAULTS.filters,...(cfg.filters||{})},
    tax:{...DEFAULTS.tax,...(cfg.tax||{})}
  };
}
const tenorOf=(days,buckets)=>(buckets.find(b=>days<=b.maxDays)||buckets[buckets.length-1]).name;
const deltaBucketOf=q=>{
  const d=Math.abs(q.greeks.delta);
  const side=q.kind==="call"?"c":"p";
  if(d>=0.40&&d<=0.60)return "atm";
  return side+(d<0.20?"15":d<0.35?"25":"35");
};

/* ============================================================
   HARD FILTERS — applied before scoring. A failure is recorded with the measured
   value and the limit, so "why isn't X here?" answers from what actually ran.
   ============================================================ */
function applyFilters(q,f,nowMs){
  const hrs=(q.expiry_ms-nowMs)/3600000, days=hrs/24;
  if(!(hrs>f.minHoursToExpiry))
    return {reason:`expiry ${hrs.toFixed(1)}h away, needs > ${f.minHoursToExpiry}h`,detail:{hours:+hrs.toFixed(2),limit:f.minHoursToExpiry}};
  if(f.maxDaysToExpiry!=null&&days>f.maxDaysToExpiry)
    return {reason:`expires in ${days.toFixed(0)} days — longer than the ${f.maxDaysToExpiry}-day limit, so your money would be tied up too long`,
            detail:{days:+days.toFixed(1),limit:f.maxDaysToExpiry}};
  if(q.spread_pct==null)
    return {reason:"no two-sided quote — spread cannot be measured",detail:{bid:q.bid,ask:q.ask}};
  if(!(q.spread_pct<f.maxSpreadPct))
    return {reason:`bid-ask spread ${q.spread_pct.toFixed(1)}% of premium, limit ${f.maxSpreadPct}%`,detail:{spread_pct:+q.spread_pct.toFixed(2),limit:f.maxSpreadPct}};
  if(!(q.oi>=f.minOI))
    return {reason:`open interest ${q.oi} below floor ${f.minOI}`,detail:{oi:q.oi,limit:f.minOI}};
  const ad=Math.abs(q.greeks.delta);
  if(!(ad>=f.minAbsDelta&&ad<=f.maxAbsDelta))
    return {reason:`|delta| ${ad.toFixed(3)} outside ${f.minAbsDelta}–${f.maxAbsDelta}`,detail:{abs_delta:+ad.toFixed(4),min:f.minAbsDelta,max:f.maxAbsDelta}};
  return null;
}

/* ============================================================
   SIGNALS
   Sign convention: NEGATIVE z = cheap = supports a BUY. The sell side flips the
   COMPOSITE, not the individual z's, so the same underlying numbers explain both sides.
   ============================================================ */
const clampZ=z=>Math.max(-4,Math.min(4,isFinite(z)?z:0));

function signalIvMinusRv(q,snap){
  if(!(snap.rvol30>0))return null;
  // Normalize by realized vol so a 5-point gap means the same on a 30-vol and a 90-vol coin.
  return clampZ((q.iv-snap.rvol30)/(0.25*snap.rvol30));
}
function signalIvPercentile(q,hist){
  if(!hist||hist.n<20)return null;                 // too little history to speak
  const p=V.percentileOf(q.iv,hist.iv);
  if(!isFinite(p))return null;
  return clampZ((p-50)/20);                        // 50th pct → 0; 90th → +2 (expensive)
}
function signalSmileResidual(q,fit,idx){
  if(!fit||fit.degraded)return null;               // thin chain → this signal abstains entirely
  const z=fit.z[idx];
  return isFinite(z)?clampZ(z):null;
}
function signalTermSlope(q,fitsByExpiry){
  // This expiry's ATM total variance vs a linear interpolation of its neighbours' in T.
  // Interpolating in VARIANCE vs time (not IV vs time) is the correct no-arb comparison.
  const list=Object.values(fitsByExpiry).filter(f=>f&&isFinite(f.a)&&f.T>0).sort((a,b)=>a.T-b.T);
  if(list.length<3)return null;
  const i=list.findIndex(f=>f.expiry_ms===q.expiry_ms);
  if(i<=0||i>=list.length-1)return null;            // need both neighbours
  const lo=list[i-1],hi=list[i+1],me=list[i];
  const span=hi.T-lo.T; if(!(span>0))return null;
  const interp=lo.a+(hi.a-lo.a)*(me.T-lo.T)/span;   // a = total variance at k=0 (ATM)
  if(!(interp>0))return null;
  return clampZ((me.a-interp)/(0.15*interp));
}
function signalThetaEfficiency(q,snap,cfg){
  // Theta bleed per day measured against the move the option needs. High bleed per unit of
  // expected move = expensive to hold = a sell-side argument.
  const days=(q.expiry_ms-snap.ts_ms)/86400000;
  const hold=cfg.holdingDays!=null?Math.min(cfg.holdingDays,days):days;
  if(!(hold>0)||!(q.mark>0))return null;
  const thetaPct=Math.abs(q.greeks.theta)/q.mark*100;            // % of premium lost per day
  const expMovePct=q.iv*Math.sqrt(hold/365)*100;                  // 1σ move over the hold
  if(!(expMovePct>0))return null;
  const ratio=(thetaPct*hold)/expMovePct;
  return clampZ((ratio-0.5)/0.35);                                // >0.5 = bleeding faster than it can move
}
function signalFundingTilt(q,snap,cfg){
  if(!cfg.fundingTiltEnabled)return null;                         // default OFF per spec
  // A directional overlay, deliberately weak: positive funding = crowded longs = calls richer.
  const tilt=(snap.funding_rate||0)*10000+(snap.basis_bps||0)/10;
  const dirn=q.kind==="call"?1:-1;
  return clampZ(dirn*tilt/50);
}

/* ============================================================
   SELL → DEFINED-RISK VERTICAL
   A naked short is never presented as an action. If no protective wing passes the
   liquidity filters, the signal is SUPPRESSED rather than shown — an unhedgeable short
   is not a tradeable recommendation.
   ============================================================ */
function buildVertical(shortQ,chain,cfg,nowMs){
  const sameExpiryKind=chain.filter(c=>c.expiry_ms===shortQ.expiry_ms&&c.kind===shortQ.kind&&c.id!==shortQ.id);
  // Protective wing = next strike further OTM.
  const further=shortQ.kind==="call"
    ? sameExpiryKind.filter(c=>c.strike>shortQ.strike).sort((a,b)=>a.strike-b.strike)
    : sameExpiryKind.filter(c=>c.strike<shortQ.strike).sort((a,b)=>b.strike-a.strike);
  for(const wing of further){
    // The wing must itself be liquid enough to actually buy — otherwise the "defined risk"
    // is fictional. Delta is deliberately NOT filtered here: a protective wing is meant to be
    // further OTM than the tradeable band.
    if(wing.spread_pct==null||!(wing.spread_pct<cfg.filters.maxSpreadPct*1.5))continue;
    if(!(wing.oi>=cfg.filters.minOI*0.5))continue;
    const width=Math.abs(wing.strike-shortQ.strike);
    const credit=shortQ.mark-wing.mark;
    if(!(credit>0))continue;                       // no net credit = not a credit spread
    const maxLoss=width-credit;
    if(!(maxLoss>0))continue;
    return {short_leg:shortQ.id,long_leg:wing.id,short_strike:shortQ.strike,long_strike:wing.strike,
            width,net_credit:credit,max_loss:maxLoss,
            breakeven: shortQ.kind==="call"?shortQ.strike+credit:shortQ.strike-credit,
            ratio:+(credit/maxLoss).toFixed(3)};
  }
  return null;
}

/* ---------- India VDA tax drag ---------- */
function taxDrag(grossGain,tax){
  if(!(grossGain>0))return 0;                       // losses get NO offset — that is the point
  const rate=(tax.gainsRatePct/100)*(1+tax.cessPct/100);
  return grossGain*rate;
}

/* ============================================================
   WHY / WHY NOT
   `why` names the dominant CONTRIBUTION (z × weight), so it is derived from the maths
   rather than guessed. `why_not` is a required field: every card must carry its strongest
   counter-argument, and a signal cannot serialize without one.
   ============================================================ */
const SIGNAL_TEXT={
  iv_rv:{cheap:"implied vol is running below the underlying's 30-day realized vol",
         rich:"implied vol is well above the underlying's 30-day realized vol"},
  iv_pctile:{cheap:"IV sits near the low end of its own 90-day range for this bucket",
             rich:"IV sits near the top of its own 90-day range for this bucket"},
  smile_resid:{cheap:"it is quoted below its expiry's own vol curve — the cheapest strike on the smile",
               rich:"it is quoted above its expiry's own vol curve — the richest strike on the smile"},
  term_slope:{cheap:"this expiry is cheap against the expiries either side of it",
              rich:"this expiry is bid up against the expiries either side of it"},
  theta_eff:{cheap:"time decay is small relative to the move it can make",
             rich:"time decay is heavy relative to the move it can realistically make"},
  funding_tilt:{cheap:"perp funding and basis lean in this contract's favour",
                rich:"perp funding and basis lean against this contract"}
};
function buildWhy(side,contrib){
  const ranked=Object.entries(contrib).filter(([,v])=>isFinite(v)&&v!==0)
    .sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]));
  const wanted=side==="buy"?-1:1;                    // buy is driven by negative contributions
  const lead=ranked.find(([,v])=>Math.sign(v)===wanted)||ranked[0];
  if(!lead)return "No single signal dominates — this is a marginal, evenly-weighted read.";
  const t=SIGNAL_TEXT[lead[0]];
  const phrase=t?(side==="buy"?t.cheap:t.rich):lead[0];
  return (side==="buy"?"Cheap because ":"Rich because ")+phrase+".";
}
function buildWhyNot(side,contrib,q,quality,structure){
  // Strongest signal pointing the OTHER way beats a quality caveat; if every signal agrees,
  // fall back to the most material data-quality or structural caveat. Never blank.
  const against=Object.entries(contrib).filter(([,v])=>isFinite(v)&&v!==0)
    .filter(([,v])=>side==="buy"?v>0:v<0)
    .sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]))[0];
  if(against){
    const t=SIGNAL_TEXT[against[0]];
    const phrase=t?(side==="buy"?t.rich:t.cheap):against[0];
    return "Against it: "+phrase+".";
  }
  if(quality.backfilled)
    return "Against it: the IV-percentile leg is scored on Deribit backfill, not CoinDCX's own history — the baseline may not reflect this venue.";
  if(quality.degraded_fit)
    return "Against it: too few strikes in this expiry to fit a reliable vol curve, so the smile signal abstained.";
  if(quality.iv_src==="computed")
    return "Against it: IV is solved from the mark rather than published by the venue, so a stale mark becomes a stale signal.";
  if(quality.spread_pct!=null&&quality.spread_pct>4)
    return `Against it: the ${quality.spread_pct.toFixed(1)}% bid-ask spread eats a meaningful share of the edge on entry and exit.`;
  if(structure)
    return `Against it: max loss is capped at the spread width, but assignment risk on the short ${structure.short_strike} leg is real if it finishes in the money.`;
  if(q.oi<200)
    return `Against it: open interest is only ${q.oi} — thin books can move against you on the way out.`;
  return "Against it: every signal points the same way, which usually means the market already knows — expect the edge to be small.";
}

/* ============================================================
   MAIN
   ============================================================ */
function scoreSnapshot(snap,ctx,cfgIn){
  const cfg=withDefaults(cfgIn);
  const now=snap.ts_ms, hist=ctx&&ctx.history?ctx.history:()=>null;
  const rejections=[...(snap.rejects||[]).map(r=>({ts_ms:now,id:r.id,stage:"normalize",reason:r.reason,detail:r.detail}))];

  /* 1 — hard filters */
  const passed=[];
  for(const q of snap.quotes){
    const bad=applyFilters(q,cfg.filters,now);
    if(bad)rejections.push({ts_ms:now,id:q.id,stage:"filter",reason:bad.reason,detail:bad.detail});
    else passed.push(q);
  }

  /* 2 — fit one smile per expiry, using ONLY filtered quotes so junk cannot set fair value */
  const byExpiry={};
  for(const q of passed)(byExpiry[q.expiry_ms]=byExpiry[q.expiry_ms]||[]).push(q);
  const fits={},idxOf={};
  for(const [exp,qs] of Object.entries(byExpiry)){
    const pts=qs.map(q=>({k:q.k,iv:q.iv,vega:q.greeks.vega,spread:q.spread||q.mark*0.01}));
    const f=V.fitSmile(pts,qs[0].T,{minVolNoise:cfg.minVolNoise});
    f.expiry_ms=+exp; f.T=qs[0].T;
    fits[exp]=f;
    qs.forEach((q,i)=>{idxOf[q.id]=i;});
  }

  /* 3 — score */
  const cards=[];
  for(const q of passed){
    const fit=fits[q.expiry_ms];
    const days=(q.expiry_ms-now)/86400000;
    const tenor=tenorOf(days,cfg.tenorBuckets);
    const h=hist(snap.underlying,tenor,deltaBucketOf(q));
    const z={
      iv_rv:        signalIvMinusRv(q,snap),
      iv_pctile:    signalIvPercentile(q,h),
      smile_resid:  signalSmileResidual(q,fit,idxOf[q.id]),
      term_slope:   signalTermSlope(q,fits),
      theta_eff:    signalThetaEfficiency(q,snap,cfg),
      funding_tilt: signalFundingTilt(q,snap,cfg)
    };
    // Renormalize over the signals that actually spoke, so an abstaining signal dilutes
    // rather than silently counting as neutral-zero.
    let wsum=0,acc=0; const contrib={};
    for(const key of Object.keys(cfg.weights)){
      const w=cfg.weights[key];
      if(!(w>0)||z[key]==null)continue;
      wsum+=w; acc+=w*z[key]; contrib[key]=+(w*z[key]).toFixed(4);
    }
    if(wsum<=0){
      rejections.push({ts_ms:now,id:q.id,stage:"score",reason:"no signal had enough data to speak",detail:{}});
      continue;
    }
    const composite=acc/wsum;                       // negative = cheap
    const spoke=Object.keys(contrib).length;
    const quality={backfilled:!!(h&&h.backfilled),iv_src:q.iv_src,spread_pct:q.spread_pct,oi:q.oi,
                   degraded_fit:!!(fit&&fit.degraded),signals_used:spoke,
                   forward_fallback:!!snap.forward_fallback,
                   native_history:h?h.nativeN:0};
    const side=composite<0?"buy":"sell";
    // 0..10 on |composite|; a 2σ blended dislocation ≈ 6.7/10.
    const score=Math.max(0,Math.min(10,Math.abs(composite)*3.33));
    cards.push({q,side,score,composite,z,contrib,quality,tenor,days,fit});
  }

  /* 3b — DIRECTION GATE.
     A contract is only surfaced if it EXPRESSES the app's current view on the underlying:
       bullish  → buy calls          (or sell put spreads: profit while it holds up)
       bearish  → buy puts           (or sell call spreads)
     Without this the screener answers "which option is cheap?" — a true statement that a
     non-options trader cannot act on, because it never says what they are betting on. */
  const view=ctx&&ctx.view?ctx.view:null;
  if(cfg.requireDirectionalView){
    if(!view||!isFinite(view.score)||Math.abs(view.score)<cfg.minViewScore){
      // No clear view = no trade. Surfacing "cheap" contracts with no thesis is how a
      // beginner ends up holding a lottery ticket they cannot explain.
      const why=!view?"no directional read available for this underlying"
        :`the ${snap.underlying} trend read is ${view.score>0?'+':''}${view.score}, inside the ±${cfg.minViewScore} "no clear direction" band`;
      cards.forEach(c=>rejections.push({ts_ms:now,id:c.q.id,stage:"direction",
        reason:`No trade suggested — ${why}. Waiting for a clearer trend beats guessing.`,
        detail:{view_score:view?view.score:null,threshold:cfg.minViewScore}}));
      return {ts_ms:now,underlying:snap.underlying,venue:snap.venue,buys:[],sells:[],longShots:[],all:[],
        rejections,view,noView:true,
        fits:Object.values(fits).map(f=>({expiry_ms:f.expiry_ms,n:f.n,degraded:f.degraded})),
        counts:{quotes:snap.quotes.length,passed:passed.length,scored:0}};
    }
    const bullish=view.score>0;
    const kept=[];
    for(const c of cards){
      // long call = bullish · long put = bearish · call credit spread = bearish/neutral ·
      // put credit spread = bullish/neutral
      const expresses = c.side==="buy"
        ? (bullish ? c.q.kind==="call" : c.q.kind==="put")
        : (bullish ? c.q.kind==="put"  : c.q.kind==="call");
      if(expresses)kept.push(c);
      else rejections.push({ts_ms:now,id:c.q.id,stage:"direction",
        reason:`Priced attractively, but it bets the wrong way: the ${snap.underlying} read is ${bullish?"bullish":"bearish"} and this position profits if it goes the other way.`,
        detail:{view_score:view.score,kind:c.q.kind,side:c.side}});
    }
    cards.length=0; cards.push(...kept);
  }

  /* 4 — economics, guardrails, WHY/WHY NOT */
  const out=[];
  for(const c of cards){
    const q=c.q;
    let structure=null;
    if(c.side==="sell"){
      structure=buildVertical(q,passed,cfg,now);
      if(!structure){
        rejections.push({ts_ms:now,id:q.id,stage:"structure",
          reason:"no liquid protective wing in this expiry — a naked short is never surfaced",
          detail:{strike:q.strike,kind:q.kind}});
        continue;                                    // suppressed, not downgraded
      }
    }
    const contractSize=ctx&&ctx.contractSize?ctx.contractSize:1;
    const fx=ctx&&ctx.toInr?ctx.toInr:(v=>v);
    const premium=q.mark*contractSize;
    const maxLoss=c.side==="buy"?premium:structure.max_loss*contractSize;
    const breakeven=c.side==="buy"
      ? (q.kind==="call"?q.strike+q.mark:q.strike-q.mark)
      : structure.breakeven;
    const reqMovePct=100*Math.abs(breakeven-q.F)/q.F;
    // Tax drag illustrated on the T1-equivalent outcome: for a long, the premium doubling;
    // for a credit spread, keeping the full credit.
    const illustrativeGain=c.side==="buy"?premium:structure.net_credit*contractSize;
    const why=buildWhy(c.side,c.contrib);
    const why_not=buildWhyNot(c.side,c.contrib,q,c.quality,structure);
    const sig={
      ts_ms:now, id:q.id, venue:snap.venue, underlying:snap.underlying,
      side:c.side, score_10:+c.score.toFixed(2), composite:+c.composite.toFixed(4),
      kind:q.kind, strike:q.strike, expiry_ms:q.expiry_ms, tenor:c.tenor,
      z:c.z, contrib:c.contrib, why, why_not,
      econ:{
        premium_inr:+fx(premium).toFixed(2),
        breakeven:+breakeven.toFixed(2),
        max_loss_inr:+fx(maxLoss).toFixed(2),
        theta_day_inr:+fx(q.greeks.theta*contractSize).toFixed(2),
        req_move_pct:+reqMovePct.toFixed(2),
        dte_days:+c.days.toFixed(2),
        tax_drag_inr:+fx(taxDrag(illustrativeGain,cfg.tax)).toFixed(2),
        tax_note:`Illustrative: ${cfg.tax.gainsRatePct}% + ${cfg.tax.cessPct}% cess on gains, losses not offsettable`
      },
      structure: structure?{
        short_leg:structure.short_leg, long_leg:structure.long_leg,
        // strikes travel with the signal: the backtest needs them to settle the spread at
        // expiry, and the card needs them to show what is actually being traded
        short_strike:structure.short_strike, long_strike:structure.long_strike,
        width:structure.width, net_credit_inr:+fx(structure.net_credit*contractSize).toFixed(2),
        max_loss_inr:+fx(structure.max_loss*contractSize).toFixed(2)
      }:null,
      quality:c.quality,
      iv:+q.iv.toFixed(4), rvol30:snap.rvol30!=null?+snap.rvol30.toFixed(4):null,
      delta:+q.greeks.delta.toFixed(4)
    };
    if(!sig.why_not)throw new Error("invariant: why_not must never be empty");

    /* ---- ODDS. This, not mispricing, is what the card is ranked on. ----
       Two independent estimates, deliberately kept separate:
         market  — the odds implied by the option's own price (Black-76 at the breakeven)
         history — how often this coin has ACTUALLY finished past that level
       Rank on the LOWER of the two. When the market is offering better odds than history
       supports, the conservative number is the honest one to lead with. */
    const winsAbove = c.side==="buy" ? q.kind==="call" : q.kind==="put";
    const marketProb = winsAbove
      ? V.probAbove(q.F,breakeven,q.T,q.iv)
      : V.probBelow(q.F,breakeven,q.T,q.iv);
    const hist=(ctx&&ctx.closes)?P.historicalOutcome(sig,snap.spot,ctx.closes,c.days,contractSize):null;
    const probs=[marketProb,hist?hist.win_rate:null].filter(x=>x!=null&&isFinite(x));
    const winProb=probs.length?Math.min(...probs):null;
    sig.odds={
      win_prob:winProb!=null?+winProb.toFixed(4):null,
      market:isFinite(marketProb)?+marketProb.toFixed(4):null,
      historical:hist?+hist.win_rate.toFixed(4):null,
      history_n:hist?hist.n:0,
      // What the trade actually RETURNED historically. A high win rate with a negative average
      // return is the classic premium-selling trap, and this is what exposes it.
      hist_avg_return_pct:hist?hist.avg_return_pct:null,
      hist_worst_inr:hist?+fx(hist.worst_pnl).toFixed(0):null
    };
    // Payoff geometry: how many times bigger a loss is than a win. Needed to judge whether the
    // odds are actually good enough.
    const maxWin=c.side==="buy"?null:(structure?structure.net_credit*contractSize:null);
    sig.odds.loss_to_win = (maxWin>0)?+(maxLoss/maxWin).toFixed(2):null;
    // The win rate this trade must clear just to break even on its own payoff geometry.
    sig.odds.breakeven_win_rate = (maxWin>0)?+(maxLoss/(maxLoss+maxWin)).toFixed(4):null;
    out.push(sig);
  }

  /* RANK BY ODDS, not by mispricing.
     Mispricing answers "is this contract cheap?", which is not the question a trader is asking.
     It stays on the card as a price-fairness check and breaks ties, but it no longer decides
     what gets shown — a contract that is 2σ cheap and almost never pays is not a setup. */
  const byOdds=(a,b)=>{
    const pa=a.odds.win_prob==null?-1:a.odds.win_prob, pb=b.odds.win_prob==null?-1:b.odds.win_prob;
    if(Math.abs(pa-pb)>0.01)return pb-pa;
    return b.score_10-a.score_10;                       // equally likely → take the better price
  };
  const likely=out.filter(s=>s.odds.win_prob!=null&&s.odds.win_prob>=cfg.minWinRate);
  const longShots=out.filter(s=>!(s.odds.win_prob!=null&&s.odds.win_prob>=cfg.minWinRate));
  const buys=likely.filter(s=>s.side==="buy").sort(byOdds).slice(0,cfg.topN);
  const sells=likely.filter(s=>s.side==="sell").sort(byOdds).slice(0,cfg.topN);
  const shots=cfg.showLongShots?longShots.sort(byOdds).slice(0,cfg.topN):[];
  for(const s of longShots){
    if(shots.includes(s))continue;
    rejections.push({ts_ms:now,id:s.id,stage:"odds",
      reason:`Only about a ${Math.round((s.odds.win_prob||0)*100)}% chance of paying off — below the ${Math.round(cfg.minWinRate*100)}% bar for a setup.`,
      detail:{win_prob:s.odds.win_prob,threshold:cfg.minWinRate}});
  }
  // Anything scored but not surfaced still needs an answer for "why isn't X here?"
  const shown=new Set([...buys,...sells].map(s=>s.id));
  for(const s of out){
    if(shown.has(s.id))continue;
    rejections.push({ts_ms:now,id:s.id,stage:"rank",
      reason:`scored ${s.score_10.toFixed(2)}/10 on the ${s.side} side — outside the top ${cfg.topN}`,
      detail:{score:s.score_10,side:s.side}});
  }
  return {ts_ms:now,underlying:snap.underlying,venue:snap.venue,buys,sells,longShots:shots,all:out,rejections,
          view, noView:false, candidates:out.length, minWinRate:cfg.minWinRate,
          fits:Object.values(fits).map(f=>({expiry_ms:f.expiry_ms,n:f.n,degraded:f.degraded,
            rmseVol:isFinite(f.rmseVol)?+f.rmseVol.toFixed(5):null,arb:f.arb})),
          counts:{quotes:snap.quotes.length,passed:passed.length,scored:out.length}};
}

/* Bucket IV points for the 90d baseline: the fitted smile sampled at FIXED deltas. */
function bucketPoints(snap,fits,cfg){
  cfg=withDefaults(cfg);
  const out=[];
  for(const f of Object.values(fits||{})){
    if(!f||f.degraded||!(f.T>0))continue;
    const days=f.T*365, tenor=tenorOf(days,cfg.tenorBuckets);
    for(const [bucket,delta,kind] of [["p15",0.15,"put"],["p25",0.25,"put"],["atm",0.5,"call"],["c25",0.25,"call"],["c15",0.15,"call"]]){
      const k=V.kForDelta(f,delta,kind,f.T,1);
      if(!isFinite(k))continue;
      const iv=V.fitIV(f,k,f.T);
      if(!(iv>0)||!isFinite(iv))continue;
      out.push({ts_ms:snap.ts_ms,underlying:snap.underlying,tenor,delta_bucket:bucket,
                iv:+iv.toFixed(6),src:snap.venue,n_points:f.n});
    }
  }
  return out;
}

module.exports={scoreSnapshot,bucketPoints,applyFilters,buildVertical,buildWhy,buildWhyNot,
  taxDrag,withDefaults,tenorOf,deltaBucketOf,DEFAULTS};
