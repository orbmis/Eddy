/**
 * Dashboard — presentational React (props in, JSX out). No next/* imports, no
 * data fetching, no server-only APIs, so it renders headlessly under jsdom for
 * the M5 smoke test. The numeric correctness lives in src/dashboard/baseline.ts
 * (unit-tested); this file only formats + lays out the five panels.
 */
import type { BaselineResult } from "../../src/dashboard/baseline.js";

export interface PartStatus {
  cycle: number;
  partsRemaining: number;
  active: boolean;
}

export interface DashboardData {
  status: PartStatus[];
  /** Average fill price across (mocked) fills, USDC per WETH whole units. */
  avgFillPriceUsdcPerWeth: bigint;
  yieldEarnedUsdc: bigint;
  spentUsdc: bigint;
  capUsdc: bigint;
  baseline: BaselineResult;
}

const usd = (bn: bigint): string => `$${(Number(bn) / 1e6).toFixed(2)}`;
const signedUsd = (bn: bigint): string => `${bn >= 0n ? "+" : "-"}${usd(bn < 0n ? -bn : bn)}`;

export function StatusPanel({ status }: { status: PartStatus[] }) {
  const active = status.filter((s) => s.active).length;
  return (
    <section data-testid="panel-status">
      <h2>Order / part status</h2>
      <p>{active} active order(s)</p>
      <ul>
        {status.map((s) => (
          <li key={s.cycle}>
            cycle {s.cycle}: {s.partsRemaining} parts remaining {s.active ? "(active)" : "(complete)"}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AvgFillPricePanel({ priceUsdcPerWeth }: { priceUsdcPerWeth: bigint }) {
  return (
    <section data-testid="panel-avg-fill-price">
      <h2>Average fill price</h2>
      <p>${priceUsdcPerWeth.toString()} / WETH</p>
    </section>
  );
}

export function YieldEarnedPanel({ yieldUsdc }: { yieldUsdc: bigint }) {
  return (
    <section data-testid="panel-yield-earned">
      <h2>Yield earned</h2>
      <p>{usd(yieldUsdc)}</p>
    </section>
  );
}

export function SpendVsCapPanel({ spent, cap }: { spent: bigint; cap: bigint }) {
  const pct = cap > 0n ? Number((spent * 10000n) / cap) / 100 : 0;
  return (
    <section data-testid="panel-spend-vs-cap">
      <h2>Spend vs cap</h2>
      <p>
        {usd(spent)} of {usd(cap)} ({pct.toFixed(1)}%)
      </p>
    </section>
  );
}

export function NetVsBaselinePanel({ baseline }: { baseline: BaselineResult }) {
  return (
    <section data-testid="panel-net-vs-baseline">
      <h2>Net vs baseline</h2>
      <p data-testid="net-vs-plain-dca">vs plain DCA: {signedUsd(baseline.netVsPlainDcaUsdc)}</p>
      <p data-testid="net-vs-plain-hold">vs plain hold: {signedUsd(baseline.netVsPlainHoldUsdc)}</p>
    </section>
  );
}

export function Dashboard({ data }: { data: DashboardData }) {
  return (
    <main data-testid="dashboard">
      <StatusPanel status={data.status} />
      <AvgFillPricePanel priceUsdcPerWeth={data.avgFillPriceUsdcPerWeth} />
      <YieldEarnedPanel yieldUsdc={data.yieldEarnedUsdc} />
      <SpendVsCapPanel spent={data.spentUsdc} cap={data.capUsdc} />
      <NetVsBaselinePanel baseline={data.baseline} />
    </main>
  );
}
