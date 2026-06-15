#!/usr/bin/env bash
#
# ACCEPTANCE M2 — basket TWAP construction + signing (Model B).
#
# Compiles the Safe module, runs the M2 fork test, then independently re-validates
# the recorded result: every check true, weights sum to 100%, partSellAmount ==
# legBudget/parts and == the pre-hook withdraw amount, all amounts ≤ the per-epoch
# cap (recomputed from .env/config, not trusted from the artifact). Prints the sentinel.
#
# IMMUTABLE (docs/ACCEPTANCE.md #3): never edit this script to force a pass.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "ACCEPTANCE M2 FAIL: $1"; exit 1; }

# --- prerequisites --------------------------------------------------------
REQ_DRY_RUN="${DRY_RUN:-}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DRY_RUN="${REQ_DRY_RUN:-${DRY_RUN:-true}}"
[ -n "${BASE_RPC_URL:-}" ] || fail "BASE_RPC_URL not set in .env — a Base RPC is required to fork."
command -v anvil >/dev/null 2>&1 || fail "anvil not found on PATH — install Foundry (foundryup)."
command -v forge >/dev/null 2>&1 || fail "forge not found on PATH — install Foundry (foundryup)."
[ -x node_modules/.bin/vitest ] || fail "vitest not installed — run the install step (pnpm install) first."
[ "$DRY_RUN" != "false" ] || fail "DRY_RUN=false is not allowed for the M2 gate (testnet/fork only)."

# --- compile the Safe module ----------------------------------------------
echo "Compiling AaveWithdrawModule (forge build)..."
forge build >/dev/null 2>&1 || fail "forge build failed."
[ -f out/AaveWithdrawModule.sol/AaveWithdrawModule.json ] || fail "module artifact missing after forge build."

# --- run the M2 test ------------------------------------------------------
echo "Running M2 basket TWAP construction + signing (Base fork)..."
node_modules/.bin/vitest run test/fork/m2.test.ts --reporter=dot || fail "M2 test failed — see output above."

ARTIFACT="artifacts/m2-result.json"
[ -f "$ARTIFACT" ] || fail "M2 did not produce $ARTIFACT."

# --- independently re-validate checks + bounds (from .env/config) ---------
REASON="$(node - <<'NODE'
const fs = require("fs");
const r = JSON.parse(fs.readFileSync("artifacts/m2-result.json", "utf8"));
const num = (k, d) => { const v = process.env[k]; const n = v === undefined || v.trim() === "" ? d : Number(v); if (!Number.isFinite(n)) { console.error(); process.exit(0); } return n; };
const cap = BigInt(Math.round(num("MAX_SPEND_PER_EPOCH_USDC", 100) * 1e6));
const epoch = BigInt(Math.round(num("EPOCH_BUDGET_USDC", 40) * 1e6));
const parts = BigInt(num("PARTS", 4));
// single leg, 100% → legBudget = epoch; partSellAmount = epoch / parts
const expectedPart = epoch / parts;
const c = r.checks || {};
const need = ["moduleEnabled","moduleWired","weightsSum100","partMatchesBudget","tokenAllowlisted","hookAmountMatches","sellAmountMatches","appDataMatches","uidValid","signatureValid","hookExecutes"];
const missing = need.filter((k) => c[k] !== true);
if (r.ok !== true || missing.length) { process.stdout.write("failed checks: " + (missing.join(",") || "ok=false")); process.exit(0); }
const v = r.values;
if (Number(v.weightsSumBps) !== 10000) { process.stdout.write("weights != 10000"); process.exit(0); }
if (BigInt(v.partSellAmountBaseUnits) !== expectedPart) { process.stdout.write(`partSellAmount ${v.partSellAmountBaseUnits} != epoch/parts ${expectedPart}`); process.exit(0); }
if (BigInt(v.hookWithdrawAmountBaseUnits) !== BigInt(v.partSellAmountBaseUnits)) { process.stdout.write("hook amount != partSellAmount"); process.exit(0); }
if (BigInt(v.epochBudgetBaseUnits) > cap) { process.stdout.write("epoch budget exceeds cap"); process.exit(0); }
if (BigInt(v.partSellAmountBaseUnits) > cap) { process.stdout.write("partSellAmount exceeds cap"); process.exit(0); }
if (String(v.isValidSignatureMagic).toLowerCase() !== "0x1626ba7e") { process.stdout.write("bad isValidSignature magic"); process.exit(0); }
const allow = (process.env.ALLOWED_BUY_TOKENS && process.env.ALLOWED_BUY_TOKENS.trim() !== ""
  ? process.env.ALLOWED_BUY_TOKENS.split(",").map((s) => s.trim().toLowerCase())
  : ["0x4200000000000000000000000000000000000006"]);
if (!allow.includes(String(v.buyToken).toLowerCase())) { process.stdout.write("buy token not in allowlist"); process.exit(0); }
process.stdout.write("OK");
NODE
)"
[ "$REASON" = "OK" ] || fail "$REASON"

# --- sentinel -------------------------------------------------------------
echo "ACCEPTANCE M2 PASS"
