/**
 * M0 — Hook-propagation spike.
 *
 * Open question: does a parent CoW TWAP's appData pre-hook propagate to EACH
 * derived child part? CoW hooks are an off-chain solver convention (not enforced
 * on-chain), so a local fork CANNOT prove a live solver fires them. What it CAN
 * prove, against real Base bytecode, is the mechanical half:
 *
 *   1. PROPAGATION (definitive): the discrete GPv2Order the TWAP handler derives
 *      for part 0 and part 1 carries the SAME appData hash we committed to —
 *      the hash that commits to our pre-hook. Asserted via eth_call against the
 *      deployed TWAP handler (the exact code path ComposableCoW.getTradeableOrder-
 *      WithSignature delegates to for appData).
 *   2. EXECUTION (demonstration): impersonating GPv2Settlement and calling
 *      HooksTrampoline.execute([preHook]) once per propagated part runs the hook
 *      against real Base bytecode — the precise interaction a solver inserts.
 *
 * Verdict mapping: a part "fires" iff its derived order carries our appData AND
 * the trampoline hook then executes for it. Both parts fire -> SPIKE_RESULT=B
 * (per-part pre-hook withdrawal). Fewer than both -> SPIKE_RESULT=A (withdraw
 * per re-up). Both outcomes are valid; the test records the answer, it does not
 * force B. The behavioral "will solvers honor it" half is confirmed at M6.
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseEther,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { MetadataApi, stringifyDeterministic } from "@cowprotocol/cow-sdk";
import { BASE_ADDRESSES } from "../../src/config/addresses.js";

// --- fork config ----------------------------------------------------------
// Process-unique port so back-to-back / overlapping fork runs never collide on
// a stale anvil.
const PORT = Number(process.env.ANVIL_PORT ?? 8645 + (process.pid % 2000));
const RPC = `http://127.0.0.1:${PORT}`;
const BASE_RPC_URL = process.env.BASE_RPC_URL;
// Pin a fixed Base block so the spike is fully reproducible: the fork
// timestamp, the deployer nonce (hence the Counter address and thus the
// appData hash), and validTo all become deterministic run-to-run. Requires an
// archive-capable RPC (Base RPC verified to serve >2M blocks of history).
const FORK_BLOCK = Number(process.env.FORK_BLOCK ?? 47_300_000);
// anvil's first default dev account — local fork only, never a real key.
const DEPLOYER_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const ARTIFACT = "artifacts/spike-result.json";

// TWAP params: 2 parts, 1h apart, whole-interval tradeable (span = 0).
const N_PARTS = 2n;
const INTERVAL_SECONDS = 3600n;
const PART_SELL_AMOUNT = 1_000_000n; // 1 USDC (6 decimals)
const MIN_PART_LIMIT = 1n;

// --- minimal ABIs (local to the spike; no funding/cow code yet) -----------
const counterAbi = [
  { type: "function", name: "increment", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "number", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

// Verified-by-deploy minimal Counter: storage slot 0; increment()/number().
const COUNTER_BYTECODE =
  "0x603680600b6000396000f360003560e01c8063d09de08a14601f5780638381f58a14602a5760006000fd5b600054600101600055005b60005460005260206000f3" as Hex;

// GPv2Order.Data tuple, exactly as the TWAP handler returns it.
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

const twapHandlerAbi = [
  {
    type: "function",
    name: "getTradeableOrder",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "sender", type: "address" },
      { name: "ctx", type: "bytes32" },
      { name: "staticInput", type: "bytes" },
      { name: "offchainInput", type: "bytes" },
    ],
    outputs: [gpv2OrderTuple],
  },
] as const;

// TWAP handler static input = abi.encode(Data).
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

const trampolineAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "hooks",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
          { name: "gasLimit", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

// --- anvil lifecycle ------------------------------------------------------
let anvil: ChildProcess;

async function waitForRpc(timeoutMs = 30_000): Promise<void> {
  const probe = createPublicClient({ transport: http(RPC) });
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await probe.getBlockNumber();
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("anvil did not become ready in time");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

beforeAll(async () => {
  if (!BASE_RPC_URL) {
    throw new Error("BASE_RPC_URL is not set in .env — the spike needs a Base RPC to fork. Aborting.");
  }
  anvil = spawn(
    "anvil",
    [
      "--fork-url", BASE_RPC_URL,
      "--fork-block-number", String(FORK_BLOCK),
      "--port", String(PORT),
      // Resilience to transient RPC throttling when forks spin up back-to-back.
      "--retries", "10",
      "--timeout", "60000",
      "--no-rate-limit",
      "--silent",
    ],
    { stdio: "ignore" },
  );
  anvil.on("error", (e) => {
    throw new Error(`failed to start anvil (is Foundry installed?): ${e.message}`);
  });
  await waitForRpc();
}, 60_000);

afterAll(() => {
  anvil?.kill("SIGKILL");
});

describe("M0 hook-propagation spike", () => {
  it("derives both TWAP parts carrying the same pre-hook appData, and fires the hook per part", async () => {
    const account = privateKeyToAccount(DEPLOYER_PK);
    const publicClient = createPublicClient({ chain: base, transport: http(RPC) });
    const walletClient = createWalletClient({ chain: base, transport: http(RPC) });
    const testClient = createTestClient({ chain: base, mode: "anvil", transport: http(RPC) });

    const forkBlockNumber = await publicClient.getBlockNumber();

    // 1. Deploy the observable Counter.
    const deployHash = await walletClient.sendTransaction({ account, data: COUNTER_BYTECODE, chain: base });
    const deployRcpt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    const counter = deployRcpt.contractAddress as Address;
    expect(counter, "Counter must deploy").toBeTruthy();

    // 2. Build the pre-hook (increment the counter) and the appData hash committing to it.
    const incrementCallData = encodeFunctionData({ abi: counterAbi, functionName: "increment" });
    const preHook = { target: counter, callData: incrementCallData, gasLimit: "100000" };
    const metadataApi = new MetadataApi();
    const doc = await metadataApi.generateAppDataDoc({
      appCode: "EddyM0Spike",
      metadata: { hooks: { pre: [preHook] } },
    });
    // The on-chain appData field is keccak256 of the deterministic appData JSON
    // (its pre-image). We compute it directly to avoid the SDK's IPFS-CID path,
    // which requires a provider adapter we don't need here.
    const appDataContent = await stringifyDeterministic(doc);
    const appData = keccak256(stringToHex(appDataContent)).toLowerCase() as Hex;

    // 3. Encode the TWAP static input with that appData. Anchor t0 to the
    //    pinned fork block's timestamp (a constant) so the derived validTo is
    //    deterministic; part selection only needs the current time within the
    //    window, which is robust to anvil's ~1s mining jitter.
    const t0 = (await publicClient.getBlock({ blockNumber: BigInt(FORK_BLOCK) })).timestamp;
    const staticInput = encodeAbiParameters(
      [twapDataTuple],
      [
        {
          sellToken: BASE_ADDRESSES.usdc,
          buyToken: BASE_ADDRESSES.weth,
          receiver: account.address,
          partSellAmount: PART_SELL_AMOUNT,
          minPartLimit: MIN_PART_LIMIT,
          t0,
          n: N_PARTS,
          t: INTERVAL_SECONDS,
          span: 0n,
          appData,
        },
      ],
    );

    const deriveCurrentPart = async () =>
      publicClient.readContract({
        address: BASE_ADDRESSES.twapHandler,
        abi: twapHandlerAbi,
        functionName: "getTradeableOrder",
        args: [account.address, zeroAddress, ZERO32, staticInput, "0x"],
      });

    // Prepare the settlement to act as the (only authorised) trampoline caller.
    const settlement = BASE_ADDRESSES.settlement;
    await testClient.setBalance({ address: settlement, value: parseEther("1") });
    await testClient.impersonateAccount({ address: settlement });
    const fireHook = async () => {
      const hash = await walletClient.sendTransaction({
        account: settlement,
        to: BASE_ADDRESSES.hooksTrampoline,
        data: encodeFunctionData({
          abi: trampolineAbi,
          functionName: "execute",
          args: [[{ target: counter, callData: incrementCallData, gasLimit: 100_000n }]],
        }),
        gas: 1_000_000n,
        chain: base,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    };
    const readCounter = () =>
      publicClient.readContract({ address: counter, abi: counterAbi, functionName: "number" });

    // 4. Part 0: derive, assert appData carries our hook, fire the hook.
    const order0 = await deriveCurrentPart();
    const p0Match = order0.appData.toLowerCase() === appData;
    // Sanity: if our appData isn't even on the first part, the harness is broken
    // (surface it — do NOT silently record "A").
    expect(p0Match, "part 0 must carry the committed appData (spike harness sanity)").toBe(true);
    if (p0Match) await fireHook();
    expect(await readCounter(), "hook must execute for part 0 (trampoline sanity)").toBe(1n);

    // 5. Advance one interval -> the handler now derives part 1.
    await testClient.increaseTime({ seconds: Number(INTERVAL_SECONDS) });
    await testClient.mine({ blocks: 1 });

    // 6. Part 1: derive, check propagation, fire the hook iff it propagated.
    const order1 = await deriveCurrentPart();
    const p1Match = order1.appData.toLowerCase() === appData;
    expect(order1.validTo, "part 1 must be a distinct window from part 0").not.toBe(order0.validTo);
    if (p1Match) await fireHook();

    const firedCount = Number(await readCounter());
    const equalAcrossParts = p0Match && p1Match;
    const result: "A" | "B" = equalAcrossParts && firedCount === 2 ? "B" : "A";

    // 7. Record the verdict + evidence for the verify script (no fabrication:
    //    these are the actual on-chain reads).
    mkdirSync("artifacts", { recursive: true });
    writeFileSync(
      ARTIFACT,
      JSON.stringify(
        {
          result,
          firedCount,
          equalAcrossParts,
          appDataHex: appData,
          order0AppData: order0.appData.toLowerCase(),
          order1AppData: order1.appData.toLowerCase(),
          order0ValidTo: order0.validTo,
          order1ValidTo: order1.validTo,
          forkBlockNumber: forkBlockNumber.toString(),
          note: "Local Base-fork spike: proves mechanical appData propagation + simulated trampoline execution. Live-solver behavior is confirmed at M6, not here.",
        },
        null,
        2,
      ),
    );

    // Both B and A are valid passes — assert only that a definitive count was produced.
    expect([0, 1, 2]).toContain(firedCount);
  });
});
