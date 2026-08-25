# Growth Intelligence Platform — PRO (Upstox real-time)

Your personal buy/sell cheatsheet, now powered by **real-time Upstox prices** that match your broker terminal.

It scans liquid Indian stocks, ETFs, and indices (plus crypto via CoinGecko), ranks the best long & short
setups, and for each one shows: **ACTION NOW** (buy now / wait / exit), entry zone, stop, three targets with
exact % returns, risk:reward, holding period, position size for your capital, reasons for/against, and
invalidation — exportable to Excel.

---

## ✅ Try it right now (DEMO — no setup)

The app ships in **DEMO mode** (synthetic data) so you can see it working immediately.

1. Install **Node.js** if you don't have it: https://nodejs.org → download **LTS** → install.
2. **Double-click `START-HERE.command`.**
   - First time only: macOS may block it. **Right-click the file → Open → Open.** (You only do this once.)
3. Your browser opens the dashboard with sample data.

When you're happy with it, switch to real Upstox prices below.

---

## 🔑 Switch to REAL-TIME Upstox prices (one-time, ~10 min)

### Step 1 — Create a free Upstox API app
1. Log in at **https://account.upstox.com/developer/apps**
2. Click **Create New App** (Upstox API is free).
3. Fill in:
   - **App name:** anything (e.g. "Growth Intelligence")
   - **Redirect URL:** `http://localhost:5180/callback`  ← must be exactly this
4. After creating, copy the **API Key** and **API Secret**.

### Step 2 — Put your keys in the app
1. Open **`config.json`** (right-click → Open With → TextEdit).
2. Replace the placeholders and turn off demo:
   ```json
   {
     "upstoxApiKey": "your-api-key-here",
     "upstoxApiSecret": "your-api-secret-here",
     "redirectUri": "http://localhost:5180/callback",
     "port": 5180,
     "demo": false
   }
   ```
3. Save the file.

### Step 3 — Run & log in
1. **Double-click `START-HERE.command`** (it restarts with your keys).
2. In the dashboard, click **“Login with Upstox →”**, sign in, approve.
3. You're back on the dashboard with **live prices**. Done.

---

## 🔁 Daily routine (15 seconds)

Upstox (like every broker) **expires the access token every morning** for security — there's no way around
this. So each trading day:

1. Double-click `START-HERE.command`.
2. Click **“Login with Upstox”** once.

That's it — live prices for the rest of the day.

---

## 🔥 Volume Movers — what is actually moving right now

Click **🔥 Volume Movers** on the dashboard to see what has the **biggest volume-backed movement right
now**, ranked by a 0–100 **volume score** (shown as a 🔥 badge on **both** panels).

**⚡ Quick Trades, 🔥 Volume Movers and 📌 Tracked setups all work across four asset classes** — pick
one with the tabs at the top of either panel:

| | Notes |
|---|---|
| **₿ Crypto** | 24×7, no login needed |
| **📊 Index / ETF** | NIFTY, Bank NIFTY, SENSEX and the liquid ETFs |
| **🛢 Commodities** | MCX near-month futures (auto-rolling) plus gold/silver ETF proxies |
| **📈 Stocks** | the full NSE universe already in the scanner |

The three non-crypto classes need an **Upstox login** and trade on **NSE/MCX hours** — the panel says
which of the two is missing instead of showing an unexplained empty list. Everything is priced in ₹
there, so the $ USDT toggle only appears on Crypto.

The score is calibrated **per asset class**, because a 3% day is routine for a coin and remarkable for
an index — one shared threshold would either flood the list with crypto or never surface an index:

- **55% — size of the 24h move**, scaled to what a big move means for that class,
- **30% — volume surge** vs that instrument's *own* 20-bar average (a real crowd, not a thin wick),
- **15% — bar range** (enough room per bar to make a scalp worth taking).

Crypto uses the exchange's own 24h ticker where available; every other class measures the same things
from its candles, so nothing depends on a crypto-only endpoint. Indices carry no volume in the feed,
so they qualify on movement alone.

**What the score means:** it answers *"is this coin actually moving, with a real crowd behind it?"* — high score =
the move is fast and well-funded, so a scalp reaches its target sooner and you can get filled without slippage.
It is an **activity gauge, not a buy signal and not trade quality**. Setup quality remains the separate
**◆ Confidence %**. Read them together: 🔥 high + ◆ High = a good setup on a coin that's actually moving;
🔥 high + ◆ Low = lots of noise, no edge (stand aside); 🔥 low + ◆ High = a clean setup that may take a while
to pay. The same score appears on Quick Trades cards, where **🔥 Sort by volume** ranks setups by it.

An instrument only qualifies as a mover with **real participation**: a volume surge ≥ 1.5× normal, or a move past its class threshold (3% crypto · 2% stocks · 1.5% commodities · 1.2% index).
Each mover card carries the engine's actual **quick-scalp plan** for that timeframe — a labeled entry zone,
stop and three targets in their own boxes, plus R:R and confidence — or shows **WATCH** when the coin is moving
but there's no clean entry (don't chase spikes). Timeframes 5m / 15m / 30m / 1h, auto-refreshing every 45s.
Use **🎯 Tradeable now only** to hide the WATCH rows. Both Volume Movers and Quick Trades have a
**$ USDT / ₹ INR** display toggle (defaults to USDT — the currency most scalpers think in).

### One coin, one price — across every tab

Every panel reads the **same feed** and shows the **same number** for the same coin. A crypto price
is built once (CoinDCX's liquid USDT market × CoinDCX's own USDT/INR, or the global price × plain FX
when CoinDCX is unreachable) and the server reports the exact rate it priced with, so the **$ view is
a lossless division** rather than a second conversion. There's a test that compares ⚡ Quick Trades,
🔥 Volume Movers, 🎢 Dump & Bounce and 🔔 Position Watch coin by coin and fails if any two disagree.

Two things that used to break it, both fixed:

- **🔔 Position Watch never refreshed the live ticker.** Every other crypto path calls
  `ensureCdxFresh()` before pricing; this one didn't, so it rescaled its candles against a snapshot
  that could be minutes old. It now refreshes like the rest, **and** overlays the same live quote
  the other panels use — the signal still comes from candles, but the price no longer does. Each row
  says whether its price is `live` or a `last close` fallback, so a stale one can't hide.
- **🎢 Dump & Bounce invented its own prices in DEMO.** It generates synthetic listing/squeeze tapes,
  which start from an arbitrary price — BTC read ₹0.46 there while every other tab read ₹5,386.25.
  Demo tapes are now scaled onto the shared price. Scaling is affine, so every ratio (drawdown, bump
  size, retrace %, R:R, the backtest) is unchanged; only the absolute number moves. LIVE mode was
  never affected — there all panels read the one feed.

### The USDT rate is never served stale

`$` is `₹ ÷ rate`, so a stale rate makes every USDT price drift while ₹ stays correct. Two things
guarantee it can't:

- **The server re-reads the rate on every response**, cache hit or not. The heavy endpoints are
  cached — scan and movers 40s, backtest 10 min, 🎢 Dump & Bounce **30 minutes** — and each used to
  bake the rate into the cached object, so a Dump & Bounce refresh could stamp a half-hour-old rate
  over a fresh one. Reading the rate is free; only the payload is cached.
- **The browser keeps the freshest reading, not the last one.** Panels poll on different clocks
  (20s / 30s / 45s), so responses arrive out of order. Every payload carries `rateAt`, and a reading
  older than the one already held is dropped.

### Why a price may not match your exchange exactly

Each panel states which currency is exact right now, and it depends on whether this server can reach CoinDCX:

| Server can reach | ₹ INR | $ USDT |
|---|---|---|
| **CoinDCX** (host in an India region, or run locally) | exact | exact |
| **Global feed only** (e.g. a US-hosted server) | ~1–4% under CoinDCX | **exact** |

CoinDCX trades at an **India premium** over the global market, so when the server is outside India it prices ₹
from the global price × a plain USD/INR rate, which lands slightly below CoinDCX's own ₹ screen. **Use the $ USDT
view to match your screen in that case** — and note every *percentage* (entry, stop, targets, R:R, and all the
tracked outcomes) is unaffected either way, because both sides of a ratio move together.

Small residual differences are normal even in CoinDCX mode: panels refresh on a timer (45s) and quotes are cached
for a few seconds, so a fast-moving coin can read slightly stale; and an exchange screen shows bid/ask around the
last trade. If ₹ is off by a *consistent* few percent rather than jittering, that's the premium above, not lag.

API: `GET /api/movers?tab=Crypto&tf=5m` · settings: `moversTop` in `config.json` (or env `MOVERS_TOP`, default 20 coins).

### 📌 Tracked setups — recommendations never just vanish

Live lists refresh every 45s, so a setup you entered could previously disappear from the panel on the next
scan. Now **every recommendation the panels show is snapshotted server-side and followed to its outcome**:

- **⏳ WAITING** — entry zone not reached yet (expires after ~6 bars if the zone never comes → *no trade*),
- **🎯 IN TRADE** — price entered the zone; **✅ T1/T2/T3 HIT** as targets are reached, with the stop
  ratcheting to breakeven after T1 and to T1 after T2 (exactly like the engine's exit plan),
- resolved as **✅ all targets / ✅ banked / ⛔ stopped / ⌛ never filled / 🚫 invalidated before fill**.

The **📌 Tracked setups** dropdown at the top of both panels (collapsed by default — the summary line shows
how many are tracked, in trade, reversed, and the running hit rate) lists every active setup with its
ORIGINAL levels and live status, so if you took a trade and the card left the list, its stop/target guidance
is still right there. Filled trades also show live unrealized %.

**⚠ If a trade reverses on you.** When the engine's signal for a coin you're holding flips to the opposite
side, the setup is marked **⚠ REVERSED** and tells you what to do — the reason you entered no longer exists:

- **Reversed before any target** → *close at market now*. A reversed scalp usually reaches the stop anyway,
  and exiting early makes the loss smaller than the planned one.
- **Reversed after Target 1** → *let the stop do its job*. You've already banked a third and the stop has
  ratcheted to your entry, so the rest is protected.
- **Merely underwater, signal intact** → *hold to plan*. The stop is the exit; don't widen it.

The tracker only ever flags — it never closes a position for you, and the flag clears if the signal comes
back onside.

**🕘 Past recommendations** (a nested dropdown) is the history: every resolved setup with what happened, the
realized %, and a plain-English note on *what it meant if you had money in it* — e.g. `stopped −3.96%`
("the planned loss — the reason position sizing matters") vs `never filled` ("NO TRADE — nothing was lost").
Percentages follow the engine's own exit plan (a third banked at each target, remainder at the exit) for one
unit per trade, **before fees and slippage**. Stop-outs are recorded at the stop price, not the sampled
price, so a once-a-minute sampling gap doesn't overstate losses.

Together these build a **forward record** — a measured, real-time hit rate of the recommendations
themselves, distinct from the backtest. Statuses are sampled ~once a minute (state survives restarts via
`setups.json`). API: `GET /api/setups` (`?tf=`, `?limit=`).

## 🎢 Dump & Bounce — the fall / bump / fall pattern

Click **🎢 Dump & Bounce** for the **XAI / COOKIE / VANA** shape: a coin peaks, falls and falls and
falls, throws one sharp bump, then falls again.

**That shape is not fraud, and the panel doesn't call it that.** These are real projects with a small
**circulating float against a huge total supply**, so every unlock lands on a thin order book — and a
coin everyone is already short squeezes violently when it does turn. Naming the mechanism is the
useful part; "fake coin" would be an accusation this app can't support and would hide the thing you
can actually trade.

### The two trades, with levels

Every card gives you **both trades this shape offers**, and one line saying which is live *right now*:

| | |
|---|---|
| **① LONG the bounce** | Counter-trend. Buy zone in the lower part of the base, stop under the floor, three targets. Fast, and the one that pays — but you're buying a falling coin, so the stop isn't optional. |
| **② SHORT the failure** | With-trend. Entry where this coin's bumps have died before, stop above it, targets back down to the prior low. Smaller reward, better odds — it's the direction the coin is already going. |

The instruction is always one of four: 🟢 **BUY THE BOUNCE** · 🔴 **SHORT THE FAILURE** ·
⏳ **WAIT — TO BUY** · ⏳ **WAIT — TO SHORT**. The two waiting states give you the exact price to set
an alert at and how far away it is. "Mid-air" is a real answer and gets said out loud rather than
dressed up as a signal.

Levels come from the coin's own **4h structure** — its recent floor, the swing high where the last
bump rolled over, its ATR — and its own **median bump size**. Never from a generic indicator.
Targets are picked from real levels and sorted, so a nearer resistance can't be skipped in favour of
a formula's projection. When a coin has no completed bump yet, the target distance is estimated from
its recent range and the card says so.

### Rank, don't gate

Only **two things** keep a coin off the list: at least **35% below a high set 20+ days ago**, plus a
liquidity floor. That's the regime; everything else *ranks* the list.

An earlier version also required a complete daily cycle and a ≥15% median daily bounce. Measured
against a population of bleeding coins, **the cycle test alone rejected half of them** — and exactly
the wrong half: coins in a near-monotonic bleed whose bumps are sharp and intraday, so they never
form a 15% leg between two *daily closes*. That is the XAI / COOKIE shape precisely. Those tests are
now score inputs and card stats.

Age is not a gate either. The regime **outlives the listing** — XAI listed in early 2024 and was
still trading this way years later — so cards say which case they're in: *"listed ~180d ago"* when
the series provably starts at the listing, or *"400d of history (listing is older)"* when it hit the
400-bar fetch cap.

### Why two timeframes

**Daily bars** decide which coins are in the regime. **4h bars** time the bump and place the levels,
because these moves run +50% and die inside 24–72 hours — on daily closes the whole event is one
candle, so a daily-only view would quote *"bounces run ~20 days"* for something that was over in two.

A **bump** is an up-leg that is both **big (≥20%)** and **fast (≤3 days)** — a slow grind of the same
size is a different animal and isn't counted. Each card shows this coin's median bump size and
duration in hours, its live 4h state, and the volume on the current leg versus normal: a squeeze
with a real crowd behind it is a squeeze; a spike on nothing is a wick.

### 🧪 Did the plan actually work?

Under the levels on every card is the number that decides whether to take the trade: **these exact
levels, replayed on this coin's own tape.** Not "what did buying a dip return" — that's a generic
question — but *"if you had taken this buy zone, with this stop, for these targets, every time it
fired, what happened?"*

It reports win rate, median return, average **R** per trade, how many stopped out, how many ran all
three targets, and the best and worst result. Then it says in one sentence whether the expectancy was
positive — **including when it wasn't**:

> ⚠ **This exact plan has LOST money on this coin** — −0.53R per trade over 11 of them. The pattern is
> real; trading it this way has not paid. Do not take it just because the card is here.

Below 5 trades it refuses to quote a win rate at all and says the sample is too thin to judge.

Three things keep the number honest:

- **It cannot see the future.** Each decision is produced by calling the *same production
  `tradePlan()`* on a strict prefix of the data, and fills are only ever checked on *later* bars. The
  backtest can't drift from the live logic, and can't peek. There's a test that appends 120 bars to a
  tape and asserts the earlier trades don't change.
- **A stop and a target in the same bar counts as the stop.** Intrabar order is unknowable from OHLC,
  and assuming the target would flatter every result.
- **Long and short run as separate books.** Sharing one position slot let the long — whose zone sits
  at the floor, where a bleeding coin lives — fire constantly and starve the short down to a
  one-trade sample. That was an artifact of the simulation, not a fact about the strategy.

**Was it the stop, or the idea?** When a plan loses, those are two different failures with opposite
fixes, so the card separates them: of the trades that stopped out, **how many reached Target 1 anyway
inside the hold window**.

- **High** (≥50%) — the stop is being picked off before the move arrives. Widening it, and sizing
  smaller to keep the same rupee risk, is the lever to try.
- **Low** (≤25%) — price mostly kept going. A wider stop would mainly just lose more per trade; if
  this side loses money, the trade is what's wrong, not the stop.

Across the demo coins this rate ranges from 15% to 80%, so there is **no single right answer to tune
globally** — which is exactly why it's a per-coin diagnostic rather than a knob the app turns for you.
The stop width itself is configurable (`bumpStopAtr`, default **1.1 ATR** beyond the floor/roof) and is
deliberately *not* fitted to the backtest: letting the plan optimise against its own replay would fit
it to whatever history happened to be in the window. Each card also shows the stop width in ATR so you
can see what you'd be changing.

The exit plan is the app's own (a third banked at each target, stop ratcheting), so these numbers are
directly comparable to 📌 Tracked setups. Note the sample is small — 4h bars over ~50 days — which is
exactly why the forward record below matters too.

### 📌 Followed to an outcome, and 📣 pushed to Telegram

Live plans are snapshotted into the **📌 Tracked setups** dropdown like every other recommendation the
app makes, so a Dump & Bounce trade you take never vanishes off the panel mid-trade — and so the
feature builds a **forward** record to set against the backtest. The tracked record carries the
*backtested* win rate rather than an invented confidence score.

Only plans that are **live now** are tracked. A waiting zone is deliberately left alone: the tracker
expires unfilled setups after a fixed number of bars, and a buy zone can legitimately take days to be
reached, so tracking those would manufacture a pile of fake "never filled" outcomes.

When Telegram is configured, entering a buy or short zone **pings you** — a bump runs and dies inside
24–72 hours, so a panel you have to be watching is a panel that misses the trade. It fires on the
*transition* into a zone, so a coin parked in its buy zone pings once, not hourly, and the message
carries the backtest line (including "not enough history to backtest").

### The part that keeps this honest

**Every bump is measured for what happened *after* it**, over the same window it took to form: the
median % given back, and how many round-tripped completely. When that give-back is high the card says
so in as many words — *"Bumps here do not hold. Take profit into strength."* That is the "then it
falls again" half, and it's what turns the second trade from a guess into a plan.

Every card also reports **what buying a dip like today's actually returned**:

- the win rate and median return after past dips of the same depth, held for as long as this coin's bounces usually run, **versus**
- the same horizon bought on **any random day**.

If those two match, the dip told you nothing and the card says exactly that. Several rows will. The
gap between them is withheld entirely below 8 samples, because a five-sample "edge" is noise dressed
up as a statistic. Both are computed **causally** — each bar is compared to its *trailing* 20-day
high, never a future one — and deliberately **not** from the swing pivots, because every pivot low is
followed by a rally *by construction*, which would make any coin look like a money printer.

**🎢 Pattern fit (0–100) ranks the list; it does not gate it, and it is not a buy signal.** A high
score means the coin closely matches "fell from an old high and never recovered" — a description of a
*falling* asset. Depth of the fall (25%), age of the high (15%), complete cycles (20%), bounce size
(20%), lower lows (15%), plus a small bonus (5%) when the history provably starts at the listing.

### Two refresh rates, and why the price may still not match CoinDCX

The scan is heavy — every coin's daily history, then 4h bars and a backtest on the survivors — so
**levels are rebuilt every 30 minutes** (**↻ rescan** forces it). That's right for levels: a floor and
a swing high don't move minute to minute.

It is *not* right for the price, and it was wrong for the **instruction**. So **live quotes are polled
every 20 seconds and the buy/short call is re-derived from them**, which means the card never tells
you to buy a zone price has already left. The header shows both clocks (`levels from 11:20 am ·
prices ⟳ 20s`). If a live quote can't be fetched, the card says **⚠ not live** rather than passing a
scan-time price off as current.

Beyond that, the same India-premium caveat as every other panel applies — see
[Why a price may not match your exchange exactly](#why-a-price-may-not-match-your-exchange-exactly).
Short version: if ₹ is off by a *consistent* 1–4%, that's the premium and the **$ USDT view is
exact**; if it's off on a fast-moving coin and jitters, that's timing.

Crypto only — the pattern is about token unlock schedules, which have no equivalent in an index or an
NSE stock. The daily pass covers the whole universe and the 4h pass runs only on the coins that qualify.
API: `GET /api/dumpbounce` (tracked plans appear in `GET /api/setups`) · settings in `config.json`: `dumpBounceTop`, `dumpBounceMinDrawdown`,
`dumpBounceMinQv`, `dumpBounceZigzag`, `bumpZigzag`, `bumpMinPct`, `bumpMaxBars`, `bumpStopAtr`
(or env `NL_TOP`, `NL_MIN_DD`, `NL_MIN_QV`, `NL_ZIGZAG`, `BUMP_ZIGZAG`, `BUMP_MIN_PCT`,
`BUMP_MAX_BARS`, `BUMP_STOP_ATR`).
## 🔔 Position Watch — your trades, and a Telegram ping when one turns

Three things in this app look similar. They aren't:

| | What it is |
|---|---|
| **📋 My Trades** | A browser-only P&L notebook. Lives in `localStorage`, dies with the tab, never touches Telegram. |
| **📌 Tracked setups** | Recommendations **this app** made, snapshotted and followed to their outcome. Builds the forward hit rate. |
| **🔔 Position Watch** | Trades **you** placed. Lives on the **server**, so the watch keeps running with the browser shut. |

Tell it what you bought or shorted and at what price. It keeps re-reading the signal behind that
trade and, the moment the signal **turns against you**, sends **one Telegram message to the person
you name** — and one more when it comes back onside. Nothing in between, so a trade that sits
reversed doesn't spam you.

- **Pick the recipient per trade.** The dropdown is the **same recipient list ⚡ Quick Trades uses** —
  anyone in `TELEGRAM_CHAT_ID` first (marked *gets scan alerts*), then anyone who has DM'd the bot.
  The trade alerts **only the person you pick**, never the whole broadcast list. A confirmation
  message goes out the moment you add it, which proves the route works before it matters.
  (List empty? Set `TELEGRAM_CHAT_ID`, or have the person send the bot "hi", then reopen the panel.)
- **Type the entry in the currency you actually traded in.** The panel carries the same
  **$ USDT / ₹ INR** toggle as the other panels, and the box is labelled with the active one — `$ USDT`
  for a coin, `₹` for an NSE stock, following the symbol as you type it. Prices are stored in ₹
  internally and converted on the way in, so a CoinDCX fill typed as `0.0067` is not silently read as
  ₹0.0067. Telegram messages quote crypto in **both** currencies, since an alert that says only
  "₹0.59" is unrecognisable on a phone.
- **A reversal is a CHANGE, not a comparison.** The signal you entered against is recorded as the
  baseline, and only a *transition* is an event. So four distinct states, not two:

  | | |
  |---|---|
  | ✅ **signal agrees** | it backs your side |
  | • **no clear signal** | HOLD — no opinion, which is not the same as disagreeing |
  | ↩ **counter-trend** | it disagreed when you entered *and still does* — a deliberate choice, **no alert** |
  | ⚠ **REVERSED** | it agreed (or was neutral) and has since **turned on you** — this is what pings you |

  This matters because it is the *main* case here, not an edge case: 🎢 Dump & Bounce exists to buy
  bounces in coins the engine still rates SELL, so a stateless "does the signal disagree right now?"
  test branded the app's own recommendations REVERSED the instant you added them. The confirmation
  message tells you when a trade starts counter-trend, so silence afterwards isn't mistaken for a fault.
- **HOLD is not a reversal.** The engine having no opinion is not the same as it disagreeing with
  you, so only an explicitly opposite verdict counts either way.
- Checked **every 2 minutes** server-side; the panel refreshes every 30s while open.
- It **never places or closes anything** on your exchange. It only tells you.
- Works without Telegram too — you just get the panel instead of the pings.

API: `GET/POST /api/positions` · state in `positions.json` (gitignored — it holds your entries and
chat IDs).

## 🤖 Paper Bot — choose which desks it trades

The bot no longer just "scans and filters". You pick **which of the four desks it takes trades
from**, and each one maps to a panel you already read, so what it trades is what you would have
seen yourself:

| Desk | What it takes |
|---|---|
| **⚡ Quick** | Scalp regimes (range / correction) on 5m–1h — the ⚡ Quick Trades panel. *(default)* |
| **📈 Normal** | The main scanner's trend and breakout setups — the dashboard table. |
| **🔥 Movers** | Only coins that passed the participation gate — real volume behind the move. |
| **🎢 Dump & Bounce** | Live buy/short plans from the fall-bump-fall detector, using **its** levels. |

**Tick any combination — each box applies the moment you click it**, no Save needed. (The Save
button is only for the typed numbers: capital, risk %, target, leverage.) A coin that qualifies
under several desks is attributed to the most specific one, so nothing is double-counted.

### 🎢 What the Dump & Bounce desk will actually take

Only the two clear ones — **long a rally** or **short a failure** — and the fast chart has to
confirm the direction first:

| | Taken when the 4h bump is… |
|---|---|
| **LONG** | `running` (a move is underway) or `building` (the fall has stopped, it's basing) |
| **SHORT** | `late` (already matched its typical size) or `fading` (rolling over) — *the failure* |

It will **not buy a floor that is still falling**. A live plan is not a trigger; the confirmation is.

**See what it would do on your own data before switching the desk on.** Every card carries the
verdict — *"🤖 Paper bot: would take this — short the failure, the bump is fading"* or *"would skip —
a long needs the bump running or basing, and it is fading"* — and the panel header counts them
(*"🤖 bot would take 3 of 12"*). The rule has exactly one definition, in `server.js`, and is handed
to the bot, so the panel can never promise a trade the bot refuses; there's a test asserting the two
agree across all ten side/state combinations.

> **DEMO vs LIVE.** `DEMO` is false as soon as an Upstox API key is set, so a configured instance
> reads real CoinDCX/Binance data here. Any figure quoted from DEMO — including "the desk takes
> nothing" — comes from synthetic tapes and says nothing about live behaviour. The header count
> above is the way to check.

**The same quality gates apply to all four.** Arriving from a different panel earns no exemption —
confidence floor, the proven-edge gate, the noise-floor stop guard, cooldowns and the loss-streak
pause are shared. Dump & Bounce brings its **own** backtest of its exact levels, so the edge gate
reads that: a plan whose own replay lost money is refused, with no special-casing. (In DEMO all ten
live plans are rejected for exactly this reason — which is the gate working, not failing.)

**Which desk is making the money.** Every position, working order and closed trade records the desk
that produced it, and the panel totals P&L per desk. That is the point of the picker: a desk with a
losing record is one you can simply untick. Open rows and closed rows carry a ⚡/📈/🔥/🎢 badge.

**When it holds nothing, it says why** — which gate rejected how many, in plain English ("Scanned 48
setups, took none: none were scalp setups"). Being correctly selective and being broken look
identical without that line.

Existing saved state migrates: a bot running `scalpOnly:true` keeps trading Quick only, and one
running `scalpOnly:false` becomes Quick + Normal — the same setups it took before the upgrade.

## How prices stay accurate

- **Stocks/ETFs/indices:** Upstox real-time last-traded price (LTP), refreshed every few seconds, plus
  30-minute / daily candles for the signal engine. These match your Upstox terminal.
- **Crypto:** CoinGecko (Upstox doesn't offer crypto), normalized to INR.
- Indices show **points**; everything else in **₹**.

## Settings (`config.json`)

| Field | Meaning |
|-------|---------|
| `upstoxApiKey` / `upstoxApiSecret` | From your Upstox developer app |
| `redirectUri` | Must match the app's Redirect URL exactly |
| `port` | Local port (default 5180) |
| `demo` | `true` = synthetic offline data; `false` = real Upstox |

## Extending the universe
Edit `STOCK_SYMS` / `ETF_SYMS` in `server.js` (plain NSE symbols). Upstox instrument keys are resolved
automatically from the daily NSE master file — no manual IDs needed.

## 🩺 Market Health — market-wide stress & correlation

Every other panel looks at one coin. This one looks at the **market**, and answers the question a
single chart cannot: *why is everything moving together right now?*

"The market is bearish" is not an answer. These three markets all look identical on a price chart
and need opposite trades:

| what it looks like | what it actually is | what it means |
|---|---|---|
| BTC ↓, 85% of the board red | **long liquidation cascade** — positions being closed *for* their owners | mechanical, self-terminating; it stops when the leverage is gone |
| BTC ↓, 85% of the board red | **new shorts pressing** — open interest *rising* into the fall | conviction selling with fresh money; no reason for it to stop |
| BTC ↓, 85% of the board red | **liquidity vacuum** — barely anyone selling, the bids simply left | small orders move price several percent; reduce size |

Open the panel with **🩺 Market Health**. It shows the regime, breadth, altcoin stress, correlation,
open interest, funding, liquidity — and a **❓ Why is everything falling?** button that writes the
whole diagnosis in plain English with the evidence it used attached.

**What it detects.** Breadth (−100…+100) and altcoin stress (0–100) · rolling correlations across
15m/1h/4h/24h, including correlation *spikes* and coins *decoupling* from BTC · BTC → ETH → altcoin
transmission with lead–lag timing · liquidation cascades · the price×open-interest matrix · funding
crowding · liquidity vacuums · per-coin beta and downside amplification · HH/HL/LH/LL market
structure · recovery-vs-continuation probabilities.

### On your open positions

Add **Leverage ×** (and optionally your venue's own **liquidation price**) when you add a trade in
🔔 Position Watch, then click **🩺 market risk** on it. You get a **Position Stress Score 0–100**,
distance to liquidation and to breakeven, a `CURRENT → SUPPORT → LIQUIDATION` risk map, whether the
coin is out- or under-performing the market, whether your position is fighting market structure, and
the specific level that would strengthen the recovery case.

> **It will not tell you to average down.** The gate starts at *no* and requires evidence to move.
> A live cascade, a liquidity vacuum, BTC still printing lower lows, or a liquidation price inside
> 15% each force an outright refusal. When conditions are merely unproven the answer is "wait", with
> the level that would change it. There is no path in the code to "yes, add more".

### What this platform genuinely cannot see

This is the important part, and the panel repeats it on screen rather than hiding it.

| data | status | consequence |
|---|---|---|
| prices, volume, breadth, correlation, beta, structure | ✅ available | the majority of the panel works off this |
| **liquidations** | ❌ **never available** | no public REST source exists — only a WebSocket stream this server does not hold open. The cascade detector therefore runs **INFERRED** (reconstructed from price, volume, breadth and correlation) with its confidence **capped at 65%**, and it never claims to have seen a liquidation |
| **open interest** | ⚠️ needs a futures venue | without it, forced long liquidation and fresh short selling are indistinguishable |
| **funding** | ⚠️ needs a futures venue | without it, you cannot tell whether price is falling into a crowded long book or one that already reset |
| **order-book depth** | ⚠️ needs a futures venue | falls back to a price-impact *estimate* from candles, labelled as such |
| **BTC dominance** | ⚠️ needs CoinGecko | the volume-share figure shown instead is **not** dominance and is labelled separately |

⚠️ **Hosting note.** The three ⚠️ rows come from Binance futures, and Binance restricts Indian
access — the same Bangalore placement that makes your CoinDCX prices correct is likely to make these
unreachable. That is a real, unresolved gap. The panel states which feeds are live every time it
renders, so you always know what a conclusion was built on. Set `INTEL_DERIVS=off` to stop trying.

### 🌍 Macro — the half that isn't on the chart

Every indicator in the rest of this platform is **endogenous**: computed from an asset's own price
history. That makes the whole system structurally blind to the most common way a technically sound
leveraged position dies — a dollar rally, a rate shock, or a number released at 8:30am that no
chart level prices in.

**The headline output is not the risk-appetite score. It's TECHNICAL RELIABILITY (0–100)** — an
estimate of how much crypto is currently being driven by macro rather than by its own structure.
When BTC's 30-day correlation to the Nasdaq is 0.8 and VIX is 30, a textbook support bounce is not
a support bounce; it's whatever the dollar does next. That is exactly the condition in which
chart-only trading keeps producing clean-looking setups and keeps losing, with nothing on the chart
saying so.

Tracked: **DXY · US 10-year yield · VIX · S&P 500 · Nasdaq · gold · crude · USD/INR · NIFTY ·
India VIX** (Yahoo Finance, Stooq fallback — free, no key).

**What "gate and degrade" actually does:**

| condition | effect |
|---|---|
| Technical reliability low | Every setup's confidence is multiplied by `0.5 + 0.5 × (reliability/100)`, with the reason shown. Never reaches zero — a degraded signal is still information. |
| Macro risk appetite ≤ −50 | New leveraged **longs** blocked (and shorts in a melt-up ≥ +60). |
| Inside a scheduled-event window | **Both** directions blocked, confidence capped at 40%, position stress floored at HIGH RISK. |
| Macro feed unreachable | **Fails open** — multiplier stays 1.0, nothing is blocked — but raises a visible `MACRO UNCHECKED` warning and its own alert. A broken API must not silently freeze the platform, and must not silently stop protecting you either. |

The paper bot honours all of this (🌍 **Respect macro**, on by default). When it sits idle because
of macro, it says so rather than looking broken.

### ⚡ Live momentum — the vertical moves the platform used to miss

**This closes a real blind spot.** `buildSetup` marks a setup as a scalp when `ADX < 26`; a coin
going vertical has a high ADX by definition, so it lands in `breakout`/`trend` — and every fast
surface filtered exactly those out:

```
index.html  ⚡ Quick Trades   filter(regime === 'range' || 'correction')
server.js   trackSetups / alertEligible      — same test
paper.js    isScalp                          — same test
```

A coin doing +45% in an hour could not appear in Quick Trades, could not be tracked, and **could
never fire an alert**. Only 🔥 Volume Movers showed it, and Movers has no alerting. Three more
things made the candle path structurally too slow: `processAsset` drops the forming bar (a 5m
signal is up to 5 minutes stale), the scan is cached 40s behind a 45s poll, and the universe is
the top 120 by *yesterday's* volume — so a coin often only joins it after the move.

**The fix reads the ticker, not the candles.** `cdxGetTicker()` already returns every market on
the exchange in one request, every few seconds, to price live quotes. Recording those snapshots
gives sub-minute resolution, no forming-bar lag, the whole exchange rather than the top 120, and
**no extra API calls** — it's the request the server was making anyway. Volume comes from
differencing the rolling 24h total between snapshots.

Each row carries a **stage** and an explicit **lateness**:

| stage | meaning |
|---|---|
| 🔥 **igniting** | the move is happening now — this is the only stage that alerts |
| ▶ **running** | sustained, still going |
| ⚠ **extended** | most of the run already happened — reported with how much |
| ⏸ **stalling** | the push has faded |

> **It never becomes a chase button.** Catching a move at +2% and at +45% are opposite trades, and
> a detector that just shouts when something is green reliably delivers the second. Alerts fire
> **only on ignition**, once per coin per 45 minutes, three coins per sweep maximum. An extended
> move is labelled extended with the plain statement that this is where leveraged entries get
> liquidated. Rows carry **no entry, stop or target** — they are move notifications, not setups.

The size threshold scales to each coin, measured from **its own recent ticks** rather than its 24h
range. That distinction matters: the 24h high/low *includes the move being detected*, so a coin
that has already run 45% gets a huge denominator and needs an absurd further move to register —
the detector would go blind exactly as a move develops.

### 🚀 Breakouts inside ⚡ Quick Trades

Quick Trades now has a **mode toggle: ⚡ Scalps / 🚀 Breakouts**. Scalps are unchanged — pullback
entries into support with tight stops. Breakouts are the setups the panel had always discarded.

The engine was already building them correctly (entry at the break, a structural stop bounded to
3 ATR so it can never be absurd, targets snapped to real chart levels). Only the filter was
hiding them. What was genuinely missing is that **breakouts fail differently from scalps**, so
they get their own guards:

| guard | why |
|---|---|
| **Volume behind the break** | A level breaking on no participation is the textbook fakeout. A range trade doesn't depend on follow-through; a breakout is nothing but follow-through. |
| **Price still inside its entry band** | Once price has left the band, the trade on offer isn't the one the plan describes. Chasing it is how a vertical liquidates people. |
| **Stop under 6%** | Wider than that can't be sized on leverage without the position being the whole account. |
| **First target clears the 1.2% round trip** | Same cost gate the paper bot applies. |
| **R:R ≥ 1.2** | |

Pullback entries (`waitdip` / `waitbounce`) deliberately stay in Scalps — mixing them in would put
two different risk profiles under one heading again.

Each breakout card carries a badge with **its stop distance**, because that's the one number that
should change how you size it. And when the list is empty it says *why* — "4 breaks seen, all
rejected: no volume behind them" is a completely different market state from "nothing is breaking
out", and only one of those means you should look at another timeframe.

The 1.2% friction figure now has **one owner** (`TRADE_COST` in `server.js`, shipped in the scan
payload), with a test asserting the paper bot's defaults still match it — so the panel and the bot
can't gate on different numbers.

### 🎯 What is actually moving crypto

Not "macro is risk-off" — that's a mood. This names the factor, sizes it, and signs it toward
*your coins*:

> *"US Dollar Index is +1.4% over the window. With BTC's −0.8 beta to it, that alone accounts for
> about −1.1% of BTC's −1.9% move — the dollar is the main thing dragging crypto right now. That's
> roughly 82% of the whole move, so this is being imported from outside crypto rather than driven
> by crypto demand — it will turn when the dollar turns, whatever the chart is doing."*

Each factor gets `contribution = its move × BTC's beta to it`, ranked by size. **A factor with no
measurable correlation to crypto is excluded**, however large its own move — a beta fitted through
noise will happily "explain" a move it has nothing to do with.

Betas are univariate on purpose. A joint regression across DXY, Nasdaq and yields is statistically
tidier and practically useless: they're collinear, so the coefficients flip sign between refreshes.
A panel that says "the dollar is dragging you" and then "the dollar is supporting you" twenty
minutes later, from the same data, is worse than none. The rank order is what's actionable, and the
rank order is stable — the trade-off is that shares overlap and don't sum to 100%, which is stated
wherever the numbers appear.

### 📈 Is this rally standing on anything?

**Technical analysis isn't bulletproof, and this is the panel that admits it.** A rally can be
carried by broad participation, expanding volume and improving macro — or it can be four coins, a
thinning book, a crowded long and an equity market already rolling over. Both print the same green
candle. Every tell of the second one is measurable *before* the reversal.

Eight legs are checked: participation · trend quality · volume trend · momentum divergence (price
higher high, RSI lower high) · **macro pointing against the move** · equity decoupling · crowded
positioning · leveraged chase. Plus extension from the mean.

Each leg reads **✓ confirmed**, **✗ missing**, or **? not measured** — three states, not two. A
green tick beside "macro UNCHECKED" would be the exact failure this platform exists to prevent, and
the headline counts only the legs it could actually check.

> **It never predicts a crash.** Nothing here forecasts a fall, and nothing built on this data
> honestly could. It says *"this rally is largely unsupported: 4 of the 6 internal supports that
> could be checked are missing — it is resting on fewer legs than the price implies."* That is a
> claim the data carries. "It will crash" is not. It also always states what would repair the move,
> so you have something to watch rather than only something to fear.

Works in both directions — the mirror case is a decline making new lows while breadth, volume and
macro all improve underneath it, which is usually the better entry of the two.

### Scheduled events — `macro-calendar.json`

There is no free API for central-bank calendars, so this is an **editable file** you maintain.
Three rules keep it honest:

1. **NFP is derived**, not configured — first Friday of the month, by rule. It can't go stale.
2. **Shipped dates are marked `unverified: true`** and flagged on screen until you check them
   against federalreserve.gov / bls.gov / rbi.org.in and set them to `false`.
3. **An expired calendar drops its events** rather than showing last year's schedule as upcoming.
   Past `validThrough` it reports `STALE` and falls back to derived NFP only.

> The event gate is **deliberately independent of every network call**. It reads a local file, so
> "don't open leverage into CPI" keeps working even when CoinDCX, Binance and Yahoo are all
> unreachable. The single most valuable guard here is the one that can't be knocked out.

### "Has this signal worked before?"

Every threshold here started as a judgement, not a measurement. The engine appends a snapshot of the
market state to `intel-history.jsonl` on each pass, and the backtest button reports what actually
happened over the next 15m/1h/4h after each signal fired. **It refuses to state a rate below 20
recorded occurrences** — under that it says how few it has instead of printing a percentage. Nothing
is backfilled: the record starts when the engine does, and resets if the host redeploys with
ephemeral storage.

## Files
```
growth-intelligence-pro/
├── START-HERE.command   ← double-click to run
├── server.js            ← backend (Upstox + engine)
├── paper.js             ← paper-trading simulator
├── intel/               ← 🩺 market-wide stress & correlation engine
│   ├── index.js         ← orchestrator (injected deps, no own price feed)
│   ├── data.js          ← one shared market snapshot, reuses server.js's loaders
│   ├── stats.js         ← correlation / beta / weighted scoring over partial evidence
│   ├── breadth.js       ├── correlation.js  ├── beta.js       ├── structure.js
│   ├── transmission.js  ├── liquidation.js  ├── openInterest.js
│   ├── funding.js       ├── liquidity.js    ├── recovery.js
│   ├── regime.js        ├── positionRisk.js ├── alerts.js     ├── history.js
│   ├── macro.js         ← 🌍 macro regime + TECHNICAL RELIABILITY (the gate)
│   ├── attribution.js   ← 🎯 which macro factor is moving crypto, and by how much
│   ├── fragility.js     ← 📈 is this move supported by its own internals?
│   ├── momentum.js      ← ⚡ exchange-wide vertical-move detector (ticker, not candles)
│   ├── calendar.js      ← scheduled-event risk; needs no network
│   ├── macroData.js     ← DXY/yields/VIX/equities adapter (Yahoo, Stooq fallback)
│   ├── derivs.js        ← futures adapter (OI/funding/depth) — honest about being unreachable
│   └── global.js        ← BTC dominance adapter
├── macro-calendar.json  ← 📅 YOU MAINTAIN THIS — FOMC/CPI/RBI dates (NFP is derived)
├── config.json          ← your keys + settings
├── public/index.html    ← dashboard
├── token.json           ← auto: daily login token (private)
├── instruments.json     ← auto: cached symbol→key map
├── intel-history.jsonl  ← auto: market snapshots for the intel backtester
└── README.md
```

## Honest notes
- This is a decision-support cheatsheet, not a guarantee. Every setup has a stop and invalidation because
  trades fail — size positions so any single loss is small.
- Keep this folder private: `config.json` and `token.json` contain your credentials.
- Not affiliated with Upstox, NSE, or BSE.
```
