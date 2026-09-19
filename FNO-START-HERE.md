# 📐 Options, from zero

**For someone who has never placed an options trade.** No prior knowledge assumed. By the end you
will understand what you are buying, be able to read the panel, and know exactly what to type into
your broker.

Read it once end to end before you trade anything. It takes about twenty minutes.

> Every number in this guide came out of the platform's own engine, not from a textbook. You can
> reproduce any of them.

---

# Part 0 — Read this part even if you skip the rest

**Options are the fastest way to lose money in the Indian market.** Not because they are a scam, but
because they have three ways to go wrong where a share has one, and most people only ever think
about the first.

Three things are true and you should decide now whether you accept them:

**1. You can be completely right and still lose.** Buy a NIFTY call at 24,000. NIFTY goes UP 150
points over five days — you called the direction correctly. You lose ₹558. That is not a trick
example; it is computed in Part 3 and it is the single most common way beginners are surprised.

**2. Your position size will hurt you more than your analysis.** Options come in fixed lots. One lot
of NIFTY is 75 contracts. You cannot buy "a little bit". On a ₹1,00,000 account, one ordinary option
is often 10–20% of everything you have.

**3. The platform will often tell you "no".** That is the feature. At ₹1,00,000 with sensible risk
settings, most days there will be nothing on NIFTY you can trade. **The correct response is to not
trade**, not to raise your risk setting until something appears.

If you want to trade this week and are hoping the answer is yes — stop here and come back when you
don't.

---

# Part 1 — What an option actually is

Forget the jargon. An option is a **booking fee**.

You pay a small amount now for the **right, but not the obligation**, to buy (or sell) something at
a fixed price, before a fixed date.

> **The flat analogy.** A flat costs ₹50 lakh. You pay the builder ₹50,000 to lock that price for
> three months. That ₹50,000 is your **premium**. ₹50 lakh is your **strike**. Three months is your
> **expiry**.
>
> - Flat rises to ₹60 lakh → you buy at ₹50 lakh. You made ₹10 lakh on a ₹50,000 outlay.
> - Flat falls to ₹45 lakh → you walk away. **You lose the ₹50,000 and nothing more.**
> - Flat stays at ₹50 lakh → you still lose the ₹50,000. **Nothing happening is a loss.**

That last line is the one people miss. Your booking fee decays to zero whether the market goes
against you *or does nothing at all*.

**Two kinds:**

| | You profit when | Called |
|---|---|---|
| **CE** — Call | the index goes **UP** | Call option |
| **PE** — Put | the index goes **DOWN** | Put option |

That's it. CE = you think up. PE = you think down.

## What you are trading

Not shares. An **index** — a number representing the market:

- **NIFTY** — India's top 50 companies
- **SENSEX** — top 30, on the BSE
- **BANKNIFTY** — the big banks

You cannot buy an index. You can buy an option on where it will be on a given date. This platform
covers index options only, which matters for one reason: **they settle in cash.** Nobody delivers
you fifty companies. The difference is paid in rupees and the position disappears.

---

# Part 2 — The eight words you need

Everything on the panel is built from these.

| Word | Plain meaning | Example |
|---|---|---|
| **Strike** | the fixed price you locked in | `24000 CE` = right to buy NIFTY at 24,000 |
| **Premium** | what the option costs, per unit | `120` = 120 points |
| **Lot size** | units you must buy — fixed by the exchange | NIFTY 75, so 120 pts = **₹9,000** |
| **Expiry** | the date it dies | weekly or monthly |
| **ITM / OTM** | already profitable / not yet | NIFTY at 24,000: a 23,900 CE is ITM, a 24,200 CE is OTM |
| **IV** | how much movement the market is charging for | 13% = a normal NIFTY week |
| **Delta** | how much the premium moves per 1 point of index | 0.5 = premium moves 50 paise per index point |
| **Theta** | what you lose per day just from time passing | always against you when buying |

**The one calculation to burn in:**

```
premium (points) × lot size = rupees
        120      ×    75    = ₹9,000
```

Every rupee figure on the panel is that multiplication. When an option is quoted at "120", it costs
₹9,000, not ₹120.

---

# Part 3 — The four ways you lose money

A share has one: it goes down. An option has four, and they can all happen at once.

## Loss 1 — Direction (the one you expected)

You bought a call, the index fell. Straightforward. Everyone anticipates this one.

## Loss 2 — Time ⏳ (the one that quietly does most of the damage)

An at-the-money NIFTY weekly call, 13% IV, and **you do nothing**:

| Days left | Premium | In rupees |
|---|---|---|
| 7 | 172.2 | ₹12,912 |
| 5 | 145.6 | ₹10,916 |
| 3 | 112.8 | ₹8,459 |
| 2 | 92.1 | ₹6,908 |
| 1 | 65.1 | ₹4,885 |
| half a day | 46.1 | ₹3,455 |

**Four days of the market doing absolutely nothing costs you 34% of what you paid.** And it
accelerates — the drop from 7→5 days is ₹2,000; from 1 day→half a day is ₹1,430 in a few hours.

This is why the panel gives you a **time stop with a date on it**. Ignore that date and time will
take the position whether or not you were right.

## Loss 3 — Volatility 📉 (the invisible one)

Options get more expensive when the market expects big moves, and cheaper when it calms down. You
can be right about direction and still lose because the *expectation* of movement collapsed.

> Buy an at-the-money NIFTY call before a big announcement. IV is elevated at 22% — everyone expects
> fireworks. Premium **₹14,315**.
>
> The announcement lands. **NIFTY moves 120 points your way.** But the uncertainty is gone, so IV
> collapses from 22% to 12%.
>
> Your premium is now **₹11,873**. You called it correctly and **lost ₹2,442**.

This is the **IV crush**, and it is why the panel refuses to call options "cheap" just because
they look cheap, and why it warns you when a scheduled event falls before your expiry.

## Loss 4 — Costs 💸 (the one that eats small trades)

Brokerage on options is a **flat ₹20 per order**, whatever the size. So the cheaper the option, the
more of it you are handing over:

| Premium | What one lot costs you | Round-trip charges | Move needed **just to break even** |
|---|---|---|---|
| 5 pts | ₹375 | ₹55 | **+14.8%** |
| 20 pts | ₹1,500 | ₹58 | **+3.8%** |
| 50 pts | ₹3,750 | ₹62 | +1.6% |
| 100 pts | ₹7,500 | ₹69 | +0.9% |
| 200 pts | ₹15,000 | ₹83 | +0.6% |

**The cheap far-away option is the expensive one.** A ₹5 option looks like a lottery ticket with
good odds. It starts nearly **15% under water**. That is the single most common beginner trade and
it is close to the worst one available.

## All four at once — the example that matters

You have ₹9,537 in a NIFTY 24100 call, 7 days left, NIFTY at 24,000. Five days pass:

| What NIFTY does | Premium becomes | Your P&L |
|---|---|---|
| **up 80 points** | 82.8 | **−₹3,327** ❌ |
| **up 150 points** | 119.7 | **−₹558** ❌ |
| **up 250 points** | 186.4 | **+₹4,443** ✅ |

Read that table twice. **NIFTY went up 150 points — you were right — and you still lost money.** Time
took more than direction gave.

This is why the panel checks your target against the **implied move**. If the move you need is bigger
than the move the market is pricing, you are betting on two things at once and being charged for
both.

---

# Part 4 — Reading the panel

Click **📐 Options (F&O)**. Read it in four passes, and **stop at the first pass that fails**. Don't
skip ahead to the exciting numbers.

## Pass 1 — Can I afford to be wrong? 🛑

Find **Worst case**. Compare it to your capital. That's the whole pass.

> Real example from this dashboard: a SENSEX straddle, worst case **₹18,065**, on **₹1,00,000** of
> capital. That is **18% of the entire account on one trade**. Five of those in a row and there is
> no account.
>
> It got offered because the risk setting was on **20%**. At 2%, nothing would have been offered —
> and that silence would have been the right answer.

**Set Risk / trade to 2%.** Three percent if you are experienced and know why. Never twenty.

## Pass 2 — What does the market expect, and what do I need?

| Tile | What it tells you |
|---|---|
| **Forward** | where the market expects the index at expiry — not today's price |
| **ATM implied vol** | the volatility being charged (NIFTY: ~10–15% is normal) |
| **Implied move** | how far the market expects it to travel by expiry |
| **Time left** | days to expiry |
| **Breakevens** | **you make nothing between these two numbers** |

Then do the only arithmetic that matters:

```
How far is my breakeven from the forward?
Is that further than the implied move?

    Further  →  you need the market to be wrong about volatility AND direction.
                Two bets. You are paying for both.
    Closer   →  reasonable.
```

Fill in the **Target level** box and the panel does this for you, in words.

## Pass 3 — Is this board even real right now? 🚦

Any single one of these means **wait**:

| Warning | What it means |
|---|---|
| price is stale / after 3:30 PM | market closed. Prices are memories. |
| **Median spread** above ~5% | you lose that much crossing in and out |
| **Forward: loose** or **suspect** | strikes disagree on where the index is |
| **backwardation** | something specific is expected before expiry |
| "Cost rates are unverified" | fix it once — see Part 7 |

Options only quote properly between **09:15 and 15:30 IST**, and even then the first and last few
minutes are unreliable. **The best time to look is roughly 10:00 AM to 2:30 PM.**

## Pass 4 — The plan

Only if the first three passed.

- **Entry** — a limit price per leg, and a "never pay above" ceiling
- **Stop** — given twice: the **index level** where your idea is dead, and the **premium** that implies
- **Targets** — with the net rupees after costs
- **Time stop** — a date. Out by then, working or not.
- **Exit rules** — in priority order
- **What kills this trade** — including the ways that aren't about direction

### Why the stop is given as an index level

If the panel says *"place the stop at 16.64 — but understand it represents the index reaching
23,563"*, it is telling you something important:

**A percentage stop on a premium is not a stop, it's a decay detector.** A weekly option can shed
30% over a weekend with the index unchanged. You would be closing a perfectly good position because
time passed. The index level is what your idea actually depends on.

---

# Part 5 — Actually placing the trade

You need a broker account with F&O enabled (Zerodha, Upstox, Angel One, Groww — any of them).
**This platform does not place orders.** It tells you what to place; you type it in yourself. That
separation is deliberate.

## Step 1 — Find the contract

Your broker's search wants the same four things the panel shows:

```
   NIFTY      25 SEP      24000       CE
   ─────      ──────      ─────       ──
   index      expiry      strike     type
```

Match all four to the panel exactly. **Check the expiry date twice** — buying the wrong week is the
most common and most avoidable beginner error.

## Step 2 — Set quantity

Brokers ask for quantity in **lots** or in **units**, and they are not the same:

- panel says **1 lot** → enter `1` in a Lots box, or `75` in a Quantity box (for NIFTY)
- **your panel shows the correct lot size** — read it there, don't rely on memory. The exchange
  changes it.

## Step 3 — LIMIT, never MARKET ⚠️

| | |
|---|---|
| ❌ **Market order** | fills at whatever price exists. On a thin option that can be far worse than the screen. |
| ✅ **Limit order** | fills at your price or not at all |

**Always LIMIT.** Type the limit price the panel gives you. If it doesn't fill in a couple of
minutes, the price moved — re-run the panel rather than chasing it upward.

## Step 4 — Product type

| Choose | Means |
|---|---|
| **NRML** / **Carry forward** | you can hold past today ✅ |
| MIS / Intraday | broker force-closes it around 3:20 PM ❌ |

Use **NRML** unless you genuinely intend to be out the same day. An MIS position closed at 3:20 by
your broker is a loss you did not choose.

## Step 5 — Multi-leg structures

If the panel gives you two or four legs (a spread, a condor), **place them as one basket order** if
your broker supports it (Zerodha calls it a Basket, others "multi-leg" or "strategy").

If you must place them one at a time: **buy the protective leg first.** Legging in the wrong order
on a moving market can leave you briefly holding a naked short — which has no floor under it.

## Step 6 — Put the stop in immediately

Place your stop-loss order **the moment the entry fills**, not later. "I'll watch it" is how a
₹9,000 loss becomes a ₹25,000 one.

Use an **SL-Limit** order at the premium the panel gave you.

---

# Part 6 — After you're in

Check once or twice a day. Not once a minute — options move fast and staring at them makes people
act badly.

**Close when any of these happens. First one wins.**

| Trigger | What to do |
|---|---|
| 🎯 **Target hit** | Take it. Don't wait for more. |
| 🛑 **Index hits your stop level** | Out. Your idea was wrong. |
| 📅 **Time-stop date arrives, nothing happened** | Out. You are paying rent on a view that isn't happening. |
| 📰 **Event passes (if you were long)** | Out, whichever way it went — the IV crush is coming. |
| 📆 **Expiry approaching, in profit** | Sell it. Don't let it settle. |

## The three that will actually get you

**"It'll come back."** A share might. **An option has a deadline.** That is the entire difference,
and it is why the time stop exists.

**Averaging down.** Buying more of a losing option turns a survivable loss into a serious one. On
options, never.

**Raising the risk setting until something appears.** If the panel says nothing fits, the answer is
no trade today. Changing the setting doesn't change the risk — it just hides it from yourself.

---

# Part 7 — Do these once, before your first trade

## ✅ Set your risk properly

At the top of the dashboard:

- **Capital ₹** — what you can genuinely afford to lose. Not your savings.
- **Risk / trade %** — set it to **2**.

Expect to see *"nothing here fits your capital"* often. **That is the system working.**

## ✅ Verify the cost rates (five minutes, highest-value thing you can do)

The platform ships tax and brokerage rates it could not verify. Every net-profit figure depends on
them.

1. Place any one small trade with your broker, or open an old contract note
2. Compare its total charges against `http://localhost:5180/api/fno/costs?price=100&qty=75`
3. Match? Open `fno-costs.json`, set `"verified": true`
4. Don't match? Edit the rate that's wrong

The warning on the panel disappears when you've done it.

## ✅ Know what ₹1,00,000 actually buys

| Risk setting | Budget per trade | Outright options you can buy |
|---|---|---|
| **2%** | ₹2,000 | only a 20-point option (which needs +3.8% to break even) |
| 5% | ₹5,000 | up to 50 points |
| 10% | ₹10,000 | up to 100 points |
| 20% | ₹20,000 | up to 200 points — **and one bad week costs a fifth of your account** |

**This is the honest picture: ₹1,00,000 is not really enough to trade NIFTY options outright at safe
risk.** Anyone telling you otherwise is selling something.

**But spreads change the maths.** A bull call spread — buy one strike, sell a higher one — risks
₹5,091 per lot instead of ₹12,912, because the strike you sell pays for part of the one you buy. The
panel ranks spreads first for exactly this reason. **If you have a small account, trade spreads.**

## ✅ Paper trade first

Ten trades on paper before one with money. Write down for each: what you expected, what happened,
why. You are not testing the platform. You are finding out whether you can follow a stop when it
hurts — which is the actual skill.

---

# Part 8 — The one-page checklist

Print this. Use it every single time.

```
BEFORE
  □ Market open? (09:15–15:30 IST, best 10:00–14:30)
  □ Risk setting is 2%
  □ Worst case is under 2% of my capital
  □ No red warnings: stale price, wide spread, loose forward
  □ My target is INSIDE the implied move
  □ I can say in one sentence why I expect this move

PLACING
  □ Right index, right expiry, right strike, right CE/PE
  □ LIMIT order, at the panel's price
  □ NRML (not MIS)
  □ Quantity = lots the panel says
  □ Multi-leg → basket order, or protective leg first
  □ Stop-loss placed immediately after the fill

AFTER
  □ Time-stop date written down
  □ Out at: target, stop, time stop, or post-event
  □ Never average down
  □ Never move a stop further away
```

---

# What this platform is, and is not

**It is** a decision-support tool that does arithmetic you would get wrong by hand: real costs, real
breakevens, real position sizes, and a plan with an exit.

**It is not** a prediction. Every number on it is *what the market is currently pricing*, not what
will happen. It has no idea what the market will do — nobody does. Its actual value is telling you
when a trade is **priced to lose even if you are right**, and when a position is **too big for your
account**.

**It cannot place orders and will never be able to.** You type them in. If a trade feels wrong, don't
take it — no amount of green on a screen makes a trade mandatory.

**Nothing here is investment advice.** F&O profit in India is taxed as business income at your slab
rate, and losses carry forward eight years if you file on time. Talk to a CA once you are trading
regularly.

---

## If you remember only five things

1. **Premium × lot size = rupees.** An option quoted at 120 costs ₹9,000.
2. **You can be right about direction and still lose** — time and volatility take their cut first.
3. **Doing nothing costs money.** 34% of your premium over four quiet days.
4. **The cheap option is the expensive one.** A 5-point weekly needs a 15% move to break even.
5. **When the panel says nothing fits — that's the answer.** Don't negotiate with it.

---

**Next:** [`FNO-GUIDE.md`](FNO-GUIDE.md) explains *why* the numbers are what they are — the forward,
the expiry decision, what the volatility read refuses to say, and how it's built.
