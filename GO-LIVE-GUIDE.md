# Go Live — put your platform on the internet (no command line, all in a browser)

You'll end up with a real web address like **https://growth-intelligence.onrender.com** that you can open
from your laptop or phone. Everything below is done by clicking in a web browser — no Terminal, no Node on
your machine.

**Total time:** ~15–20 minutes, once. Have your `growth-intelligence-pro` folder ready.

> 💡 Pick your app name now. Wherever you see **YOURNAME** below, use the same word every time
> (lowercase, no spaces — e.g. `riddhi-trades`). Your live address will be `https://YOURNAME.onrender.com`.

---

## Part 1 — Get a free Upstox API app (≈5 min)

1. Go to **https://account.upstox.com/developer/apps** and log in.
2. Click **Create New App** (Upstox API is free).
3. Fill in:
   - **App name:** anything (e.g. Growth Intelligence)
   - **Redirect URL:** `https://YOURNAME.onrender.com/callback`  ← use your chosen name
4. Click create. Copy the **API Key** and **API Secret** somewhere safe — you'll paste them in Part 3.

(If Upstox won't let you save that redirect yet, that's fine — you can come back and set it after Part 2.)

---

## Part 2 — Put the code on GitHub (≈5 min, drag & drop)

1. Go to **https://github.com** → sign up (free) or log in.
2. Click the **+** (top-right) → **New repository**.
3. **Repository name:** `growth-intelligence` → keep it **Public** → click **Create repository**.
4. On the next page click the link **“uploading an existing file”**.
5. Open your **growth-intelligence-pro** folder on your computer. Select **everything inside it**
   (server.js, package.json, config.json, README.md, GO-LIVE-GUIDE.md, and the **public** folder) and
   **drag it all onto the GitHub upload page.**
   - Make sure the **public** folder uploads too (it contains index.html). GitHub will show
     `public/index.html` in the list — that means it worked.
6. Click the green **Commit changes**.

✅ Your code now lives on GitHub.

---

## Part 3 — Deploy it on Render (≈5 min)

1. Go to **https://render.com** → **Get Started** → sign up with your **GitHub** account (easiest).
2. Click **New +** → **Web Service**.
3. Find your `growth-intelligence` repo in the list → **Connect**.
4. Fill in the settings:
   - **Name:** `YOURNAME`  (this sets your web address → `https://YOURNAME.onrender.com`)
   - **Region:** Singapore (closest to India)
   - **Branch:** main
   - **Build Command:** leave blank (or `npm install`)
   - **Start Command:** `node server.js`
   - **Instance Type:** **Free**
5. Scroll to **Environment Variables** → **Add Environment Variable**, add these three:

   | Key | Value |
   |-----|-------|
   | `UPSTOX_KEY` | *(paste your Upstox API Key)* |
   | `UPSTOX_SECRET` | *(paste your Upstox API Secret)* |
   | `REDIRECT_URI` | `https://YOURNAME.onrender.com/callback` |

6. Click **Create Web Service**. Render builds it for ~2–3 minutes. When it says **“Live”**, you're up. 🎉

---

## Part 4 — Final link-up & first login

1. Go back to your **Upstox app** (Part 1) and make sure its **Redirect URL** is exactly:
   `https://YOURNAME.onrender.com/callback`  → Save.
2. Open **https://YOURNAME.onrender.com** in any browser (works on your phone too).
3. Click **“Login with Upstox →”**, sign in, approve.
4. You now have **live, broker-matching prices** on the internet. Bookmark the link.

---

## Daily routine (15 seconds)

Brokers expire access every morning for security (true everywhere, not just here). So once a day:

1. Open **https://YOURNAME.onrender.com**
2. Click **Login with Upstox**.

Done for the day.

---

## Good to know about the FREE plan

- **It sleeps after ~15 minutes of no visitors.** The next time you open the link it takes ~30–60 seconds
  to wake up, and you may need to click **Login with Upstox** again. That's normal for free hosting.
- Want it always-on and instant? Render's paid plan (~$7/month) keeps it awake — optional, only if you
  use it heavily.
- Your API keys live **only** in Render's Environment Variables (not in the code on GitHub), so they stay private.

## If something doesn't work
- **Page won't load / "Bad Gateway":** wait 60 seconds (it's waking up) and refresh.
- **Login bounces back to an error:** the Upstox Redirect URL and the Render `REDIRECT_URI` must be the
  **exact same** text, including `https://` and `/callback`. Fix to match and try again.
- **A few stocks show as unavailable:** that's just an occasional data hiccup; the next refresh fixes it.
- Stuck? Send me your Render URL and a screenshot of the error and I'll pinpoint it.

---

This is the honest fastest route to a live, broker-accurate SaaS you control. The daily one-click login is
the only recurring step, and it's a broker security rule no platform can remove.
```
