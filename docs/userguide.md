# Yield-Funded DCA — User Guide

*(working title; "the app" below refers to this tool)*

---

## 1. What this app is, in plain English

This app dollar-cost-averages (DCA) a regular budget into a basket of tokens you choose — buying a little at a time, on a schedule, so you're not betting everything on one moment's price. That part is ordinary.

The thing that makes it different: **the money waiting to be spent doesn't sit idle.** While it waits its turn, your capital earns interest in a lending pool, and it's only pulled out at the exact moment each purchase needs it. So instead of a pile of cash slowly being spent down doing nothing, you have a pile of cash that earns right up until the second it's deployed.

You keep control of your funds throughout — though it's worth being precise about where they sit. At rest, your capital isn't idle in your wallet: it's supplied to a lending pool (Aave), and your Safe holds an interest-bearing token (e.g. aUSDC) that represents your deposit and grows as interest accrues. When it's time to buy, the exact amount each purchase needs is withdrawn from the pool into your Safe, where CoW's solvers take it to settle the swap. Custody stays with you the whole way: the redeemable claim lives in **your own Safe**, and the app holds only a narrow, revocable permission to run the DCA — it can move funds between the pool, your Safe, and your scheduled buys, but it cannot send your money anywhere else, and you can switch it off at any time.

In one line: **continual, hands-off DCA where your un-deployed capital keeps earning yield until the moment it's spent.**

---

## 2. The problem it solves

A normal DCA plan — including the built-in DCA on most platforms — leaves the un-spent portion of your budget doing nothing. If you're averaging $1,000 into the market over a month, on day one most of that $1,000 is just sitting there waiting. That waiting capital is dead weight.

This app puts the waiting capital to work in a yield pool and only withdraws each slice when it's needed. On top of that it:

- **runs continually** — ordinary DCA orders are finite (they buy N times and stop); this one tops itself up and keeps going, and
- **compounds** — the interest your idle capital earns is rolled into future purchases, so your buying power grows over time.

It is an *efficiency* improvement, not a magic money machine. See the honest sizing in Section 5.

---

## 3. How it works (the moving parts, kept simple)

1. **Your wallet (Safe).** Your funds stay in a Safe smart account that you own. The app never takes custody.
2. **Idle capital earns yield.** Your budget is supplied to a lending pool (Aave). In return you hold an interest-bearing token (e.g. aUSDC) whose balance quietly grows over time.
3. **Scheduled buying (CoW TWAP).** On the cadence you set, the app places a TWAP order on CoW Protocol — a single instruction that splits your purchase into many small parts executed at intervals. This reduces price impact and is protected against MEV/front-running.
4. **Just-in-time funding.** Each small part is funded by withdrawing *exactly that part's worth* from the yield pool at the moment it settles — using a CoW "pre-hook" that runs the withdrawal inside the same transaction as the swap. The rest of your money stays earning. (This per-part behaviour is validated during setup; if a deployment can't do it per-part, it falls back to withdrawing one tranche at a time, which earns slightly less.)
5. **Compounding + re-up.** When an order nears completion, the app sizes the next one — folding in the interest earned — and places it. The cycle repeats indefinitely.
6. **Guardrails.** Everything the app can do is fenced by limits you define: which tokens it may buy, how much it may spend per period, the worst price it may accept, and a one-action kill switch.

A note on trust: CoW executes the withdrawal-plus-swap as one atomic step, and you only pay fees if the whole sequence succeeds. Hook execution is carried out by CoW's solvers by convention rather than being forced by the protocol's core contracts — in practice reliable, but worth knowing.

---

## 4. Benefits

- **You keep custody.** Your capital moves only between the lending pool, your Safe, and your scheduled buys — never to any other destination, and the app's permission is revocable.
- **Idle capital earns.** The biggest single difference from ordinary DCA.
- **Better average price.** Splitting the order lowers price impact, and CoW forwards 100% of any price improvement (surplus) back to you.
- **MEV protection.** Orders settle in batches that resist front-running and sandwiching.
- **Hands-off and continual.** Set it once; it tops up and keeps going.
- **Compounding.** Earned interest is rolled into future purchases.
- **Bounded risk.** The app operates only within the limits you set, and you can stop it in one action.

---

## 5. Constraints and things to know (read this)

**Setup requirements**
- **You need a Safe, not a plain wallet.** CoW TWAP requires a Safe smart account with an upgraded "fallback handler." You'll be prompted to do this one-time upgrade; it's a single batched transaction.
- **Recommended on a low-fee chain (Base or Arbitrum).** This keeps minimums tiny and lets you slice finely.

**Minimums**
- **There is a per-part minimum size.** Because every part settles on-chain, each part must clear an execution-cost floor: roughly **$5 per part on Base / Arbitrum / Gnosis**, and substantially higher on Ethereum mainnet (CoW's docs cite figures from ~$1k to ~$5k). On Base this rarely matters, but it does cap how finely you can slice — parts × $5 must be ≤ your budget.
- **No minimum time commitment.** You choose the total horizon (hours, days, weeks, or months). The only practical limit is that parts can't be spaced closer than it takes to settle a batch.

**How much yield to actually expect**
- The gain is roughly *(pool APY) × (average idle balance) × (time)*. At, say, ~5% APY, averaging out a balance over a month captures interest on the average un-deployed amount — real, but modest (think low tens of dollars per $10k that month). It's most worthwhile on **larger balances over longer horizons**, and negligible on small, short runs where it may not beat the added complexity.

**Operational edge cases**
- **Yield-pool withdrawal liquidity.** Lending-pool withdrawals depend on available liquidity; in rare high-utilisation moments a withdrawal can be constrained. A small cash buffer in the Safe absorbs this (see config).
- **Price protection can skip a part.** If you set a minimum price and the market dips below it, that part waits until the price recovers — so a buy can be delayed.
- **Each buy may be a taxable event.** Crypto-to-crypto swaps are disposals in many jurisdictions. This guide is not tax advice; check your local rules or an advisor.

**Risks**
- Smart-contract risk across the Safe, CoW, and Aave (all widely used and audited, but never zero).
- Stablecoin de-peg risk on the idle leg.
- The app is not principal-protected; it buys volatile assets by design.

---

## 6. Setting it up (step by step)

1. **Create or open a Safe on Base.** Use the Safe interface (app.safe.global). If you don't have one, create one and add it to the network.
2. **Fund the Safe** with the stablecoin you'll DCA from (e.g. USDC).
3. **Connect the app** to your Safe and configure your plan (Section 7).
4. **Approve the one-time upgrades and allowances.** You'll be prompted to upgrade the Safe's fallback handler (required for TWAP) and to approve the CoW Vault Relayer and the Aave pool. These are batched to save gas.
5. **Deposit idle capital into the yield pool.** The app supplies your budget to Aave; you'll see it as an interest-bearing balance.
6. **Start the plan and watch the dashboard.** It shows order/part status, average price paid, interest earned, amount spent against your cap, and your performance versus simply holding or plain DCA.
7. **Stopping.** Use the kill switch any time — it cancels the active order and revokes the app's permission in one action. Your funds remain in your Safe.

---

## 7. Configuration reference (the knobs)

- **Basket & weights** — the tokens to buy and their proportions (must sum to 100%).
- **Budget per period** — how much to deploy each cycle.
- **Number of parts** — how many slices each cycle is split into. More parts = smoother averaging and more time in yield, but each part must stay above the ~$5 floor.
- **Total duration / cadence** — the window each cycle runs over, and how often cycles repeat.
- **Price protection (slippage)** — the worst price you'll accept per part. Too tight and parts stall; too loose and you risk poor fills.
- **Per-period spend cap** — a hard ceiling the app cannot exceed.
- **Allowlist** — the only tokens the app may buy (your basket).
- **Cash buffer** — a small reserve kept in the Safe to absorb withdrawal-liquidity hiccups.
- **Compounding** — on/off; whether earned interest is folded into future budgets.
- **Kill switch** — always available.

---

## 8. Worked examples for optimal returns

**The optimisation in one sentence:** returns are best when capital spends the *most time earning yield* and is sliced *finely but above the minimum*, on a *low-fee chain*, with *compounding on*. That means longer horizons, more parts, and Base.

### Example A — "Patient stacker" (near-optimal)
- **Chain:** Base
- **Idle capital:** 10,000 USDC supplied to Aave
- **Basket:** 60% WETH / 40% cbBTC
- **Budget per cycle:** 2,500 USDC/month
- **Parts:** 30 (one per day) → ~83 USDC per part, comfortably above the ~$5 floor
- **Total duration:** 30 days per cycle, repeating
- **Price protection:** 1.0%
- **Cash buffer:** 5% (≈125 USDC)
- **Compounding:** ON

**Why it's near-optimal:** the bulk of the 10,000 USDC stays earning in Aave for most of the month, with only each day's ~83 USDC pulled just-in-time. Thirty parts smooth the average price well; Base keeps per-part costs trivial; compounding rolls the month's interest into the next cycle. This is the configuration where the yield-efficiency advantage is largest.

### Example B — "Lean / small balance" (set expectations)
- **Chain:** Base
- **Idle capital:** 600 USDC
- **Basket:** 100% WETH
- **Budget per cycle:** 200 USDC/month
- **Parts:** 10 (≈20 USDC per part — still well above the floor; avoid going so granular that parts approach $5)
- **Total duration:** 30 days, repeating
- **Price protection:** 1.5%
- **Cash buffer:** 10%
- **Compounding:** ON

**Why this shape:** at small sizes, keep parts comfortably above the minimum and don't over-slice. Be realistic — the yield captured here is a few cents to a few dollars a month. The app still gives you smooth averaging, MEV protection, and hands-off operation, but the yield edge is minor at this scale; the value is mostly the DCA discipline and execution quality.

**Tuning rules of thumb**
- Lengthen the horizon and add parts to capture more yield — until parts approach the $5 floor.
- Set price protection wide enough that parts don't routinely stall, tight enough to avoid bad fills (≈0.5–1.5% is a sensible band for liquid pairs).
- Keep a 5–10% buffer so a withdrawal hiccup never stalls a part.
- Leave compounding on unless you have a reason not to.

---

## 9. Further reading

**CoW Protocol (execution + just-in-time hooks)**
- TWAP orders — how-to: https://docs.cow.fi/cow-protocol/tutorials/cow-swap/twap
- TWAP orders — technical reference: https://docs.cow.fi/cow-protocol/reference/contracts/programmatic/twap
- CoW Hooks — concept: https://docs.cow.fi/cow-protocol/concepts/order-types/cow-hooks
- CoW Hooks — reference (pre/post-hook behaviour): https://docs.cow.fi/cow-protocol/reference/core/intents/hooks
- Building hook dApps: https://docs.cow.fi/cow-protocol/tutorials/hook-dapp
- Flash-loan tutorial (shows the Aave-withdraw pre-hook pattern this app uses): https://docs.cow.fi/cow-protocol/tutorials/cow-swap/flash-loans
- Intro article — TWAP launch: https://cow.fi/learn/cow-swap-launches-twap-orders
- Intro article — getting to grips with TWAP: https://cow.fi/learn/getting-to-grips-with-time-weighted-average-price-twap-orders
- Smart orders with a Safe: https://cow.fi/learn/tutorial-creating-smart-orders-with-cow-protocol

**Safe (your wallet + the fallback handler + agent execution)**
- Safe docs home: https://docs.safe.global/
- Safe{Core} Protocol overview (modules, handlers): https://docs.safe.global/protocol-overview
- AI agent swaps on CoW Swap with a Safe (closest reference implementation): https://docs.safe.global/home/ai-agent-actions/ai-agent-swaps-with-cow-swap
- Safe interface: https://app.safe.global

**Aave (the yield pool)**
- Aave v3 overview: https://aave.com/docs/aave-v3/overview
- Supply / withdraw operations: https://aave.com/docs/developers/aave-v3/markets/operations
- Pool contract reference: https://aave.com/docs/aave-v3/smart-contracts/pool
- aTokens (interest-bearing balances): https://aave.com/docs/aave-v3/smart-contracts/tokenization

---

*This guide describes how the app behaves and how to configure it. It is not financial or tax advice. You retain custody of your funds and full responsibility for the limits you set.*
