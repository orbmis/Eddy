/**
 * Shared fork-test harness: pinned Base anvil lifecycle + a funded, TWAP-ready
 * Safe (deploy → set domain verifier → fund via impersonated whale → supply to
 * Aave → approve VaultRelayer). Reused by the M1 and M2 fork tests.
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { BASE_ADDRESSES } from "../../src/config/addresses.js";
import { envelope } from "../../src/config/envelope.js";
import { deploySafe, setDomainVerifier } from "../../src/safe/safe.js";
import { ERC20_ABI, erc20BalanceOf, safeApprove } from "../../src/safe/erc20.js";
import { supplyToAave } from "../../src/yield/aave.js";

export const FORK_BLOCK = Number(process.env.FORK_BLOCK ?? 47_300_000);
// anvil's first default dev account — local fork only, never a real key.
export const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
export const BASE_RPC_URL = process.env.BASE_RPC_URL;

export const SETTLEMENT_ABI = [
  { type: "function", name: "domainSeparator", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

/** Process-unique port (distinct base per caller) so back-to-back runs never collide. */
export function forkPort(base_: number): number {
  return Number(process.env.ANVIL_PORT ?? base_ + (process.pid % 2000));
}

export async function waitForRpc(rpc: string, timeoutMs = 30_000): Promise<void> {
  const probe = createPublicClient({ transport: http(rpc) });
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

/** Spawn an anvil fork of Base at the pinned block on `port`. */
export function startAnvilFork(port: number): ChildProcess {
  if (!BASE_RPC_URL) throw new Error("BASE_RPC_URL is not set in .env — fork tests need a Base RPC. Aborting.");
  const anvil = spawn(
    "anvil",
    [
      "--fork-url", BASE_RPC_URL,
      "--fork-block-number", String(FORK_BLOCK),
      "--port", String(port),
      // Resilience to transient RPC throttling when forks spin up back-to-back.
      "--retries", "10",
      "--timeout", "60000",
      "--no-rate-limit",
      "--silent",
    ],
    { stdio: "ignore" },
  );
  anvil.on("error", (e) => {
    throw new Error(`failed to start anvil (is Foundry installed?): ${e.message}`);
  });
  return anvil;
}

export function makeClients(rpc: string) {
  const owner = privateKeyToAccount(DEPLOYER_PK);
  const publicClient = createPublicClient({ chain: base, transport: http(rpc) });
  const walletClient = createWalletClient({ account: owner, chain: base, transport: http(rpc) });
  const testClient = createTestClient({ chain: base, mode: "anvil", transport: http(rpc) });
  return { owner, publicClient, walletClient, testClient };
}

export type Clients = ReturnType<typeof makeClients>;

export interface FundedSafe {
  safe: Address;
  domainSeparator: Hex;
  fundAmount: bigint;
  depositAmount: bigint;
  approveAmount: bigint;
}

/**
 * Deploy a threshold-1 Safe with the ExtensibleFallbackHandler, point its domain
 * verifier at ComposableCoW, fund it with USDC (impersonated aUSDC whale), supply
 * to Aave, and approve USDC→VaultRelayer. Mirrors M1's setup.
 */
export async function setupFundedSafe(clients: Clients): Promise<FundedSafe> {
  const { owner, publicClient, walletClient, testClient } = clients;
  const { usdc, aUsdc, vaultRelayer, composableCow, extensibleFallbackHandler, settlement } = BASE_ADDRESSES;

  const depositAmount = envelope.deposit;
  const fundAmount = envelope.deposit + envelope.buffer;
  const approveAmount = envelope.deposit;

  await testClient.setBalance({ address: owner.address, value: parseEther("10") });

  // Fresh Safe per attempt (random salt) so a vitest retry after a transient RPC
  // flake deploys a new Safe rather than colliding with the prior attempt's proxy.
  const saltNonce = BigInt(Math.floor(Math.random() * 1e15));
  const safe = await deploySafe(publicClient, walletClient, {
    owner,
    fallbackHandler: extensibleFallbackHandler,
    saltNonce,
  });

  const domainSeparator = await publicClient.readContract({
    address: settlement,
    abi: SETTLEMENT_ABI,
    functionName: "domainSeparator",
  });
  await setDomainVerifier(publicClient, walletClient, { safe, owner, domainSeparator, verifier: composableCow });

  // Fund with USDC from the aUSDC aToken (a large, stable USDC holder at the pinned block).
  const whale = aUsdc;
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

  await supplyToAave(publicClient, walletClient, { safe, owner, asset: usdc, amount: depositAmount });
  await safeApprove(publicClient, walletClient, { safe, owner, token: usdc, spender: vaultRelayer, amount: approveAmount });

  // sanity: funded
  const aBal = await erc20BalanceOf(publicClient, aUsdc, safe);
  if (aBal <= 0n) throw new Error("setupFundedSafe: aUSDC balance is zero after supply");

  return { safe, domainSeparator, fundAmount, depositAmount, approveAmount };
}
