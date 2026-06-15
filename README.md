# Eddy — Continual Yield-Funded DCA

Perpetual basket dollar-cost averaging, funded by recurring re-ups from a pool that earns yield while it waits. Idle pre-DCA capital stays in **Aave** (earning interest) and is drip-fed into **MEV-protected CoW TWAP** execution. An agent loop stitches the yield venue to the execution venue so the DCA never stops.

The "intelligence" here is **operational, not predictive**: keep capital earning until the last moment, then fund each TWAP slice just-in-time. The differentiation is the yield-idle funding loop + honest **net-vs-baseline** accounting — not the DCA itself.

> ⚠️ **v1 is testnet / small-amounts only.** It moves real funds and signs orders. Every automated gate runs against a local fork with `DRY_RUN=true` and refuses `DRY_RUN=false`. The only real-value step (M6) is **manual** — see [`docs/M6_RUNBOOK.md`](docs/M6_RUNBOOK.md).

## How it works (Model B)

A single CoW **TWAP conditional order** is signed once; solvers emit and fill its parts on an interval — no keeper, no cron. Each part carries a **pre-hook** that withdraws *just that part's* USDC from Aave at settlement (executed *as the Safe* via a constrained withdraw-only module), so capital stays in yield until the exact moment a slice is needed. An agent loop notices the active order nearing completion, rolls accrued yield into the next tranche, and re-ups.

The funding model (Model B = per-part pre-hook withdrawal) was chosen by the **Step-0 spike** ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)). Whether a *production solver* actually fires the per-part hook is the one thing a fork can't prove — it's confirmed in the manual M6 live test.

## Stack

- **TypeScript (strict)**, **viem** for wallet/RPC, **`@cowprotocol/cow-sdk`** for appData/hooks.
- **Safe** (threshold-1) with the **ExtensibleFallbackHandler** + ComposableCoW domain verifier ("TWAP fallback handler").
- **Aave v3** as the yield venue (aUSDC; withdraw underlying), plus a small **withdraw-only Safe module** (`contracts/AaveWithdrawModule.sol`) that the per-part pre-hook calls.
- **Next.js 15 / React 19** (App Router) dashboard.
- **vitest** for unit + component tests; **anvil** (Foundry) fork tests against a pinned **Base mainnet** block for the funding/hook path.
- Network: **Base** first.

## Milestone status

| # | Milestone | Gate | Status |
|---|-----------|------|--------|
| M0 | Hook-propagation spike → Model B | `pnpm verify:m0` | ✅ |
| M1 | Safe + Aave funded; approvals | `pnpm verify:m1` | ✅ |
| M2 | Basket TWAP construct + sign; executable per-part pre-hook | `pnpm verify:m2` | ✅ |
| M3 | Envelope enforcement (rejections) + one-tx kill + per-call cap | `pnpm verify:m3` | ✅ |
| M4 | Agent loop, N cycles, compounding yield ≤ cap | `pnpm verify:m4` | ✅ |
| M5 | Dashboard + net-vs-baseline math | `pnpm verify:m5` | ✅ |
| — | All milestones | `pnpm verify:all` → `ACCEPTANCE ALL (M0-M5) PASS` | ✅ |
| M6 | Live small-amount E2E | **manual** ([runbook](docs/M6_RUNBOOK.md)) | ⏳ pending |

Each milestone collapses to a `verify:mN` script that runs the relevant tests, independently re-validates the bounds from `.env`/`src/config` (anti-gaming), and prints `ACCEPTANCE MN PASS` only on success. The machine-checkable criteria live in [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).

## Prerequisites

- **Node ≥ 22.13** — pinned pnpm requires it. If you use nvm: `nvm install 22 && nvm use 22`.
- **pnpm** `9.15.4` (pinned via `packageManager`; `corepack enable` resolves it).
- **Foundry** (`anvil` + `forge`) — fork tests + the Solidity module. Install via `foundryup`.
- An **archive-capable Base RPC** URL (fork tests read state at a pinned historical block).

## Setup

```bash
nvm use 22                       # Node ≥ 22.13
pnpm install
cp .env.example .env             # then fill BASE_RPC_URL (archive Base RPC)
```

`.env` keys (see `.env.example`): `BASE_RPC_URL` (required), `AGENT_PRIVATE_KEY` (throwaway/testnet only), envelope bounds (`MAX_SPEND_PER_EPOCH_USDC`, `MAX_SLIPPAGE_BPS`, `MAX_ORDER_TTL_SECONDS`, `ALLOWED_BUY_TOKENS`, `USDC_BUFFER`, `EPOCH_BUDGET_USDC`, `PARTS`), `DRY_RUN=true`. Addresses default from `src/config/addresses.ts`; `FORK_BLOCK` pins the fork (default `47300000`).

## Commands

```bash
pnpm typecheck        # tsc --noEmit (node src/ + DOM app/ via tsconfig.app.json)
pnpm test             # unit tests (envelope rejections, net-vs-baseline math)
pnpm test:fork        # all fork tests (spins up an anvil Base fork per file)
pnpm test:component   # dashboard component smoke test (jsdom)
pnpm build:contracts  # forge build (AaveWithdrawModule)
pnpm dev              # Next.js dashboard (dev server; not part of the gate)

pnpm verify:m0 … m5   # per-milestone acceptance gate (prints ACCEPTANCE MN PASS)
pnpm verify:all       # run M0→M5 in order → ACCEPTANCE ALL (M0-M5) PASS
```

Fork tests need `BASE_RPC_URL` set and `anvil` on PATH; they're deterministic (pinned block, fixed salts) and absorb transient RPC flakiness via retry.

## Repo layout

```
src/
  config/    basket allocations, envelope bounds, network addresses
  cow/       TWAP construction, appData pre-hooks, ComposableCoW, order digest/UID
  yield/     Aave supply/withdraw (withdraw-only)
  envelope/  caveat-bound validation (allowlist/cap/slippage/expiry)
  agent/     monitor → decide (size tranche) → act (sign next TWAP)
  safe/      Safe deploy, exec, module enable, ERC-1271
  dashboard/ net-vs-baseline accounting (pure)
app/         Next.js App Router dashboard (presentational components)
contracts/   AaveWithdrawModule.sol (withdraw-only Safe module)
test/        unit/ + component/ + fork/ (anvil)
scripts/     verify-*.sh acceptance sentinels (immutable)
docs/        ARCHITECTURE · ACCEPTANCE · DEVELOPER_GUIDE · userguide · M6_RUNBOOK
```

## Safety model (the envelope)

A buggy or compromised agent cannot exceed its mandate:

- **Yield leg:** designated vault only; **withdraw-only** (never transfer/approve-to-arbitrary); per-call withdrawal cap on the module.
- **Swap leg:** allowlisted buy tokens (basket only); per-epoch spend cap; slippage enforced via each part's limit price; order expiry.
- **Kill:** cancel the conditional order in one tx (`ComposableCoW.remove` as the Safe).
- **No real value** without explicit, same-session sign-off; bounds are never widened to make a check pass.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — canonical design (Model B/A, spike outcome, envelope).
- [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) — machine-checkable milestone criteria.
- [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md) · [`docs/userguide.md`](docs/userguide.md) — build/usage notes.
- [`docs/M6_RUNBOOK.md`](docs/M6_RUNBOOK.md) — the manual live-test checklist (the only real-value step).
