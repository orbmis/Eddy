/**
 * Aave v3 yield leg — WITHDRAW-ONLY discipline (CLAUDE.md): the only approval
 * this module ever sets is USDC → the Aave Pool (required for `supply`). It
 * never transfers the yield position elsewhere and never approves an arbitrary
 * address. `withdraw` burns the Safe's own aTokens and needs no approval.
 */
import { encodeFunctionData, type Account, type Address } from "viem";
import { BASE_ADDRESSES } from "../config/addresses.js";
import { execSafe, type EddyPublicClient, type EddyWalletClient } from "../safe/safe.js";
import { erc20BalanceOf, safeApprove } from "../safe/erc20.js";

export const AAVE_POOL_ABI = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Supply `amount` of `asset` to Aave on behalf of the Safe (approves the Pool first). */
export async function supplyToAave(
  publicClient: EddyPublicClient,
  walletClient: EddyWalletClient,
  params: { safe: Address; owner: Account; asset: Address; amount: bigint },
): Promise<void> {
  const { safe, owner, asset, amount } = params;
  // Withdraw-only leg: the sole approval is asset → the Aave Pool, for supply.
  await safeApprove(publicClient, walletClient, {
    safe,
    owner,
    token: asset,
    spender: BASE_ADDRESSES.aavePool,
    amount,
  });
  const data = encodeFunctionData({
    abi: AAVE_POOL_ABI,
    functionName: "supply",
    args: [asset, amount, safe, 0],
  });
  await execSafe(publicClient, walletClient, { safe, owner, to: BASE_ADDRESSES.aavePool, data });
}

/** Withdraw `amount` of `asset` from Aave back to the Safe (no approval needed). */
export async function withdrawFromAave(
  publicClient: EddyPublicClient,
  walletClient: EddyWalletClient,
  params: { safe: Address; owner: Account; asset: Address; amount: bigint },
): Promise<void> {
  const data = encodeFunctionData({
    abi: AAVE_POOL_ABI,
    functionName: "withdraw",
    args: [params.asset, params.amount, params.safe],
  });
  await execSafe(publicClient, walletClient, {
    safe: params.safe,
    owner: params.owner,
    to: BASE_ADDRESSES.aavePool,
    data,
  });
}

/** The Safe's aToken balance (principal + accrued interest). */
export function aTokenBalance(publicClient: EddyPublicClient, aToken: Address, account: Address): Promise<bigint> {
  return erc20BalanceOf(publicClient, aToken, account);
}
