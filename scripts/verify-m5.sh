#!/usr/bin/env bash
#
# ACCEPTANCE M5 — dashboard (numeric net-vs-baseline gate + component smoke).
#
# Runs the baseline-math unit test and the dashboard component smoke test, then
# INDEPENDENTLY recomputes the net-vs-baseline figures from the fixture inputs
# (a second implementation in plain JS) and asserts the module's recorded output
# matches. No aesthetic checks — numeric correctness is the gate.
#
# IMMUTABLE (docs/ACCEPTANCE.md #3): never edit this script to force a pass.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "ACCEPTANCE M5 FAIL: $1"; exit 1; }

[ -x node_modules/.bin/vitest ] || fail "vitest not installed — run the install step (pnpm install) first."

# --- baseline math + component smoke (M5 is off-chain; no anvil/forge needed) ---
echo "Running net-vs-baseline unit test..."
node_modules/.bin/vitest run test/unit/baseline.test.ts --reporter=dot || fail "baseline unit test failed."
echo "Running dashboard component smoke test..."
node_modules/.bin/vitest run test/component/dashboard.test.tsx --reporter=dot || fail "dashboard smoke test failed."

ARTIFACT="artifacts/m5-result.json"
[ -f "$ARTIFACT" ] || fail "M5 did not produce $ARTIFACT."

# --- independently recompute net-vs-baseline from the fixture inputs -------
REASON="$(node - <<'NODE'
const fs = require("fs");
const r = JSON.parse(fs.readFileSync("artifacts/m5-result.json", "utf8"));
if (r.ok !== true) { process.stdout.write("ok=false"); process.exit(0); }
const ONE_USDC = 10n ** 6n, ONE_WETH = 10n ** 18n;
const wethFor = (usdc, price) => (usdc * ONE_WETH) / (price * ONE_USDC);
const valOf = (weth, price) => (weth * price * ONE_USDC) / ONE_WETH;
const inp = r.inputs;
const budget = BigInt(inp.budgetUsdc);
const cycles = Number(inp.cycles);
const prices = inp.pricesUsdcPerWeth.map(BigInt);
const accrued = inp.accruedYieldUsdc.map(BigInt);
const base = budget / BigInt(cycles);
let plainDca = 0n, dcaYield = 0n, spent = 0n;
for (let i = 0; i < cycles; i++) { plainDca += wethFor(base, prices[i]); const t = base + accrued[i]; dcaYield += wethFor(t, prices[i]); spent += t; }
const plainHold = wethFor(budget, prices[0]);
const pf = prices[cycles - 1];
const exp = {
  plainHoldWeth: plainHold,
  plainDcaWeth: plainDca,
  dcaYieldWeth: dcaYield,
  netVsPlainDcaUsdc: valOf(dcaYield, pf) - valOf(plainDca, pf),
  netVsPlainHoldUsdc: valOf(dcaYield, pf) - valOf(plainHold, pf),
  totalSpentUsdc: spent,
};
const o = r.outputs;
const checks = [
  ["plainHoldWeth", BigInt(o.plainHoldWeth), exp.plainHoldWeth],
  ["plainDcaWeth", BigInt(o.plainDcaWeth), exp.plainDcaWeth],
  ["dcaYieldWeth", BigInt(o.dcaYieldWeth), exp.dcaYieldWeth],
  ["netVsPlainDcaUsdc", BigInt(o.netVsPlainDcaUsdc), exp.netVsPlainDcaUsdc],
  ["netVsPlainHoldUsdc", BigInt(o.netVsPlainHoldUsdc), exp.netVsPlainHoldUsdc],
  ["totalSpentUsdc", BigInt(o.totalSpentUsdc), exp.totalSpentUsdc],
];
for (const [name, got, want] of checks) {
  if (got !== want) { process.stdout.write(`${name}: got ${got} != recomputed ${want}`); process.exit(0); }
}
// the yield edge must be real and positive
if (exp.dcaYieldWeth < exp.plainDcaWeth) { process.stdout.write("dcaYield < plainDca"); process.exit(0); }
if (exp.netVsPlainDcaUsdc <= 0n) { process.stdout.write("netVsPlainDca <= 0"); process.exit(0); }
process.stdout.write("OK");
NODE
)"
[ "$REASON" = "OK" ] || fail "$REASON"

# --- sentinel -------------------------------------------------------------
echo "ACCEPTANCE M5 PASS"
