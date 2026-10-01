import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbiParameters,
  parseTransaction,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  configSchema,
  deploymentSchema,
  type Deployment,
} from "../src/config.js";
import { projectAdapter, registryAbi } from "../src/discovery.js";
import { Engine } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import { eligibility } from "../src/policy.js";
import { encodeBuy, minimumOut, poolAbi, poolId, routerAbi } from "../src/v4.js";
import type { AdapterContext, Candidate, PoolKey } from "../src/types.js";

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex;
const token = address("1");
const factory = address("4");
const registry = address("5");
const deployer = address("6");
const bytecode: Hex = "0x60006000";
const codeHash = keccak256(bytecode);
const pool: PoolKey = {
  currency0: zeroAddress,
  currency1: token,
  fee: 3000,
  tickSpacing: 60,
  hooks: zeroAddress,
};

function deployment(): Deployment {
  return deploymentSchema.parse({
    chainId: 1,
    verified: true,
    verifiedSource: "https://example.invalid/reviewed-deployment",
    poolManager: { address: address("7"), codeHash },
    router: { address: address("8"), codeHash },
    quoter: { address: address("9"), codeHash },
    stateView: { address: address("a"), codeHash },
    factories: [{ address: factory, codeHash }],
    registries: [{ address: registry, codeHash }],
    deployers: [deployer],
    taxPolicies: [
      {
        tokenCodeHash: codeHash,
        hookCodeHash: null,
        immutable: true,
        buyTaxBps: 0,
        sellTaxBps: 0,
        source: "Reviewed immutable fixture contract",
      },
    ],
  });
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: `1:1:${token}`,
    token,
    pool,
    poolId: poolId(pool),
    launchNumber: 1,
    kind: "evm_project",
    launchTxHash: hash("b"),
    blockNumber: 100n,
    blockHash: hash("c"),
    transactionIndex: 0,
    logIndex: 1,
    ...overrides,
  };
}

function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    config: configSchema.parse({ startBlock: "100" }),
    deployment: deployment(),
    client: { getCode: async () => bytecode } as unknown as PublicClient,
    ...overrides,
  };
}

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "imd-core-test-"));
}

async function isolatedWorkspace(run: () => Promise<void>) {
  const original = process.cwd();
  const directory = temporaryDirectory();
  process.chdir(directory);
  try {
    await run();
  } finally {
    process.chdir(original);
    rmSync(directory, { recursive: true, force: true });
  }
}

function installManifest() {
  mkdirSync("config", { recursive: true });
  writeFileSync("config/mainnet.json", JSON.stringify(deployment()));
}

test("unknown taxes and a mismatched token / hook evidence pair fail closed", async () => {
  const ctx = context();
  ctx.deployment.taxPolicies = [];
  assert.match((await eligibility(candidate(), ctx))!, /税率未知/);
  ctx.deployment = deployment();
  ctx.deployment.taxPolicies[0]!.hookCodeHash = codeHash;
  assert.match((await eligibility(candidate(), ctx))!, /税率未知/);
  ctx.deployment.taxPolicies[0]!.hookCodeHash = null;
  ctx.deployment.taxPolicies[0]!.tokenCodeHash = hash("f");
  assert.match((await eligibility(candidate(), ctx))!, /税率未知/);
});

test("tax evidence must satisfy both buy and sell limits", async () => {
  const ctx = context();
  assert.equal(await eligibility(candidate(), ctx), null);
  ctx.deployment.taxPolicies[0]!.buyTaxBps = 100;
  assert.match((await eligibility(candidate(), ctx))!, /税率超过/);
  ctx.config.maxBuyTaxBps = 100;
  assert.equal(await eligibility(candidate(), ctx), null);
  ctx.deployment.taxPolicies[0]!.sellTaxBps = 101;
  assert.match((await eligibility(candidate(), ctx))!, /税率超过/);
});

test("mutable or unreviewed tax evidence cannot activate a trade", async () => {
  const manifest = deployment();
  assert.equal(
    deploymentSchema.safeParse({
      ...manifest,
      taxPolicies: [{ ...manifest.taxPolicies[0], immutable: false }],
    }).success,
    false,
  );
  assert.equal(
    deploymentSchema.safeParse({
      ...manifest,
      taxPolicies: [{ ...manifest.taxPolicies[0], immutable: undefined }],
    }).success,
    false,
  );
  const ctx = context();
  // A dynamically loaded adapter must not bypass the runtime guard by skipping schema validation.
  Object.assign(ctx.deployment.taxPolicies[0]!, { immutable: false });
  assert.match((await eligibility(candidate(), ctx))!, /不可变税率/);
});

test("unapproved hooks, nonnative pools, absent token code and unverifiable reserves are rejected", async () => {
  const base = candidate();
  assert.match(
    (await eligibility(
      { ...base, pool: { ...pool, hooks: address("d") } },
      context(),
    ))!,
    /白名单/,
  );
  assert.match(
    (await eligibility(
      { ...base, pool: { ...pool, currency0: address("d") } },
      context(),
    ))!,
    /原生 ETH/,
  );
  assert.match(
    (await eligibility(
      base,
      context({
        client: { getCode: async () => "0x" } as unknown as PublicClient,
      }),
    ))!,
    /字节码/,
  );
  assert.match(
    (await eligibility(
      base,
      context({
        config: configSchema.parse({ startBlock: "100", minLiquidityEth: "1" }),
      }),
    ))!,
    /实际池储备/,
  );
});

test("launch number and deployment block filters exclude historical launches", async () => {
  assert.match(
    (await eligibility(
      candidate({ launchNumber: 1 }),
      context({
        config: configSchema.parse({ startBlock: "100", minLaunchNumber: 2 }),
      }),
    ))!,
    /早于起点/,
  );
  assert.match(
    (await eligibility(candidate({ blockNumber: 99n }), context()))!,
    /早于起点/,
  );
});

test("advanced chain policy preserves its historical filters before token code reads", async () => {
  let codeReads = 0;
  const ctx = context({
    config: configSchema.parse({ discoverySource: "chain", startBlock: "100", minLaunchNumber: 2 }),
    client: { getCode: async () => { codeReads++; return bytecode; } } as unknown as PublicClient,
  });
  assert.match((await eligibility(candidate({ launchNumber: 1 }), ctx))!, /早于起点/);
  assert.match((await eligibility(candidate({ blockNumber: 99n, launchNumber: 2 }), ctx))!, /早于起点/);
  assert.equal(codeReads, 0);
  assert.equal(await eligibility(candidate({ launchNumber: 2 }), ctx), null);
  assert.equal(codeReads, 1);
});

test("advanced chain policy rejects conflicting reviews and standardized delegation wrappers", async () => {
  const ctx = context({ config: configSchema.parse({ discoverySource: "chain" }) });
  ctx.deployment.taxPolicies.push({ ...ctx.deployment.taxPolicies[0]!, sellTaxBps: 1 });
  assert.match((await eligibility(candidate(), ctx))!, /审核证据冲突/);

  const wrapper: Hex = `0x363d3d373d3d3d363d73${"77".repeat(20)}5af43d82803e903d91602b57fd5bf3`;
  ctx.deployment.taxPolicies = [{ ...ctx.deployment.taxPolicies[0]!, tokenCodeHash: keccak256(wrapper) }];
  ctx.client = { getCode: async () => wrapper } as unknown as PublicClient;
  assert.match((await eligibility(candidate(), ctx))!, /使用委托代码/);
});

test("configuration prohibits unknown-tax overrides, unsafe slippage and mixed fee caps", () => {
  assert.equal(
    configSchema.safeParse({ unknownTaxPolicy: "allow" }).success,
    false,
  );
  assert.equal(configSchema.safeParse({ slippageBps: 10000 }).success, false);
  assert.equal(
    configSchema.safeParse({ priorityFeeGwei: "31", maxFeeGwei: "30" }).success,
    false,
  );
  assert.equal(configSchema.safeParse({ buyAmountEth: "0" }).success, false);
  assert.equal(
    configSchema.safeParse({ buyAmountEth: "340282366920938463464" }).success,
    false,
  );
  assert.equal(
    deploymentSchema.safeParse({ ...deployment(), chainId: 11155111 }).success,
    false,
  );
  assert.equal(
    deploymentSchema.safeParse({ ...deployment(), verified: false }).success,
    false,
  );
});

test("native v4 calldata settles ETH, takes token output and forbids partial command failure", () => {
  const amount = 10n ** 16n;
  const minOut = 970_000n;
  const deadline = 1_800_000_060n;
  const decoded = decodeFunctionData({
    abi: routerAbi,
    data: encodeBuy(pool, amount, minOut, deadline),
  });
  assert.equal(decoded.functionName, "execute");
  const [commands, inputs, encodedDeadline] = decoded.args;
  // Universal Router V4_SWAP 0x10, with the allow-revert bit unset.
  assert.equal(commands, "0x10");
  assert.equal(encodedDeadline, deadline);
  assert.equal(inputs.length, 1);
  const [actions, parameters] = decodeAbiParameters(
    parseAbiParameters("bytes,bytes[]"),
    inputs[0]!,
  );
  // v4-periphery SWAP_EXACT_IN_SINGLE / SETTLE_ALL / TAKE_ALL.
  assert.equal(actions, "0x060c0f");
  assert.equal(parameters.length, 3);
  const [swap] = decodeAbiParameters(
    parseAbiParameters(
      "((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)",
    ),
    parameters[0]!,
  );
  assert.deepEqual(swap, {
    poolKey: pool,
    zeroForOne: true,
    amountIn: amount,
    amountOutMinimum: minOut,
    hookData: "0x",
  });
  assert.deepEqual(
    decodeAbiParameters(parseAbiParameters("address,uint256"), parameters[1]!),
    [zeroAddress, amount],
  );
  assert.deepEqual(
    decodeAbiParameters(parseAbiParameters("address,uint256"), parameters[2]!),
    [token, minOut],
  );
});

test("slippage output never rounds to zero or accepts invalid uint128 swap inputs", () => {
  assert.equal(minimumOut(1_000_000n, 300), 970_000n);
  assert.throws(() => minimumOut(1n, 300), /Zero minimum/);
  assert.throws(() => minimumOut(0n, 300), /Invalid/);
  assert.throws(() => minimumOut(100n, 10000), /Invalid/);
  assert.throws(() => encodeBuy(pool, 1n, 0n, 1n), /uint128/);
  assert.throws(() => encodeBuy(pool, 2n ** 128n, 1n, 1n), /uint128/);
  assert.throws(
    () => encodeBuy({ ...pool, currency0: address("d") }, 1n, 1n, 1n),
    /native ETH/,
  );
});

test("journal exclusive ownership and durable claimed state prevent a second purchase", () => {
  const directory = temporaryDirectory();
  const first = new Journal(directory);
  const second = new Journal(directory);
  try {
    first.lock();
    assert.throws(() => second.lock());
    assert.equal(first.claim("candidate-a", token), true);
    assert.equal(first.claim("candidate-b", address("2")), false);
    first.update({ phase: "signed", txHash: hash("e"), nonce: 7 });
    const persisted = JSON.parse(
      readFileSync(join(directory, "state.json"), "utf8"),
    );
    assert.equal(persisted.phase, "signed");
    assert.equal(persisted.nonce, 7);
    first.close();
    second.lock();
    assert.equal(second.state.phase, "signed");
    assert.equal(second.state.txHash, hash("e"));
    assert.equal(second.claim("candidate-b", address("2")), false);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a journal constructed before another process finishes rereads state after locking", () => {
  const directory = temporaryDirectory();
  const stale = new Journal(directory);
  const owner = new Journal(directory);
  try {
    owner.lock();
    owner.claim("first", token);
    owner.update({ phase: "confirmed", txHash: hash("e") });
    owner.close();
    assert.equal(stale.state.phase, "idle");
    stale.lock();
    assert.equal(stale.state.phase, "confirmed");
    assert.equal(stale.claim("second", address("2")), false);
  } finally {
    stale.close();
    owner.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("crashed process lock and malformed persisted state fail closed", () => {
  const directory = temporaryDirectory();
  try {
    writeFileSync(join(directory, "process.lock"), "dead-process");
    assert.throws(() => new Journal(directory).lock());
    writeFileSync(join(directory, "state.json"), '{"phase":"unexpected"}');
    assert.throws(() => new Journal(directory), /Invalid journal/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("journal updates require ownership of the process lock", () => {
  const directory = temporaryDirectory();
  try {
    assert.throws(() => new Journal(directory).claim("first", token), /locked/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface DiscoveryFixtureOptions {
  sender?: Address;
  target?: Address;
  eventAddress?: Address;
  artifact?: Address;
  removed?: boolean;
  receiptStatus?: "success" | "reverted";
  receiptBlockHash?: Hex;
  txChainId?: number;
  missingInitialization?: boolean;
  registryBlockHash?: Hex;
}

function discoveryClient(
  candidates: Candidate[],
  options: DiscoveryFixtureOptions = {},
): PublicClient {
  return {
    getLogs: async ({
      fromBlock,
      toBlock,
    }: {
      fromBlock: bigint;
      toBlock: bigint;
    }) =>
      candidates
        .filter((c) => c.blockNumber >= fromBlock && c.blockNumber <= toBlock)
        .map((c) => ({
          address: address("7"),
          args: { ...c.pool, id: c.poolId },
          removed: options.removed ?? false,
          transactionHash: c.launchTxHash,
          blockHash: c.blockHash,
          blockNumber: c.blockNumber,
          transactionIndex: c.transactionIndex,
          logIndex: c.logIndex,
        })),
    getTransaction: async ({ hash: txHash }: { hash: Hex }) => {
      const c = candidates.find((item) => item.launchTxHash === txHash)!;
      return { hash: txHash, from: options.sender ?? deployer, to: options.target ?? factory,
        chainId: options.txChainId ?? 1, blockNumber: c.blockNumber, blockHash: c.blockHash, transactionIndex: c.transactionIndex };
    },
    getTransactionReceipt: async ({ hash: txHash }: { hash: Hex }) => {
      const c = candidates.find((item) => item.launchTxHash === txHash)!;
      return {
        from: options.sender ?? deployer,
        to: options.target ?? factory,
        transactionHash: txHash,
        blockNumber: c.blockNumber,
        transactionIndex: c.transactionIndex,
        status: options.receiptStatus ?? "success",
        blockHash: options.receiptBlockHash ?? c.blockHash,
        logs: [
          ...options.missingInitialization ? [] : [{
            address: address("7"), removed: false, transactionHash: txHash,
            blockNumber: c.blockNumber, blockHash: c.blockHash, transactionIndex: c.transactionIndex, logIndex: c.logIndex,
            topics: encodeEventTopics({ abi: poolAbi, eventName: "Initialize", args: { id: c.poolId, currency0: c.pool.currency0, currency1: c.pool.currency1 } }),
            data: encodeAbiParameters(parseAbiParameters("uint24,int24,address,uint160,int24"), [c.pool.fee, c.pool.tickSpacing, c.pool.hooks, 2n ** 96n, 0]),
          }],
          {
            removed: false, transactionHash: txHash, blockNumber: c.blockNumber,
            blockHash: options.registryBlockHash ?? c.blockHash, transactionIndex: c.transactionIndex, logIndex: c.logIndex + 1,
            address: options.eventAddress ?? registry,
            topics: encodeEventTopics({
              abi: registryAbi,
              eventName: "LaunchRecorded",
              args: {
                launchNumber: BigInt(c.launchNumber),
                kind: stringToHex(c.kind, { size: 32 }),
              },
            }),
            data: encodeAbiParameters(
              parseAbiParameters("bytes32,bytes32,address[],uint256[]"),
              [hash("0"), hash("0"), [options.artifact ?? c.token], []],
            ),
          },
        ],
      };
    },
  } as unknown as PublicClient;
}

test("discovery requires trusted factory, deployer, registry and token artifact in one successful transaction", async () => {
  const c = candidate();
  const result = await projectAdapter.discover(
    100n,
    100n,
    context({ client: discoveryClient([c]) }),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, c.id);
  assert.equal(result[0]!.poolId, c.poolId);
  for (const options of [
    { sender: address("d") },
    { target: address("d") },
    { eventAddress: address("d") },
    { artifact: address("d") },
    { removed: true },
  ]) {
    assert.deepEqual(
      await projectAdapter.discover(
        100n,
        100n,
        context({ client: discoveryClient([c], options) }),
      ),
      [],
    );
  }
});

test("discovery stops inconsistent RPC chunks rather than attesting a spliced pool or advancing past it", async () => {
  const c = candidate();
  for (const options of [
    { receiptStatus: "reverted" as const }, { receiptBlockHash: hash("d") },
    { txChainId: 11155111 }, { missingInitialization: true }, { registryBlockHash: hash("d") },
  ]) {
    await assert.rejects(projectAdapter.discover(100n, 100n, context({ client: discoveryClient([c], options) })), /Inconsistent|missing from/);
  }
});

test("discovery rejects inconsistent pool IDs and orders candidates canonically", async () => {
  const first = candidate();
  const secondPool = { ...pool, currency1: address("2") };
  const second = candidate({
    id: `1:2:${secondPool.currency1}`,
    token: secondPool.currency1,
    pool: secondPool,
    poolId: poolId(secondPool),
    launchNumber: 2,
    launchTxHash: hash("d"),
    transactionIndex: 1,
  });
  const result = await projectAdapter.discover(
    100n,
    100n,
    context({ client: discoveryClient([second, first]) }),
  );
  assert.deepEqual(
    result.map((c) => c.launchNumber),
    [1, 2],
  );
  await assert.rejects(
    projectAdapter.discover(
      100n,
      100n,
      context({ client: discoveryClient([{ ...first, poolId: hash("f") }]) }),
    ),
    /Pool ID mismatch/,
  );
});

test("live readiness rejects any broadcast RPC connected to a different chain", async () => {
  await isolatedWorkspace(async () => {
    installManifest();
    const previousKey = process.env.TRADING_PRIVATE_KEY;
    process.env.TRADING_PRIVATE_KEY = `0x${"11".repeat(32)}`;
    try {
      const engine = new Engine(() => () => {});
      engine.config = configSchema.parse({
        discoverySource: "chain",
        startBlock: "100",
        rpcHttpUrls: [
          "https://mainnet.example.invalid",
          "https://wrong.example.invalid",
        ],
      });
      engine.client = (url = engine.config.rpcHttpUrls[0]) =>
        ({
          getChainId: async () => (url?.includes("wrong") ? 11155111 : 1),
          getCode: async () => bytecode,
          getBlockNumber: async () => 100n,
        }) as unknown as PublicClient;
      const result = await engine.check();
      assert.equal(result.ok, false);
      assert.equal(
        result.checks.find((check) => check.name === "RPC 1")!.ok,
        true,
      );
      assert.equal(
        result.checks.find((check) => check.name === "RPC 2")!.ok,
        false,
      );
    } finally {
      if (previousKey === undefined) delete process.env.TRADING_PRIVATE_KEY;
      else process.env.TRADING_PRIVATE_KEY = previousKey;
    }
  });
});

test(
  "first candidate quote failure stops instead of silently purchasing a later launch",
  { timeout: 5000 },
  async () => {
    await isolatedWorkspace(async () => {
      installManifest();
      const first = candidate({ blockNumber: 101n });
      const secondPool = { ...pool, currency1: address("2") };
      const second = candidate({
        id: `1:2:${secondPool.currency1}`,
        token: secondPool.currency1,
        pool: secondPool,
        poolId: poolId(secondPool),
        launchNumber: 2,
        launchTxHash: hash("d"),
        transactionIndex: 1,
        blockNumber: 101n,
      });
      const quoted: Address[] = [];
      let head = 100n;
      const fake = discoveryClient([first, second]) as unknown as Record<
        string,
        unknown
      >;
      Object.assign(fake, {
        getChainId: async () => 1,
        getBlockNumber: async () => head,
        getCode: async () => bytecode,
        getBlock: async ({
          blockNumber = head,
        }: { blockNumber?: bigint } = {}) => ({
          number: blockNumber,
          hash: first.blockHash,
          timestamp: 1_800_000_000n,
          baseFeePerGas: 1n,
        }),
        readContract: async () => 1n,
        simulateContract: async ({
          args,
        }: {
          args: [{ poolKey: PoolKey }];
        }) => {
          quoted.push(args[0].poolKey.currency1);
          if (quoted.length === 1) throw new Error("temporary RPC failure");
          return { result: [1_000_000n, 50_000n] };
        },
      });
      const engine = new Engine(() => () => {}, {}, { now: () => 1_800_000_000_000 });
      engine.config = configSchema.parse({
        discoverySource: "chain",
        startBlock: "100",
        rpcHttpUrls: ["https://mainnet.example.invalid"],
        rpcWsUrls: [],
      });
      engine.client = () => fake as unknown as PublicClient;
      try {
        await engine.start("dry-run");
        head = 101n;
        const end = Date.now() + 3500;
        while (engine.state.phase !== "failed" && Date.now() < end)
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(engine.state.phase, "failed");
        assert.equal(engine.state.token, first.token);
        assert.deepEqual(quoted, [first.token]);
        assert.equal(engine.running, false);
      } finally {
        engine.stop();
      }
    });
  },
);

test("stop cancels startup while live readiness is still pending", async () => {
  await isolatedWorkspace(async () => {
    const engine = new Engine(() => () => {});
    let finish!: (value: { ok: boolean; checks: [] }) => void;
    const gate = new Promise<{ ok: boolean; checks: [] }>((resolve) => {
      finish = resolve;
    });
    engine.check = () => gate;
    const starting = engine.start("live");
    engine.stop();
    finish({ ok: true, checks: [] });
    await assert.rejects(starting, /启动已取消/);
    assert.equal(engine.running, false);
    assert.equal(engine.starting, false);
  });
});

test("stop cancels startup while the chain ID check is still pending", async () => {
  await isolatedWorkspace(async () => {
    installManifest();
    const engine = new Engine(() => () => {});
    engine.config = configSchema.parse({
      discoverySource: "chain",
      startBlock: "100",
      rpcHttpUrls: ["https://mainnet.example.invalid"],
      rpcWsUrls: [],
    });
    let finish!: (value: number) => void;
    const gate = new Promise<number>((resolve) => {
      finish = resolve;
    });
    engine.client = () =>
      ({ getChainId: () => gate }) as unknown as PublicClient;
    const starting = engine.start("dry-run");
    engine.stop();
    finish(1);
    await assert.rejects(starting, /启动已取消/);
    assert.equal(engine.running, false);
    assert.equal(engine.starting, false);
  });
});

test(
  "multiple mock RPCs receive one identical signed purchase and restart refuses another",
  { timeout: 5000 },
  async () => {
    await isolatedWorkspace(async () => {
      installManifest();
      const previousKey = process.env.TRADING_PRIVATE_KEY;
      process.env.TRADING_PRIVATE_KEY = `0x${"11".repeat(32)}`;
      const first = candidate({ blockNumber: 101n });
      let head = 100n;
      const sent: Hex[] = [];
      const fake = discoveryClient([first]) as unknown as Record<
        string,
        unknown
      >;
      Object.assign(fake, {
        getChainId: async () => 1,
        getBlockNumber: async () => head,
        getCode: async () => bytecode,
        getBlock: async ({
          blockNumber = head,
        }: { blockNumber?: bigint } = {}) => ({
          number: blockNumber,
          hash: first.blockHash,
          timestamp: 1_800_000_000n,
          baseFeePerGas: 1_000_000_000n,
        }),
        readContract: async () => 1n,
        simulateContract: async () => ({ result: [1_000_000n, 50_000n] }),
        getTransactionCount: async () => 0,
        getBalance: async () => 10n ** 18n,
        estimateGas: async () => 100_000n,
        sendRawTransaction: async ({
          serializedTransaction,
        }: {
          serializedTransaction: Hex;
        }) => {
          sent.push(serializedTransaction);
          return keccak256(serializedTransaction);
        },
        waitForTransactionReceipt: async () => ({
          status: "success",
          blockNumber: 101n,
        }),
      });
      const engine = new Engine(() => () => {}, {}, { now: () => 1_800_000_000_000 });
      engine.config = configSchema.parse({
        discoverySource: "chain",
        startBlock: "100",
        rpcHttpUrls: [
          "https://one.example.invalid",
          "https://two.example.invalid",
        ],
        rpcWsUrls: [],
      });
      engine.client = () => fake as unknown as PublicClient;
      try {
        await engine.start("live");
        head = 101n;
        const end = Date.now() + 3500;
        while (engine.state.phase !== "confirmed" && Date.now() < end)
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(engine.state.phase, "confirmed");
        assert.equal(sent.length, 2);
        assert.equal(sent[0], sent[1]);
        const tx = parseTransaction(sent[0]!);
        assert.equal(tx.chainId, 1);
        assert.equal(tx.nonce, 0);
        assert.equal(tx.value, 10n ** 16n);
        const state = JSON.parse(
          readFileSync("runtime/live/state.json", "utf8"),
        );
        assert.equal(state.txHash, keccak256(sent[0]!));
        assert.equal(state.phase, "confirmed");
        await assert.rejects(
          engine.start("live"),
          /已有交易记录|实盘检查未通过/,
        );
        assert.equal(
          engine.readiness.checks.find((check) => check.name === "单次交易状态")
            ?.ok,
          false,
        );
        assert.equal(sent.length, 2);
      } finally {
        engine.stop();
        if (previousKey === undefined) delete process.env.TRADING_PRIVATE_KEY;
        else process.env.TRADING_PRIVATE_KEY = previousKey;
      }
    });
  },
);
