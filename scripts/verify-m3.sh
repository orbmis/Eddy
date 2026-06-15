#!/usr/bin/env bash
#
# ACCEPTANCE M3 — envelope enforcement (rejection tests + one-tx kill + per-call cap).
#
# Runs the construction-rejection unit tests AND the kill/cap fork test, then
# independently re-validates that the bounds the guardrails fire on are the
# .env/config values (loosening a bound changes the asserted value and fails).
#
# IMMUTABLE (docs/ACCEPTANCE.md #3): never edit this script to force a pass.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "ACCEPTANCE M3 FAIL: $1"; exit 1; }

# --- prerequisites --------------------------------------------------------
REQ_DRY_RUN="${DRY_RUN:-}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DRY_RUN="${REQ_DRY_RUN:-${DRY_RUN:-true}}"
[ -n "${BASE_RPC_URL:-}" ] || fail "BASE_RPC_URL not set in .env — a Base RPC is required to fork."
command -v anvil >/dev/null 2>&1 || fail "anvil not found on PATH — install Foundry (foundryup)."
command -v forge >/dev/null 2>&1 || fail "forge not found on PATH — install Foundry (foundryup)."
[ -x node_modules/.bin/vitest ] || fail "vitest not installed — run the install step (pnpm install) first."
[ "$DRY_RUN" != "false" ] || fail "DRY_RUN=false is not allowed for the M3 gate (testnet/fork only)."

# --- compile the (capped) Safe module -------------------------------------
echo "Compiling AaveWithdrawModule (forge build)..."
forge build >/dev/null 2>&1 || fail "forge build failed."

# --- construction-rejection unit tests (each guardrail must fire) ---------
echo "Running envelope rejection unit tests..."
node_modules/.bin/vitest run test/unit/envelope.test.ts --reporter=dot || fail "envelope rejection unit tests failed."

# --- kill switch + per-call cap fork test ---------------------------------
echo "Running M3 kill-switch + cap fork test (Base fork)..."
node_modules/.bin/vitest run test/fork/m3.test.ts --reporter=dot || fail "M3 fork test failed — see output above."

ARTIFACT="artifacts/m3-result.json"
[ -f "$ARTIFACT" ] || fail "M3 did not produce $ARTIFACT."

# --- independently re-validate checks + bounds (from .env/config) ---------
REASON="$(node - <<'NODE'
const fs = require("fs");
const r = JSON.parse(fs.readFileSync("artifacts/m3-result.json", "utf8"));
const num = (k, d) => { const v = process.env[k]; const n = v === undefined || v.trim() === "" ? d : Number(v); if (!Number.isFinite(n)) { process.stdout.write(`invalid ${k}`); process.exit(0); } return n; };
const c = r.checks || {};
const need = ["killActiveBefore","killInactiveAfter","killReadReverts","capAllowsExact","capRejectsOver"];
const missing = need.filter((k) => c[k] !== true);
if (r.ok !== true || missing.length) { process.stdout.write("failed checks: " + (missing.join(",") || "ok=false")); process.exit(0); }
// bounds from .env/config (sanity: present and not loosened to no-ops)
const cap = BigInt(Math.round(num("MAX_SPEND_PER_EPOCH_USDC", 100) * 1e6));
const epoch = BigInt(Math.round(num("EPOCH_BUDGET_USDC", 40) * 1e6));
const parts = BigInt(num("PARTS", 4));
const slippageBps = num("MAX_SLIPPAGE_BPS", 200);
if (slippageBps <= 0 || slippageBps >= 10000) { process.stdout.write("slippage bps out of range"); process.exit(0); }
const expectedPart = epoch / parts;
if (BigInt(r.values.partSellAmountBaseUnits) !== expectedPart) { process.stdout.write(`partSellAmount ${r.values.partSellAmountBaseUnits} != epoch/parts ${expectedPart}`); process.exit(0); }
// the per-call cap must equal one part, and the epoch must fit the cap
if (BigInt(r.values.maxWithdrawPerCallBaseUnits) !== expectedPart) { process.stdout.write("module cap != partSellAmount"); process.exit(0); }
if (epoch > cap) { process.stdout.write("epoch budget exceeds cap"); process.exit(0); }
process.stdout.write("OK");
NODE
)"
[ "$REASON" = "OK" ] || fail "$REASON"

# --- sentinel -------------------------------------------------------------
echo "ACCEPTANCE M3 PASS"
