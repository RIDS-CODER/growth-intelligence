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

- **Pick the recipient per trade.** The dropdown lists everyone who has DM'd your bot, so a trade
  placed by one person alerts **only that person** — never the broadcast list the scan alerts use.
  A confirmation message goes out the moment you add it, which proves the route works before it
  matters. (Nobody in the list? Open the bot in Telegram, send it "hi", reopen the panel.)
- **HOLD is not a reversal.** The engine having no opinion is not the same as it disagreeing with
  you, so only an explicitly opposite verdict raises the flag.
- Checked **every 2 minutes** server-side; the panel refreshes every 30s while open.
- It **never places or closes anything** on your exchange. It only tells you.
- Works without Telegram too — you just get the panel instead of the pings.

API: `GET/POST /api/positions` · state in `positions.json` (gitignored — it holds your entries and
chat IDs).

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

## Files
```
growth-intelligence-pro/
├── START-HERE.command   ← double-click to run
├── server.js            ← backend (Upstox + engine)
├── config.json          ← your keys + settings
├── public/index.html    ← dashboard
├── token.json           ← auto: daily login token (private)
├── instruments.json     ← auto: cached symbol→key map
└── README.md
```

## Honest notes
- This is a decision-support cheatsheet, not a guarantee. Every setup has a stop and invalidation because
  trades fail — size positions so any single loss is small.
- Keep this folder private: `config.json` and `token.json` contain your credentials.
- Not affiliated with Upstox, NSE, or BSE.
```
