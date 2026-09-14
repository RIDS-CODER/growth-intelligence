# 📐 Options (F&O) — how it works

Index options on **NIFTY, BANKNIFTY, SENSEX** (plus FINNIFTY, MIDCPNIFTY, BANKEX where they are listed).

This guide is in three parts. Read part 1 to use it. Read part 2 when a number surprises you. Read
part 3 if you are changing the code.

---

# Part 1 — Using it

## Opening it

Click **📐 Options (F&O)** in the button row. The panel needs two things you have already set at the
top of the page:

| Field | Where | What it does |
|---|---|---|
| **Capital ₹** | top risk bar | every position size, every rupee figure, and the whole "can I trade this" verdict scales off it |
| **Risk / trade %** | top risk bar | the most you are willing to lose on one trade |

They come from the shared risk bar on purpose — so the options panel can never disagree with the
rest of the dashboard about how much money is in play.

Then pick, inside the panel:

- **Index** — NIFTY, BANKNIFTY, SENSEX…
- **Expiry** — nearest first, with days remaining
- **My view** — Bullish / Bearish / Expecting a big move / Expecting it to stay put / No view
- **Target level** *(optional)* — where you think the index is going. Fill this in; it unlocks the
  single most useful check in the panel (see *"Your target"* below).
- **allow naked shorts** — off by default. Leave it off unless you know exactly why you are turning
  it on.

## Reading the top row

| Tile | What it means |
|---|---|
| **Forward** | what the market thinks the index is worth **at expiry**. Not the spot price — see part 2. |
| **ATM implied vol** | the volatility the market is charging, at the money |
| **Implied move** | how far the market expects the index to travel by expiry, in points and % |
| **Time left** | calendar days to the 15:30 expiry |
| **Lot size** | read live from the exchange, never hardcoded |
| **Skew (25Δ)** | how much more downside protection costs than upside |

**The implied move is the number to internalise.** If NIFTY's weekly straddle says 350 points and
your target is 500 points away, you are betting the market is wrong about *direction* **and** about
*how far it can travel*. That is two bets, and you are paying for both.

## "Is this volatility cheap or expensive?"

A verdict — cheap / leaning cheap / fair / leaning expensive / expensive — with:

- **confidence** (good / partial / thin) and **what % of the evidence** it rests on
- the specific evidence used, listed out
- any caveats, including when a scheduled event is distorting things

**Low confidence is not a footnote.** A verdict at "thin, 35% of the evidence" is a first
impression, not a finding, and the panel says so in those words.

### What feeds it

| Input | Needs | Available |
|---|---|---|
| Term structure | nothing but today's board | **day one** |
| Implied move vs the index's actual moves | the index's closes | **day one** |
| IV percentile | a history of implied vol | day one for NIFTY (via India VIX), ~3 months for the rest |
| IV − RV gap percentile | a history of the gap | ~3 months |

So early on the verdict leans on the first two and says its coverage is partial. That is correct
behaviour, not a gap being papered over.

## "What to trade"

If something fits, you get: the structure, its legs, size in lots, capital needed, worst case in
rupees **and as a % of your capital**, round-trip cost, breakevens, and net delta/theta.

### If nothing fits — which is common

You will see, in rupees:

- the **cheapest structure** on the board and what one lot of it risks
- the **capital you would need** at your current risk setting
- the **shortfall**
- the **risk % you would have to accept** to take it at your current capital

> **Worked example.** ₹3,00,000 capital, 2% risk budget (₹6,000). The cheapest thing on the NIFTY
> weekly is a Bull Call Spread risking ₹7,680 a lot. You need **₹3,84,018** at 2% risk — ₹84,018
> more than you have — or you accept **2.6%** risk on the trade. There is no third option: index
> options do not come in fractions of a lot.

This is the honest answer for most retail accounts on NIFTY and it is given as much room as a
recommendation would be. **A ₹50,000 account cannot trade NIFTY options at a 2% risk discipline.**
The panel tells you that instead of handing you a trade you cannot hold.

**The way around it is a spread, not more risk.** The same ₹50,000 that cannot fund one outright
call can often fund a vertical spread, because the spread's worst case is a fraction of the
premium. The panel ranks spreads first for exactly this reason.

## The trade plan

**Entry** — a limit price per leg, set inside the spread rather than crossing it, plus a
"never pay above" ceiling. Multi-leg structures carry a warning to place them as one basket order:
legging in one at a time on a moving market is how a defined-risk structure becomes an accidental
naked short.

**Stop** — given twice, on purpose:

- the **index level** at which your thesis is dead
- the **premium** that level implies, so you can actually place the order

> Why both: *"place the stop on the premium at about 16.64 — but understand it represents the index
> reaching 23563. If the premium reaches that level WITHOUT the index moving there, time and
> volatility took it, not your thesis."*

A flat "exit at −30%" on a premium is mostly a decay detector. A long weekly can shed 30% over a
weekend with the index unchanged, and you would be closing a position for a reason that has nothing
to do with being wrong.

**Targets** — at half, one, and 1.5× the implied move, each with the premium it implies and the
**net** rupee P&L after costs.

**Your target** *(if you filled it in)* — checked against the implied move, with one of three
readings:

- inside 60% of it → *"you are not relying on a volatility surprise. That is the comfortable case."*
- inside 100% → *"achievable, but you are paying for most of the move you expect to capture."*
- beyond it → *"you are betting the market is wrong about direction AND about how far it can travel.
  Those are two bets and you are being charged for both."*

**Time stop** — a date. Almost every options plan omits this and it is why most of them fail
quietly. A stock position can be wrong for a month and recover; an option cannot. For a long
position the stop lands at about half the remaining life: *"if the index has not moved by then this
position has already surrendered 20% of its premium to time, and what remains decays faster every
day. Waiting for it to come back is paying rent on a view that has not happened."*

**Exit rules**, in priority order — target, stop, time stop, the post-event volatility crush, and
the expiry decision.

**What kills this trade** — explicitly, including the ones that are not about direction: implied
vol falling while the index goes nowhere, the skew inverting against you, and — on anything
unbounded — *"the market reopens past your level, not at it."*

## Before you place anything

Three things the panel flags and you should act on:

1. **Cost rates are unverified.** Open one real contract note and compare it against
   `/api/fno/costs?price=100&qty=75`. If they match, set `"verified": true` in `fno-costs.json` and
   the warning clears. If they do not, edit the rate that is wrong. **This is the single highest-value
   thing you can do to this build** — every net P&L figure depends on it.
2. **Margin is an estimate.** For anything you sell, check your broker's margin calculator. SPAN is
   a risk model the exchange re-runs several times a day, not a formula anyone can reproduce.
3. **Data quality.** If the panel says the chain's forward is *suspect*, or that most strikes are
   quoting off last-traded prices, wait for a two-sided market. Entry is blocked outright when the
   chain is unusable.

---

# Part 2 — Why the numbers are what they are

## The forward, not the spot

Textbook Black-Scholes needs the risk-free rate **and** the dividend yield. For NIFTY that second
one is the blended dividend of fifty companies over the contract's life — unobservable, and being
wrong about it bends every delta on the board.

So this engine does not use it. Put-call parity is a **no-arbitrage identity** — it holds whatever
the volatility surface looks like and whatever the dividends are:

```
F = K + e^(rT) × (Call − Put)
```

The market has already priced carry into that call-minus-put spread. Reading the forward off the
chain means the engine inherits the market's own assumptions instead of imposing a guess. The
interest rate then survives only as a discount factor, where being wrong by 2% moves a weekly
premium by about **0.04%**.

The forward is taken as the **median** across near-the-money strikes, so one stale leg cannot drag
the whole surface with it.

## Why the cheap option is the expensive one

Brokerage on options is a **flat ₹20 per order** — there is no percentage alternative at a discount
broker (futures are different). Everything else scales with turnover. So cost as a share of your
position explodes as the option gets cheaper.

One lot of NIFTY (75), round trip:

| Premium | Cost | Move needed just to break even | How much is flat brokerage |
|---|---|---|---|
| 400 | ₹111 | 0.37% | 43% |
| 200 | ₹83 | 0.55% | 57% |
| 100 | ₹69 | 0.92% | 69% |
| 50 | ₹62 | 1.65% | 76% |
| 20 | ₹58 | **3.83%** | 82% |
| 10 | ₹56 | **7.48%** | 84% |
| 5 | ₹55 | **14.77%** | 85% |

The cheap far-out-of-the-money weekly — the one that looks like the low-risk way to express a view —
starts nearly **15% under water**. It is not a lottery ticket with good odds; it is a lottery ticket
with a fee.

**Trading more lots fixes the percentage, not the risk.** The same 20-point option goes from 3.83%
at one lot to 0.81% at twenty-five, because the flat fee amortises. That is a real effect and it is
why the panel reports what limited your size.

## The expiry decision, against the folk rule

The received wisdom is *"exercise is taxed at 0.125% and a sale at 0.1%, so always square off."*
The arithmetic disagrees once there is no time value left. Per rupee of value:

```
square off :  0.100% STT + 0.035% exchange + GST on that  ≈ 0.142%
              ... plus another ₹20 of brokerage, plus the spread
let expire :  0.125% STT on intrinsic, and nothing else
```

Selling saves 0.025% of intrinsic in STT and hands most of it straight back. On a 20-lot deep
in-the-money position that is a **₹375 saving against ₹729 of extra charges — expiring wins by ₹354.**

So the engine computes both routes and reports the **crossover**: how many points of time value must
still be in the premium for selling to be worth it.

| Position | Crossover |
|---|---|
| 1 lot | 0.54 points |
| 5 lots | 0.28 points |
| 20 lots | 0.24 points |
| 50 lots | 0.23 points |

Above that, square off. Below it, let it settle. Usually there *is* more than a quarter-point of
time value left, so squaring off is usually right — but now you know when it is not, and why.

### The trap that no longer exists, and the one that does

Before **September 2019**, STT on an exercised option was charged on the **full settlement value**
— strike × quantity — which on a NIFTY contract meant thousands of rupees on an option worth a few
hundred. That is where the stories of accounts destroyed by letting a profitable option expire come
from. **It was amended.** The charge is now on intrinsic value only. Repeating the old warning is
its own kind of inaccuracy.

What is **still** catastrophic: single-stock options in India are **physically settled**. Letting
one expire in the money obliges you to take or give delivery of the full share value — many times
the premium for one lot, with broker penalties if the account cannot fund it. Index options are
cash settled, so this build is not exposed to it, and the warning is wired in anyway so that
pointing the engine at stock options later cannot inherit a model that assumes cash settlement.

## What the volatility read refuses to say

**"Implied vol is above realized vol, therefore options are expensive"** is the most common piece of
options analysis in circulation and it is close to worthless.

Implied exceeds subsequently-realized volatility roughly **four sessions in five**. That gap is the
**variance risk premium** — the compensation option sellers are paid for carrying gap risk. It is a
structural feature of the market, not an anomaly. Treating it as a signal means saying "sell
premium" in every market state, including the ones that end accounts.

So with no history to place it against, this engine offers **no verdict** on the gap, and the
combined score records it as *missing evidence* rather than letting it in as bullish evidence. What
matters is whether the gap is unusual **for this instrument**, which needs a history of the gap and
not one observation of it.

## Where the volatility history comes from

The platform has never stored option data, so an IV percentile would normally be a quarter away.
But **India VIX *is* 30-day NIFTY implied volatility**, and `intel/macroData.js` is already fetching
six months of it for the Market Health panel. So NIFTY gets a usable percentile on day one from a
feed that was already running.

It is a real but imperfect substitute — VIX is constant-maturity 30-day, the weekly you are trading
is not — and it is labelled everywhere it appears. **BANKNIFTY and SENSEX have no such index and are
told so**, rather than quietly borrowing NIFTY's.

Meanwhile the engine records one at-the-money reading per underlying per session to
`fno-iv-history.jsonl`. After about 60 sessions it switches to its own data automatically, for every
underlying.

## IV rank vs IV percentile

Both are shown. They disagree, and the disagreement is the point.

- **IV Rank** = (today − year's low) / (year's high − year's low). One panic day sets the high for a
  year, after which every reading is measured against an afternoon that is long gone. A market can
  read "IV Rank 20" for eight months without ever being cheap.
- **IV Percentile** = the fraction of days that were lower than today. It ignores the extremes and
  answers the question you are actually asking.

The verdict leans on **percentile**. Rank is shown because it is what most broker platforms display,
and a number that disagrees with your terminal needs to be visible, not hidden.

## Realized volatility, and why the overnight gap matters

Four estimators are computed. Two are worth knowing about:

- **Close-to-close** — the convention implied vol is quoted against, so it is the headline. Also the
  least informative: a day that travelled 2% and came back flat contributes zero.
- **Yang-Zhang** — the only one that captures **overnight gaps**.

NIFTY is repriced every morning by whatever happened in New York while Mumbai slept. An estimator
blind to that jump systematically understates how much this index moves — and that gap is precisely
the risk a long option is paid for and a short option is destroyed by, because **it happens before
the market opens and cannot be stopped out of**. When Yang-Zhang runs well above close-to-close, the
panel says so.

## Skew, normalised

The 25-delta risk reversal — what downside protection costs over upside — is reported both raw and
**normalised by `atmIv × √T`**.

The normalisation is not cosmetic. The 25-delta strikes sit at roughly ±0.674 σ√T, so the band they
span runs from **0.46%** of the index on a one-day option to **4.58%** on a quarterly — a tenfold
range. A fixed threshold on the raw number would be unreachable on a weekly during a genuine panic
and would trigger on a quarterly in a dead market. The normalised slope means the same thing at
every maturity, so a weekly and a quarterly reach the same verdict about the same market.

## Term structure

Normal is **contango** — further-dated options carry higher implied vol, because more can go wrong
in more time.

**Backwardation** — the front expiry richer than the back — means the market has identified
something specific and near: an event, a decision, a result. It is a reliable signal precisely
because it is a price rather than an opinion, and it is the clearest warning available that selling
short-dated premium here is selling insurance against a risk everyone can see coming.

It needs no history at all, which makes it the most useful thing in the volatility section on day one.

## Max pain, PCR and OI walls

Computed, and labelled. They are watched by enough people to matter, which is the honest argument
for showing them; the evidence that any of them predicts anything on its own is weak. Max pain moves
whenever open interest moves and says nothing about the path in between. A put-call ratio of 1.1
means nothing until you know whether this chain usually runs at 0.7 or 1.4.

The skew is different — it is a **price**, not a folk indicator.

---

# Part 3 — How it is built

## Modules

```
fno/
  bs.js           pricing, Greeks, implied vol, expected move, touch odds
  costs.js        brokerage/STT/GST/stamp/exchange, slippage, the expiry decision
  instruments.js  contract master → underlying → expiry → strike, and the lot size
  chain.js        forward from parity, vol surface, skew, OI, liquidity, data quality
  vol.js          realized vol, IV percentile, term structure, the combined verdict
  strategy.js     payoff engine, capital gating, position sizing, structure ranking
  signal.js       entry limits, stops, targets, the time stop, exit rules
  index.js        the orchestrator
fno-costs.json    editable rate table — YOU maintain this
```

Every module is a pure function of what came before it. `fno/` never requires `server.js` — that
would be circular — and dependencies (`quotes`, `candles`, `macroData`, `calendar`) are injected,
the same pattern `intel/` and `paper.js` use. There is a test that enforces it.

## The pass, in order

```
instruments  →  which contracts exist, and the lot size everything scales off
chain        →  the forward from parity, then the vol surface built ON that forward
vol          →  cheap or expensive, from the chain's ATM IV + the index's own history
strategy     →  what to trade, given that read, your capital, your risk budget
costs        →  charged into every candidate BEFORE any of them is ranked
signal       →  the plan for whichever one won
```

## What is reused rather than rebuilt

| From | Used for |
|---|---|
| `intel/macroData.js` | India VIX → NIFTY's IV percentile on day one |
| `intel/calendar.js` | scheduled event risk (CPI, FOMC, RBI) |
| `intel/stats.js` `scoreParts` | weighted scoring that renormalises over available evidence |
| `server.js` `upstoxCandles` | daily OHLC for realized volatility |

## Endpoints

| Path | What it returns |
|---|---|
| `/api/fno?u=NIFTY&capital=500000&risk=0.02&view=up&target=24400` | the full pass |
| `/api/fno/list` | underlyings, expiries, lot sizes |
| `/api/fno/expiry?type=CE&strike=24000&settlement=24300&qty=75` | settle or square off, for your size |
| `/api/fno/costs?price=100&qty=75` | itemised round-trip cost |
| `/api/fno/health` | IV history accrued, rate vintage, last error |

Optional on `/api/fno`: `expiry=<ms>`, `naked=1`, `force=1`.

## Design rules this code follows

1. **A number that cannot be measured is reported as unavailable, with its reason.** Never a zero,
   never a dash. A missing feed must widen the uncertainty, not score as evidence against.
2. **Nothing that the exchange revises is hardcoded.** Lot sizes and expiry days are read from the
   master on every load. A contract with no readable lot size is **dropped and counted**, because
   every position size and rupee of P&L scales linearly off it.
3. **Estimates are labelled as estimates.** Margin, assumed spreads, and unverified rates all carry
   that label into the UI.
4. **Certainty is tiered and never blended.** Capital required is *exact* for a net debit,
   *near-exact* for a defined-risk spread, an *estimate* for a naked short.
5. **Unbounded loss is detected, not assumed.** The payoff engine reads the tail slopes rather than
   trusting a structure's name. An iron condor missing one wing still looks like a condor — and the
   engine notices it has no floor.

## Testing

442 tests, of which ~140 are F&O. The approach is **inversion and generation** rather than fixtures:

- Build a chain from a chosen forward and volatility smile, price every option, then require the
  analytics to recover the inputs **from the prices alone**.
- Synthesise a price series with a chosen volatility and require each estimator to recover it.
- Hand-worked payoffs for every structure: a 24000/24200 bull call spread bought for 60 makes 140
  and loses 60, and the engine has to agree.

The pricing core is proven four independent ways: published reference values, **Simpson quadrature
of the payoff expectation** (which shares no code path with the closed form), no-arbitrage
identities, and central differences for every Greek across a grid of moneyness, maturity and vol.

```bash
npm test                              # everything
node --test test/fno-*.test.js        # F&O only
```

## Known limitations

- **Nothing here has been run against live Upstox data.** The build sandbox's proxy returns 403 for
  every outbound market endpoint, including `assets.upstox.com`. The instrument and quote parsers are
  written tolerantly and — more importantly — **report what they failed to find**, so a renamed field
  surfaces as a warning rather than an empty options tab. Verify on first live run.
- **The instrument-master filename could not be verified**, so the loader does not bet on one. See
  *Troubleshooting* below.
- **Cost rates are dated and unverified.** See part 1.
- **Margin is a percentage-of-notional estimate.** SPAN is a portfolio risk model, not a formula.
- **No historical option backtesting.** Historical chain data is not available at retail, so
  structures are scored forward from recorded snapshots rather than backtested. This was a
  deliberate choice over fabricating a backtest.
- **Repricing does not model vol-of-vol.** Stops and targets are repriced under both sticky-strike
  and sticky-delta and the gap is shown as the error bar. Neither captures fixed-strike vols *rising*
  in a sharp selloff, which is real — so a long put's value at a downside stop is, if anything,
  understated. Fitting it needs history the platform does not have, and naming the gap beats
  inventing a number for it.
- **Calendar spreads are not proposed.** The term structure is measured and reported; trading it
  needs two expiries priced as one structure, which the payoff engine supports but the catalogue
  does not yet offer.

---

# Troubleshooting

## "No options read available — could not reach any F&O instrument master … HTTP 403"

**First, look at the Stocks tab.** It downloads `NSE.json.gz` from the same host
(`assets.upstox.com`) every single day. That one observation separates the two possible causes,
and the status code cannot:

| Stocks tab | What it means | What to do |
|---|---|---|
| **populated** | the host is reachable; none of the candidate files contained index derivatives | a schema change — see below |
| **also empty** | `assets.upstox.com` is genuinely blocked from this server | firewall / proxy / DNS on the droplet |

**Why 403 and not 404.** `assets.upstox.com` is object storage. When bucket listing is denied —
which is the default — a request for a key that *does not exist* is answered **403 Forbidden**, not
404. So "you are blocked" and "there is no such file" are indistinguishable from the response alone.
That is why the loader does not depend on any single filename.

**What the loader does instead.** Each exchange has a chain of candidates, tried in order, and a
candidate only counts when it actually yields contracts — a file that downloads successfully but
contains no derivatives is rejected and the chain keeps walking:

```
NSE:  NSE_FO.json.gz  →  NSE.json.gz  →  complete.json.gz
BSE:  BSE_FO.json.gz  →  BSE.json.gz  →  complete.json.gz
```

The second entry in each chain is the file this codebase already downloads successfully every day,
which makes the fallback proven rather than hopeful. `NSE.json.gz` is very likely where the
derivatives actually live: `server.js` filters `segment === "NSE_EQ"` out of it, and there would be
nothing to filter if that file held only equities.

Whichever source worked is reported in the panel's **Data quality** section, and a fallback raises a
visible notice. After your first successful live run this stops being a guess — check there to see
which filename Upstox actually serves.

**If Stocks loads but options still fail**, the panel's warnings will say which candidates were tried
and why each was rejected (`downloaded 94,312 rows but none are NSE_FO contracts` means the file
exists but the schema moved). Send that line along and it is a one-line fix.

## "The quote feed returned nothing for this expiry"

The contract master is a *public* file; the **quotes are not**. This message means the master loaded
but `/v2/market-quote/quotes` came back empty. Check, in order:

1. **Are you logged in?** The Upstox token expires daily. The login bar at the top of the dashboard
   says.
2. **Is the market open?** Outside 09:15–15:30 IST the option chain has no live two-sided quotes.
3. If both are fine, `/api/fno/health` reports the last error verbatim.

## Everything loads but the panel says the chain is "suspect"

Near-the-money strikes disagree about the forward by more than 0.2%, which means the legs are not
trading together — normal in the first minute after the open, and a reason to wait. Entry is blocked
outright when the chain is unusable. This is working as intended, not a fault.
