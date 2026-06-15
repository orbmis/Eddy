/**
 * M1 — Safe + Aave funded (deterministic Base-fork gate).
 *
 * On a pinned Base mainnet fork (sandbox; no broadcast), this:
 *   1. deploys a threshold-1 Safe with the ExtensibleFallbackHandler,
 *   2. points its domain verifier at ComposableCoW (the "TWAP fallback handler"),
 *   3. funds it with USDC (impersonated whale) and supplies USDC to Aave,
 *   4. sets the USDC→VaultRelayer approval (the swap / withdraw-path allowance),
 *   5. demonstrates the per-part Aave withdraw path works (withdraw-only),
 * then records every check + the amounts used to artifacts/m1-result.json.
 * All amounts stay below the per-epoch cap read from config (never widened).
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { BASE_ADDRESSES } from "../../src/config/addresses.js";
import { envelope } from "../../src/config/envelope.js";
import { deploySafe, readDomainVerifier, readFallbackHandler, setDomainVerifier } from "../../src/safe/safe.js";
import { ERC20_ABI, erc20Allowance, erc20BalanceOf, safeApprove } from "../../src/safe/erc20.js";
import { aTokenBalance, supplyToAave, withdrawFromAave } from "../../src/yield/aave.js";

// Process-unique port so back-to-back / overlapping fork runs never collide on
// a stale anvil (distinct base from the M0 spike's range).
const PORT = Number(process.env.ANVIL_PORT ?? 10645 + (process.pid % 2000));
const RPC = `http://127.0.0.1:${PORT}`;
const BASE_RPC_URL = process.env.BASE_RPC_URL;
const FORK_BLOCK = Number(process.env.FORK_BLOCK ?? 47_300_000);
// anvil's first default dev account — local fork only, never a real key.
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const ARTIFACT = "artifacts/m1-result.json";

const SETTLEMENT_ABI = [
  { type: "function", name: "domainSeparator", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

let anvil: ChildProcess;

async function waitForRpc(timeoutMs = 30_000): Promise<void> {
  const probe = createPublicClient({ transport: http(RPC) });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await probe.getBlockNumber();
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("anvil did not become ready in time");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

beforeAll(async () => {
  if (!BASE_RPC_URL) throw new Error("BASE_RPC_URL is not set in .env — M1 needs a Base RPC to fork. Aborting.");
  anvil = spawn(
    "anvil",
    ["--fork-url", BASE_RPC_URL, "--fork-block-number", String(FORK_BLOCK), "--port", String(PORT), "--silent"],
    { stdio: "ignore" },
  );
  anvil.on("error", (e) => {
    throw new Error(`failed to start anvil (is Foundry installed?): ${e.message}`);
  });
  await waitForRpc();
}, 60_000);

afterAll(() => {
  anvil?.kill("SIGKILL");
});

describe("M1 Safe + Aave funded", () => {
  it("deploys a TWAP-ready Safe, supplies USDC to Aave, sets approvals, and proves the withdraw path", async () => {
    const owner = privateKeyToAccount(DEPLOYER_PK);
    const publicClient = createPublicClient({ chain: base, transport: http(RPC) });
    const walletClient = createWalletClient({ account: owner, chain: base, transport: http(RPC) });
    const testClient = createTestClient({ chain: base, mode: "anvil", transport: http(RPC) });

    await testClient.setBalance({ address: owner.address, value: parseEther("10") });

    const { usdc, aUsdc, aavePool, vaultRelayer, composableCow, extensibleFallbackHandler, settlement } =
      BASE_ADDRESSES;
    const cap = envelope.maxSpendPerEpoch;
    const depositAmount = envelope.deposit;
    const fundAmount = envelope.deposit + envelope.buffer;
    const partAmount = envelope.deposit / 10n; // a representative single-part withdrawal

    // 1. Deploy the Safe with the ExtensibleFallbackHandler.
    const safe = await deploySafe(publicClient, walletClient, { owner, fallbackHandler: extensibleFallbackHandler });
    const handler = await readFallbackHandler(publicClient, safe);
    const handlerSet = handler.toLowerCase() === extensibleFallbackHandler.toLowerCase();
    expect(handlerSet, "fallback handler must be the ExtensibleFallbackHandler").toBe(true);

    // 2. Point the domain verifier at ComposableCoW (the TWAP capability).
    const domainSeparator = await publicClient.readContract({
      address: settlement,
      abi: SETTLEMENT_ABI,
      functionName: "domainSeparator",
    });
    await setDomainVerifier(publicClient, walletClient, {
      safe,
      owner,
      domainSeparator,
      verifier: composableCow,
    });
    const verifier = await readDomainVerifier(publicClient, { handler: extensibleFallbackHandler, safe, domainSeparator });
    const domainVerifierSet = verifier.toLowerCase() === composableCow.toLowerCase();
    expect(domainVerifierSet, "domain verifier must be ComposableCoW").toBe(true);

    // 3. Fund the Safe with USDC from an impersonated whale (the aUSDC aToken holds plenty).
    const whale = aUsdc;
    const whaleBal = await erc20BalanceOf(publicClient, usdc, whale);
    expect(whaleBal >= fundAmount, "whale must hold enough USDC").toBe(true);
    await testClient.setBalance({ address: whale, value: parseEther("1") });
    await testClient.impersonateAccount({ address: whale });
    const fundHash = await walletClient.writeContract({
      account: whale,
      chain: base,
      address: usdc,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [safe, fundAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });
    await testClient.stopImpersonatingAccount({ address: whale });

    // 4. Supply USDC to Aave -> aUSDC.
    await supplyToAave(publicClient, walletClient, { safe, owner, asset: usdc, amount: depositAmount });
    const aUsdcBal = await aTokenBalance(publicClient, aUsdc, safe);
    const aUsdcGtZero = aUsdcBal > 0n;
    expect(aUsdcGtZero, "aUSDC balance must be > 0 after supply").toBe(true);

    // 5. Approve USDC -> CoW VaultRelayer (swap leg + withdraw-path allowance).
    await safeApprove(publicClient, walletClient, {
      safe,
      owner,
      token: usdc,
      spender: vaultRelayer,
      amount: depositAmount,
    });
    const allowance = await erc20Allowance(publicClient, usdc, safe, vaultRelayer);
    const relayerApproved = allowance > 0n;
    const allowanceWithinCap = allowance <= cap;
    expect(relayerApproved, "VaultRelayer allowance must be set").toBe(true);
    expect(allowanceWithinCap, "allowance must not exceed the per-epoch cap").toBe(true);

    // 6. Prove the per-part Aave withdraw path works (withdraw-only).
    const usdcBefore = await erc20BalanceOf(publicClient, usdc, safe);
    await withdrawFromAave(publicClient, walletClient, { safe, owner, asset: usdc, amount: partAmount });
    const usdcAfter = await erc20BalanceOf(publicClient, usdc, safe);
    const aUsdcAfter = await aTokenBalance(publicClient, aUsdc, safe);
    const withdrawPathOk = usdcAfter - usdcBefore === partAmount && aUsdcAfter > 0n;
    expect(withdrawPathOk, "Safe-routed Aave withdraw must deliver USDC and leave aUSDC > 0").toBe(true);

    const depositWithinCap = depositAmount <= cap;
    const ok =
      handlerSet &&
      domainVerifierSet &&
      aUsdcGtZero &&
      relayerApproved &&
      allowanceWithinCap &&
      depositWithinCap &&
      withdrawPathOk;

    mkdirSync("artifacts", { recursive: true });
    writeFileSync(
      ARTIFACT,
      JSON.stringify(
        {
          ok,
          checks: {
            handlerSet,
            domainVerifierSet,
            aUsdcGtZero,
            relayerApproved,
            allowanceWithinCap,
            depositWithinCap,
            withdrawPathOk,
          },
          values: {
            safe,
            fallbackHandler: handler,
            domainVerifier: verifier,
            aUsdcBalance: aUsdcBal.toString(),
            usdcAllowanceToVaultRelayer: allowance.toString(),
            depositUsdcBaseUnits: depositAmount.toString(),
            capUsdcBaseUnits: cap.toString(),
            partWithdrawnBaseUnits: partAmount.toString(),
            forkBlockNumber: FORK_BLOCK.toString(),
          },
          note: "Pinned Base mainnet fork (sandbox). Safe deploy + Aave supply + approvals + withdraw-path demo. No real broadcast; DRY_RUN respected.",
        },
        null,
        2,
      ),
    );

    expect(ok, "all M1 checks must pass").toBe(true);
  });
});
