/**
 * Minimal Safe (v1.4.1) deploy + execution helpers, raw viem — no Safe SDK, for
 * deterministic fork use. Threshold-1 Safe owned by a single EOA; Safe txs are
 * authorised with the **pre-validated signature** format (r = owner, s = 0,
 * v = 1), valid when the caller IS the owner — so no EIP-712 signing is needed.
 */
import {
  concat,
  encodeFunctionData,
  getAddress,
  pad,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { base } from "viem/chains";
import { BASE_ADDRESSES, FALLBACK_HANDLER_SLOT } from "../config/addresses.js";

// Base-locked client types: the project is Base-only, and Base's OP-stack
// formatters specialise getBlock's tx union, which is not assignable to viem's
// default (chain-agnostic) PublicClient/WalletClient. Locking to `typeof base`
// lets the fork-test clients (created with `chain: base`) pass cleanly.
export type EddyPublicClient = PublicClient<Transport, typeof base>;
export type EddyWalletClient = WalletClient<Transport, typeof base, Account>;

export const SAFE_PROXY_FACTORY_ABI = [
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
] as const;

export const SAFE_ABI = [
  {
    type: "function",
    name: "setup",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owners", type: "address[]" },
      { name: "_threshold", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "fallbackHandler", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint256" },
      { name: "paymentReceiver", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    type: "function",
    name: "enableModule",
    stateMutability: "nonpayable",
    inputs: [{ name: "module", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isModuleEnabled",
    stateMutability: "view",
    inputs: [{ name: "module", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  // ERC-1271 — served by the ExtensibleFallbackHandler, which delegates to the
  // registered domain verifier (ComposableCoW). Returns the 0x1626ba7e magic.
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "_hash", type: "bytes32" },
      { name: "_signature", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4" }],
  },
] as const;

/** EIP-1271 "valid signature" magic value for isValidSignature(bytes32,bytes). */
export const ERC1271_MAGIC = "0x1626ba7e" as const;

export const EXTENSIBLE_FALLBACK_HANDLER_ABI = [
  {
    type: "function",
    name: "setDomainVerifier",
    stateMutability: "nonpayable",
    inputs: [
      { name: "domainSeparator", type: "bytes32" },
      { name: "verifier", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "domainVerifiers",
    stateMutability: "view",
    inputs: [
      { name: "safe", type: "address" },
      { name: "domainSeparator", type: "bytes32" },
    ],
    outputs: [{ name: "verifier", type: "address" }],
  },
] as const;

const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** Pre-validated Safe signature for `owner` (valid only when msg.sender == owner). */
export function prevalidatedSignature(owner: Address): Hex {
  return concat([pad(owner, { size: 32 }), pad("0x00", { size: 32 }), "0x01"]);
}

/** Encode the Safe `setup` initializer for a single-owner, threshold-1 Safe. */
export function encodeSafeSetup(owner: Address, fallbackHandler: Address): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "setup",
    args: [[owner], 1n, ZERO, "0x", fallbackHandler, ZERO, 0n, ZERO],
  });
}

/** Deploy a fresh Safe proxy and return its (deterministic, salt-pinned) address. */
export async function deploySafe(
  publicClient: EddyPublicClient,
  walletClient: EddyWalletClient,
  params: { owner: Account; fallbackHandler: Address; saltNonce?: bigint },
): Promise<Address> {
  const { owner, fallbackHandler, saltNonce = 0n } = params;
  const initializer = encodeSafeSetup(owner.address, fallbackHandler);
  const args = [BASE_ADDRESSES.safeL2Singleton, initializer, saltNonce] as const;

  // Simulate to recover the proxy address (createProxyWithNonce returns it),
  // then send the real deploy tx — deterministic given the pinned saltNonce.
  const { result: proxy } = await publicClient.simulateContract({
    account: owner,
    address: BASE_ADDRESSES.safeProxyFactory,
    abi: SAFE_PROXY_FACTORY_ABI,
    functionName: "createProxyWithNonce",
    args,
  });
  const hash = await walletClient.writeContract({
    account: owner,
    chain: walletClient.chain,
    address: BASE_ADDRESSES.safeProxyFactory,
    abi: SAFE_PROXY_FACTORY_ABI,
    functionName: "createProxyWithNonce",
    args,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return proxy;
}

/** Execute an arbitrary call FROM the Safe (threshold-1, pre-validated signature). */
export async function execSafe(
  publicClient: EddyPublicClient,
  walletClient: EddyWalletClient,
  params: { safe: Address; owner: Account; to: Address; data: Hex; value?: bigint },
): Promise<void> {
  const { safe, owner, to, data, value = 0n } = params;
  const hash = await walletClient.writeContract({
    account: owner,
    chain: walletClient.chain,
    address: safe,
    abi: SAFE_ABI,
    functionName: "execTransaction",
    args: [to, value, data, 0, 0n, 0n, 0n, ZERO, ZERO, prevalidatedSignature(owner.address)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

/** Point the Safe's ExtensibleFallbackHandler domain verifier at ComposableCoW. */
export async function setDomainVerifier(
  publicClient: EddyPublicClient,
  walletClient: EddyWalletClient,
  params: { safe: Address; owner: Account; domainSeparator: Hex; verifier: Address },
): Promise<void> {
  const data = encodeFunctionData({
    abi: EXTENSIBLE_FALLBACK_HANDLER_ABI,
    functionName: "setDomainVerifier",
    args: [params.domainSeparator, params.verifier],
  });
  // Routed THROUGH the Safe (to: the Safe itself) so the handler sees msg.sender == Safe.
  await execSafe(publicClient, walletClient, {
    safe: params.safe,
    owner: params.owner,
    to: params.safe,
    data,
  });
}

/** Read the installed fallback handler from the fixed Safe storage slot. */
export async function readFallbackHandler(publicClient: EddyPublicClient, safe: Address): Promise<Address> {
  const raw = await publicClient.getStorageAt({ address: safe, slot: FALLBACK_HANDLER_SLOT });
  if (!raw) return ZERO;
  return getAddress(`0x${raw.slice(-40)}`);
}

/** Read the domain verifier the Safe has registered for `domainSeparator`. */
export async function readDomainVerifier(
  publicClient: EddyPublicClient,
  params: { handler: Address; safe: Address; domainSeparator: Hex },
): Promise<Address> {
  return publicClient.readContract({
    address: params.handler,
    abi: EXTENSIBLE_FALLBACK_HANDLER_ABI,
    functionName: "domainVerifiers",
    args: [params.safe, params.domainSeparator],
  });
}
