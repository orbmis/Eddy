/**
 * M3 — fork-level guardrails: the one-tx kill switch and the module per-call cap.
 *
 *  - Kill: register a leg order, confirm it's active, then cancel it in ONE Safe
 *    tx (ComposableCoW.remove) and confirm it's no-longer-active (singleOrders
 *    false + getTradeableOrderWithSignature reverts).
 *  - Cap: the AaveWithdrawModule rejects a withdraw above maxWithdrawPerCall and
 *    allows exactly the cap.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, stringToHex, type Abi, type Hex } from "viem";
import { base } from "viem/chains";
import { BASE_ADDRESSES } from "../../src/config/addresses.js";
import { basket, partSellAmount } from "../../src/config/basket.js";
import { execSafe } from "../../src/safe/safe.js";
import { AAVE_WITHDRAW_MODULE_ABI, deployModule, enableModule } from "../../src/safe/module.js";
import { erc20BalanceOf } from "../../src/safe/erc20.js";
import {
  buildLegOrder,
  conditionalOrderHash,
  createOrderCalldata,
  getTradeableOrderWithSignature,
  isSingleOrderActive,
  killOrderCalldata,
} from "../../src/cow/twap.js";
import { FORK_BLOCK, forkPort, makeClients, setupFundedSafe, startAnvilFork, waitForRpc } from "./support.js";

const PORT = forkPort(14645);
const RPC = `http://127.0.0.1:${PORT}`;
const ARTIFACT = "artifacts/m3-result.json";

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

describe("M3 kill switch + module per-call cap", () => {
  it("cancels a conditional order in one tx and enforces the withdraw cap", async () => {
    const clients = makeClients(RPC);
    const { owner, publicClient, walletClient } = clients;
    const { usdc, aavePool, composableCow } = BASE_ADDRESSES;

    const { safe } = await setupFundedSafe(clients);
    const leg = basket.legs[0]!;
    const psa = partSellAmount(leg);

    const { bytecode, abi } = loadModuleArtifact();
    const module = await deployModule(publicClient, walletClient, {
      deployer: owner,
      bytecode,
      abi,
      safe,
      pool: aavePool,
      asset: usdc,
      maxWithdrawPerCall: psa,
    });
    await enableModule(publicClient, walletClient, { safe, owner, module });

    // --- Kill switch ---
    const t0 = (await publicClient.getBlock({ blockNumber: BigInt(FORK_BLOCK) })).timestamp;
    const now = (await publicClient.getBlock()).timestamp;
    const salt = keccak256(stringToHex(`eddy:m3:${Math.floor(Math.random() * 1e15)}`));
    const built = await buildLegOrder({ leg, safe, module, t0, now, salt });

    await execSafe(publicClient, walletClient, {
      safe,
      owner,
      to: composableCow,
      data: createOrderCalldata(built.params, true),
    });
    const orderHash = await conditionalOrderHash(publicClient, built.params);
    const killActiveBefore = await isSingleOrderActive(publicClient, safe, orderHash);
    // sanity: derivable while active
    await getTradeableOrderWithSignature(publicClient, { owner: safe, params: built.params });

    await execSafe(publicClient, walletClient, { safe, owner, to: composableCow, data: killOrderCalldata(orderHash) });
    const killInactiveAfter = !(await isSingleOrderActive(publicClient, safe, orderHash));

    let killReadReverts = false;
    try {
      await getTradeableOrderWithSignature(publicClient, { owner: safe, params: built.params });
    } catch {
      killReadReverts = true; // SingleOrderNotAuthed
    }

    expect(killActiveBefore, "order must be active after create").toBe(true);
    expect(killInactiveAfter, "order must be inactive after remove").toBe(true);
    expect(killReadReverts, "getTradeableOrderWithSignature must revert after remove").toBe(true);

    // --- Module per-call cap ---
    const usdcBefore = await erc20BalanceOf(publicClient, usdc, safe);
    const exactHash = await walletClient.writeContract({
      account: owner,
      chain: base,
      address: module,
      abi: AAVE_WITHDRAW_MODULE_ABI,
      functionName: "withdrawPart",
      args: [psa],
    });
    await publicClient.waitForTransactionReceipt({ hash: exactHash });
    const usdcAfter = await erc20BalanceOf(publicClient, usdc, safe);
    const capAllowsExact = usdcAfter - usdcBefore === psa;

    let capRejectsOver = false;
    try {
      await publicClient.simulateContract({
        account: owner,
        address: module,
        abi: AAVE_WITHDRAW_MODULE_ABI,
        functionName: "withdrawPart",
        args: [psa + 1n],
      });
    } catch {
      capRejectsOver = true; // AmountExceedsCap
    }

    expect(capAllowsExact, "withdrawPart(maxWithdrawPerCall) must deliver exactly the cap").toBe(true);
    expect(capRejectsOver, "withdrawPart(maxWithdrawPerCall + 1) must revert").toBe(true);

    const ok = killActiveBefore && killInactiveAfter && killReadReverts && capAllowsExact && capRejectsOver;

    mkdirSync("artifacts", { recursive: true });
    writeFileSync(
      ARTIFACT,
      JSON.stringify(
        {
          ok,
          checks: { killActiveBefore, killInactiveAfter, killReadReverts, capAllowsExact, capRejectsOver },
          values: {
            safe,
            module,
            orderHash,
            partSellAmountBaseUnits: psa.toString(),
            maxWithdrawPerCallBaseUnits: psa.toString(),
            partsCount: basket.parts.toString(),
            forkBlockNumber: String(FORK_BLOCK),
          },
          note: "Pinned Base mainnet fork (sandbox). One-tx kill (ComposableCoW.remove) + module per-call withdraw cap. Construction-time rejections are covered by test/unit/envelope.test.ts.",
        },
        null,
        2,
      ),
    );

    expect(ok, "all M3 fork checks must pass").toBe(true);
  });
});
