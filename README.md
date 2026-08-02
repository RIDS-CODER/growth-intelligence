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
movement right now**, ranked by a 0–100 **Mover Score**:

- **55% — size of the 24h move** (from the exchange's own 24h stats),
- **30% — volume surge** vs that coin's *own* 20-bar average (a real crowd, not a thin wick),
- **15% — bar range** (enough room per bar to make a scalp worth taking).

A coin only qualifies as a mover with **real participation**: a volume surge ≥ 1.5× normal, or a 24h move ≥ 3%.
Each mover card carries the engine's actual **quick-scalp plan** for that timeframe — entry zone, stop, targets,
R:R and confidence — or shows **WATCH** when the coin is moving but there's no clean entry (don't chase spikes).
Timeframes 5m / 15m / 30m / 1h, auto-refreshing every 45s. Use **🎯 Tradeable now only** to hide the WATCH rows.

API: `GET /api/movers?tf=5m` · settings: `moversTop` in `config.json` (or env `MOVERS_TOP`, default 20 coins).

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
