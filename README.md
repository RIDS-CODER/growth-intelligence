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

### Two timeframes, because the two halves run on different clocks

**Daily bars decide which coins are in the regime.** Not listing age — the regime *outlives* the
listing. XAI listed in early 2024 and was still trading this way years later, so a listing-age gate
would reject the very coins the feature exists to find. What matters instead is that the high is
**old** and price is far below it:

| Filter | Why |
|---|---|
| ≥ 40% below its high | A coin near its high isn't in this regime. |
| High set ≥ 30 days ago | 40% off a high set last week is a *pullback*, not a bleed. |
| ≥ 1 complete cycle, bounces ≥ 15% | Needs repeated behaviour, and bounces worth trading. |
| Peaked in the first 60% of its life | **Only applied when the history provably starts at the listing.** Past 400 daily bars the feed is capped, so bar 0 is an arbitrary date and this test would be meaningless. |

Cards say which case they're in: *"listed ~180d ago"* when the series starts at the listing, or
*"400d of history (listing is older)"* when it hit the cap.

**4h bars time the bump — that's the trade.** These moves run +50% and die inside 24–72 hours; on
daily closes the whole event is one candle, so a daily-only view would quote *"bounces run ~20 days"*
for something that was over in two. A **bump** is an up-leg that is both **big (≥20%)** and
**fast (≤3 days)** — a slow grind of the same size is a different animal and isn't counted.

- **🔥 BUMP RUNNING** — a fast counter-trend move is underway, still short of this coin's typical size.
- **⚠️ BUMP LATE** — it has already matched the typical bump in size or in hours. Past bumps rolled over here.
- **📉 FADING** — rolling over off the last swing high. The give-back leg.
- **🌱 BASING** — off the lows but not moving with force. Set an alert; don't chase.

Each card carries **this coin's own** bump size and duration in hours, plus the volume on the current
leg versus normal — a squeeze with a real crowd behind it is a squeeze; a spike on nothing is a wick.

### The part that keeps this honest

**Every bump is measured for what happened *after* it**, over the same window it took to form: the
median % given back, and how many round-tripped completely. When that give-back is high the card says
so in as many words — *"These do not hold. Take profit into strength or you give it all back."* That
is the "then it falls again" half, and it's what makes this a trade with an exit instead of a hope.

On the daily side, every card also reports **what buying a dip like today's actually returned**:

- the win rate and median return after past dips of the same depth, held for as long as this coin's bounces usually run, **versus**
- the same horizon bought on **any random day**.

If those two match, the dip told you nothing and the card says exactly that. Several rows will. The
gap between them is withheld entirely below 8 samples, because a five-sample "edge" is noise dressed
up as a statistic. Both are computed **causally** — each bar is compared to its *trailing* 20-day
high, never a future one — and deliberately **not** from the swing pivots, because every pivot low is
followed by a rally *by construction*, which would make any coin look like a money printer.

**🎢 Pattern fit (0–100) is not a buy signal.** A high score means the coin closely matches "fell from
an old high and never recovered", which is a description of a *falling* asset. Depth of the fall
(25%), age of the high (15%), complete cycles (20%), bounce size (20%), lower lows (15%), plus a small
bonus (5%) when the history provably starts at the listing.

Crypto only — the pattern is about token unlock schedules, which have no equivalent in an index or an
NSE stock. Cached 30 minutes (**↻ rescan** forces a refresh); the daily pass covers the whole universe
and the 4h pass runs only on the coins that qualify.
API: `GET /api/dumpbounce` · settings in `config.json`: `dumpBounceTop`, `dumpBounceMinDrawdown`,
`dumpBounceMinRally`, `dumpBounceMinQv`, `dumpBounceZigzag`, `bumpZigzag`, `bumpMinPct`, `bumpMaxBars`
(or env `NL_TOP`, `NL_MIN_DD`, `NL_MIN_RALLY`, `NL_MIN_QV`, `NL_ZIGZAG`, `BUMP_ZIGZAG`,
`BUMP_MIN_PCT`, `BUMP_MAX_BARS`).
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
