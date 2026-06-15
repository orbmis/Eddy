/**
 * M4 — agent loop, unattended N=3 cycles (Model B, fork/DRY_RUN).
 *
 * Runs monitor → decide → act for 3 cycles. Between cycles time advances so the
 * idle Aave pool accrues yield; each re-up's tranche folds that yield in, so the
 * tranche strictly grows. Asserts: 3 cycles, strictly-increasing tranches that
 * reflect accrued yield, every order registered (active), cumulative spend ≤ the
 * per-epoch cap, and each tranche within the envelope.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Abi, Hex } from "viem";
import { BASE_ADDRESSES } from "../../src/config/addresses.js";
import { envelope } from "../../src/config/envelope.js";
import { basket } from "../../src/config/basket.js";
import { deployModule, enableModule } from "../../src/safe/module.js";
import { aTokenBalance } from "../../src/yield/aave.js";
import { runAgentLoop } from "../../src/agent/loop.js";
import { forkPort, makeClients, setupFundedSafe, startAnvilFork, waitForRpc } from "./support.js";

const PORT = forkPort(16645);
const RPC = `http://127.0.0.1:${PORT}`;
const ARTIFACT = "artifacts/m4-result.json";
const CYCLES = 3;

function loadModuleArtifact(): { bytecode: Hex; abi: Abi } {
  const art = JSON.parse(readFileSync("out/AaveWithdrawModule.sol/AaveWithdrawModule.json", "utf8"));
  return { bytecode: art.bytecode.object as Hex, abi: art.abi as Abi };
}

let anvil: ChildProcess;

beforeAll(async () => {
  anvil = startAnvilFork(PORT);
  await waitForRpc(RPC);
}, 60_000);

afterAll(() => {
  anvil?.kill("SIGKILL");
});

describe("M4 agent loop", () => {
  it("runs N cycles, compounding accrued yield into each re-up while staying within the cap", async () => {
    const clients = makeClients(RPC);
    const { owner, publicClient, walletClient, testClient } = clients;
    const { usdc, aUsdc, aavePool } = BASE_ADDRESSES;
    const cap = envelope.maxSpendPerEpoch;
    const leg = basket.legs[0]!;

    const { safe } = await setupFundedSafe(clients);

    const { bytecode, abi } = loadModuleArtifact();
    const module = await deployModule(publicClient, walletClient, {
      deployer: owner,
      bytecode,
      abi,
      safe,
      pool: aavePool,
      asset: usdc,
      maxWithdrawPerCall: cap / basket.parts,
    });
    await enableModule(publicClient, walletClient, { safe, owner, module });

    // Principal = the actual aUSDC right after supply (baseline for accrued yield).
    const principal = await aTokenBalance(publicClient, aUsdc, safe);
    const basePerCycle = basket.epochBudget / BigInt(CYCLES);

    const records = await runAgentLoop({
      publicClient,
      walletClient,
      testClient,
      owner,
      safe,
      module,
      principal,
      cap,
      basePerCycle,
      leg,
      cycles: CYCLES,
    });

    // --- assertions ---
    const cyclesRan = records.length === CYCLES;
    const yieldObserved = records.every((r) => r.accruedYield > 0n);
    let tranchesIncreasing = true;
    for (let i = 1; i < records.length; i++) {
      if (!(records[i]!.tranche > records[i - 1]!.tranche)) tranchesIncreasing = false;
    }
    const allActive = records.every((r) => r.active);
    const cumulative = records[records.length - 1]!.cumulativeSpent;
    const cumulativeWithinCap = cumulative <= cap;
    const eachTrancheWithinCap = records.every((r) => r.tranche <= cap);

    expect(cyclesRan, "must run N cycles").toBe(true);
    expect(yieldObserved, "each cycle must observe accrued yield > 0").toBe(true);
    expect(tranchesIncreasing, "tranche must strictly grow as yield compounds").toBe(true);
    expect(allActive, "each cycle must register an active order (re-up)").toBe(true);
    expect(cumulativeWithinCap, "cumulative spend must stay within the per-epoch cap").toBe(true);
    expect(eachTrancheWithinCap, "each tranche must be within the cap").toBe(true);

    const ok = cyclesRan && yieldObserved && tranchesIncreasing && allActive && cumulativeWithinCap && eachTrancheWithinCap;

    mkdirSync("artifacts", { recursive: true });
    writeFileSync(
      ARTIFACT,
      JSON.stringify(
        {
          ok,
          checks: { cyclesRan, yieldObserved, tranchesIncreasing, allActive, cumulativeWithinCap, eachTrancheWithinCap },
          values: {
            safe,
            module,
            cycles: CYCLES,
            principalBaseUnits: principal.toString(),
            basePerCycleBaseUnits: basePerCycle.toString(),
            capBaseUnits: cap.toString(),
            cumulativeSpentBaseUnits: cumulative.toString(),
            tranches: records.map((r) => ({
              cycle: r.cycle,
              accruedYield: r.accruedYield.toString(),
              tranche: r.tranche.toString(),
              partSellAmount: r.partSellAmount.toString(),
              cumulativeSpent: r.cumulativeSpent.toString(),
              partsRemaining: r.partsRemaining.toString(),
              active: r.active,
            })),
            forkBlockNumber: String(process.env.FORK_BLOCK ?? 47_300_000),
          },
          note: "Pinned Base mainnet fork (sandbox). Monitor→decide→act re-up loop; tranches compound accrued Aave yield; cumulative ≤ cap. No real broadcast; live solver settlement is M6.",
        },
        null,
        2,
      ),
    );

    expect(ok, "all M4 checks must pass").toBe(true);
  });
});
