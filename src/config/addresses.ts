/**
 * On-chain contract addresses, by network.
 *
 * Base (chainId 8453). CoW's core/periphery contracts are CREATE2-deployed at
 * the same address on every chain. The values below were verified against live
 * Base bytecode during the M0 spike (all six addresses returned non-zero code
 * on a Base mainnet fork) and cross-checked against the cow-sdk `sdk-config`
 * constants and the CoW docs (https://docs.cow.fi/.../reference/contracts).
 *
 * NOTE: cow-sdk v9 exports COMPOSABLE_COW / settlement / vault-relayer / the
 * extensible fallback handler, but NOT the TWAP handler or HooksTrampoline —
 * those two are hardcoded here from the CoW periphery docs.
 */

export const BASE_CHAIN_ID = 8453 as const;

export const BASE_ADDRESSES = {
  /** GPv2Settlement — the settlement contract; the only caller HooksTrampoline trusts. */
  settlement: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
  /** GPv2VaultRelayer — sell tokens are approved to this address. */
  vaultRelayer: "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110",
  /** ComposableCoW — registry/verifier for conditional (programmatic) orders. */
  composableCow: "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74",
  /** TWAP conditional-order handler — derives each discrete part via getTradeableOrder. */
  twapHandler: "0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5",
  /** HooksTrampoline — executes appData pre/post hooks; onlySettlement-gated. */
  hooksTrampoline: "0x60Bf78233f48eC42eE3F101b9a05eC7878728006",
  /** Safe ExtensibleFallbackHandler — required on the Safe for ComposableCoW/TWAP (M1). */
  extensibleFallbackHandler: "0x2f55e8b20D0B9FEFA187AA7d00B6Cbe563605bF5",
  /** Native USDC on Base (sell token for the DCA). */
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  /** WETH on Base (a basket buy token). */
  weth: "0x4200000000000000000000000000000000000006",
} as const satisfies Record<string, `0x${string}`>;

export type BaseAddresses = typeof BASE_ADDRESSES;
