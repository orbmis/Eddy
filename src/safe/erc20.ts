/** ERC-20 reads + Safe-executed approve (used for USDC→Pool and USDC→VaultRelayer). */
import { encodeFunctionData, type Account, type Address } from "viem";
import { execSafe, type EddyPublicClient, type EddyWalletClient } from "./safe.js";

export const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Approve `spender` to pull `amount` of `token`, executed FROM the Safe. */
export async function safeApprove(
  publicClient: EddyPublicClient,
  walletClient: EddyWalletClient,
  params: { safe: Address; owner: Account; token: Address; spender: Address; amount: bigint },
): Promise<void> {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [params.spender, params.amount],
  });
  await execSafe(publicClient, walletClient, {
    safe: params.safe,
    owner: params.owner,
    to: params.token,
    data,
  });
}

export function erc20BalanceOf(publicClient: EddyPublicClient, token: Address, account: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [account] });
}

export function erc20Allowance(
  publicClient: EddyPublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, spender] });
}
