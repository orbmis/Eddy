/**
 * M1 — Safe + Aave funded (deterministic Base-fork gate).
 *
 * Builds the funded, TWAP-ready Safe (shared setupFundedSafe), then asserts the
 * four M1 checks (handler + domain verifier set, aUSDC > 0, VaultRelayer approval)
 * plus a working per-part Aave withdraw path, and records the result.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import { BASE_ADDRESSES } from "../../src/config/addresses.js";
import { envelope } from "../../src/config/envelope.js";
import { readDomainVerifier, readFallbackHandler } from "../../src/safe/safe.js";
import { erc20Allowance, erc20BalanceOf } from "../../src/safe/erc20.js";
import { aTokenBalance, withdrawFromAave } from "../../src/yield/aave.js";
import { forkPort, makeClients, setupFundedSafe, startAnvilFork, waitForRpc } from "./support.js";

const PORT = forkPort(10645);
const RPC = `http://127.0.0.1:${PORT}`;
const ARTIFACT = "artifacts/m1-result.json";

let anvil: ChildProcess;

beforeAll(async () => {
  anvil = startAnvilFork(PORT);
  await waitForRpc(RPC);
}, 60_000);

afterAll(() => {
  anvil?.kill("SIGKILL");
});

describe("M1 Safe + Aave funded", () => {
  it("deploys a TWAP-ready Safe, supplies USDC to Aave, sets approvals, and proves the withdraw path", async () => {
    const clients = makeClients(RPC);
    const { owner, publicClient, walletClient } = clients;
    const { usdc, aUsdc, vaultRelayer, composableCow, extensibleFallbackHandler } = BASE_ADDRESSES;
    const cap = envelope.maxSpendPerEpoch;

    const { safe, domainSeparator, depositAmount, approveAmount } = await setupFundedSafe(clients);

    const handler = await readFallbackHandler(publicClient, safe);
    const handlerSet = handler.toLowerCase() === extensibleFallbackHandler.toLowerCase();
    expect(handlerSet, "fallback handler must be the ExtensibleFallbackHandler").toBe(true);

    const verifier = await readDomainVerifier(publicClient, { handler: extensibleFallbackHandler, safe, domainSeparator });
    const domainVerifierSet = verifier.toLowerCase() === composableCow.toLowerCase();
    expect(domainVerifierSet, "domain verifier must be ComposableCoW").toBe(true);

    const aUsdcBal = await aTokenBalance(publicClient, aUsdc, safe);
    const aUsdcGtZero = aUsdcBal > 0n;
    expect(aUsdcGtZero, "aUSDC balance must be > 0 after supply").toBe(true);

    const allowance = await erc20Allowance(publicClient, usdc, safe, vaultRelayer);
    const relayerApproved = allowance > 0n;
    const allowanceWithinCap = allowance <= cap;
    expect(relayerApproved && allowanceWithinCap, "VaultRelayer allowance set and within cap").toBe(true);

    // Per-part Aave withdraw path (withdraw-only).
    const partAmount = depositAmount / 10n;
    const usdcBefore = await erc20BalanceOf(publicClient, usdc, safe);
    await withdrawFromAave(publicClient, walletClient, { safe, owner, asset: usdc, amount: partAmount });
    const usdcAfter = await erc20BalanceOf(publicClient, usdc, safe);
    const aUsdcAfter = await aTokenBalance(publicClient, aUsdc, safe);
    const withdrawPathOk = usdcAfter - usdcBefore === partAmount && aUsdcAfter > 0n;
    expect(withdrawPathOk, "Safe-routed Aave withdraw must deliver USDC and leave aUSDC > 0").toBe(true);

    const depositWithinCap = depositAmount <= cap;
    const ok =
      handlerSet && domainVerifierSet && aUsdcGtZero && relayerApproved && allowanceWithinCap && depositWithinCap && withdrawPathOk;

    mkdirSync("artifacts", { recursive: true });
    writeFileSync(
      ARTIFACT,
      JSON.stringify(
        {
          ok,
          checks: { handlerSet, domainVerifierSet, aUsdcGtZero, relayerApproved, allowanceWithinCap, depositWithinCap, withdrawPathOk },
          values: {
            safe,
            fallbackHandler: handler,
            domainVerifier: verifier,
            aUsdcBalance: aUsdcBal.toString(),
            usdcAllowanceToVaultRelayer: allowance.toString(),
            depositUsdcBaseUnits: depositAmount.toString(),
            capUsdcBaseUnits: cap.toString(),
            partWithdrawnBaseUnits: partAmount.toString(),
            forkBlockNumber: String(process.env.FORK_BLOCK ?? 47_300_000),
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
