/**
 * M2 — Basket TWAP construction + signing (Model B, executable pre-hook).
 *
 * On a pinned Base mainnet fork: build the funded TWAP-ready Safe, deploy + enable
 * the AaveWithdrawModule, construct the basket-leg TWAP(s) with a per-part
 * Aave-withdraw pre-hook (amount == partSellAmount) baked into appData, register
 * via ComposableCoW (as the Safe), sign (ERC-1271) with a valid UID, and prove the
 * hook executes (impersonated trampoline → USDC delta == partSellAmount).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, parseEther, stringToHex, type Abi, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { BASE_ADDRESSES } from "../../src/config/addresses.js";
import { envelope } from "../../src/config/envelope.js";
import { assertWeightsSum100, basket, legBudget, minPartLimit, partSellAmount, weightsSumBps } from "../../src/config/basket.js";
import { ERC1271_MAGIC, execSafe, SAFE_ABI } from "../../src/safe/safe.js";
import { AAVE_WITHDRAW_MODULE_ABI, deployModule, enableModule, isModuleEnabled } from "../../src/safe/module.js";
import { erc20BalanceOf } from "../../src/safe/erc20.js";
import { aTokenBalance } from "../../src/yield/aave.js";
import {
  buildPreHookAppData,
  conditionalOrderParams,
  createOrderCalldata,
  decodeWithdrawPartAmount,
  encodeTwapStaticInput,
  getTradeableOrderWithSignature,
  orderDigest,
  orderUid,
} from "../../src/cow/twap.js";
import { FORK_BLOCK, forkPort, makeClients, setupFundedSafe, startAnvilFork, waitForRpc } from "./support.js";

const PORT = forkPort(12645);
const RPC = `http://127.0.0.1:${PORT}`;
const ARTIFACT = "artifacts/m2-result.json";

const TRAMPOLINE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "hooks",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
          { name: "gasLimit", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

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

describe("M2 basket TWAP construction + signing", () => {
  it("constructs + registers + signs a basket-leg TWAP with an executable per-part Aave-withdraw pre-hook", async () => {
    const clients = makeClients(RPC);
    const { owner, publicClient, walletClient, testClient } = clients;
    const { usdc, aUsdc, aavePool, composableCow, settlement, hooksTrampoline } = BASE_ADDRESSES;

    const { safe } = await setupFundedSafe(clients);

    // 1. Deploy + enable the withdraw-only module.
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
    const moduleEnabled = await isModuleEnabled(publicClient, safe, module);
    expect(moduleEnabled, "module must be enabled on the Safe").toBe(true);

    // module immutables wired correctly
    const [modSafe, modAsset] = await Promise.all([
      publicClient.readContract({ address: module, abi: AAVE_WITHDRAW_MODULE_ABI, functionName: "safe" }),
      publicClient.readContract({ address: module, abi: AAVE_WITHDRAW_MODULE_ABI, functionName: "asset" }),
    ]);
    const moduleWired = (modSafe as Address).toLowerCase() === safe.toLowerCase() && (modAsset as Address).toLowerCase() === usdc.toLowerCase();
    expect(moduleWired, "module must be bound to (safe, USDC)").toBe(true);

    // 2. Basket arithmetic.
    assertWeightsSum100();
    const weightsSum = weightsSumBps();
    const weightsSum100 = weightsSum === 10000;
    const lb = legBudget(leg);
    const mpl = minPartLimit(leg);
    const partMatchesBudget = psa === lb / basket.parts;
    expect(partMatchesBudget, "partSellAmount must equal legBudget / parts").toBe(true);
    const tokenAllowlisted = envelope.allowedBuyTokens.some((t) => t.toLowerCase() === leg.token.toLowerCase());
    expect(tokenAllowlisted, "leg buy token must be in the allowlist").toBe(true);

    // 3. Per-part pre-hook appData (amount == partSellAmount), targeting the module.
    const { appData, preHook } = await buildPreHookAppData({ module, partSellAmount: psa });
    const hookAmount = decodeWithdrawPartAmount(preHook.callData);
    const hookAmountMatches = hookAmount === psa;
    expect(hookAmountMatches, "pre-hook withdraw amount must equal partSellAmount").toBe(true);

    // 4. Construct + register the TWAP (as the Safe).
    const t0 = (await publicClient.getBlock({ blockNumber: BigInt(FORK_BLOCK) })).timestamp;
    const staticInput = encodeTwapStaticInput({
      sellToken: usdc,
      buyToken: leg.token,
      receiver: safe,
      partSellAmount: psa,
      minPartLimit: mpl,
      t0,
      n: basket.parts,
      t: basket.intervalSeconds,
      span: basket.span,
      appData,
    });
    // Unique salt per attempt so a retry after a transient RPC flake re-registers
    // cleanly instead of colliding with the prior attempt's conditional order.
    const salt = keccak256(stringToHex(`eddy:leg:0:${Math.floor(Math.random() * 1e15)}`));
    const params = conditionalOrderParams(staticInput, salt);
    await execSafe(publicClient, walletClient, { safe, owner, to: composableCow, data: createOrderCalldata(params, true) });

    // 5. Read back the discrete order + ERC-1271 signature; assert UID + validity.
    const { order, signature } = await getTradeableOrderWithSignature(publicClient, { owner: safe, params });
    const sellAmountMatches = order.sellAmount === psa;
    const appDataMatches = order.appData.toLowerCase() === appData.toLowerCase();
    expect(sellAmountMatches && appDataMatches, "derived order must carry partSellAmount + the hook appData").toBe(true);

    const digest = orderDigest(order);
    const uid = orderUid(order, safe);
    const uidValid = uid.length === 2 + 56 * 2; // 56 bytes
    const magic = (await publicClient.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: "isValidSignature",
      args: [digest, signature],
    })) as Hex;
    const signatureValid = magic.toLowerCase() === ERC1271_MAGIC;
    expect(uidValid, "UID must be 56 bytes").toBe(true);
    expect(signatureValid, `Safe.isValidSignature must return ${ERC1271_MAGIC}, got ${magic}`).toBe(true);

    // 6. Prove the per-part pre-hook executes: impersonated settlement → trampoline.
    const usdcBefore = await erc20BalanceOf(publicClient, usdc, safe);
    const aBefore = await aTokenBalance(publicClient, aUsdc, safe);
    await testClient.setBalance({ address: settlement, value: parseEther("1") });
    await testClient.impersonateAccount({ address: settlement });
    const execHash = await walletClient.writeContract({
      account: settlement,
      chain: base,
      address: hooksTrampoline,
      abi: TRAMPOLINE_ABI,
      functionName: "execute",
      args: [[{ target: preHook.target, callData: preHook.callData, gasLimit: BigInt(preHook.gasLimit) }]],
    });
    await publicClient.waitForTransactionReceipt({ hash: execHash });
    await testClient.stopImpersonatingAccount({ address: settlement });
    const usdcAfter = await erc20BalanceOf(publicClient, usdc, safe);
    const aAfter = await aTokenBalance(publicClient, aUsdc, safe);
    const hookExecutes = usdcAfter - usdcBefore === psa && aAfter < aBefore;
    expect(hookExecutes, "pre-hook must withdraw exactly partSellAmount into the Safe").toBe(true);

    const ok =
      moduleEnabled && moduleWired && weightsSum100 && partMatchesBudget && tokenAllowlisted &&
      hookAmountMatches && sellAmountMatches && appDataMatches && uidValid && signatureValid && hookExecutes;

    mkdirSync("artifacts", { recursive: true });
    writeFileSync(
      ARTIFACT,
      JSON.stringify(
        {
          ok,
          checks: {
            moduleEnabled, moduleWired, weightsSum100, partMatchesBudget, tokenAllowlisted,
            hookAmountMatches, sellAmountMatches, appDataMatches, uidValid, signatureValid, hookExecutes,
          },
          values: {
            safe,
            module,
            buyToken: leg.token,
            weightsSumBps: weightsSum,
            partsCount: basket.parts.toString(),
            legBudgetBaseUnits: lb.toString(),
            partSellAmountBaseUnits: psa.toString(),
            hookWithdrawAmountBaseUnits: hookAmount.toString(),
            epochBudgetBaseUnits: basket.epochBudget.toString(),
            capBaseUnits: envelope.maxSpendPerEpoch.toString(),
            minPartLimit: mpl.toString(),
            appData,
            orderUid: uid,
            isValidSignatureMagic: magic,
            usdcWithdrawnByHook: (usdcAfter - usdcBefore).toString(),
            forkBlockNumber: String(FORK_BLOCK),
          },
          note: "Pinned Base mainnet fork (sandbox). Construction + ComposableCoW registration + ERC-1271 signing + executable per-part Aave-withdraw pre-hook. No real broadcast; live solver settlement is M6.",
        },
        null,
        2,
      ),
    );

    expect(ok, "all M2 checks must pass").toBe(true);
  });
});
