/**
 * Envelope enforcement — the caveat bounds that keep the agent inside its
 * mandate. `assertValidOrder` is the construction guard: it throws EnvelopeError
 * for any swap-leg order that breaches the allowlist, per-epoch spend cap,
 * slippage bound, or expiry rules (and mirrors the TWAP handler's own validity
 * rules so construction fails fast rather than at solve time). Bounds come from
 * src/config — never widened here.
 */
import { zeroAddress, type Address } from "viem";
import { envelope } from "../config/envelope.js";
import { minLimitForAmount } from "../config/basket.js";

export class EnvelopeError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "EnvelopeError";
  }
}

const MAX_UINT32 = 2n ** 32n - 1n;
const MAX_FREQUENCY_SECONDS = 365n * 24n * 60n * 60n; // TWAP handler bound on `t`

export interface OrderEconomics {
  sellToken: Address;
  buyToken: Address;
  partSellAmount: bigint;
  minPartLimit: bigint;
  /** TWAP start time. */
  t0: bigint;
  /** number of parts. */
  n: bigint;
  /** interval between parts (seconds). */
  t: bigint;
  /** tradeable window within each interval (0 = whole interval). */
  span: bigint;
}

const isAllowlisted = (token: Address): boolean =>
  envelope.allowedBuyTokens.some((a) => a.toLowerCase() === token.toLowerCase());

/** Throws EnvelopeError unless the order is within every caveat bound. */
export function assertValidOrder(o: OrderEconomics, ctx: { now: bigint }): void {
  // --- allowlist (swap leg: basket only) ---
  if (!isAllowlisted(o.buyToken)) throw new EnvelopeError(`buy token ${o.buyToken} not in allowlist`);

  // --- TWAP handler validity (mirror TWAPOrder.validate so construction fails fast) ---
  if (o.sellToken.toLowerCase() === o.buyToken.toLowerCase()) throw new EnvelopeError("sellToken == buyToken");
  if (o.sellToken === zeroAddress || o.buyToken === zeroAddress) throw new EnvelopeError("zero token address");
  if (o.partSellAmount <= 0n) throw new EnvelopeError("partSellAmount must be > 0");
  if (o.minPartLimit <= 0n) throw new EnvelopeError("minPartLimit must be > 0");
  if (!(o.n > 1n && o.n <= MAX_UINT32)) throw new EnvelopeError("n must be in (1, 2^32)");
  if (!(o.t > 0n && o.t <= MAX_FREQUENCY_SECONDS)) throw new EnvelopeError("t must be in (0, 365d]");
  if (o.span > o.t) throw new EnvelopeError("span must be <= t");

  // --- per-epoch spend cap ---
  const spend = o.partSellAmount * o.n;
  if (spend > envelope.maxSpendPerEpoch)
    throw new EnvelopeError(`epoch spend ${spend} exceeds per-epoch cap ${envelope.maxSpendPerEpoch}`);

  // --- slippage (enforced via the per-part limit price) ---
  const floor = minLimitForAmount(o.partSellAmount);
  if (o.minPartLimit < floor)
    throw new EnvelopeError(`minPartLimit ${o.minPartLimit} below slippage floor ${floor} (max ${envelope.maxSlippageBps} bps)`);

  // --- expiry: t0 + n*t must be set, in the future, and not beyond the TTL ---
  if (o.t0 === 0n) throw new EnvelopeError("t0 missing (0)");
  if (o.t0 >= MAX_UINT32) throw new EnvelopeError("t0 too large");
  const expiry = o.t0 + o.n * o.t;
  if (expiry <= ctx.now) throw new EnvelopeError(`order already expired (expiry ${expiry} <= now ${ctx.now})`);
  if (expiry > ctx.now + envelope.maxOrderTtlSeconds)
    throw new EnvelopeError(`expiry ${expiry} beyond max TTL (now ${ctx.now} + ${envelope.maxOrderTtlSeconds})`);
}
