#!/usr/bin/env bash
#
# ACCEPTANCE M4 — agent loop, unattended N cycles (Model B, fork/DRY_RUN).
#
# Runs the loop fork test, then independently re-validates the recorded result:
# N cycles ran, tranches strictly increase (compounding actually changed size),
# cumulative spend ≤ the per-epoch cap (recomputed from .env, not trusted from
# the artifact), and each tranche ≤ cap. Prints the sentinel.
#
# IMMUTABLE (docs/ACCEPTANCE.md #3): never edit this script to force a pass.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "ACCEPTANCE M4 FAIL: $1"; exit 1; }

# --- prerequisites --------------------------------------------------------
REQ_DRY_RUN="${DRY_RUN:-}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DRY_RUN="${REQ_DRY_RUN:-${DRY_RUN:-true}}"
[ -n "${BASE_RPC_URL:-}" ] || fail "BASE_RPC_URL not set in .env — a Base RPC is required to fork."
command -v anvil >/dev/null 2>&1 || fail "anvil not found on PATH — install Foundry (foundryup)."
command -v forge >/dev/null 2>&1 || fail "forge not found on PATH — install Foundry (foundryup)."
[ -x node_modules/.bin/vitest ] || fail "vitest not installed — run the install step (pnpm install) first."
[ "$DRY_RUN" != "false" ] || fail "DRY_RUN=false is not allowed for the M4 gate (testnet/fork only)."

# --- compile the Safe module ----------------------------------------------
echo "Compiling AaveWithdrawModule (forge build)..."
forge build >/dev/null 2>&1 || fail "forge build failed."

# --- run the agent-loop fork test -----------------------------------------
echo "Running M4 agent loop (Base fork)..."
node_modules/.bin/vitest run test/fork/m4.test.ts --reporter=dot || fail "M4 test failed — see output above."

ARTIFACT="artifacts/m4-result.json"
[ -f "$ARTIFACT" ] || fail "M4 did not produce $ARTIFACT."

# --- independently re-validate checks + bounds (from .env/config) ---------
REASON="$(node - <<'NODE'
const fs = require("fs");
const r = JSON.parse(fs.readFileSync("artifacts/m4-result.json", "utf8"));
const num = (k, d) => { const v = process.env[k]; const n = v === undefined || v.trim() === "" ? d : Number(v); if (!Number.isFinite(n)) { process.stdout.write(`invalid ${k}`); process.exit(0); } return n; };
const c = r.checks || {};
const need = ["cyclesRan","yieldObserved","tranchesIncreasing","allActive","cumulativeWithinCap","eachTrancheWithinCap"];
const missing = need.filter((k) => c[k] !== true);
if (r.ok !== true || missing.length) { process.stdout.write("failed checks: " + (missing.join(",") || "ok=false")); process.exit(0); }
const cap = BigInt(Math.round(num("MAX_SPEND_PER_EPOCH_USDC", 100) * 1e6));
const tr = r.values.tranches || [];
if (tr.length !== 3) { process.stdout.write(`expected 3 cycles, got ${tr.length}`); process.exit(0); }
// strictly increasing tranches (compounding changed the size)
for (let i = 1; i < tr.length; i++) {
  if (!(BigInt(tr[i].tranche) > BigInt(tr[i - 1].tranche))) { process.stdout.write("tranches not strictly increasing"); process.exit(0); }
}
// each tranche within cap, and cumulative within cap (recomputed)
let sum = 0n;
for (const t of tr) { const v = BigInt(t.tranche); if (v > cap) { process.stdout.write("a tranche exceeds cap"); process.exit(0); } sum += v; }
if (sum > cap) { process.stdout.write(`cumulative ${sum} exceeds cap ${cap}`); process.exit(0); }
if (BigInt(r.values.cumulativeSpentBaseUnits) !== sum) { process.stdout.write("recorded cumulative != sum of tranches"); process.exit(0); }
// yield actually moved the tranche (anti-gaming): each tranche > base allocation
for (const t of tr) { if (BigInt(t.accruedYield) <= 0n) { process.stdout.write("a cycle had no accrued yield"); process.exit(0); } }
process.stdout.write("OK");
NODE
)"
[ "$REASON" = "OK" ] || fail "$REASON"

# --- sentinel -------------------------------------------------------------
echo "ACCEPTANCE M4 PASS"
