/**
 * Safe module helpers — deploy the AaveWithdrawModule and enable it on the Safe.
 * The module lets a CoW per-part pre-hook trigger an Aave withdraw executed AS
 * the Safe (see contracts/AaveWithdrawModule.sol).
 */
import { encodeFunctionData, type Abi, type Account, type Address, type Hex } from "viem";
import {
  execSafe,
  SAFE_ABI,
  type EddyPublicClient,
  type EddyWalletClient,
} from "./safe.js";

export const AAVE_WITHDRAW_MODULE_ABI = [
  {
    type: "function",
    name: "withdrawPart",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  { type: "function", name: "safe", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pool", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** Deploy AaveWithdrawModule(safe, pool, asset) from its compiled creation bytecode. */
export async function deployModule(
  publicClient: EddyPublicClient,
  walletClient: EddyWalletClient,
  params: { deployer: Account; bytecode: Hex; abi: Abi; safe: Address; pool: Address; asset: Address },
): Promise<Address> {
  const hash = await walletClient.deployContract({
    account: params.deployer,
    chain: walletClient.chain,
    abi: params.abi,
    bytecode: params.bytecode,
    args: [params.safe, params.pool, params.asset],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("module deploy produced no address");
  return receipt.contractAddress;
}

/** Enable `module` on the Safe (executed as the Safe). */
export async function enableModule(
  publicClient: EddyPublicClient,
  walletClient: EddyWalletClient,
  params: { safe: Address; owner: Account; module: Address },
): Promise<void> {
  const data = encodeFunctionData({ abi: SAFE_ABI, functionName: "enableModule", args: [params.module] });
  await execSafe(publicClient, walletClient, { safe: params.safe, owner: params.owner, to: params.safe, data });
}

export function isModuleEnabled(
  publicClient: EddyPublicClient,
  safe: Address,
  module: Address,
): Promise<boolean> {
  return publicClient.readContract({ address: safe, abi: SAFE_ABI, functionName: "isModuleEnabled", args: [module] });
}
