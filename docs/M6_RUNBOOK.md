# M6 — Live small-amount E2E (MANUAL runbook)

> **This is the only real-value action in the project.** It is **not** a `/goal`, has **no sentinel**, and must **never** run inside an autonomous loop. Acceptance is this human checklist. The agent cannot run M6 for you: every `verify:*` gate refuses `DRY_RUN=false`, and broadcasting real value requires your explicit, same-session sign-off (CLAUDE.md safety rules).

## 1. Why M6 exists — what it actually proves
M0–M5 proved everything that can be proven deterministically on a fork:
- appData pre-hook **propagates** to every TWAP part (M0), and the hook **executes** when driven (M2);
- the Safe/Aave/approvals/envelope/loop/accounting all work.

What a fork **cannot** prove — and what M6 confirms — is the **behavioral half**: that a **production CoW solver actually fires the per-part Aave-withdraw pre-hook on each part at settlement**. Hooks are an off-chain solver convention, not enforced on-chain (see `docs/ARCHITECTURE.md` Step 0 caveat). M6 is the first and only time a real solver settles our parts.

**If the solver does NOT honor the per-part hook, Model B is invalidated** and the funding leg must fall back to Model A (agent withdraws per re-up). Treat M6 as a go/no-go test of Model B, not a formality.

## 2. Hard safety rules (non-negotiable)
- [ ] **Explicit sign-off, same session**, before any `DRY_RUN=false` broadcast.
- [ ] **Sub-$50 total**; deploy only what you can lose.
- [ ] **Throwaway key** in `.env` (`AGENT_PRIVATE_KEY`) — never a key holding real balances elsewhere. Never logged/echoed/committed.
- [ ] **Envelope unchanged** — do not widen allowlist / cap / slippage / expiry for the live run. The `.env` bounds are the mandate.
- [ ] **Kill switch ready** before you start (see §7). Know how to cancel in one tx.
- [ ] **Yield leg withdraw-only** — no new transfer/approve-to-arbitrary on Aave.

## 3. Decide the network FIRST (the load-bearing prerequisite)
M6 needs a chain where **all three** are live simultaneously: **Aave v3** (USDC market), the **CoW stack** (watch-tower that posts conditional-order parts to the orderbook **+ solvers** that settle them and honor hooks), and the **Safe** contracts.

| Option | Real value? | Solvers/watch-tower | Aave v3 | Addresses |
|---|---|---|---|---|
| **Base mainnet, tiny (~$10–20)** *(recommended)* | Yes (small) | ✅ live | ✅ live | ✅ match `src/config/addresses.ts` as-is |
| Base Sepolia | No (test funds) | ⚠️ **unconfirmed** (CoW watch-tower/solver liveness on Base Sepolia was not verified) | ⚠️ verify the testnet market | ✗ need a Base-Sepolia address set |
| Ethereum Sepolia | No | ✅ CoW's historical testnet | ⚠️ Aave addresses differ | ✗ need a Sepolia address set |

**Recommendation:** the cleanest *faithful* test is **Base mainnet with a tiny real amount**, because it's the exact environment the code targets (addresses in `src/config/addresses.ts` are Base mainnet) and real solvers are guaranteed. CLAUDE.md requires explicit approval for any mainnet/real-value tx — that approval is the first gate below.

**If you require testnet-only:** first **confirm CoW watch-tower + solvers are live on that testnet** and **add a testnet address set** (Aave Pool, aUSDC, USDC, ComposableCoW/TWAP handler/settlement/vaultRelayer/HooksTrampoline, Safe factory/handler) — the current addresses are Base-mainnet-only. Do not proceed on a testnet where solvers don't run; you'd see parts never settle and learn nothing about hook behavior.

- [ ] **Network chosen and signed off:** ____________________
- [ ] If not Base mainnet: testnet CoW solver liveness **confirmed**, and a verified address set added to config.

## 4. Prerequisites
- [ ] Node 22 (`nvm use 22`), `pnpm`, Foundry (`anvil`/`forge`), repo installed (`pnpm install`).
- [ ] `.env`: `BASE_RPC_URL` (real RPC for the chosen network), `AGENT_PRIVATE_KEY` (throwaway), envelope bounds set as intended. Keep `DRY_RUN=true` until §6.
- [ ] Funds in the agent EOA: native gas (ETH) + the DCA budget in **USDC** (≤ cap, sub-$50).
- [ ] A block explorer + the CoW Explorer (explorer.cow.fi) open to watch orders/fills.
- [ ] Re-read `docs/ARCHITECTURE.md` Envelope + Model B sections.

## 5. Pre-flight (still DRY_RUN / no real value)
- [ ] `nvm use 22 && pnpm verify:all` → `ACCEPTANCE ALL (M0-M5) PASS` on the fork. Don't go live on a red build.
- [ ] `pnpm typecheck` clean.
- [ ] Confirm the operative envelope: `MAX_SPEND_PER_EPOCH_USDC`, `MAX_SLIPPAGE_BPS`, `MAX_ORDER_TTL_SECONDS`, `ALLOWED_BUY_TOKENS`, `EPOCH_BUDGET_USDC`, `PARTS` are the values you intend for real.
- [ ] Dry-run the exact construction against a fork of the **chosen** network (point `BASE_RPC_URL` at it) and confirm the order builds + signs and the per-part hook decodes to `withdrawPart(partSellAmount)`.

## 6. Live sequence (real value — only after §2/§3 sign-off)
Flip `DRY_RUN=false` **only now**, and only with same-session approval. Reuse the existing modules (no new code needed); each step is one or more Safe txs.

1. [ ] **Deploy the Safe** (`src/safe/safe.ts deploySafe`) with `ExtensibleFallbackHandler`; **set the domain verifier** to ComposableCoW (`setDomainVerifier`). (M1)
2. [ ] **Fund** the Safe with USDC (transfer from the agent EOA) + a small **USDC buffer** as the withdrawal shock absorber (`USDC_BUFFER`).
3. [ ] **Supply** idle USDC to Aave (`src/yield/aave.ts supplyToAave`) → aUSDC. (M1)
4. [ ] **Deploy + enable** the `AaveWithdrawModule` (`src/safe/module.ts`), `maxWithdrawPerCall = partSellAmount`. (M2/M3)
5. [ ] **Approve** USDC → CoW VaultRelayer up to `n × partSellAmount` (`safeApprove`). (M1)
6. [ ] **Build + register** the basket TWAP with the per-part pre-hook (`src/cow/twap.ts buildLegOrder` → `createOrderCalldata` via `execSafe`). (M2)
7. [ ] **Make the order discoverable by solvers.** ComposableCoW orders are surfaced by the **watch-tower**, which posts each part (with the **full appData incl. hooks**) to the CoW OrderBook API. On a supported network CoW runs it; otherwise run `@cowprotocol/watch-tower` yourself. Confirm the order appears on the CoW Explorer with the pre-hook attached. **(This is the step a fork can't do — it's the whole point of M6.)**

## 7. Kill switch / abort (have this ready before step 6)
- [ ] To stop: `execSafe(ComposableCoW.remove(hash))` (one tx) — `src/cow/twap.ts killOrderCalldata` + `conditionalOrderHash`. Confirm `isSingleOrderActive` → false and no further parts settle.
- [ ] Funds remain in the Safe; aUSDC stays in Aave. Withdraw to USDC via the module/`withdrawFromAave` if you want to unwind.

## 8. What to observe — the behavioral proof (the actual acceptance)
For **each** part the solver settles, verify on-chain / on the CoW Explorer:
- [ ] The part **filled** (USDC sold → WETH received into the Safe), respecting the **limit price** (slippage bound held).
- [ ] **Per-part hook fired:** the Safe's **aUSDC decreased by ~`partSellAmount`** right at settlement (the pre-hook withdrew exactly that part's USDC from Aave into the Safe before the relayer pulled it). This is the Model B confirmation.
- [ ] Across all parts: cumulative spend ≤ the per-epoch cap; expiry respected.
- [ ] One **re-up** observed (the agent loop sizes + places the next tranche, folding in accrued yield).
- [ ] **Kill switch** exercised at the end: cancel and confirm settlement stops.

## 9. Acceptance checklist (human sign-off — per docs/ACCEPTANCE.md M6)
One real cycle observed end-to-end:
- [ ] tranche withdrawn (per-part hook),
- [ ] parts filled,
- [ ] buy tokens received in the Safe,
- [ ] envelope respected (cap/slippage/allowlist/expiry),
- [ ] kill switch verified.

## 10. Record the outcome
- [ ] **If the per-part hook fired on every part → Model B confirmed live.** Note tx hashes + the per-part aUSDC deltas in `docs/ARCHITECTURE.md` (append to the Step 0 block: "M6 confirmed behavioral half on <network> at <date>").
- [ ] **If the solver did NOT fire the hook → Model B fails live.** Record it, cancel everything (kill switch), and switch the funding leg to **Model A** (withdraw-per-re-up; the agent withdraws the tranche to USDC in the Safe before signing the TWAP — no pre-hook dependency). Update `docs/ARCHITECTURE.md` and revisit M2/M4 funding accordingly.
- [ ] Either way: leave `DRY_RUN=true` again afterward; never leave a real-value config armed.
