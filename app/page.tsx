import { computeBaselines } from "../src/dashboard/baseline.js";
import { Dashboard, type DashboardData } from "./components/Dashboard.js";

/**
 * Demo page. v1 feeds the dashboard a representative snapshot; M6 will wire live
 * order/part status, real fills, and on-chain yield. The net-vs-baseline figures
 * come from the unit-tested computeBaselines.
 */
export default function Page() {
  const baseline = computeBaselines({
    budgetUsdc: 30_000_000n,
    cycles: 3,
    pricesUsdcPerWeth: [2000n, 2500n, 2000n],
    accruedYieldUsdc: [0n, 1_000_000n, 2_000_000n],
  });

  const data: DashboardData = {
    status: [
      { cycle: 1, partsRemaining: 0, active: true },
      { cycle: 2, partsRemaining: 0, active: true },
      { cycle: 3, partsRemaining: 4, active: true },
    ],
    avgFillPriceUsdcPerWeth: baseline.avgFillPriceUsdcPerWeth,
    yieldEarnedUsdc: 3_000_000n,
    spentUsdc: baseline.totalSpentUsdc,
    capUsdc: 100_000_000n,
    baseline,
  };

  return <Dashboard data={data} />;
}
