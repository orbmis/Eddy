# ACCEPTANCE.md — Goal-Driven Completion Criteria

Designed for Claude Code `/goal`. After every turn, a lightweight evaluator checks the goal condition against **what has been surfaced in the transcript**. So each criterion here is a single command that prints a deterministic **sentinel** on success. The agent works; the evaluator reads the sentinel; nobody marks their own homework.

## How this is wired
- Each milestone has one script: `pnpm verify:mN`. It runs the relevant tests and, **only on exit 0**, echoes `ACCEPTANCE MN PASS`. On failure it prints `ACCEPTANCE MN FAIL: <reason>` and exits non-zero.
- A goal condition is then trivial and unfakeable: *"…until `pnpm verify:m2` prints `ACCEPTANCE M2 PASS`."*
- Aggregate: `pnpm verify:all` runs m0→m5 in order and prints `ACCEPTANCE ALL (M0-M5) PASS`.

## Global constraints (apply to EVERY goal — these are must-nots)
1. **No real value, ever, in an autonomous run.** `DRY_RUN=true`, Base **testnet** only. Never broadcast a mainnet or real-value transaction inside a `/goal` loop. (M6 is manual — see bottom.)
2. **Never widen the envelope** (allowlist, per-epoch cap, slippage bps, expiry) to make a check pass. Bound values are asserted against `.env`/`src/config`.
3. **Acceptance is immutable.** Do not edit, weaken, skip, or delete anything under `test/acceptance/**` or `scripts/verify-*`. Deleting a failing test is a failure, not a pass. (Recommend a `/permissions` deny-edit on these paths.)
4. **Surface, don't fabricate.** If blocked, print the blocker and stop the turn — do not invent a passing result.
5. **Stay in milestone scope.** Don't build ahead; one milestone per goal.

## Reliability setup (do once, before running goals)
- `CLAUDE.md` at root (loaded every turn) — done.
- **Auto mode on** so the run doesn't stall on approvals — but paired with constraint #1, never `--dangerously-skip-permissions` with real funds.
- **PostToolUse hook** to auto-run `pnpm typecheck && pnpm lint` after edits, so breakage surfaces mid-run.
- Set a **turn limit** on each goal so a wrong-direction run halts instead of grinding (`/goal` amplifies a wrong goal as hard as a right one).

---

## M0 — Hook-propagation spike
- **Goal:** `Run pnpm verify:m0 and stop when it prints "ACCEPTANCE M0 PASS". Record SPIKE_RESULT and evidence in docs/ARCHITECTURE.md. Do not write any funding logic.`
- **Verify:** `pnpm verify:m0` → runs `test/fork/spike.test.ts`: a 2-part TWAP on a Base fork with an observable pre-hook; asserts the hook-fire count (0/1/2).
- **Pass = a definitive answer recorded, not B specifically.** Script prints `SPIKE_RESULT=B` (fired on both parts) or `SPIKE_RESULT=A` (did not), appends decision + evidence to `docs/ARCHITECTURE.md`, then `ACCEPTANCE M0 PASS`.
- **Constraint:** spike only; both B and A are valid outcomes — do not churn trying to force B.
- **Turn limit:** ~15.

## M1 — Safe + Aave funded (Base testnet)
- **Goal:** `…until pnpm verify:m1 prints "ACCEPTANCE M1 PASS".`
- **Checks:** Safe deployed **with the TWAP fallback handler** (assert handler address set); idle USDC deposited to Aave (assert aUSDC balance > 0); required approvals present (Vault Relayer for USDC; withdraw path for the pre-hook).
- **Constraint:** testnet only; amounts below the per-epoch cap; `DRY_RUN` respected.
- **Turn limit:** ~20.

## M2 — Basket TWAP construction + signing
- **Goal:** `…until pnpm verify:m2 prints "ACCEPTANCE M2 PASS".`
- **Checks:** constructs N basket-leg TWAPs from `src/config`; asserts allocation weights sum to 100%; asserts each leg's per-part sell amount == legBudget / parts; orders sign via Safe (ERC-1271) with a valid UID. **Model B:** asserts `appData` carries the per-part Aave-withdraw pre-hook AND its withdraw amount == partSellAmount (not a placeholder).
- **Anti-gaming:** the hook-amount equality and the 100% sum are explicit assertions, so a stubbed hook fails.
- **Turn limit:** ~25.

## M3 — Envelope enforcement (negative tests are the point)
- **Goal:** `…until pnpm verify:m3 prints "ACCEPTANCE M3 PASS".`
- **Checks — each is a REJECTION test (guardrail must actually fire):**
  - buy token not in allowlist → construction rejected
  - order exceeding per-epoch spend cap → rejected
  - slippage beyond `MAX_SLIPPAGE_BPS` → limit price rejects the part
  - expired/missing expiry → handled, not silently accepted
  - kill switch cancels the conditional order in one tx → order asserted no-longer-active
- **Anti-gaming:** bound values are read from `.env`/config and asserted; the milestone cannot pass by loosening a bound (that changes the asserted value and other checks fail). Done **requires the guardrails to fire**, not just exist.
- **Turn limit:** ~30.

## M4 — Agent loop, unattended, N cycles (testnet / DRY_RUN)
- **Goal:** `…until pnpm verify:m4 prints "ACCEPTANCE M4 PASS".`
- **Checks:** loop runs N=3 simulated cycles; each cycle monitors parts-remaining + budget + accrued yield, sizes the next tranche **including accrued yield** (assert tranche_{n+1} reflects yield), re-ups; cumulative spend across cycles ≤ per-epoch cap; envelope never breached.
- **Anti-gaming:** assert compounding actually changed tranche size between cycles; assert cumulative-spend ≤ cap (not per-order only).
- **Constraint:** no real broadcast — fork/testnet with `DRY_RUN=true`.
- **Turn limit:** ~30.

## M5 — Dashboard (make the math testable, not the looks)
- **Goal:** `…until pnpm verify:m5 prints "ACCEPTANCE M5 PASS".`
- **Checks:** unit test on the baseline computation against a fixture — DCA+yield vs plain-DCA vs plain-hold must match expected values; component smoke test that status, avg fill price, yield earned, spend-vs-cap, and net-vs-baseline all render with mocked data.
- **Constraint:** no subjective/aesthetic criteria — the numeric correctness of net-vs-baseline is the gate.
- **Turn limit:** ~25.

---

## Recommended goal invocations
- **Per-milestone (preferred — branch at M0, tightest control):** run M0 first; once `SPIKE_RESULT` is recorded, run M1…M5 as separate goals.
- **Chained (hands-off through M5):**
  `/goal Implement docs/ARCHITECTURE.md following CLAUDE.md until pnpm verify:all prints "ACCEPTANCE ALL (M0-M5) PASS". Obey all global constraints in docs/ACCEPTANCE.md. Stop and surface if blocked.`

## M6 — Live small-amount E2E — **MANUAL, NOT a /goal**
This is the only financial action. It runs **outside** any autonomous loop, with `DRY_RUN=false` set **only after explicit human sign-off**, on a tiny amount on Base. Acceptance is a human checklist: one real cycle observed end-to-end (tranche withdrawn, parts filled, buy tokens received, envelope respected, kill switch verified). Never include M6 — or any real-value broadcast — in a `/goal` condition.
