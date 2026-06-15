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

  // --- Safe v1.4.1 canonical contracts (safe-global/safe-deployments) ---
  /** SafeProxyFactory v1.4.1 — createProxyWithNonce deploys the Safe proxy. */
  safeProxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  /** SafeL2 v1.4.1 singleton — the implementation behind the proxy (use the L2 variant on Base). */
  safeL2Singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  /** CompatibilityFallbackHandler v1.4.1 — default handler (not used for TWAP; here for reference). */
  compatibilityFallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",

  // --- Aave v3 on Base (bgd-labs/aave-address-book AaveV3Base) ---
  /** Aave v3 Pool — supply/withdraw the idle USDC. */
  aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  /** aUSDC (aBasUSDC) — the interest-bearing aToken received on supply. */
  aUsdc: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",

  /** Native USDC on Base (sell token for the DCA). FiatTokenV2_2; balances packed at slot 9. */
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  /** WETH on Base (a basket buy token). */
  weth: "0x4200000000000000000000000000000000000006",
} as const satisfies Record<string, `0x${string}`>;

/**
 * Fixed Safe fallback-handler storage slot (keccak256("fallback_manager.handler.address")),
 * stable across Safe versions — read this slot to assert the installed handler.
 */
export const FALLBACK_HANDLER_SLOT =
  "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5" as const;

export type BaseAddresses = typeof BASE_ADDRESSES;
