#!/usr/bin/env bash
#
# ACCEPTANCE M1 — Safe + Aave funded (deterministic Base-fork gate).
#
# Runs the M1 fork test, then independently re-validates the recorded result:
# all setup checks true, and deposit/allowance ≤ the per-epoch cap read from
# .env/config (never trusting the artifact for the bound). Prints the sentinel.
#
# IMMUTABLE (docs/ACCEPTANCE.md #3): never edit this script to force a pass.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "ACCEPTANCE M1 FAIL: $1"; exit 1; }

# --- prerequisites (surface blockers; never fabricate a result) ----------
# Capture a caller-exported DRY_RUN BEFORE .env can override it, so an explicit
# `DRY_RUN=false ...` still trips the guard below (caller > .env > default true).
REQ_DRY_RUN="${DRY_RUN:-}"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
DRY_RUN="${REQ_DRY_RUN:-${DRY_RUN:-true}}"
[ -n "${BASE_RPC_URL:-}" ] || fail "BASE_RPC_URL not set in .env — a Base RPC is required to fork."
command -v anvil >/dev/null 2>&1 || fail "anvil not found on PATH — install Foundry (foundryup)."
[ -x node_modules/.bin/vitest ] || fail "vitest not installed — run the install step (pnpm install) first."
# M1 must never be an autonomous real-value broadcast.
[ "$DRY_RUN" != "false" ] || fail "DRY_RUN=false is not allowed for the M1 gate (testnet/fork only)."

# --- run the M1 setup test ------------------------------------------------
echo "Running M1 Safe + Aave funding (Base fork)..."
node_modules/.bin/vitest run test/fork/m1.test.ts --reporter=dot || fail "M1 test failed — see output above."

ARTIFACT="artifacts/m1-result.json"
[ -f "$ARTIFACT" ] || fail "M1 did not produce $ARTIFACT."

# --- independently re-validate checks + bounds (cap from .env, not artifact) ---
REASON="$(node - <<'NODE'
const fs = require("fs");
const r = JSON.parse(fs.readFileSync("artifacts/m1-result.json", "utf8"));
const capHuman = Number(process.env.MAX_SPEND_PER_EPOCH_USDC ?? 100);
if (!Number.isFinite(capHuman)) { process.stdout.write("invalid MAX_SPEND_PER_EPOCH_USDC"); process.exit(0); }
const cap = BigInt(Math.round(capHuman * 1e6));
const c = r.checks || {};
const need = ["handlerSet","domainVerifierSet","aUsdcGtZero","relayerApproved","allowanceWithinCap","depositWithinCap","withdrawPathOk"];
const missing = need.filter((k) => c[k] !== true);
if (r.ok !== true || missing.length) { process.stdout.write("failed checks: " + (missing.join(",") || "ok=false")); process.exit(0); }
const deposit = BigInt(r.values.depositUsdcBaseUnits);
const allowance = BigInt(r.values.usdcAllowanceToVaultRelayer);
if (deposit > cap) { process.stdout.write(`deposit ${deposit} exceeds cap ${cap}`); process.exit(0); }
if (allowance > cap) { process.stdout.write(`allowance ${allowance} exceeds cap ${cap}`); process.exit(0); }
process.stdout.write("OK");
NODE
)"
[ "$REASON" = "OK" ] || fail "$REASON"

# --- sentinel -------------------------------------------------------------
echo "ACCEPTANCE M1 PASS"
