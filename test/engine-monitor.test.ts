import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbiParameters,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  configSchema,
  deploymentSchema,
  type Config,
  type Deployment,
} from "../src/config.js";
import { registryAbi } from "../src/discovery.js";
import { Engine } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import type { Candidate, PoolKey } from "../src/types.js";
import { poolAbi, poolId } from "../src/v4.js";

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const blockHash = (block: bigint, fork = 0) =>
  `0x${(block * 100n + BigInt(fork)).toString(16).padStart(64, "0")}` as Hex;
const factory = address("4");
const registry = address("5");
const deployer = address("6");
const bytecode: Hex = "0x60006000";
const codeHash = keccak256(bytecode);

function manifest(): Deployment {
  return deploymentSchema.parse({
    chainId: 1,
    verified: true,
    verifiedSource: "https://example.invalid/monitor-fixture",
    poolManager: { address: address("7"), codeHash },
    router: { address: address("8"), codeHash },
    quoter: { address: address("9"), codeHash },
    stateView: { address: address("a"), codeHash },
    factories: [
      {
        address: factory,
        codeHash,
        autoStartSafe: true,
        deploymentBlock: "100",
      },
    ],
    registries: [{ address: registry, codeHash }],
    deployers: [deployer],
    taxPolicies: [
      {
        tokenCodeHash: codeHash,
        hookCodeHash: null,
        immutable: true,
        buyTaxBps: 0,
        sellTaxBps: 0,
        source: "Reviewed immutable test contract",
      },
    ],
  });
}

function launch(block: bigint, launchNumber = 1): Candidate {
  const token = address(String(launchNumber));
  const pool: PoolKey = {
    currency0: zeroAddress,
    currency1: token,
    fee: 3000,
    tickSpacing: 60,
    hooks: zeroAddress,
  };
  return {
    id: `1:${launchNumber}:${token}`,
    token,
    pool,
    poolId: poolId(pool),
    launchNumber,
    kind: "evm_project",
    launchTxHash: blockHash(block, launchNumber),
    blockNumber: block,
    blockHash: blockHash(block),
    transactionIndex: 0,
    logIndex: 1,
  };
}

class FakeChain {
  head = 100n;
  launches: Candidate[] = [];
  ranges: { from: bigint; to: bigint }[] = [];
  codeReads: { address: Address; blockNumber: bigint | undefined }[] = [];
  quotes: Address[] = [];
  broadcasts: Hex[] = [];
  failLogsFrom?: bigint;
  onLogs?: (from: bigint, to: bigint) => void;
  onCode?: (address: Address, blockNumber?: bigint) => void;
  forks = new Map<bigint, number>();
  client = {
    getChainId: async () => 1,
    getBlockNumber: async () => this.head,
    getCode: async ({
      address: target,
      blockNumber,
    }: {
      address: Address;
      blockNumber?: bigint;
    }) => {
      this.codeReads.push({ address: target, blockNumber });
      this.onCode?.(target, blockNumber);
      return target.toLowerCase() === factory.toLowerCase() &&
        (blockNumber ?? this.head) < 100n
        ? "0x"
        : bytecode;
    },
    getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => {
      const number = blockNumber ?? this.head;
      return {
        number,
        hash: blockHash(number, this.forks.get(number) ?? 0),
        timestamp: 1_800_000_000n + number * 12n,
        baseFeePerGas: 1_000_000_000n,
      };
    },
    getLogs: async ({
      fromBlock,
      toBlock,
    }: {
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      this.ranges.push({ from: fromBlock, to: toBlock });
      if (this.failLogsFrom !== undefined && fromBlock >= this.failLogsFrom)
        throw Error("Historical logs unavailable");
      // Return only logs in the requested interval; a broad stub hides cursor skips.
      const result = this.launches
        .filter(
          (candidate) =>
            candidate.blockNumber >= fromBlock &&
            candidate.blockNumber <= toBlock,
        )
        .map((candidate) => ({
          address: address("7"),
          args: { ...candidate.pool, id: candidate.poolId },
          removed: false,
          transactionHash: candidate.launchTxHash,
          blockHash: candidate.blockHash,
          blockNumber: candidate.blockNumber,
          transactionIndex: candidate.transactionIndex,
          logIndex: candidate.logIndex,
        }));
      this.onLogs?.(fromBlock, toBlock);
      return result;
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      const candidate = this.launches.find((item) => item.launchTxHash === hash)!;
      return { hash, from: deployer, to: factory, chainId: 1,
        blockNumber: candidate.blockNumber, blockHash: candidate.blockHash, transactionIndex: candidate.transactionIndex };
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const candidate = this.launches.find(
        (item) => item.launchTxHash === hash,
      )!;
      return {
        transactionHash: hash, from: deployer, to: factory,
        blockNumber: candidate.blockNumber, transactionIndex: candidate.transactionIndex,
        status: "success",
        blockHash: candidate.blockHash,
        logs: [
          {
            address: address("7"), removed: false, transactionHash: hash,
            blockNumber: candidate.blockNumber, blockHash: candidate.blockHash, transactionIndex: candidate.transactionIndex, logIndex: candidate.logIndex,
            topics: encodeEventTopics({ abi: poolAbi, eventName: "Initialize", args: { id: candidate.poolId, currency0: candidate.pool.currency0, currency1: candidate.pool.currency1 } }),
            data: encodeAbiParameters(parseAbiParameters("uint24,int24,address,uint160,int24"), [candidate.pool.fee, candidate.pool.tickSpacing, candidate.pool.hooks, 2n ** 96n, 0]),
          },
          {
            removed: false, transactionHash: hash, blockNumber: candidate.blockNumber,
            blockHash: candidate.blockHash, transactionIndex: candidate.transactionIndex, logIndex: candidate.logIndex + 1,
            address: registry,
            topics: encodeEventTopics({
              abi: registryAbi,
              eventName: "LaunchRecorded",
              args: {
                launchNumber: BigInt(candidate.launchNumber),
                kind: stringToHex(candidate.kind, { size: 32 }),
              },
            }),
            data: encodeAbiParameters(
              parseAbiParameters("bytes32,bytes32,address[],uint256[]"),
              [blockHash(0n), blockHash(0n), [candidate.token], []],
            ),
          },
        ],
      };
    },
    simulateContract: async ({ args }: { args: [{ poolKey: PoolKey }] }) => {
      this.quotes.push(args[0].poolKey.currency1);
      return { result: [1_000_000n, 50_000n] };
    },
    getTransactionCount: async () => 0,
    getBalance: async () => 10n ** 18n,
    estimateGas: async () => 100_000n,
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => {
      this.broadcasts.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
    waitForTransactionReceipt: async () => ({
      status: "success",
      blockNumber: this.head,
    }),
  } as unknown as PublicClient;
}

async function eventually(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 3_500;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(predicate(), true, label);
}

function cursors(): {
  nextBlock: string;
  lastScanned?: { number: string; hash: Hex };
}[] {
  if (!existsSync("runtime/monitor")) return [];
  return readdirSync("runtime/monitor")
    .filter((file) => file.startsWith("cursor-") && file.endsWith(".json"))
    .map((file) =>
      JSON.parse(readFileSync(join("runtime/monitor", file), "utf8")),
    );
}

function monitorStatus(engine: Engine) {
  return (engine as unknown as { monitor: { status: string } }).monitor.status;
}

type FeedFactory = NonNullable<ConstructorParameters<typeof Engine>[0]>;
type FeedOptions = Parameters<FeedFactory>[0];

async function isolated(
  run: (fixture: {
    chain: FakeChain;
    saveManifest: (value: Deployment) => void;
    engine: (config?: Partial<Config>, startFeed?: FeedFactory) => Engine;
  }) => Promise<void>,
) {
  const originalDirectory = process.cwd();
  const originalKey = process.env.TRADING_PRIVATE_KEY;
  const originalAdapter = process.env.IMD_ADAPTER_PATH;
  const directory = mkdtempSync(join(tmpdir(), "imd-engine-monitor-"));
  const engines: Engine[] = [];
  const chain = new FakeChain();
  process.chdir(directory);
  process.env.TRADING_PRIVATE_KEY = `0x${"11".repeat(32)}`;
  delete process.env.IMD_ADAPTER_PATH;
  const saveManifest = (value: Deployment) => {
    mkdirSync("config", { recursive: true });
    writeFileSync("config/mainnet.json", JSON.stringify(value));
  };
  saveManifest(manifest());
  try {
    await run({
      chain,
      saveManifest,
      engine: (config = {}, startFeed = () => () => {}) => {
        const engine = new Engine(startFeed, {}, {
          now: () => Number(1_800_000_000n + chain.head * 12n) * 1000,
        });
        engine.config = configSchema.parse({
          discoverySource: "chain",
          startBlock: "0",
          rpcHttpUrls: ["https://fixture.example.invalid"],
          rpcWsUrls: [],
          ...config,
        });
        engine.client = () => chain.client;
        // Readiness is covered elsewhere. Every chain and broadcast method here is local.
        engine.check = async () => ({ ok: true, checks: [] });
        engines.push(engine);
        return engine;
      },
    });
  } finally {
    for (const engine of engines) engine.stop();
    for (const engine of engines)
      await eventually(
        () => engine.canConfigure,
        "engine finished before removing fixture workspace",
      );
    process.chdir(originalDirectory);
    if (originalKey === undefined) delete process.env.TRADING_PRIVATE_KEY;
    else process.env.TRADING_PRIVATE_KEY = originalKey;
    if (originalAdapter === undefined) delete process.env.IMD_ADAPTER_PATH;
    else process.env.IMD_ADAPTER_PATH = originalAdapter;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("automatic live audit marks an already eligible launch missed without quoting or sending", async () => {
  await isolated(async ({ chain, engine: createEngine }) => {
    chain.head = 110n;
    chain.launches = [launch(100n)];
    const engine = createEngine();
    await engine.start("live");
    await eventually(
      () => !engine.running,
      "historical first launch stops the watcher",
    );
    assert.equal(engine.state.phase, "missed");
    assert.equal(monitorStatus(engine), "missed");
    assert.deepEqual(chain.ranges[0], { from: 100n, to: 110n });
    assert.deepEqual(chain.quotes, []);
    assert.deepEqual(chain.broadcasts, []);
    const persisted = new Journal().state;
    assert.equal(persisted.phase, "failed");
    assert.ok(persisted.reason, "missed launch records a durable stop reason");
    assert.equal(persisted.txHash, undefined);
    await assert.rejects(engine.start("live"), /记录|重复|已|首|错过/);
  });
});

test("restart resumes the durable cursor and catches an eligible launch during downtime", async () => {
  await isolated(async ({ chain, engine: createEngine }) => {
    const first = createEngine();
    await first.start("live");
    await eventually(
      () => cursors().some((cursor) => cursor.nextBlock === "101"),
      "first scan saved next block",
    );
    first.stop();
    await eventually(() => first.canConfigure, "first watcher stopped");
    chain.head = 103n;
    chain.launches = [launch(102n)];
    chain.ranges = [];
    const restarted = createEngine();
    await restarted.start("live");
    await eventually(
      () => !restarted.running,
      "outage launch is detected on restart",
    );
    assert.deepEqual(chain.ranges[0], { from: 101n, to: 103n });
    assert.equal(restarted.state.phase, "missed");
    assert.equal(monitorStatus(restarted), "missed");
    assert.equal(new Journal().state.phase, "failed");
    assert.deepEqual(chain.quotes, []);
    assert.deepEqual(chain.broadcasts, []);
  });
});

test("a failed historical chunk cannot advance the durable cursor and restart retries it", async () => {
  await isolated(async ({ chain, engine: createEngine }) => {
    chain.head = 249n;
    chain.failLogsFrom = 200n;
    const first = createEngine();
    await first.start("dry-run");
    await eventually(
      () => first.logs.some((entry) => entry.event === "scan_error"),
      "second chunk fails",
    );
    assert.equal(cursors().length, 1);
    assert.equal(cursors()[0]!.nextBlock, "200");
    assert.deepEqual(cursors()[0]!.lastScanned, {
      number: "199",
      hash: blockHash(199n),
    });
    first.stop();
    await eventually(() => first.canConfigure, "failed scan has finished");
    chain.failLogsFrom = undefined;
    chain.ranges = [];
    const restarted = createEngine();
    await restarted.start("dry-run");
    await eventually(
      () => cursors().some((cursor) => cursor.nextBlock === "250"),
      "restart completes failed chunk",
    );
    assert.deepEqual(chain.ranges[0], { from: 200n, to: 249n });
    assert.deepEqual(chain.quotes, []);
    assert.deepEqual(chain.broadcasts, []);
  });
});

test("relaxing a tax filter re-audits previously rejected history instead of skipping it", async () => {
  await isolated(async ({ chain, engine: createEngine, saveManifest }) => {
    const deployment = manifest();
    deployment.taxPolicies[0]!.buyTaxBps = 100;
    saveManifest(deployment);
    chain.head = 110n;
    chain.launches = [launch(100n)];
    const first = createEngine({ maxBuyTaxBps: 0 });
    await first.start("live");
    await eventually(
      () => cursors().some((cursor) => cursor.nextBlock === "111"),
      "strict policy completes history",
    );
    assert.equal(first.running, true);
    first.stop();
    await eventually(() => first.canConfigure, "strict-policy scan stopped");
    chain.ranges = [];
    const relaxed = createEngine({ maxBuyTaxBps: 100 });
    await relaxed.start("live");
    await eventually(
      () => !relaxed.running,
      "relaxed policy detects historical eligible launch",
    );
    assert.deepEqual(chain.ranges[0], { from: 100n, to: 110n });
    assert.equal(relaxed.state.phase, "missed");
    assert.deepEqual(chain.quotes, []);
    assert.deepEqual(chain.broadcasts, []);
  });
});

test("a manifest tax-evidence change re-audits history even when factory boundary is unchanged", async () => {
  await isolated(async ({ chain, engine: createEngine, saveManifest }) => {
    const deployment = manifest();
    deployment.taxPolicies = [];
    saveManifest(deployment);
    chain.head = 110n;
    chain.launches = [launch(100n)];
    const first = createEngine();
    await first.start("dry-run");
    await eventually(
      () => cursors().some((cursor) => cursor.nextBlock === "111"),
      "unknown-tax history was audited",
    );
    first.stop();
    await eventually(() => first.canConfigure, "old-manifest scan stopped");
    saveManifest(manifest());
    chain.ranges = [];
    const reviewed = createEngine();
    await reviewed.start("dry-run");
    await eventually(
      () => !reviewed.running,
      "new evidence triggers historical eligibility review",
    );
    assert.deepEqual(chain.ranges[0], { from: 100n, to: 110n });
    assert.equal(reviewed.state.phase, "missed");
    assert.deepEqual(chain.quotes, []);
    assert.deepEqual(chain.broadcasts, []);
  });
});

test("a chunk reorg during discovery stops before quoting and leaves the prior cursor intact", async () => {
  await isolated(async ({ chain, engine: createEngine }) => {
    const engine = createEngine();
    await engine.start("dry-run");
    await eventually(
      () => cursors().some((cursor) => cursor.nextBlock === "101"),
      "initial chunk committed",
    );
    chain.head = 102n;
    chain.launches = [launch(101n)];
    chain.onLogs = (from, to) => {
      if (from === 101n) chain.forks.set(to, 1);
    };
    await eventually(
      () => !engine.running,
      "reorganized chunk stops the watcher",
    );
    assert.equal(engine.state.phase, "failed");
    assert.match(String(engine.state.reason), /重组|reorg/i);
    assert.equal(cursors()[0]!.nextBlock, "101");
    assert.deepEqual(chain.quotes, []);
    assert.deepEqual(chain.broadcasts, []);
  });
});

test("a prior checkpoint reorg after the initial tick check blocks a consistent-looking new chunk", async () => {
  await isolated(async ({ chain, engine: createEngine }) => {
    const engine = createEngine();
    await engine.start("live");
    await eventually(
      () => cursors().some((cursor) => cursor.nextBlock === "101"),
      "initial checkpoint committed",
    );
    const committed = cursors()[0]!;
    chain.head = 102n;
    chain.launches = [launch(101n)];
    chain.onLogs = (from) => {
      // The initial checkpoint query has already returned its old hash. The
      // chunk's endpoint reads remain consistent, so only rechecking the prior
      // checkpoint can detect that the previously audited history changed.
      if (from === 101n) chain.forks.set(100n, 1);
    };
    await eventually(
      () => !engine.running,
      "changed prior checkpoint stops the watcher",
    );
    assert.equal(engine.state.phase, "failed");
    assert.match(String(engine.state.reason), /重组|reorg/i);
    assert.deepEqual(cursors(), [committed]);
    assert.deepEqual(chain.quotes, []);
    assert.deepEqual(chain.broadcasts, []);
    assert.equal(new Journal().state.txHash, undefined);
  });
});

test("an eligible launch after the startup head follows the normal dry-run quote path", async () => {
  await isolated(async ({ chain, engine: createEngine }) => {
    const engine = createEngine();
    await engine.start("dry-run");
    await eventually(
      () => cursors().some((cursor) => cursor.nextBlock === "101"),
      "startup history complete",
    );
    chain.head = 101n;
    chain.launches = [launch(101n)];
    await eventually(() => !engine.running, "new launch finishes dry-run");
    assert.equal(engine.state.phase, "simulated");
    assert.deepEqual(chain.quotes, [chain.launches[0]!.token]);
    assert.deepEqual(chain.broadcasts, []);
  });
});

test("startup head is captured after boundary resolution so launches during resolution count as missed", async () => {
  await isolated(async ({ chain, engine: createEngine }) => {
    chain.launches = [launch(101n)];
    chain.onCode = (target, number) => {
      if (target.toLowerCase() === factory.toLowerCase() && number === 99n)
        chain.head = 101n;
    };
    const engine = createEngine();
    await engine.start("dry-run");
    await eventually(
      () => !engine.running,
      "launch during startup is detected",
    );
    assert.equal(engine.state.phase, "missed");
    assert.equal(monitorStatus(engine), "missed");
    assert.deepEqual(chain.quotes, []);
    assert.deepEqual(chain.broadcasts, []);
  });
});

test("API hints trigger canonical discovery, and duplicate signals plus polling produce only one live purchase", async () => {
  await isolated(async ({ chain, engine: createEngine }) => {
    let feed!: FeedOptions;
    let feedStops = 0;
    const engine = createEngine({}, (options) => {
      feed = options;
      return () => {
        feedStops++;
      };
    });
    await engine.start("live");
    await eventually(
      () => cursors().some((cursor) => cursor.nextBlock === "101"),
      "startup history audited",
    );
    assert.ok(feed, "engine installs the injectable API wakeup feed");

    const oldHint = [
      {
        id: "old-api-only-hint",
        launchNumber: 999,
        chainId: 1,
        status: "completed",
        kind: "evm_project",
        token: address("2"),
      },
    ];
    chain.head = 101n;
    await feed.onSignal(oldHint);
    await eventually(
      () => cursors().some((cursor) => cursor.nextBlock === "102"),
      "API signal caused a canonical empty-range scan",
    );
    assert.ok(
      chain.ranges.some((range) => range.from === 101n && range.to === 101n),
    );
    assert.deepEqual(
      chain.quotes,
      [],
      "API metadata alone cannot authorize a quote",
    );
    assert.deepEqual(chain.broadcasts, []);
    assert.equal(new Journal().state.phase, "idle");

    let releaseQuote!: () => void;
    const quoteGate = new Promise<void>((resolve) => {
      releaseQuote = resolve;
    });
    Object.assign(chain.client, {
      simulateContract: async ({ args }: { args: [{ poolKey: PoolKey }] }) => {
        chain.quotes.push(args[0].poolKey.currency1);
        await quoteGate;
        return { result: [1_000_000n, 50_000n] };
      },
    });
    chain.head = 102n;
    chain.launches = [launch(102n)];
    try {
      // The signal's token deliberately differs from the canonical launch.
      await Promise.all([feed.onSignal(oldHint), feed.onSignal(oldHint)]);
      await eventually(
        () => chain.quotes.length === 1,
        "concurrent hints select one canonical launch",
      );
      // Keep execution in flight across a real timer tick to exercise the shared
      // busy guard between the API wakeup and HTTP polling paths.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      assert.deepEqual(chain.quotes, [chain.launches[0]!.token]);
      assert.deepEqual(chain.broadcasts, []);
    } finally {
      releaseQuote();
    }
    await eventually(
      () => engine.state.phase === "confirmed",
      "one mocked live purchase completes",
    );
    assert.deepEqual(chain.quotes, [chain.launches[0]!.token]);
    assert.equal(chain.broadcasts.length, 1);
    assert.equal(new Journal().state.phase, "confirmed");
    assert.equal(new Journal().state.token, chain.launches[0]!.token);
    assert.equal(feedStops, 1, "trade completion stops the API feed");
  });
});
