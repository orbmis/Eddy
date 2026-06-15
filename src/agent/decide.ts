/**
 * Agent — DECIDE. Sizes the next tranche, folding in accrued yield so the DCA
 * budget compounds with what the idle capital earned. Enforces the CUMULATIVE
 * per-epoch spend cap across cycles (the cross-cycle bound that has no on-chain
 * enforcer) — throws EnvelopeError rather than widen it.
 */
import { EnvelopeError } from "../envelope/validate.js";

export function sizeNextTranche(params: {
  /** Base allocation for this cycle (e.g. epochBudget / cycles). */
  basePerCycle: bigint;
  /** Yield accrued to date by the idle pool. */
  accruedYield: bigint;
  /** Total spend committed in prior cycles. */
  cumulativeSpent: bigint;
  /** Per-epoch spend cap. */
  cap: bigint;
}): bigint {
  const tranche = params.basePerCycle + params.accruedYield;
  if (params.cumulativeSpent + tranche > params.cap) {
    throw new EnvelopeError(
      `cumulative spend ${params.cumulativeSpent + tranche} would exceed per-epoch cap ${params.cap}`,
    );
  }
  return tranche;
}
