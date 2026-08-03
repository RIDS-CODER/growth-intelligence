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

## 🔥 Volume Movers — scalp the coins that are actually moving

Click **🔥 Volume Movers** on the dashboard to see the crypto coins with the **biggest volume-backed
movement right now**, ranked by a 0–100 **volume score** (shown as a 🔥 badge on **both** panels):

- **55% — size of the 24h move** (from the exchange's own 24h stats),
- **30% — volume surge** vs that coin's *own* 20-bar average (a real crowd, not a thin wick),
- **15% — bar range** (enough room per bar to make a scalp worth taking).

**What the score means:** it answers *"is this coin actually moving, with a real crowd behind it?"* — high score =
the move is fast and well-funded, so a scalp reaches its target sooner and you can get filled without slippage.
It is an **activity gauge, not a buy signal and not trade quality**. Setup quality remains the separate
**◆ Confidence %**. Read them together: 🔥 high + ◆ High = a good setup on a coin that's actually moving;
🔥 high + ◆ Low = lots of noise, no edge (stand aside); 🔥 low + ◆ High = a clean setup that may take a while
to pay. The same score appears on Quick Trades cards, where **🔥 Sort by volume** ranks setups by it.

A coin only qualifies as a mover with **real participation**: a volume surge ≥ 1.5× normal, or a 24h move ≥ 3%.
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

API: `GET /api/movers?tf=5m` · settings: `moversTop` in `config.json` (or env `MOVERS_TOP`, default 20 coins).

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

## 🎯 Options Radar — mispricing screener

Click **🎯 Options Radar** for the Top 3 BUYS and Top 3 SELLS across the options chain, ranked by
**how far each contract sits from a fitted fair value** — this is a relative-value screen, **not** a
forecast of direction.

**Six signals**, z-scored and blended with weights from `config.json → optionsRadar.weights`
(nothing hardcoded). A signal that lacks data **abstains** rather than counting as neutral:

| Signal | What it measures |
|---|---|
| IV − 30d realized vol | Is implied vol above or below what the coin actually does |
| IV percentile | Where IV sits in its own 90-day range for that tenor/delta bucket |
| Smile residual | Distance from its expiry's own fitted vol curve (leave-one-out) |
| Term-structure slope | This expiry's ATM variance vs the expiries either side |
| Theta efficiency | Daily bleed against the move the option can realistically make |
| Funding + basis tilt | Directional overlay — **off by default**, user-toggleable |

**Hard filters** run first: spread < 8% of premium, OI above a floor, |delta| 0.15–0.70, > 12h to expiry.

### Guardrails

- **Never a naked short.** Every SELL is converted to a defined-risk vertical with a capped max loss in ₹.
  If no liquid protective wing exists, the signal is **suppressed entirely** rather than shown.
- **The record is always on screen** — rolling 90d hit rate, 95% confidence interval and average return
  per signal, including when it is bad, with an explicit "too few trades to be meaningful" label.
- **"Why isn't X here?"** — paste any contract id and get the exact filter it failed with the measured
  value and the limit, or the score that missed the top 3. Answers come from the recorded pipeline
  result, not a re-derivation.
- **Analysis, not investment advice** — stated on the panel, and no card offers one-tap execution.
- **India VDA tax drag** on every P&L projection. Default 30% + 4% cess = 31.2% on gains with **no loss
  offset**; that asymmetry means a 50%-hit-rate strategy is loss-making after tax, which the backtest
  reports explicitly. Treatment of crypto derivatives in India is genuinely unsettled, so the model is
  configurable and is an estimate, not tax advice.

### Backtest

**🧪 Replay last 30d of stored chains** re-scores the stored tape with the live scoring service, fills at
**mark ± half the spread** on entry and exit (both legs of a spread), and reports hit rate and average
return **attributed to whichever signal actually drove each trade** — with sample sizes and Wilson
confidence intervals, so a 12-trade sample cannot pass as an edge. Positions still open at the end of the
tape are excluded rather than marked to last price. Both gross and post-VDA-tax figures are shown.

The tape builds as the radar scans, so backtests only cover history the screener has actually seen.

### Data sources and the cold start

CoinDCX publishes **no documented public options-chain endpoint**, so the radar runs behind a venue
adapter: **Deribit is live** (documented public API, and the spec's backfill source anyway), and the
CoinDCX adapter sits behind the same interface — swapping it in changes one function, `fetchRaw`.
Set `optionsRadar.venue` to choose.

The 90-day IV baseline is keyed by **bucket** (underlying × tenor × delta), not by contract, because a
weekly option does not live 90 days. Bucket IV is the fitted smile sampled at a **fixed delta**, so the
series stays continuous across strike and expiry rolls. Any card scored against Deribit backfill instead
of native CoinDCX history carries a **⚠ backfilled baseline** badge until 90 days of local data exists.

> **Persistence matters here.** History lives in SQLite (`node:sqlite`, Node 22+; falls back to NDJSON on
> Node 18). Render/DigitalOcean filesystems are **ephemeral**, so point `OPTIONS_DB` at a persistent
> volume — otherwise every redeploy resets the baseline and cards stay permanently "backfilled".

Tests: `node --test options/*.test.js` (68 covering the vol math, guardrails and backtest accounting).
Design notes: [`docs/options-radar-design.md`](docs/options-radar-design.md).

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
