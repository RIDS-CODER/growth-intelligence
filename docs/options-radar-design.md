# Options Radar — data schema & smile-fitting design

**Status: proposal, pending sign-off. No scoring code written yet.**

Scope: CoinDCX options (BTC, ETH, SOL — daily/weekly/monthly expiries, INR-margined).
Goal: rank contracts by **mispricing vs fair value**, not by directional forecast.

---

## 0. The data-availability constraint (read first)

CoinDCX offers options trading, but **no public options-chain REST endpoint is documented** — the public
API surface covers spot and futures/derivatives. That has three consequences the design must absorb:

1. **Everything sits behind a venue adapter.** The scoring service never sees a venue payload; it sees a
   normalized `Snapshot`. Swapping in the real CoinDCX endpoint later touches one file.
2. **Every adapter validates shape at runtime** and reports which fields were missing, rather than silently
   producing `undefined` that later reads as `0` and poisons a z-score.
3. **IV is treated as optional input.** If the venue publishes IV we use it; otherwise we solve it from mark
   price ourselves. Either way the source is recorded per quote (`iv_src`), because a screener that mixes
   venue IV and self-computed IV without tracking which is which will produce fake smile residuals.

---

## 1. Data schema

Six record types. Storage format is a separate decision (see §5) — these are the shapes.

### 1.1 `Instrument` — slowly-changing dimension

```jsonc
{
  "id":            "BTC-31OCT26-90000-C",   // canonical, venue-independent
  "venue":         "coindcx",               // | "deribit"
  "venue_symbol":  "<raw venue string>",    // exactly as the venue names it
  "underlying":    "BTC",                   // BTC | ETH | SOL
  "kind":          "call",                  // call | put
  "strike":        90000,
  "expiry_ms":     1793923200000,           // UTC ms, exchange settlement instant
  "contract_size": 0.01,                    // underlying units per contract
  "quote_ccy":     "INR",                   // INR | USDT | USD
  "tick_size":     1,
  "first_seen_ms": 0, "last_seen_ms": 0
}
```

### 1.2 `Snapshot` — append-only; this *is* the backtest tape

One record per scan interval per venue. Everything the scorer needs must be in here, so a backtest replay
is bit-identical to what live scoring saw.

```jsonc
{
  "ts_ms": 0, "venue": "coindcx", "underlying": "BTC",
  "spot": 8500000,
  "forwards":     [ { "expiry_ms": 0, "F": 8530000, "T_years": 0.0192 } ],
  "funding_rate": 0.0001,     // perp funding, per interval, decimal
  "basis_bps":    35,         // futures-spot basis, nearest quarterly
  "rvol30":       0.52,       // 30d realized vol of underlying, annualized
  "fx_usdinr":    88.4,       // for INR normalization + Deribit comparability
  "quotes": [ /* Quote */ ]
}
```

```jsonc
// Quote
{
  "id": "BTC-31OCT26-90000-C",
  "bid": 12000, "ask": 12600, "mark": 12300,
  "oi": 420, "vol24h": 88,
  "iv": 0.58, "iv_src": "venue",          // venue | computed | null
  "greeks": { "delta": 0.42, "gamma": 0.0000021, "vega": 1180, "theta": -940 },
  "flags": ["wide"]                        // stale | crossed | no_bid | wide | zero_oi
}
```

> **Why the forward, not spot.** Every vol calculation uses the forward `F` per expiry, derived from
> perp/futures basis. INR-margined crypto options carry a non-trivial basis; fitting a smile in `ln(K/spot)`
> smears that basis into apparent skew and manufactures mispricing signals that aren't there.

### 1.3 `BucketPoint` — the rolling 90d IV baseline (signal #2)

The spec says "90d IV history per contract bucket", and bucketing is not a convenience here — it is
required for correctness. **Individual contracts do not live 90 days.** A weekly option exists for 7 days,
so "IV percentile vs its own 90d history" is undefined at the contract level. Buckets persist; contracts
roll through them.

```jsonc
{
  "ts_ms": 0, "underlying": "BTC",
  "tenor_bucket": "3-9d",       // 0-2d | 3-9d | 10-30d | 31-90d   (edges configurable)
  "delta_bucket": "c25",        // p15 | p25 | atm | c25 | c15
  "iv": 0.556,
  "src": "deribit",             // coindcx | deribit  → drives the "backfilled" badge
  "n_points": 9                 // contracts backing the interpolation
}
```

> **Critical detail:** bucket IV is the **fitted smile evaluated at the target delta**, never "whichever
> contract was nearest". A nearest-contract series jumps every time the front contract rolls or a new strike
> lists, and those jumps become fake percentile extremes. Evaluating the fitted curve at a fixed delta gives
> a continuous constant-maturity series — the same construction Deribit's DVOL and standard CMV surfaces use.

### 1.4 `SmileFit` — per underlying × expiry × snapshot

```jsonc
{
  "ts_ms": 0, "underlying": "BTC", "expiry_ms": 0, "F": 8530000, "T_years": 0.0192,
  "a": 0.0031, "b": -0.0008, "c": 0.0042,   // w(k) = a + b·k + c·k²
  "n": 11,
  "rmse_vol": 0.011,                        // in vol points
  "mad_sigma": 0.009,                       // robust residual sigma → z denominator
  "hat": [0.31, 0.12],                      // leverage per point → leave-one-out residuals
  "arb": [],                                // convexity_violation | calendar_violation
  "degraded": false                         // true → signal #3 weight forced to 0
}
```

### 1.5 `Signal` — what a card renders

```jsonc
{
  "ts_ms": 0, "id": "BTC-31OCT26-90000-C", "side": "buy", "score_10": 7.4,
  "z":       { "iv_rv": -1.8, "iv_pctile": -1.2, "smile_resid": -2.1,
               "term_slope": 0.3, "theta_eff": -0.6, "funding_tilt": 0.0 },
  "contrib": { "smile_resid": -0.63, "iv_rv": -0.45 },   // z × weight → dominant signal is derived, not guessed
  "why":     "Priced 2.1σ below its own expiry's vol curve — the cheapest strike on the smile.",
  "why_not": "Open interest is 40% below the chain median, so the discount may be a stale quote, not an edge.",
  "econ":    { "premium_inr": 12300, "breakeven": 9023000, "max_loss_inr": 12300,
               "theta_day_inr": -940, "req_move_pct": 6.1, "dte_days": 7.2, "tax_drag_inr": 0 },
  "structure": null,        // SELL side: always a defined-risk vertical (see §4)
  "quality":   { "backfilled": true, "iv_src": "computed", "spread_pct": 4.9,
                 "oi": 420, "degraded_fit": false }
}
```

### 1.6 `Rejection` + `Perf` — guardrail support

`Rejection` is retained per contract per scan so **"why isn't X here?"** answers from the recorded pipeline
result, not a re-derivation that might disagree with what actually ran:

```jsonc
{ "ts_ms": 0, "id": "...", "stage": "filter",       // filter | score | structure
  "reason": "spread_pct 11.2% > 8% limit",
  "detail": { "spread_pct": 11.2, "limit": 8 } }
```

`Perf` powers the always-on-screen honesty metric (§4):

```jsonc
{ "window_days": 90, "n_signals": 214, "hit_rate": 0.47, "avg_ret_pct": -1.2,
  "by_signal": { "smile_resid": { "n": 88, "hit_rate": 0.55, "avg_ret_pct": 2.1 } },
  "last_updated_ms": 0 }
```

---

## 2. Smile fitting — recommended approach

### 2.1 Coordinates

Fit **total implied variance against log-moneyness**, per expiry:

```
k = ln(K / F)          log-moneyness on the forward
w = σ²·T               total implied variance
```

Both choices are load-bearing: `k` normalizes across underlyings and price levels, and `w` is the
coordinate in which no-arbitrage conditions and calendar comparisons are naturally expressed.

### 2.2 Model: weighted quadratic — **not** SVI

```
w(k) = a + b·k + c·k²
```

Three parameters, closed-form weighted least squares (3×3 normal equations via Cramer's rule — no solver,
no dependency).

**Why not SVI or SABR, despite being the industry default.** After the hard filters (spread < 8%, OI floor,
|delta| 0.15–0.70) a CoinDCX expiry will realistically leave **6–15 usable strikes**. SVI has 5 parameters
and SABR 4. Fitting 5 parameters to 8 points drives residuals toward zero — and **the residual is signal
#3**. An overfitted curve doesn't just add noise, it silently deletes one of the six signals while still
reporting a number. A 3-parameter curve on 10 points leaves genuine residual structure to measure. Same
reason a cubic spline is disqualified: it interpolates, so its residual is identically zero.

### 2.3 Weighting

```
weight_i ∝ vega_i² / (spread_i + ε)
```

ATM contracts carry the most vega and the tightest spreads, so they anchor the curve; wide-spread wings
can't drag it. Without this, the single widest quote in the chain bends the fit and every other contract
inherits a fake residual.

Then **one IRLS pass with Huber weights** (threshold 1.5 × MAD) so a single fat-fingered quote can't set
the curve it is then measured against.

### 2.4 Residuals — leave-one-out, robustly scaled

```
r_i      = w_observed,i − w_fit(k_i)
r_LOO,i  = r_i / (1 − h_ii)                    // h_ii = leverage from the closed-form hat matrix
z_smile  = r_LOO,i / (1.4826 · MAD(r))
```

Two deliberate choices:

- **Leave-one-out.** With ~10 points and 3 parameters, each contract meaningfully influences the curve it is
  scored against — a mispriced contract partly validates its own price. The studentized form removes that
  self-influence at no extra fitting cost.
- **MAD, not standard deviation.** One outlier inflates σ and mutes every other signal in the chain, so the
  screener goes quiet exactly when a real dislocation appears.

### 2.5 Arbitrage sanity and degenerate chains

- Enforce `c ≥ 0`; refit with `c = 0` if violated (crude butterfly sanity).
- Check calendar monotonicity: `w(k, T₁) ≤ w(k, T₂)` for `T₁ < T₂`. Violations are **flagged, not traded** —
  in a thin market this is a stale quote far more often than a genuine arbitrage.
- `n < 5` → linear fit (`c = 0`); `n < 3` → flat vega-weighted mean IV. Either sets `degraded: true`, which
  forces signal #3's weight to **0** for that expiry rather than emitting a confident-looking noise number.

### 2.6 Term structure (signal #4)

Compare this expiry's ATM **total variance** to a linear interpolation of its neighbours' ATM `w` in `T` —
interpolating in variance-vs-time, not IV-vs-time, which is the correct no-arb comparison and avoids
manufacturing a signal purely from the shape of the √T mapping.

### 2.7 IV and greeks when the venue doesn't publish them

**Black-76** on the forward (correct for European, cash-settled, futures-style crypto options):
Newton–Raphson on vega, bisection fallback, bracketed to σ ∈ [1%, 500%], with explicit no-solution handling
for quotes below intrinsic. Greeks analytic from the same model. Delta is needed for the hard filter anyway,
so this path is required regardless of whether the venue publishes IV.

---

## 3. Signals and weights

All weights live in `config.json` under `optionsRadar.weights`; none hardcoded. Proposed starting values
(sign convention: **negative z = cheap = buy**; the sell side flips the composite, not the individual z's):

| # | Signal | Default weight | Notes |
|---|--------|---------------:|-------|
| 1 | IV − 30d realized vol | 0.30 | The core carry signal |
| 2 | IV percentile vs own 90d bucket history | 0.20 | Backfill-flagged until 90d of local data |
| 3 | Smile residual (LOO) | 0.25 | Forced to 0 when the fit is `degraded` |
| 4 | Term-structure slope | 0.10 | |
| 5 | Theta/day ÷ expected move over holding period | 0.15 | Penalizes bleed |
| 6 | Funding + basis directional tilt | 0.00 | **Default off** per spec; user-toggleable |

Composite → z-blend → squashed to a 0–10 score. `contrib` (z × weight) is stored per signal so the
**WHY** sentence names the actually-dominant driver instead of a guess, and **WHY NOT** is generated from
the strongest opposing contribution *or* the worst quality flag — enforced non-empty in code, with a unit
test asserting no signal can serialize with a blank `why_not`.

---

## 4. Guardrails (implementation notes)

- **No naked shorts.** Every SELL is converted to a vertical spread: the short leg plus the next OTM strike
  in the same expiry that independently passes the liquidity filters. Max loss =
  `(width × contract_size) − net_credit`, displayed in INR. **If no valid protective wing exists, the signal
  is suppressed entirely** rather than shown as a naked short — an unhedgeable short is not a tradeable
  recommendation.
- **Persistent performance.** Rolling 90d hit rate and average return per signal render on-screen at all
  times, including when negative, sourced from the backtest/forward-record store (§6). Never hidden, never
  collapsed behind a toggle.
- **"Why isn't X here?"** Contract lookup returns the recorded `Rejection` — exact failing filter with the
  measured value and the limit, or the score that fell short of the cut, or the missing protective wing.
- **Analysis, not advice.** Persistent label; no one-tap execution from a card.
- **VDA tax drag** shown in every P&L projection. Default model (configurable, and explicitly an estimate):
  30% on gains + 4% cess ⇒ **31.2% effective**, **no offset of losses** against other income and no carry
  forward, plus an optional 1% TDS toggle. The asymmetry matters more than the rate: expected value is
  `p·win·(1−0.312) − (1−p)·loss`, so a 50%-hit-rate strategy with symmetric gross payoffs is **negative**
  after tax. The screener states this rather than quietly reporting pre-tax edge.

> Tax treatment of crypto **derivatives** in India is genuinely unsettled — §115BBH addresses VDA transfers,
> while derivatives may instead be business/speculative income. The model is therefore configurable and
> labelled an estimate, not tax advice.

---

## 5. Open decisions (need sign-off)

1. **CoinDCX options feed** — no public chain endpoint is documented and this environment can't reach the
   API to probe. Need either the authenticated endpoint + a sample payload, or agreement to build against
   the adapter interface with Deribit live and CoinDCX behind fixtures.
2. **Where 90d history lives.** Render/DigitalOcean app filesystems are **ephemeral** — a redeploy wipes
   flat files. `setups.json` already has this exposure; for a 90d IV baseline it is fatal, because the
   percentile signal silently degrades to "backfilled" after every deploy. Options: SQLite on a persistent
   volume, a hosted Postgres/Supabase, or accept re-backfilling from Deribit on every boot.
3. **Smile model** — confirm the weighted-quadratic + LOO recommendation over SVI.

---

## 6. Deliverables (build order, once the above are settled)

1. **Vol math core** (`options/vol.js`) — Black-76 pricing, IV solve, greeks, smile fit, LOO residuals.
   Unit tests via built-in `node:test`: round-trip price→IV→price, put-call parity, known-value fixtures,
   monotonicity of vega, degenerate-chain fallbacks, and LOO correctness against a brute-force refit.
2. **Scoring service** (`options/score.js`) — pluggable weights from config, z-blend, WHY/WHY-NOT generation,
   spread construction, rejection recording.
3. **Backtest harness** (`options/backtest.js`) — replays stored `Snapshot` tape, entry/exit at
   **mark ± half-spread**, reports hit rate and average return **attributed by signal**, with sample sizes
   and confidence intervals so a 12-trade sample can't masquerade as an edge. Handles expiry settlement and
   spread structures, and reports gross and post-VDA-tax.
4. **Signal card UI** — new panel, consistent with the existing Quick Trades / Volume Movers components,
   with the persistent performance strip and the "why isn't X here?" lookup.

---

## Addendum — direction is the thesis, mispricing is the selector

**Revision after review.** The original brief specified ranking by mispricing and explicitly *not*
forecasting direction, which is what §1–§4 above describe and what was built. Reviewing the result
against the actual user — someone who does not know how options work — exposed the gap: a mispricing
score is a true statement that **cannot be acted on**. "This call is 2.1σ cheap on the smile" never
tells you what you are betting on, so it cannot function as a guiding star.

The two questions are different and both are needed:

| Question | Answered by |
|---|---|
| *What am I betting on?* | The app's existing directional engine on the underlying |
| *Which contract expresses that best?* | The mispricing maths in §2 |

So the pipeline gained a **direction gate** between scoring and output:

- The thesis comes from the **same signal engine that drives Quick Trades**, so an options card can
  never contradict the rest of the dashboard.
- **No clear trend ⇒ no cards for that underlying**, with the reason stated on screen. Surfacing a
  cheap contract with no thesis is how a beginner ends up holding a lottery ticket they cannot explain.
- Only positions that profit if the view is right survive: bullish → long calls / short put spreads;
  bearish → long puts / short call spreads. Anything betting the other way is rejected with a plain
  reason, visible through the "why isn't X here?" lookup.
- `requireDirectionalView: false` restores pure relative-value mode for expert use.

The mispricing engine is unchanged — it simply moved from being the *reason to trade* to being the
*contract selector*, which is what it is actually good at.

### Plain-English layer (`options/plain.js`)

Every surfaced card is translated into: the bet, the literal instruction, the cost, the win condition,
the loss condition, the daily time cost, and a payoff table at expiry. Two deliberate choices:

- **Payoffs are quoted at expiry**, because at-expiry value is arithmetic a beginner can verify by
  eye (price minus strike). A mid-life mark depends on vol and time decay and cannot be checked.
- **An honest base rate, not a probability.** Each card states how often the underlying has *actually*
  made the required move over the required window, measured from real history, and labels it as a
  past base rate rather than a prediction. This is the single most useful reality check available: a
  card asking for a 6% move in 10 days that has happened 2% of the time should say so.

A test asserts that no user-facing string contains "theta", "vega", "delta", "implied vol", "skew",
"smile", "σ" or "IV".

### Backtest consequence

The direction gate applies during replay too, or the backtest would measure a screener that does not
exist. `replay()` prefers a caller-supplied view (the real engine) and otherwise derives a point-in-time
trend from the tape's own prices; either way the source is reported in `assumptions.direction_view`.
