/**
 * Agent — MONITOR. Reads the state the re-up decision needs: parts remaining on
 * the active TWAP, the Safe's USDC balance, the yield-vault (aUSDC) balance, and
 * the accrued yield (aUSDC balance − principal supplied).
 */
import { type Address } from "viem";
import { erc20BalanceOf } from "../safe/erc20.js";
import { aTokenBalance } from "../yield/aave.js";
import type { EddyPublicClient } from "../safe/safe.js";

/** Minimal description of the active TWAP needed to compute parts-remaining. */
export interface ActiveOrder {
  t0: bigint;
  n: bigint;
  t: bigint;
}

export interface MonitorReading {
  now: bigint;
  /** Parts not yet elapsed on the active TWAP (0 = complete → time to re-up). */
  partsRemaining: bigint;
  safeUsdc: bigint;
  aUsdcBalance: bigint;
  /** Interest earned by the idle pool: aUSDC balance − principal. */
  accruedYield: bigint;
}

export async function monitor(
  publicClient: EddyPublicClient,
  params: { safe: Address; usdc: Address; aUsdc: Address; principal: bigint; activeOrder?: ActiveOrder },
): Promise<MonitorReading> {
  const now = (await publicClient.getBlock()).timestamp;
  const [safeUsdc, aUsdcBalance] = await Promise.all([
    erc20BalanceOf(publicClient, params.usdc, params.safe),
    aTokenBalance(publicClient, params.aUsdc, params.safe),
  ]);
  const accruedYield = aUsdcBalance > params.principal ? aUsdcBalance - params.principal : 0n;

  let partsRemaining = 0n;
  if (params.activeOrder) {
    const { t0, n, t } = params.activeOrder;
    const elapsed = now > t0 ? now - t0 : 0n;
    const completed = elapsed / t;
    partsRemaining = completed >= n ? 0n : n - completed;
  }

  return { now, partsRemaining, safeUsdc, aUsdcBalance, accruedYield };
}
