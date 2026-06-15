/**
 * M3 — envelope rejection tests (pure unit; no fork).
 *
 * Each guardrail must FIRE: a non-allowlisted token, an over-cap order, a
 * slippage breach, and bad/missing/expired/too-far expiry are all rejected at
 * construction; a within-bounds order passes. Bounds come from src/config.
 */
import { describe, expect, it } from "vitest";
import { BASE_ADDRESSES } from "../../src/config/addresses.js";
import { envelope } from "../../src/config/envelope.js";
import { minLimitForAmount } from "../../src/config/basket.js";
import { assertValidOrder, EnvelopeError, type OrderEconomics } from "../../src/envelope/validate.js";
import { buildLegOrder } from "../../src/cow/twap.js";

const NOW = 1_781_392_946n;
const PART = 10_000_000n; // 10 USDC

// A within-bounds baseline: 4 parts × 10 USDC = 40 USDC ≤ cap; limit at the
// slippage floor; expiry NOW + 4h, comfortably inside the TTL.
const base: OrderEconomics = {
  sellToken: BASE_ADDRESSES.usdc,
  buyToken: BASE_ADDRESSES.weth,
  partSellAmount: PART,
  minPartLimit: minLimitForAmount(PART),
  t0: NOW,
  n: 4n,
  t: 3600n,
  span: 0n,
};

const NOT_ALLOWLISTED = "0x000000000000000000000000000000000000dEaD" as const;

describe("M3 envelope — assertValidOrder", () => {
  it("accepts a within-bounds order", () => {
    expect(() => assertValidOrder(base, { now: NOW })).not.toThrow();
  });

  it("rejects a buy token not in the allowlist", () => {
    expect(() => assertValidOrder({ ...base, buyToken: NOT_ALLOWLISTED }, { now: NOW })).toThrow(EnvelopeError);
    expect(() => assertValidOrder({ ...base, buyToken: NOT_ALLOWLISTED }, { now: NOW })).toThrow(/allowlist/);
  });

  it("rejects an order exceeding the per-epoch spend cap", () => {
    // 30 USDC × 4 = 120 USDC > 100 USDC cap.
    const over = { ...base, partSellAmount: 30_000_000n };
    expect(() => assertValidOrder(over, { now: NOW })).toThrow(/per-epoch cap/);
  });

  it("rejects slippage worse than the bound (minPartLimit below the floor)", () => {
    expect(() => assertValidOrder({ ...base, minPartLimit: 1n }, { now: NOW })).toThrow(/slippage floor/);
  });

  it("rejects missing expiry (t0 == 0)", () => {
    expect(() => assertValidOrder({ ...base, t0: 0n }, { now: NOW })).toThrow(/t0 missing/);
  });

  it("rejects an already-expired order", () => {
    expect(() => assertValidOrder({ ...base, t0: NOW - 100_000n }, { now: NOW })).toThrow(/already expired/);
  });

  it("rejects an expiry beyond the max TTL", () => {
    // t=200000s × 4 parts ≈ 9.3 days > 7d TTL (t still ≤ 365d handler bound).
    expect(() => assertValidOrder({ ...base, t: 200_000n }, { now: NOW })).toThrow(/max TTL/);
  });

  it("enforces the envelope at construction (buildLegOrder rejects a non-allowlisted leg)", async () => {
    await expect(
      buildLegOrder({
        leg: { token: NOT_ALLOWLISTED, weightBps: 10000 },
        safe: BASE_ADDRESSES.settlement, // any address; rejection happens before use
        module: BASE_ADDRESSES.settlement,
        t0: NOW,
        now: NOW,
        salt: `0x${"00".repeat(32)}`,
      }),
    ).rejects.toThrow(/allowlist/);
  });

  it("reads its bounds from config (sanity: cap and slippage are the .env/config values)", () => {
    expect(envelope.maxSpendPerEpoch).toBeGreaterThan(0n);
    expect(envelope.maxSlippageBps).toBeGreaterThan(0);
    expect(envelope.allowedBuyTokens.map((t) => t.toLowerCase())).toContain(BASE_ADDRESSES.weth.toLowerCase());
  });
});
