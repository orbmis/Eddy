/**
 * Basket configuration (fixed allocations — no live editing in v1; changing the
 * basket = cancel + re-sign). Each leg buys one token with a fixed weight; the
 * weights MUST sum to 100% (10000 bps). The per-epoch budget is split by weight
 * into legs, and each leg into `parts` equal slices → `partSellAmount`.
 *
 * v1: single leg, 100% WETH. Every leg token must be in `envelope.allowedBuyTokens`.
 */
import "dotenv/config";
import { BASE_ADDRESSES } from "./addresses.js";
import { envelope, toUsdc, USDC_DECIMALS } from "./envelope.js";

const WETH_DECIMALS = 18;

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric env ${key}=${raw}`);
  return n;
}

export interface BasketLeg {
  /** Buy token (must be in the allowlist). */
  token: `0x${string}`;
  /** Allocation weight in basis points (10000 = 100%). */
  weightBps: number;
}

/** Per-epoch USDC budget deployed across the basket (≤ per-epoch cap). */
const epochBudgetUsdc = envNumber("EPOCH_BUDGET_USDC", 40);

export const basket = {
  epochBudgetUsdc,
  epochBudget: toUsdc(epochBudgetUsdc),
  /** Number of equal TWAP parts per leg. */
  parts: BigInt(envNumber("PARTS", 4)),
  /** Seconds between parts. */
  intervalSeconds: BigInt(envNumber("PART_INTERVAL_SECONDS", 3600)),
  /** Tradeable window within each interval (0 = whole interval). */
  span: 0n,
  /** Static reference price (USDC per 1 WETH) for the M2 limit price; M3 uses a live quote. */
  referencePriceUsdcPerWeth: BigInt(envNumber("REFERENCE_PRICE_USDC_PER_WETH", 2500)),
  legs: [{ token: BASE_ADDRESSES.weth, weightBps: 10000 }] as BasketLeg[],
} as const;

/** Sum of leg weights in bps. */
export function weightsSumBps(): number {
  return basket.legs.reduce((acc, l) => acc + l.weightBps, 0);
}

/** Throws unless the leg weights sum to exactly 100% (10000 bps). */
export function assertWeightsSum100(): void {
  const sum = weightsSumBps();
  if (sum !== 10000) throw new Error(`basket weights must sum to 10000 bps, got ${sum}`);
}

/** A leg's share of the epoch budget, in USDC base units. */
export function legBudget(leg: BasketLeg): bigint {
  return (basket.epochBudget * BigInt(leg.weightBps)) / 10000n;
}

/** A leg's per-part sell amount (USDC base units) = legBudget / parts. */
export function partSellAmount(leg: BasketLeg): bigint {
  return legBudget(leg) / basket.parts;
}

/**
 * Minimum acceptable buy amount (WETH wei) for a given USDC sell amount, at the
 * slippage bound: expectedOut · (1 − maxSlippageBps/1e4). A part whose
 * minPartLimit is below this implies worse-than-allowed slippage. M2/M3 use a
 * static reference price; M-future replaces it with a live quote. Assumes an
 * 18-decimal buy token (WETH).
 */
export function minLimitForAmount(sellAmount: bigint): bigint {
  // expected buy = sell / price, rescaled from USDC(6) to WETH(18)
  const expected =
    (sellAmount * 10n ** BigInt(WETH_DECIMALS)) / (basket.referencePriceUsdcPerWeth * 10n ** BigInt(USDC_DECIMALS));
  return (expected * BigInt(10000 - envelope.maxSlippageBps)) / 10000n;
}

/** A leg's per-part minimum buy amount (buy-token base units). */
export function minPartLimit(leg: BasketLeg): bigint {
  return minLimitForAmount(partSellAmount(leg));
}

/** A leg's per-part sell amount for an arbitrary epoch budget (used by the agent loop's compounding tranches). */
export function partSellAmountForBudget(leg: BasketLeg, epochBudget: bigint): bigint {
  return ((epochBudget * BigInt(leg.weightBps)) / 10000n) / basket.parts;
}
