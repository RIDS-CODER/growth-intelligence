# Go Live — put your platform on the internet

You'll end up with a real web address you can open from your laptop or phone.

**Total time:** ~20 minutes, once.

> ### 🇮🇳 Host it in **India (Bangalore)** — this is not a preference, it changes your prices
>
> CoinDCX refuses connections from outside India. A server anywhere else silently falls back to the
> **global** market (Binance), and on a thin alt-coin the two venues genuinely trade several percent
> apart — so the ₹ and $ on your screen stop matching your CoinDCX app.
>
> The app tells you which happened. Under **Current Price** on any crypto card:
>
> | label | meaning |
> |---|---|
> | `· CoinDCX USDT market` | ✅ what you want — the coin's own CoinDCX book |
> | `· CoinDCX INR pair` | CoinDCX, but this coin has no USDT market (or too little history); the card says which |
> | `· Binance (global), not CoinDCX` | ⚠️ your server can't reach CoinDCX — wrong region |
>
> There's also a one-line summary above the cards: *"✅ all 40 coins priced off CoinDCX's USDT market"*.

---

## Part 1 — Get a free Upstox API app (≈5 min)

Only needed for **stocks, ETFs, indices and commodities**. Crypto works without it.

1. Go to **https://account.upstox.com/developer/apps** and log in.
2. Click **Create New App** (Upstox API is free).
3. Fill in:
   - **App name:** anything (e.g. Growth Intelligence)
   - **Redirect URL:** your app's address + `/callback` — you'll have it after Part 3, so you can
     come back and set this then.
4. Copy the **API Key** and **API Secret** somewhere safe.

---

## Part 2 — Put the code on GitHub (≈5 min)

1. Go to **https://github.com** → sign up (free) or log in.
2. Click the **+** (top-right) → **New repository**.
3. **Repository name:** `growth-intelligence` → **Create repository**.
4. Upload the project files — `server.js`, `paper.js`, `index.html`, `package.json`, and the `test`
   folder. (`index.html` may live at the root or in a `public` folder; both work.)

> ⚠️ **Never upload `token.json`, `positions.json`, `setups.json` or `paper-state.json`.** They hold
> your live broker session and your Telegram chat IDs. `.gitignore` already excludes them — just
> don't add them by hand.

---

## Part 3 — Deploy on DigitalOcean

Two ways. **App Platform** is click-only and redeploys itself on every push. **A Droplet** is a plain
server you update yourself, and is cheaper to run always-on.

Either way, choose the **Bangalore (BLR1)** region. See the box at the top of this page.

### Option A — App Platform (no command line)

1. **https://cloud.digitalocean.com/apps** → **Create App** → **GitHub** → pick `growth-intelligence`.
2. **Region: Bangalore.** Branch `main`, **Autodeploy** on.
3. It detects Node. Leave the build command blank; **Run command** `npm start`.
4. **Settings → App-Level Environment Variables:**

   | Key | Value |
   |-----|-------|
   | `UPSTOX_KEY` | *(your Upstox API Key)* |
   | `UPSTOX_SECRET` | *(your Upstox API Secret)* |
   | `REDIRECT_URI` | `https://YOUR-APP.ondigitalocean.app/callback` |

   Mark the two Upstox values **Encrypt**.
5. **Create Resources.** When it goes live, open the URL.

Pushing to `main` redeploys automatically.

### Option B — Droplet (cheapest always-on)

1. **Create → Droplet → Bangalore (BLR1)**, Ubuntu, the smallest size is plenty.
2. SSH in, then:

```bash
apt update && apt install -y nodejs npm git
git clone https://github.com/YOURNAME/growth-intelligence.git
cd growth-intelligence
```

3. Create `/etc/systemd/system/growth.service` so it starts on boot and restarts on crash:

```ini
[Unit]
Description=Growth Intelligence
After=network.target

[Service]
WorkingDirectory=/root/growth-intelligence
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=80
Environment=UPSTOX_KEY=your_key_here
Environment=UPSTOX_SECRET=your_secret_here
Environment=REDIRECT_URI=http://YOUR_DROPLET_IP/callback

[Install]
WantedBy=multi-user.target
```

4. Start it:

```bash
systemctl enable --now growth
systemctl status growth      # should say active (running)
```

**To update after a push — a Droplet does NOT auto-deploy:**

```bash
cd /root/growth-intelligence && git pull && systemctl restart growth
```

> If a change doesn't appear, this is almost always why. `git log --oneline -1` on the Droplet tells
> you which commit is actually running.

---

## Part 4 — Final link-up & first login

1. Back in your **Upstox app**, set the **Redirect URL** to exactly your address + `/callback`.
   It must match `REDIRECT_URI` character for character, including `https://`.
2. Open your address in any browser (works on your phone too).
3. Click **Login with Upstox** → sign in → approve.

---

## Daily routine (15 seconds)

Brokers expire access every morning for security. Once a day: open the app, click
**Login with Upstox**. Crypto keeps working without it.

---

## If something doesn't work

**Crypto prices don't match my CoinDCX screen**
Check the venue label under **Current Price**. `Binance (global), not CoinDCX` means the server
isn't in India — that's a region problem, not a pricing bug. `CoinDCX INR pair` means that
particular coin has no USDT market or too little history at that timeframe; hover the `ⓘ` and it
says which.

**The price looks frozen**
The clock beside the price shows the age of the last quote that actually landed, and goes amber
past 15s, red past 40s. If it says `browser feed failing, using server`, CoinDCX is rate-limiting
your browser and the app has fallen back on its own.

**A change I pushed isn't showing**
On a Droplet, pull and restart (above). On App Platform, check the deploy actually succeeded.

**Login bounces back to an error**
The Upstox Redirect URL and `REDIRECT_URI` must be the exact same text.

**Stocks are empty but crypto works**
You're not logged in to Upstox, or the market is closed. Both are stated on the page.
