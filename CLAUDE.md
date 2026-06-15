# CLAUDE.md — Continual Yield-Funded DCA

Persistent project context. The canonical architecture lives in `docs/ARCHITECTURE.md`; read it before any non-trivial change. This file is the rules; that file is the design.

## What we're building
Perpetual basket DCA funded by recurring re-ups from a yield-earning pool. Idle pre-DCA capital stays in Aave earning interest and is drip-fed into MEV-protected CoW TWAP execution. An agent loop stitches the yield venue to the execution venue so the DCA never stops.

## Prime directive — spike before architecture
**Step 0 (the hook-propagation spike) must pass before any funding code is written.** It decides Model B (per-part pre-hook withdrawal, target) vs Model A (withdraw per re-up, fallback). Record the outcome in `docs/ARCHITECTURE.md`. Do not build the funding layer until this resolves.

## Hard scope — do NOT build
- No volatility/sentiment-adjusted sizing. Fixed allocations.
- No VWAP. TWAP only.
- No live-editable allocations in v1 (changing the basket = cancel + re-sign).
- v1 targets **Base testnet / small amounts only** until explicitly told otherwise.

## Safety rules — non-negotiable (this app moves real funds and signs orders)
- **Secrets:** never commit them. All config via `.env` (gitignored). Private keys never in code, never in logs, never echoed.
- **No real value without explicit approval:** default to Base testnet and sub-$50 amounts. Never sign or broadcast a mainnet / real-value transaction unless I approve it in that same session.
- **The envelope is sacrosanct:** never widen caveat bounds (token allowlist, per-epoch spend cap, slippage limit price, order expiry) to make something pass. If a bound blocks you, STOP and ask.
- **Yield leg is withdraw-only:** never add transfer or approve-to-arbitrary-address logic on the yield vault.
- **Irreversibility:** before anything irreversible (broadcasting a tx, deleting/overwriting files, revoking keys), use AskUserQuestion and show what will happen.

## Tech stack
- TypeScript (strict), Next.js (App Router) for the dashboard.
- `viem` + `wagmi` for wallet/RPC.
- `@cowprotocol/cow-sdk` — `ConditionalOrder`/TWAP construction, `OrderBookApi` reads, hooks via `appData` (HooksTrampoline executes them).
- Safe (Safe{Core} SDK) with the **TWAP fallback handler** installed.
- Aave v3 as the yield venue (aUSDC; withdraw underlying).
- Agent loop hosted in Scout.
- Network: Base first, Arbitrum second.
- Tests: vitest for unit; fork tests against a Base fork (anvil or hardhat) for the funding + hook path.

## Repo structure (target)
```
.
├── CLAUDE.md
├── docs/ARCHITECTURE.md         # canonical design (Model B/A, spike, envelope)
├── .env.example
├── src/
│   ├── config/                  # basket allocations, caps, addresses, network
│   ├── cow/                     # TWAP construction, appData hooks, orderbook reads
│   ├── yield/                   # Aave deposit/withdraw, accrual accounting
│   ├── envelope/                # caveat bounds: allowlist, caps, slippage, expiry, kill
│   ├── agent/                   # monitor → decide (size next tranche) → act (sign)
│   └── safe/                    # Safe deploy/sign, fallback handler setup
├── app/                         # Next.js dashboard
└── test/
    ├── unit/
    └── fork/                    # spike + funding-path fork tests
```

## Commands
(Fill in after scaffold; keep this section current.)
- `pnpm dev` — dashboard
- `pnpm typecheck` — tsc --noEmit
- `pnpm lint`
- `pnpm test` — unit
- `pnpm test:fork` — fork tests (Base)

## Workflow in this repo
- **Explore → Plan → Code → Commit.** Begin non-trivial work in **plan mode**; present the plan and wait for approval before editing.
- Small, single-concern commits with clear messages.
- Before marking any milestone done, have a **fresh-context subagent review the diff** against `docs/ARCHITECTURE.md` and the milestone's acceptance criteria — it should see only the diff and the criteria, not your reasoning.
- If implementation reveals the design is wrong, update `docs/ARCHITECTURE.md` in the same change. Docs and code never diverge silently.

## Definition of done (per milestone — tracks the day plan)
The machine-checkable version lives in `docs/ACCEPTANCE.md` — each milestone collapses to `pnpm verify:mN` printing a sentinel, for use with `/goal`. The list below is the human summary; `docs/ACCEPTANCE.md` is authoritative. Never edit files under `test/acceptance/**` or `scripts/verify-*` to force a pass.

0. **Spike** resolved; Model B/A decision recorded in `docs/ARCHITECTURE.md`.
1. Safe deployed on Base with TWAP fallback handler; idle USDC deposited to Aave; approvals set.
2. Basket TWAP legs construct + sign; Model B: per-part Aave-withdraw pre-hook baked into `appData`.
3. Envelope enforced in code; allowlist / per-epoch cap / slippage limit / expiry present and unit-tested; one-tx kill works.
4. Agent loop runs unattended for N cycles on testnet: monitors parts + budget + accrued yield, sizes next tranche (compounding yield), re-ups.
5. Dashboard shows order/part status, avg fill price, yield earned, spend vs cap, and **net vs plain-DCA / plain-hold**.
6. Live small-amount test on Base passes end-to-end.
