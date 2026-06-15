# Continual Yield-Funded DCA — Build Spec

**What this is:** perpetual basket dollar-cost averaging, funded by recurring re-ups from a pool that earns yield while it waits. Idle pre-DCA capital stays productive (e.g. USDC in Aave) and is drip-fed into MEV-protected TWAP execution on CoW. An agent stitches the yield venue to the execution venue on a recurring cadence, so the DCA never stops.

**Explicitly out of scope:** volatility/sentiment-adjusted sizing, VWAP. Fixed allocations, fixed cadence. The "intelligence" here is operational (keep capital earning until the last moment), not predictive.

---

## Core insight (why this is ~a day and why the agent is load-bearing)

1. **CoW TWAP is both scheduler and executor.** Sign a conditional order once; solvers emit and fill the parts on your interval. No keeper, no cron, no execution algo.
2. **CoW pre-hooks can pull funds from a yield venue at settlement time.** Documented pattern: a pre-hook withdraws collateral from Aave during settlement, before the settlement contract pulls in the sell token. That means idle capital can stay in yield until the exact moment each slice is needed.
3. **TWAP is finite; perpetual DCA needs a loop.** Something must notice the current order nearing completion, absorb newly-arrived budget, and re-up. That loop is the agent — genuinely load-bearing, not decoration.

---

## Architecture

**Model B (canonical target): per-part pre-hook withdrawal.**
Each TWAP part carries a pre-hook that withdraws *just that part's* USDC from the yield vault at settlement. Capital stays in yield across the entire DCA horizon and is drip-fed out part by part. Parts are equal-size, so it's a fixed per-part withdrawal amount. Near-zero yield drag, and the withdrawal rides inside the solver's settlement — no separate withdrawal tx per part. Bonus: the agent's standing privilege shrinks to "sign the next TWAP," because the capital movement is pre-authorised in-settlement rather than executed by the agent at runtime. Smaller attack surface.

**Model A (fallback): withdraw per re-up.**
Agent withdraws the next tranche from the yield vault to USDC in the Safe, then signs a TWAP for that tranche. Capital earns yield until the tranche is released, then sits idle as USDC for that TWAP window. Lumpier, a real frequency tradeoff to tune, but dead simple and no dependency on per-part hook behaviour.

```
            Idle capital in yield vault (aUSDC, earning)
                          │
        ┌─────────────────┴─────────────────┐
   MODEL B                               MODEL A
   per-part pre-hook                     per re-up
        │                                     │
   each TWAP part settlement            agent withdraws next
   triggers Aave withdraw of            tranche → USDC in Safe
   exactly that part's USDC                  │
        │                                signs TWAP for tranche
   solver bundles withdraw + swap            │
        │                                tranche sits idle as
   buy token → Safe                      USDC during its window
        │                                     │
        └─────────────────┬─────────────────┘
                          │
              Basket leg TWAPs (WETH, wBTC, …)
                          │
              Agent: monitor → re-up → repeat (perpetual)
```

---

## Step 0 — the spike (do this FIRST, ~30–60 min)

Everything above pivots on one unverified assumption: **does a parent TWAP's `appData` pre-hook fire on each child part settlement?** Hooks are well-documented for discrete orders; per-part firing on a conditional TWAP is the open question.

- Build a 2-part TWAP on Base with a trivial pre-hook (a cheap, observable call — e.g. a tiny Aave `withdraw`).
- Watch whether the hook executes on **both** parts.
- **Pass → Model B.** **Fail → Model A**, no further investigation needed; the rest of the build is identical downstream of the funding mechanism.

Do not build the funding layer until this resolves.

---

## The agentic loop (load-bearing)

- **Monitor:** parts remaining on the active TWAP, Safe USDC balance, yield-vault balance, accrued yield, incoming budget.
- **Decide:** when the active TWAP is near complete (or fresh budget has landed), size the next tranche — roll accrued yield into it so the DCA budget compounds with what the idle capital earned.
- **Act (bounded):**
  - Model B: construct + sign the next basket TWAPs with the per-part Aave-withdraw pre-hook baked into `appData`.
  - Model A: withdraw the tranche from the vault, then sign the TWAPs.
- **Host:** Scout job. The runtime action surface in Model B is essentially "sign the next order," which is the tight envelope you want.

---

## Envelope (delegation is now properly load-bearing — authority spans two protocols)

Bound each leg independently so a buggy or compromised agent can't exceed the mandate:

- **Yield leg:** designated vault only; withdraw-only (never transfer elsewhere); per-epoch withdrawal cap.
- **Swap leg:** allowlisted buy tokens (basket only); per-epoch spend cap; slippage enforced via each part's limit price; order expiry.
- **Kill:** cancel the conditional order(s) + revoke the session key in one action.

Session key to *act*; caveat enforcers to *constrain*. Model B further reduces standing privilege because the withdrawal is a pre-authorised in-settlement hook, not a live agent capability.

---

## Stack

- **Frontend/host:** Next.js (dashboard) + Scout (agent loop).
- **Wallet:** Safe with the TWAP fallback handler (required for TWAP orders).
- **CoW:** `@cowprotocol/cow-sdk` — `ConditionalOrder`/TWAP construction, `OrderBookApi` for reads, hooks via `appData` (HooksTrampoline executes them). Confirm exact signatures against current docs.
- **Yield venue:** Aave v3 (deep liquidity, battle-tested). aUSDC = principal + accruing interest; withdraw underlying.
- **Network:** Base or Arbitrum (cheap; TWAP part minimum ~$5 vs $1k mainnet; frequent small parts viable).
- **Wallet libs:** viem + wagmi. **Deploy:** Vercel / Cloudflare Pages.

### Pre-hook (illustrative — verify against live SDK/docs)
```ts
// Per-part pre-hook: withdraw exactly one part's USDC from Aave before settlement.
// Parts are equal size, so amount is fixed. The hook call is sent to the Safe,
// which executes the Aave withdraw; ensure approvals + fallback handler are set.
const preHook = {
  target: AAVE_POOL,
  callData: encodeFunctionData({
    abi: aavePoolAbi,
    functionName: 'withdraw',
    args: [USDC, partSellAmount, SAFE_ADDRESS], // asset, amount, to
  }),
  gasLimit: '...',
};
// Attach via order appData; spike confirms it fires on each TWAP part.
```

---

## What "optimal" reduces to

- **Model B:** the optimisation mostly dissolves — many small parts + per-part withdrawal minimises yield drag *and* per-tx cost at once. No real frequency knob left to tune.
- **Model A:** one genuine knob — re-up frequency trades yield-capture against DCA smoothness. More frequent = smoother + more yield captured, but more withdrawal txs.

---

## Day plan (hours)

0. **(0.5–1h)** Spike: per-part hook propagation. Decide Model B vs A.
1. **(1h)** Deploy Safe on Base w/ TWAP fallback handler; fund; deposit idle USDC into Aave; set approvals (Vault Relayer for USDC; withdraw path for the pre-hook).
2. **(2h)** cow-sdk: construct basket leg TWAPs. Model B: bake per-part Aave-withdraw pre-hook into appData. Model A: withdraw-then-sign.
3. **(1.5h)** Envelope: allowlist, per-part limit price, per-epoch caps, session-key scoping.
4. **(2h)** Agent loop in Scout: monitor parts-remaining + budget + accrued yield → size next tranche (compound yield) → sign next TWAPs.
5. **(1.5h)** Dashboard: order/part status from OrderBook API; avg fill price; yield earned; spend vs cap; **net vs just-holding / vs plain DCA**.
6. **(1h)** Live test, small amount, Base; confirm parts fill and (Model B) per-part withdrawal lands.

~9.5–11h — a focused day.

---

## Risks & caveats

- **New failure mode — yield-venue withdrawal liquidity.** Aave withdrawals can stall near 100% utilisation; a per-part pre-hook that can't pull its USDC fails the part. Mitigate with a small USDC buffer in the Safe as a shock absorber, and/or a deep-liquidity venue.
- **Safe + fallback handler required** for TWAP — one-time setup.
- **aToken accounting** — rebasing balance; track principal vs accrued interest for the compounding logic.
- **Stable depeg** on the idle leg; **yield-venue contract risk** (Aave is low, not zero).
- **Adjusting allocations** = cancel + re-sign (fine for v1; not live-editable).
- **This core is commoditised** (CoW native TWAP-DCA, Balmy, 1inch). The differentiation is the yield-idle funding loop + the honest net-vs-baseline accounting, not the DCA itself.

---

## v-next (do not build now)

- Replace any manual signing with a Safe module / ERC-7715 session key for fully hands-off re-ups.
- Multi-venue yield routing (rate-shop the idle pool) — only if a single venue's liquidity proves limiting.
- Net-vs-baseline panel hardened into the trust centrepiece: DCA+yield vs plain DCA vs plain hold, side by side.
