/**
 * Net-vs-baseline accounting — the dashboard's "honest accounting" centrepiece
 * and M5's numeric gate. Compares three ways to deploy the SAME budget into the
 * basket asset (WETH), all valued at the final price:
 *
 *   - plainHold : lump-sum the whole budget into WETH at the FIRST price, hold.
 *   - plainDca  : split the budget into equal per-cycle parts, buy at each price.
 *   - dcaYield  : like plainDca, but each tranche also folds in the Aave yield
 *                 the idle pool earned (our strategy).
 *
 * Pure + deterministic (bigint). No DOM/React — stays node-typecheckable.
 */

const USDC_DECIMALS = 6n;
const WETH_DECIMALS = 18n;
const ONE_USDC = 10n ** USDC_DECIMALS;
const ONE_WETH = 10n ** WETH_DECIMALS;

export interface BaselineInput {
  /** Total budget to deploy, USDC base units (6 decimals). */
  budgetUsdc: bigint;
  /** Number of DCA cycles. */
  cycles: number;
  /** Price per cycle, USDC per 1 WETH (whole units, e.g. 2500n). length === cycles. */
  pricesUsdcPerWeth: bigint[];
  /** Idle yield folded into each cycle's tranche, USDC base units. length === cycles. */
  accruedYieldUsdc: bigint[];
}

export interface BaselineResult {
  plainHoldWeth: bigint;
  plainDcaWeth: bigint;
  dcaYieldWeth: bigint;
  finalPriceUsdcPerWeth: bigint;
  valueUsdc: { plainHold: bigint; plainDca: bigint; dcaYield: bigint };
  /** dcaYield value − plainDca value (USDC) — the yield edge. */
  netVsPlainDcaUsdc: bigint;
  /** dcaYield value − plainHold value (USDC) — the averaging + yield edge. */
  netVsPlainHoldUsdc: bigint;
  /** Our strategy's average fill price, USDC per WETH (whole units, floored). */
  avgFillPriceUsdcPerWeth: bigint;
  /** Total USDC actually deployed (budget + total accrued yield). */
  totalSpentUsdc: bigint;
}

/** WETH (wei) bought by `usdc` (6-dec base units) at `price` USDC per WETH. */
export function wethForUsdc(usdc: bigint, priceUsdcPerWeth: bigint): bigint {
  return (usdc * ONE_WETH) / (priceUsdcPerWeth * ONE_USDC);
}

/** USDC (6-dec base units) value of `weth` (wei) at `price` USDC per WETH. */
export function usdcValueOfWeth(weth: bigint, priceUsdcPerWeth: bigint): bigint {
  return (weth * priceUsdcPerWeth * ONE_USDC) / ONE_WETH;
}

export function computeBaselines(input: BaselineInput): BaselineResult {
  const { budgetUsdc, cycles, pricesUsdcPerWeth: prices, accruedYieldUsdc: accrued } = input;
  if (cycles <= 0) throw new Error("cycles must be > 0");
  if (prices.length !== cycles || accrued.length !== cycles) {
    throw new Error("pricesUsdcPerWeth and accruedYieldUsdc must each have length === cycles");
  }
  if (prices.some((p) => p <= 0n)) throw new Error("prices must be > 0");

  const n = BigInt(cycles);
  const basePerCycle = budgetUsdc / n;

  const plainHoldWeth = wethForUsdc(budgetUsdc, prices[0]!);

  let plainDcaWeth = 0n;
  let dcaYieldWeth = 0n;
  let totalSpentUsdc = 0n;
  for (let i = 0; i < cycles; i++) {
    plainDcaWeth += wethForUsdc(basePerCycle, prices[i]!);
    const tranche = basePerCycle + accrued[i]!;
    dcaYieldWeth += wethForUsdc(tranche, prices[i]!);
    totalSpentUsdc += tranche;
  }

  const finalPrice = prices[cycles - 1]!;
  const valueUsdc = {
    plainHold: usdcValueOfWeth(plainHoldWeth, finalPrice),
    plainDca: usdcValueOfWeth(plainDcaWeth, finalPrice),
    dcaYield: usdcValueOfWeth(dcaYieldWeth, finalPrice),
  };

  const avgFillPriceUsdcPerWeth = dcaYieldWeth > 0n ? (totalSpentUsdc * ONE_WETH) / (dcaYieldWeth * ONE_USDC) : 0n;

  return {
    plainHoldWeth,
    plainDcaWeth,
    dcaYieldWeth,
    finalPriceUsdcPerWeth: finalPrice,
    valueUsdc,
    netVsPlainDcaUsdc: valueUsdc.dcaYield - valueUsdc.plainDca,
    netVsPlainHoldUsdc: valueUsdc.dcaYield - valueUsdc.plainHold,
    avgFillPriceUsdcPerWeth,
    totalSpentUsdc,
  };
}
