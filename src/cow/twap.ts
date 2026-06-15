/**
 * CoW TWAP construction + signing (Model B).
 *
 * Per leg: build the per-part Aave-withdraw pre-hook (targeting the
 * AaveWithdrawModule's withdrawPart) into the appData, encode the TWAP `Data`
 * static input, register the conditional order with ComposableCoW (as the Safe),
 * and read back the discrete order + its ERC-1271 signature. The GPv2 order
 * digest + UID are computed with viem (no cow-sdk adapter needed).
 */
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  numberToHex,
  pad,
  stringToHex,
  concat,
  type Address,
  type Hex,
} from "viem";
import { MetadataApi, stringifyDeterministic } from "@cowprotocol/cow-sdk";
import { BASE_ADDRESSES, BASE_CHAIN_ID } from "../config/addresses.js";
import { AAVE_WITHDRAW_MODULE_ABI } from "../safe/module.js";
import type { EddyPublicClient } from "../safe/safe.js";

const HOOK_GAS_LIMIT = "200000";

// --- ABIs -----------------------------------------------------------------
const twapDataTuple = {
  type: "tuple",
  components: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "partSellAmount", type: "uint256" },
    { name: "minPartLimit", type: "uint256" },
    { name: "t0", type: "uint256" },
    { name: "n", type: "uint256" },
    { name: "t", type: "uint256" },
    { name: "span", type: "uint256" },
    { name: "appData", type: "bytes32" },
  ],
} as const;

const gpv2OrderTuple = {
  type: "tuple",
  components: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "bytes32" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "bytes32" },
    { name: "buyTokenBalance", type: "bytes32" },
  ],
} as const;

const conditionalOrderParamsTuple = {
  type: "tuple",
  components: [
    { name: "handler", type: "address" },
    { name: "salt", type: "bytes32" },
    { name: "staticInput", type: "bytes" },
  ],
} as const;

export const COMPOSABLE_COW_ABI = [
  {
    type: "function",
    name: "create",
    stateMutability: "nonpayable",
    inputs: [conditionalOrderParamsTuple, { name: "dispatch", type: "bool" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getTradeableOrderWithSignature",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      conditionalOrderParamsTuple,
      { name: "offchainInput", type: "bytes" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [gpv2OrderTuple, { name: "signature", type: "bytes" }],
  },
] as const;

// --- GPv2 order digest / UID (viem) ---------------------------------------
const KIND_SELL = keccak256(stringToHex("sell"));
const BALANCE_ERC20 = keccak256(stringToHex("erc20"));

const GPV2_ORDER_EIP712_TYPES = {
  Order: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "string" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "string" },
    { name: "buyTokenBalance", type: "string" },
  ],
} as const;

const GPV2_DOMAIN = {
  name: "Gnosis Protocol",
  version: "v2",
  chainId: BASE_CHAIN_ID,
  verifyingContract: BASE_ADDRESSES.settlement,
} as const;

export interface Gpv2Order {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  validTo: number;
  appData: Hex;
  feeAmount: bigint;
  kind: Hex;
  partiallyFillable: boolean;
  sellTokenBalance: Hex;
  buyTokenBalance: Hex;
}

function kindToString(kind: Hex): "sell" | "buy" {
  if (kind.toLowerCase() === KIND_SELL.toLowerCase()) return "sell";
  return "buy";
}
function balanceToString(b: Hex): "erc20" | "external" | "internal" {
  // We only ever use ERC20 balances; default to erc20.
  return b.toLowerCase() === BALANCE_ERC20.toLowerCase() ? "erc20" : "erc20";
}

/** EIP-712 digest of a GPv2 order over the settlement domain. */
export function orderDigest(order: Gpv2Order): Hex {
  return hashTypedData({
    domain: GPV2_DOMAIN,
    types: GPV2_ORDER_EIP712_TYPES,
    primaryType: "Order",
    message: {
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      receiver: order.receiver,
      sellAmount: order.sellAmount,
      buyAmount: order.buyAmount,
      validTo: order.validTo,
      appData: order.appData,
      feeAmount: order.feeAmount,
      kind: kindToString(order.kind),
      partiallyFillable: order.partiallyFillable,
      sellTokenBalance: balanceToString(order.sellTokenBalance),
      buyTokenBalance: balanceToString(order.buyTokenBalance),
    },
  });
}

/** 56-byte order UID = digest(32) ++ owner(20) ++ validTo(4). */
export function orderUid(order: Gpv2Order, owner: Address): Hex {
  return concat([orderDigest(order), owner, numberToHex(order.validTo, { size: 4 })]);
}

// --- appData pre-hook ------------------------------------------------------
export interface PreHook {
  target: Address;
  callData: Hex;
  gasLimit: string;
}

/** Build the per-part pre-hook (module.withdrawPart(amount)) and its appData hash. */
export async function buildPreHookAppData(params: {
  module: Address;
  partSellAmount: bigint;
  appCode?: string;
}): Promise<{ appData: Hex; appDataContent: string; preHook: PreHook }> {
  const callData = encodeFunctionData({
    abi: AAVE_WITHDRAW_MODULE_ABI,
    functionName: "withdrawPart",
    args: [params.partSellAmount],
  });
  const preHook: PreHook = { target: params.module, callData, gasLimit: HOOK_GAS_LIMIT };
  const metadataApi = new MetadataApi();
  const doc = await metadataApi.generateAppDataDoc({
    appCode: params.appCode ?? "EddyDCA",
    metadata: { hooks: { pre: [preHook] } },
  });
  const appDataContent = await stringifyDeterministic(doc);
  const appData = keccak256(stringToHex(appDataContent)).toLowerCase() as Hex;
  return { appData, appDataContent, preHook };
}

/** Decode the withdraw amount back out of a module.withdrawPart pre-hook callData. */
export function decodeWithdrawPartAmount(callData: Hex): bigint {
  const { functionName, args } = decodeFunctionData({ abi: AAVE_WITHDRAW_MODULE_ABI, data: callData });
  if (functionName !== "withdrawPart") throw new Error(`expected withdrawPart, got ${functionName}`);
  return args[0] as bigint;
}

// --- TWAP static input + conditional order --------------------------------
export interface TwapParams {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
  partSellAmount: bigint;
  minPartLimit: bigint;
  t0: bigint;
  n: bigint;
  t: bigint;
  span: bigint;
  appData: Hex;
}

export function encodeTwapStaticInput(p: TwapParams): Hex {
  return encodeAbiParameters([twapDataTuple], [p]);
}

export interface ConditionalOrderParams {
  handler: Address;
  salt: Hex;
  staticInput: Hex;
}

export function conditionalOrderParams(staticInput: Hex, salt: Hex): ConditionalOrderParams {
  return { handler: BASE_ADDRESSES.twapHandler, salt, staticInput };
}

/** Calldata for ComposableCoW.create(params, dispatch) — execute as the Safe. */
export function createOrderCalldata(params: ConditionalOrderParams, dispatch = true): Hex {
  return encodeFunctionData({
    abi: COMPOSABLE_COW_ABI,
    functionName: "create",
    args: [params, dispatch],
  });
}

/** Read the current discrete part order + its ERC-1271 signature from ComposableCoW. */
export async function getTradeableOrderWithSignature(
  publicClient: EddyPublicClient,
  args: { owner: Address; params: ConditionalOrderParams },
): Promise<{ order: Gpv2Order; signature: Hex }> {
  const [order, signature] = (await publicClient.readContract({
    address: BASE_ADDRESSES.composableCow,
    abi: COMPOSABLE_COW_ABI,
    functionName: "getTradeableOrderWithSignature",
    args: [args.owner, args.params, "0x", []],
  })) as unknown as [Gpv2Order, Hex];
  return { order, signature };
}
