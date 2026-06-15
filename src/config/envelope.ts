/**
 * Envelope bounds — the caveat limits that constrain the agent's authority.
 *
 * M1 only READS these (to keep deposit/approval amounts below the per-epoch
 * cap and to assert the bounds aren't widened). Full enforcement + negative
 * tests land in M3. Values come from `.env`; the defaults below are the
 * testnet defaults locked for v1 (cap 100 / deposit 50 / buffer 10 / 2% slip).
 */
import "dotenv/config";
import { BASE_ADDRESSES } from "./addresses.js";

export const USDC_DECIMALS = 6;

/** Convert a human USDC amount (e.g. 50) to base units (50_000_000n). */
export function toUsdc(human: number): bigint {
  return BigInt(Math.round(human * 10 ** USDC_DECIMALS));
}

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric env ${key}=${raw}`);
  return n;
}

function envList(key: string, fallback: readonly `0x${string}`[]): `0x${string}`[] {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return [...fallback];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as `0x${string}`[];
}

/** Per-epoch spend cap (human USDC). The hard ceiling on USDC spent per epoch. */
const maxSpendPerEpochUsdc = envNumber("MAX_SPEND_PER_EPOCH_USDC", 100);
/** Idle USDC to supply to Aave in M1 (human USDC). Kept below the cap. */
const depositUsdc = envNumber("DEPOSIT_USDC", 50);
/** Shock-absorber USDC kept liquid in the Safe (human USDC). */
const usdcBuffer = envNumber("USDC_BUFFER", 10);

export const envelope = {
  /** Per-epoch spend cap. */
  maxSpendPerEpochUsdc,
  maxSpendPerEpoch: toUsdc(maxSpendPerEpochUsdc),
  /** M1 deposit amount. */
  depositUsdc,
  deposit: toUsdc(depositUsdc),
  /** Liquidity buffer. */
  usdcBuffer,
  buffer: toUsdc(usdcBuffer),
  /** Max slippage in basis points → per-part TWAP limit price (M2/M3). */
  maxSlippageBps: envNumber("MAX_SLIPPAGE_BPS", 200),
  /** Allowlisted buy tokens (basket only). Defaults to WETH. */
  allowedBuyTokens: envList("ALLOWED_BUY_TOKENS", [BASE_ADDRESSES.weth]),
  /** DRY_RUN: true = simulate/sign only, never broadcast real value. Defaults true. */
  dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
} as const;

export type Envelope = typeof envelope;
