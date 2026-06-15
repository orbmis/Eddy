/**
 * M5 — net-vs-baseline numeric gate. The fixture's expected values are derived
 * by hand (below), independent of the implementation, so this is a real check
 * of the math rather than a tautology.
 *
 * Fixture: budget 30 USDC, 3 cycles, basePerCycle 10 USDC.
 *   prices (USDC/WETH): [2000, 2500, 2000]   accrued (USDC): [0, 1, 2]
 *
 *   plainHold = 30 / 2000                       = 0.015   WETH
 *   plainDca  = 10/2000 + 10/2500 + 10/2000     = 0.014   WETH
 *   dcaYield  = 10/2000 + 11/2500 + 12/2000     = 0.0154  WETH   (tranche = base + accrued)
 *   final price = 2000  →  value = qty · 2000
 *     plainHold 30.0 USDC, plainDca 28.0 USDC, dcaYield 30.8 USDC
 *   netVsPlainDca = 2.8 USDC ; netVsPlainHold = 0.8 USDC
 *   totalSpent = 33 USDC ; avgFillPrice = 33 / 0.0154 = 2142.85… → 2142
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeBaselines, type BaselineInput } from "../../src/dashboard/baseline.js";

const USDC = 1_000_000n; // 1 USDC in base units
const WETH = 10n ** 18n;

const fixture: BaselineInput = {
  budgetUsdc: 30n * USDC,
  cycles: 3,
  pricesUsdcPerWeth: [2000n, 2500n, 2000n],
  accruedYieldUsdc: [0n, 1n * USDC, 2n * USDC],
};

describe("M5 net-vs-baseline", () => {
  const r = computeBaselines(fixture);

  it("computes the three WETH quantities exactly", () => {
    expect(r.plainHoldWeth).toBe((15n * WETH) / 1000n); // 0.015 WETH
    expect(r.plainDcaWeth).toBe((14n * WETH) / 1000n); // 0.014 WETH
    expect(r.dcaYieldWeth).toBe((154n * WETH) / 10000n); // 0.0154 WETH
  });

  it("values each strategy at the final price", () => {
    expect(r.finalPriceUsdcPerWeth).toBe(2000n);
    expect(r.valueUsdc.plainHold).toBe(30n * USDC);
    expect(r.valueUsdc.plainDca).toBe(28n * USDC);
    expect(r.valueUsdc.dcaYield).toBe(30_800_000n); // 30.8 USDC
  });

  it("computes the net-vs-baseline deltas", () => {
    expect(r.netVsPlainDcaUsdc).toBe(2_800_000n); // +2.8 USDC from yield
    expect(r.netVsPlainHoldUsdc).toBe(800_000n); // +0.8 USDC vs lump-sum hold
  });

  it("reports total spent and average fill price", () => {
    expect(r.totalSpentUsdc).toBe(33n * USDC);
    expect(r.avgFillPriceUsdcPerWeth).toBe(2142n);
  });

  it("holds the core invariants (yield only adds WETH; net-vs-plain-DCA > 0)", () => {
    expect(r.dcaYieldWeth >= r.plainDcaWeth).toBe(true);
    expect(r.netVsPlainDcaUsdc > 0n).toBe(true);
  });

  it("validates input shape", () => {
    expect(() => computeBaselines({ ...fixture, pricesUsdcPerWeth: [2000n] })).toThrow();
    expect(() => computeBaselines({ ...fixture, pricesUsdcPerWeth: [2000n, 0n, 2000n] })).toThrow();
  });

  it("records the result + fixture for the sentinel to independently re-validate", () => {
    mkdirSync("artifacts", { recursive: true });
    writeFileSync(
      "artifacts/m5-result.json",
      JSON.stringify(
        {
          ok: true,
          inputs: {
            budgetUsdc: fixture.budgetUsdc.toString(),
            cycles: fixture.cycles,
            pricesUsdcPerWeth: fixture.pricesUsdcPerWeth.map((p) => p.toString()),
            accruedYieldUsdc: fixture.accruedYieldUsdc.map((a) => a.toString()),
          },
          outputs: {
            plainHoldWeth: r.plainHoldWeth.toString(),
            plainDcaWeth: r.plainDcaWeth.toString(),
            dcaYieldWeth: r.dcaYieldWeth.toString(),
            valueUsdc: {
              plainHold: r.valueUsdc.plainHold.toString(),
              plainDca: r.valueUsdc.plainDca.toString(),
              dcaYield: r.valueUsdc.dcaYield.toString(),
            },
            netVsPlainDcaUsdc: r.netVsPlainDcaUsdc.toString(),
            netVsPlainHoldUsdc: r.netVsPlainHoldUsdc.toString(),
            totalSpentUsdc: r.totalSpentUsdc.toString(),
            avgFillPriceUsdcPerWeth: r.avgFillPriceUsdcPerWeth.toString(),
          },
        },
        null,
        2,
      ),
    );
  });
});
