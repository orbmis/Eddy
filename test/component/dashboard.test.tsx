// @vitest-environment jsdom
/**
 * M5 — dashboard component smoke test (jsdom + mocked data). Asserts the five
 * panels render and that the net-vs-baseline panel shows the unit-tested figures.
 * No aesthetic assertions — presence + the numeric centrepiece only.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { computeBaselines } from "../../src/dashboard/baseline.js";
import { Dashboard, type DashboardData } from "../../app/components/Dashboard.js";

const baseline = computeBaselines({
  budgetUsdc: 30_000_000n,
  cycles: 3,
  pricesUsdcPerWeth: [2000n, 2500n, 2000n],
  accruedYieldUsdc: [0n, 1_000_000n, 2_000_000n],
});

const data: DashboardData = {
  status: [
    { cycle: 1, partsRemaining: 0, active: true },
    { cycle: 2, partsRemaining: 4, active: true },
  ],
  avgFillPriceUsdcPerWeth: baseline.avgFillPriceUsdcPerWeth,
  yieldEarnedUsdc: 3_000_000n,
  spentUsdc: baseline.totalSpentUsdc,
  capUsdc: 100_000_000n,
  baseline,
};

describe("M5 dashboard smoke", () => {
  it("renders all five panels with mocked data", () => {
    render(<Dashboard data={data} />);
    for (const id of [
      "panel-status",
      "panel-avg-fill-price",
      "panel-yield-earned",
      "panel-spend-vs-cap",
      "panel-net-vs-baseline",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it("shows the net-vs-baseline figures from the baseline math", () => {
    render(<Dashboard data={data} />);
    expect(screen.getByTestId("net-vs-plain-dca").textContent).toContain("+$2.80");
    expect(screen.getByTestId("net-vs-plain-hold").textContent).toContain("+$0.80");
  });
});
