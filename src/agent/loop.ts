/**
 * Agent — LOOP. The load-bearing re-up loop that makes the DCA perpetual:
 * monitor → decide (size next tranche, compounding accrued yield) → act
 * (construct + sign the next basket TWAP with the per-part Aave-withdraw
 * pre-hook, Model B). Runs N cycles; between cycles time advances so the idle
 * pool accrues yield. Pure fork/DRY_RUN orchestration — registers orders on the
 * provided (sandbox) clients; never broadcasts to a real network.
 */
import { keccak256, stringToHex, type Account, type Address, type Hex } from "viem";
import { BASE_ADDRESSES } from "../config/addresses.js";
import { basket, type BasketLeg } from "../config/basket.js";
import { buildLegOrder, conditionalOrderHash, createOrderCalldata, isSingleOrderActive } from "../cow/twap.js";
import { execSafe, type EddyPublicClient, type EddyWalletClient } from "../safe/safe.js";
import { monitor } from "./monitor.js";
import { sizeNextTranche } from "./decide.js";

/** Just the time-machine actions the loop needs from a viem anvil test client. */
export interface TimeMachine {
  increaseTime(args: { seconds: number }): Promise<unknown>;
  mine(args: { blocks: number }): Promise<unknown>;
}

export interface CycleRecord {
  cycle: number;
  accruedYield: bigint;
  tranche: bigint;
  partSellAmount: bigint;
  cumulativeSpent: bigint;
  partsRemaining: bigint;
  orderHash: Hex;
  active: boolean;
}

const SECONDS_PER_180D = 15_552_000n;

export async function runAgentLoop(params: {
  publicClient: EddyPublicClient;
  walletClient: EddyWalletClient;
  testClient: TimeMachine;
  owner: Account;
  safe: Address;
  module: Address;
  /** Principal supplied to Aave (for accrued-yield = aUSDC − principal). */
  principal: bigint;
  /** Per-epoch spend cap (cumulative bound across cycles). */
  cap: bigint;
  /** Base allocation per cycle (e.g. epochBudget / cycles). */
  basePerCycle: bigint;
  leg: BasketLeg;
  cycles?: number;
  advanceSeconds?: bigint;
}): Promise<CycleRecord[]> {
  const cycles = params.cycles ?? 3;
  const advance = params.advanceSeconds ?? SECONDS_PER_180D;
  const records: CycleRecord[] = [];
  let cumulativeSpent = 0n;
  let activeOrder: { t0: bigint; n: bigint; t: bigint } | undefined;

  for (let i = 1; i <= cycles; i++) {
    // Idle capital earns yield since the last re-up.
    await params.testClient.increaseTime({ seconds: Number(advance) });
    await params.testClient.mine({ blocks: 1 });

    // MONITOR
    const m = await monitor(params.publicClient, {
      safe: params.safe,
      usdc: BASE_ADDRESSES.usdc,
      aUsdc: BASE_ADDRESSES.aUsdc,
      principal: params.principal,
      activeOrder,
    });

    // DECIDE (compound accrued yield; enforce the cumulative cap)
    const tranche = sizeNextTranche({
      basePerCycle: params.basePerCycle,
      accruedYield: m.accruedYield,
      cumulativeSpent,
      cap: params.cap,
    });

    // ACT (Model B): build + register the next order with the per-part pre-hook.
    const t0 = m.now;
    const salt = keccak256(stringToHex(`eddy:cycle:${i}:${m.now}`));
    const built = await buildLegOrder({
      leg: params.leg,
      safe: params.safe,
      module: params.module,
      t0,
      now: m.now,
      salt,
      epochBudgetOverride: tranche,
    });
    await execSafe(params.publicClient, params.walletClient, {
      safe: params.safe,
      owner: params.owner,
      to: BASE_ADDRESSES.composableCow,
      data: createOrderCalldata(built.params, true),
    });
    const orderHash = await conditionalOrderHash(params.publicClient, built.params);
    const active = await isSingleOrderActive(params.publicClient, params.safe, orderHash);

    cumulativeSpent += tranche;
    activeOrder = { t0, n: basket.parts, t: basket.intervalSeconds };

    records.push({
      cycle: i,
      accruedYield: m.accruedYield,
      tranche,
      partSellAmount: built.partSellAmount,
      cumulativeSpent,
      partsRemaining: m.partsRemaining,
      orderHash,
      active,
    });
  }

  return records;
}
