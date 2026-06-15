# Developer Guide — Yield-Funded DCA

End-to-end setup, every dependency, and the options for running it as an AI agent.

## How this fits with the other docs
- `docs/ARCHITECTURE.md` — the design (Model B per-part JIT withdrawal, Model A fallback, the spike). **Canonical.**
- `CLAUDE.md` — rules + safety envelope for building with Claude Code.
- `docs/ACCEPTANCE.md` — machine-checkable completion gates for `/goal`.
- `userguide.md` — end-user facing.
- **This file** — how a developer stands the whole thing up and wires the agent.

---

## 1. Architecture in one screen

Idle capital sits in Aave (Safe holds aUSDC). On a schedule the app places a CoW **TWAP** order split into N parts. In **Model B** each part carries a pre-hook that withdraws exactly that part's USDC from Aave at settlement, so capital stays earning until the last moment; the CoW solver then pulls the USDC from the Safe to settle the swap. An **agent loop** monitors the active order and re-ups perpetually, compounding accrued yield. Everything is fenced by a delegation/permission envelope. **Model A** (withdraw a whole tranche per re-up) is the fallback if the per-part hook doesn't fire — that's what the Step 0 spike decides.

---

## 2. Prerequisites

- **Node.js 20 LTS+** and **pnpm** (`corepack enable`).
- **git**.
- **Foundry** (`anvil` for fork tests) — or Hardhat if you prefer.
- A wallet you control (e.g. MetaMask) to own/operate the Safe.
- **Base RPC URL** (Alchemy/Infura/public) and a **Base Sepolia** URL for testnet.
- Test funds: Base Sepolia ETH (gas) + test USDC.
- **A Safe on Base** — created during setup if you don't have one.
- *(Optional)* **Claude Code** (`npm i -g @anthropic-ai/claude-code`) if you want agent-assisted build via `CLAUDE.md` + `/goal`.

---

## 3. Dependencies (what each is for)

**Core SDKs**
- `@cowprotocol/cow-sdk` (**v7+**) — umbrella. Exposes `TradingSdk`, `OrderBookApi`, `ConditionalOrder` (programmatic/TWAP orders), `MetadataApi`, `CowShedSdk`. v7 uses an **adapter pattern**.
- `@cowprotocol/sdk-viem-adapter` — the `ViemAdapter`. Lets the SDK run on **viem**, matching Safe's stack (no more ethers/viem split). Ethers adapters exist too (`@cowprotocol/sdk-ethers-v6-adapter`) if needed.
- `@safe-global/protocol-kit` — deploy/configure the Safe, set the fallback handler, build/sign transactions (viem-based).
- `@safe-global/api-kit` — Safe Transaction Service (propose/collect signatures) if threshold > 1.
- `viem` — RPC, accounts, encoding. The common layer.

**Aave (yield leg)** — no heavy SDK required; call the Pool directly with viem.
- `@bgd-labs/aave-address-book` — typed Pool/asset/aToken addresses per network (or copy addresses from the Aave docs).

**Frontend (dashboard)**
- `next`, `react`, `react-dom`
- `wagmi` + `@tanstack/react-query` — wallet connection; `ViemAdapter` can take a wagmi `walletClient`.

**Dev / test**
- `typescript`, `tsx` (run TS directly)
- `vitest` — unit tests
- `foundry` (anvil) for fork tests — or `hardhat`
- `eslint`, `prettier`, `dotenv`

**Install**
```bash
pnpm add @cowprotocol/cow-sdk @cowprotocol/sdk-viem-adapter \
         @safe-global/protocol-kit @safe-global/api-kit viem \
         @bgd-labs/aave-address-book
pnpm add next react react-dom wagmi @tanstack/react-query
pnpm add -D typescript tsx vitest eslint prettier dotenv
# Foundry (fork tests): curl -L https://foundry.paradigm.xyz | bash && foundryup
```
> API surfaces move. Treat all snippets below as illustrative and confirm exact exports/signatures against the linked docs before relying on them — especially `ConditionalOrder`/TWAP and the appData hook shape.

---

## 4. Setup, start to finish

### Step 0 — repo + context files
```bash
git init yield-dca && cd yield-dca
# add CLAUDE.md, docs/ARCHITECTURE.md, docs/ACCEPTANCE.md, .env.example, .gitignore
cp .env.example .env   # fill in; never commit .env
pnpm install
```

### Step 1 — config
Put network, addresses, basket, and envelope values in `.env` and `src/config`. Pull Aave/asset addresses from `@bgd-labs/aave-address-book`; keep caps and the basket allowlist in code so they're testable.

### Step 2 — adapter + clients
```ts
import { TradingSdk, OrderBookApi, SupportedChainId } from '@cowprotocol/cow-sdk'
import { ViemAdapter } from '@cowprotocol/sdk-viem-adapter'
import { createPublicClient, http, privateKeyToAccount } from 'viem'
import { base } from 'viem/chains'

const adapter = new ViemAdapter({
  provider: createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) }),
  signer: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`), // dev: throwaway key only
})
const sdk = new TradingSdk({ chainId: SupportedChainId.BASE, appCode: 'yield-dca' }, {}, adapter)
const orderBook = new OrderBookApi({ chainId: SupportedChainId.BASE })
```

### Step 3 — Safe + fallback handler (required for TWAP)
Create the Safe (Protocol Kit or app.safe.global) and **upgrade the fallback handler** — CoW TWAP won't run without it. The CoW UI prompts a `setFallbackHandler` batched into signing; programmatically, do it via Protocol Kit. Threshold = 1 if the agent will sign autonomously (see §5).

### Step 4 — approvals
- Approve the **CoW Vault Relayer** to spend the sell token (USDC) up to `n × partSellAmount`.
- Approve the **Aave Pool** for supply.
- Ensure the Safe can execute the pre-hook's Aave `withdraw` at settlement (fallback handler + the hook call routed through the Safe).

### Step 5 — supply idle capital to Aave
```ts
// Pool.supply(asset, amount, onBehalfOf=safe, referralCode=0) → Safe receives aUSDC
// balanceOf(aUSDC) returns principal + accrued interest over time.
```

### Step 6 — run the spike (gate)
`pnpm verify:m0` — 2-part TWAP on a Base fork with an observable pre-hook; confirm whether the hook fires on **each** part. Record `SPIKE_RESULT=B|A` in `docs/ARCHITECTURE.md`. **Do not build funding logic before this resolves.**

### Step 7 — order construction
Build one `ConditionalOrder` (TWAP) per basket leg: equal parts, `minPartLimit` from your slippage, interval and count from the cadence. **Model B:** put the per-part Aave-withdraw pre-hook in `appData` (amount == `partSellAmount`). The full appData (with hooks) **must be posted to the OrderBook** or the hooks won't be included in settlement.

### Step 8 — envelope
Enforce caveat bounds in code (and ideally on-chain — §5C): token allowlist, per-epoch spend cap, slippage limit price, expiry, one-tx kill (cancel conditional order). Cover with the negative tests in `verify:m3`.

### Step 9 — agent loop
Monitor parts-remaining (OrderBookApi) + Safe/aUSDC balances + accrued yield → size next tranche (compound) → place next TWAP(s). Host per §5.

### Step 10 — dashboard + test
`pnpm test` (unit) and `pnpm test:fork`, then a small live run on Base with `DRY_RUN=false` only after sign-off. Dashboard reads order/part status and shows net-vs-baseline.

---

## 5. Options for running it as an AI agent

**First, what the agent must actually do.** CoW's watchtower emits and solvers settle the TWAP parts automatically — you do **not** run a keeper for parts. The agent's only job is the **re-up loop**: detect the active order nearing completion, size the next tranche (compounding yield), and place the next order. In Model B the capital movement is an in-settlement pre-hook, so the agent's runtime action is essentially "sign/post the next order" — a deliberately small privileged surface.

### Authority models (least-privilege spectrum)

**A. Threshold-1 Safe + dedicated agent EOA owner** — *simplest.* The agent key is an owner of a 1-of-1 Safe and signs autonomously. This is exactly Safe's documented AI-agent-on-CoW pattern. **Trade-off:** the agent key effectively controls the whole Safe; compromise = full loss. Fine for testnet and small balances.

**B. Scoped session key** — the agent holds a key authorised only for specific actions (place CoW orders on allowlisted tokens, withdraw from the designated Aave reserve), with a spend cap and expiry. Smaller blast radius than A.

**C. ERC-7710/7715 delegation + caveat enforcers** — *most robust.* Bound the authority **on-chain**: yield leg = withdraw-only + per-epoch cap; swap leg = allowlist + per-epoch cap + slippage + expiry; single-action revoke. A buggy or compromised agent still can't exceed the mandate. Pairs naturally with Model B (standing privilege ≈ "sign next order").

**D. Safe module** — a policy module installed on the Safe enforces the bounds at the account level (the Rhinestone/Safe7579 module ecosystem). Good if you want the envelope enforced by audited module code rather than your own.

**CoW Shed** — `CowShedSdk` gives an EOA "smart-contract capabilities" if you want to avoid a full Safe. Note TWAP still needs the conditional-order framework on a SC wallet; **Safe is the proven path** — treat CoW Shed as an alternative to evaluate, not the default.

**Recommendation:** build on **A** for testnet, design the code so the envelope is explicit, then graduate to **C** (or **D**) before any mainnet/real-value run. Never widen the envelope to make something pass.

### Hosting / triggering
- **Scout job** (your existing infra) — natural home for the monitor→re-up loop.
- **Cron / keeper** — GitHub Actions, a serverless function, or a small VPS on an interval.
- **Event-driven** — subscribe to order-completion / low-balance events and trigger a re-up.
Whatever the host: the loop is low-frequency (re-up per cycle), not a per-block keeper.

### Building it *with* an AI agent (Claude Code)
`CLAUDE.md` is loaded every session; `docs/ACCEPTANCE.md` defines `pnpm verify:mN` gates for `/goal`. Run **spike-first** in plan mode, enable auto mode for unattended runs, deny-edit `test/acceptance/**` and `scripts/verify-*`, and keep `DRY_RUN=true` — `/goal` must never include a real-value broadcast (M6 is manual).

### Agent security checklist
- Keys in `.env`/KMS, never in code or logs; production uses a scoped key or module (§5B–D), not a raw owner key.
- `DRY_RUN=true` and **testnet first**; real value only behind an explicit human gate.
- The envelope is the trust boundary — enforce it, test it with negative cases, make it revocable.
- Never run Claude Code with `--dangerously-skip-permissions` against real funds.

---

## 6. Reference

**CoW SDK**
- npm (v7, adapters): https://www.npmjs.com/package/@cowprotocol/cow-sdk
- SDK modules reference: https://docs.cow.fi/cow-protocol/reference/sdks/cow-sdk/modules
- Trading SDK: https://www.npmjs.com/package/@cowprotocol/sdk-trading
- Order Book package: https://github.com/cowprotocol/cow-sdk/blob/main/packages/order-book/README.md

**CoW Protocol**
- TWAP how-to: https://docs.cow.fi/cow-protocol/tutorials/cow-swap/twap
- TWAP reference (struct): https://docs.cow.fi/cow-protocol/reference/contracts/programmatic/twap
- Hooks (concept): https://docs.cow.fi/cow-protocol/concepts/order-types/cow-hooks
- Hooks (pre/post-fill behaviour): https://docs.cow.fi/cow-protocol/reference/core/intents/hooks
- Aave-withdraw pre-hook example: https://docs.cow.fi/cow-protocol/tutorials/cow-swap/flash-loans

**Safe**
- Docs: https://docs.safe.global/
- Protocol overview (modules/handlers): https://docs.safe.global/protocol-overview
- AI agent swaps on CoW Swap (reference impl): https://docs.safe.global/home/ai-agent-actions/ai-agent-swaps-with-cow-swap
- App: https://app.safe.global

**Aave**
- v3 overview: https://aave.com/docs/aave-v3/overview
- Supply/withdraw operations: https://aave.com/docs/developers/aave-v3/markets/operations
- Pool contract: https://aave.com/docs/aave-v3/smart-contracts/pool
- aTokens: https://aave.com/docs/aave-v3/smart-contracts/tokenization

---

## 7. Troubleshooting / gotchas

- **TWAP rejected / nothing executes** → the Safe's fallback handler isn't upgraded. Set it (Step 3).
- **Hooks ignored at settlement** → the full appData including hook info must be posted to the OrderBook with the order; hooks are referenced via appData. Also: hook execution is by solver social consensus, not enforced by core contracts — generally reliable, not guaranteed.
- **Pre-hook fired once, not per part** → CoW's rule is that on a *partially fillable* order, pre-hooks run only on the first fill (post-hooks run every fill). TWAP **parts are discrete orders** (each a full fill), which is why per-part pre-hooks *should* work — but this is exactly what the Step 0 spike verifies. If it fails, switch to Model A.
- **Part below minimum** → each part must clear ~$5 on Base (≫ on mainnet). Reduce part count or raise tranche size.
- **Aave withdraw reverts** → reserve utilisation/liquidity. Keep a USDC buffer in the Safe; size parts against available liquidity.
- **Parts stalling** → price protection (`minPartLimit`) too tight for current market; widen slightly.
- **Adapter errors** → in cow-sdk v7 you must set an adapter (ViemAdapter) or `setGlobalAdapter`; v6-style calls without an adapter will fail.
