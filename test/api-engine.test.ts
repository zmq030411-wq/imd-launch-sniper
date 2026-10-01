import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { setImmediate } from "node:timers";
import { keccak256, decodeFunctionData, parseEther, parseTransaction, recoverTransactionAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Engine, type ApiDependencies } from "../src/engine.js";
import { configSchema, type Config, type Deployment } from "../src/config.js";
import { ApiLaunchError, trustedUniswap } from "../src/api-launch.js";
import { ApiSession, ApiHttpError } from "../src/api-session.js";
import type { LaunchHint, LaunchSnapshot } from "../src/launch-feed.js";
import { Journal } from "../src/journal.js";
import { poolId, routerAbi } from "../src/v4.js";
import type { Candidate, PoolKey } from "../src/types.js";

const key = `0x${"11".repeat(32)}` as Hex;
const wallet = privateKeyToAccount(key).address;
const bytecode: Hex = "0x6000";
const codeHash = keccak256(bytecode);
const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const blockHash = (number: bigint, fork = 0) => `0x${(number * 100n + BigInt(fork)).toString(16).padStart(64, "0")}` as Hex;
const launchId = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const hint = (number = 1, extra: Partial<LaunchHint> = {}): LaunchHint => ({
  id: launchId(number), launchNumber: number, chainId: 1, status: "live", kind: "evm_project", token: address(String(number)), ...extra,
});
function candidate(number = 1, at = 101n): Candidate {
  const token = address(String(number));
  const pool: PoolKey = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  return { id: `1:${number}:${token}`, token, pool, poolId: poolId(pool), launchNumber: number, kind: "evm_project", launchTxHash: blockHash(at, number), blockNumber: at, blockHash: blockHash(at), transactionIndex: 0, logIndex: 1 };
}
function deployment(): Deployment {
  return { chainId: 1, verified: true, verifiedSource: "https://api.imd.fun/launches/fixture", ...trustedUniswap(),
    factories: [{ address: address("a"), codeHash, autoStartSafe: false }],
    registries: [{ address: address("b"), codeHash }], deployers: [address("c")], taxPolicies: [], relayUrl: "https://relay.flashbots.net" };
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
async function advance(t: TestContext, milliseconds = 1000) { t.mock.timers.tick(milliseconds); await settle(); }

class Fixture {
  head = 100n;
  nowMs?: number;
  baseFees = new Map<bigint, bigint>();
  rows: LaunchHint[] = [];
  snapshots = 0;
  cacheMaxAgeSeconds: number | null = null;
  snapshotOverride?: () => Promise<LaunchSnapshot>;
  resolutions: string[] = [];
  resolveSignals: (AbortSignal | undefined)[] = [];
  quotes: Address[] = [];
  broadcasts: Hex[] = [];
  protocolReads = 0;
  engines: Engine[] = [];
  launches = new Map<string, Candidate>();
  codeOverrides = new Map<string, Hex>();
  forkHashes = new Map<bigint, Hex>();
  resolveOverride?: ApiDependencies["resolve"];
  protocolCode = JSON.parse(gunzipSync(Buffer.from(PROTOCOL_CODE_GZIP, "base64")).toString()) as Record<string, Hex>;
  client = {
    getChainId: async () => 1,
    getBlockNumber: async () => this.head,
    getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => {
      const number = blockNumber ?? this.head;
      return { number, hash: this.forkHashes.get(number) ?? blockHash(number), timestamp: 1_800_000_000n + 12n * number, baseFeePerGas: this.baseFees.get(number) ?? 1_000_000_000n };
    },
    getCode: async ({ address: target }: { address: Address }) => {
      const pinned = this.protocolCode[target.toLowerCase()];
      if (pinned) this.protocolReads++;
      return this.codeOverrides.get(target.toLowerCase()) ?? pinned ?? bytecode;
    },
    simulateContract: async ({ args }: { args: [{ poolKey: PoolKey }] }) => {
      this.quotes.push(args[0].poolKey.currency1); return { result: [1_000_000n, 50_000n] };
    },
    getTransactionCount: async () => 0,
    getBalance: async () => 10n ** 18n,
    estimateGas: async () => 100_000n,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      this.broadcasts.push(serializedTransaction); return keccak256(serializedTransaction);
    },
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: this.head }),
  } as unknown as PublicClient;
  create(config: Partial<Config> = {}) {
    const api: ApiDependencies = {
      snapshot: async (): Promise<LaunchSnapshot> => {
        this.snapshots++; if (this.snapshotOverride) return this.snapshotOverride(); return { checkedAt: new Date().toISOString(), source: "https://api.imd.fun/launches?limit=500", cacheMaxAgeSeconds: this.cacheMaxAgeSeconds, launches: structuredClone(this.rows) };
      },
      resolve: async (id, client, options) => {
        this.resolutions.push(id);
        this.resolveSignals.push(options?.signal);
        if (this.resolveOverride) return this.resolveOverride(id, client, options);
        const found = this.launches.get(id);
        if (!found) throw new ApiLaunchError("not_ready", "fixture pending", true);
        return { candidate: found, deployment: deployment() };
      },

    };
    const engine = new Engine(() => () => {}, api, {
      now: () => this.nowMs ?? Number(1_800_000_000n + 12n * this.head) * 1000,
    });
    engine.config = configSchema.parse({ rpcHttpUrls: ["https://fixture.invalid"], rpcWsUrls: [], pollIntervalMs: 1000, ...config });
    engine.client = () => this.client;
    this.engines.push(engine);
    return engine;
  }
  publish(number = 1, at = 101n) {
    this.head = at; this.launches.set(launchId(number), candidate(number, at));
    this.rows = this.rows.filter((x) => x.id !== launchId(number)); this.rows.push(hint(number));
  }
}

async function isolated(t: TestContext, run: (fixture: Fixture) => Promise<void>) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const originalDirectory = process.cwd();
  const originalKey = process.env.TRADING_PRIVATE_KEY;
  const directory = mkdtempSync(join(tmpdir(), "imd-api-engine-"));
  const fixture = new Fixture();
  process.chdir(directory); process.env.TRADING_PRIVATE_KEY = key;
  try { await run(fixture); }
  finally {
    fixture.engines.forEach((engine) => engine.stop());
    await settle();
    process.chdir(originalDirectory);
    if (originalKey === undefined) delete process.env.TRADING_PRIVATE_KEY;
    else process.env.TRADING_PRIVATE_KEY = originalKey;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("API readiness and live arming require no IMD manifest or starting block", async (t) => {
  await isolated(t, async (f) => {
    const engine = f.create();
    assert.equal(engine.config.discoverySource, "api");
    assert.equal(engine.config.taxCheck, "off");
    const check = await engine.check();
    assert.equal(check.ok, true, JSON.stringify(check));
    assert.equal(existsSync("config/mainnet.json"), false);
    await engine.start("live");
    assert.equal(engine.state.phase, "watching");
    assert.equal(engine.running, true);
    assert.equal(new ApiSession("live").state!.anchor.number, "100");
    assert.deepEqual(f.broadcasts, []);
  });
});

test("baseline permanently excludes already live mainnet records", async (t) => {
  await isolated(t, async (f) => {
    f.rows = [hint()]; f.launches.set(launchId(1), candidate(1, 90n));
    const engine = f.create(); await engine.start("live");
    await advance(t, 3000);
    assert.deepEqual(f.resolutions, []);
    assert.deepEqual(new ApiSession("live").state!.excluded, [launchId(1)]);
    assert.deepEqual(f.broadcasts, []);
  });
});

test("baseline assembling project becoming live buys once using the real wallet address", async (t) => {
  await isolated(t, async (f) => {
    f.rows = [hint(1, { status: "assembling", token: undefined })];
    const engine = f.create(); await engine.start("live");
    f.publish(); await advance(t);
    assert.equal(engine.state.phase, "confirmed", JSON.stringify(engine.logs));
    assert.equal(await recoverTransactionAddress({ serializedTransaction: f.broadcasts[0]! as `0x02${string}` }), wallet);
    assert.deepEqual(f.quotes, [candidate().token]);
    assert.equal(f.broadcasts.length, 1);
    const signed = parseTransaction(f.broadcasts[0]!);
    assert.equal(signed.chainId, 1);
    assert.equal(signed.to?.toLowerCase(), trustedUniswap().router.address);
    assert.equal(signed.value, parseEther("0.01"));
    assert.equal(new Journal().state.phase, "confirmed");
    await advance(t, 6000);
    assert.equal(f.broadcasts.length, 1);
    await assert.rejects(engine.start("live"));
  });
});

test("duplicate API polling while a resolver is active never duplicates signing", async (t) => {
  await isolated(t, async (f) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.resolveOverride = async (id) => { await gate; return { candidate: f.launches.get(id)!, deployment: deployment() }; };
    const engine = f.create(); await engine.start("live");
    f.publish(); await advance(t);
    try {
      assert.equal(engine.state.phase, "validating");
      await advance(t, 6000);
      assert.equal(f.resolutions.length, 1);
      assert.deepEqual(f.broadcasts, []);
    } finally { release(); }
    await settle();
    assert.equal(engine.state.phase, "confirmed", JSON.stringify(engine.logs));
    assert.equal(f.broadcasts.length, 1);
  });
});

test("testnet and non-live API rows never reach the mainnet resolver", async (t) => {
  await isolated(t, async (f) => {
    const engine = f.create(); await engine.start("live");
    f.rows = [hint(1, { chainId: 11155111 }), hint(2, { status: "abandoned" })];
    await advance(t, 3000);
    assert.deepEqual(f.resolutions, []);
    assert.deepEqual(new ApiSession("live").pending(), []);
    assert.deepEqual(f.broadcasts, []);
  });
});

test("an earlier launch arriving during resolution is reordered before any later-token claim", async (t) => {
  await isolated(t, async (f) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.resolveOverride = async (id) => {
      if (id === launchId(2)) await gate;
      return { candidate: f.launches.get(id)!, deployment: deployment() };
    };
    const engine = f.create();
    await engine.start("live");
    f.publish(2, 102n);
    await advance(t);
    try {
      assert.equal(engine.state.phase, "validating");
      assert.equal(f.resolutions[0], launchId(2));
      // The API learns about the block-101 launch only while the block-102
      // candidate's resolution is running. The chain head itself never moves backward.
      f.publish(1, 101n);
      f.head = 103n;
      await advance(t);
      assert.deepEqual(new ApiSession("live").pending().map((item) => item.id).sort(), [launchId(1), launchId(2)]);
      assert.equal(new Journal().state.phase, "idle");
      assert.deepEqual(f.broadcasts, []);
    } finally { release(); }
    await settle();
    assert.equal(new Journal().state.phase, "idle", "stale resolver result cannot claim the later token");
    assert.deepEqual(f.quotes, [], "no live quote starts for the stale batch");
    assert.deepEqual(f.broadcasts, []);
    await advance(t);
    assert.equal(engine.state.phase, "confirmed", JSON.stringify(engine.logs));
    assert.equal(new Journal().state.token, candidate(1).token);
    assert.deepEqual(f.quotes, [candidate(1).token]);
    assert.equal(f.broadcasts.length, 1);
    await advance(t, 6000);
    assert.equal(f.broadcasts.length, 1);
  });
});

test("an API record arriving late with an older transaction is rejected before quoting", async (t) => {
  await isolated(t, async (f) => {
    const engine = f.create(); await engine.start("live");
    f.publish(1, 100n); await advance(t);
    assert.equal(f.resolutions.length, 1);
    assert.equal(f.quotes.length, 0);
    assert.deepEqual(f.broadcasts, []);
    assert.match(new ApiSession("live").state!.decisions[launchId(1)]!, /启动前|旧记录/);
  });
});

test("restart preserves the baseline and pending records but never chases an outage launch", async (t) => {
  await isolated(t, async (f) => {
    f.rows = [hint(2)];
    const first = f.create(); await first.start("live");
    f.rows.push(hint(1)); await advance(t);
    const before = new ApiSession("live").state!;
    assert.deepEqual(before.pending.map((x) => x.id), [launchId(1)]);
    first.stop(); await settle();
    f.head = 104n; f.launches.set(launchId(1), candidate(1, 102n));
    const restarted = f.create(); await restarted.start("live"); await settle();
    const after = new ApiSession("live").state!;
    assert.equal(after.baselineAt, before.baselineAt);
    assert.deepEqual(after.excluded, [launchId(2)]);
    assert.match(after.decisions[launchId(1)]!, /启动前|停机/);
    assert.deepEqual(f.broadcasts, []);
    f.publish(3, 105n); await advance(t);
    assert.equal(restarted.state.phase, "confirmed", JSON.stringify(restarted.logs));
    assert.equal(new Journal().state.token, candidate(3).token);
  });
});

test("retryable earliest candidate blocks a later one until resolution then buys chain-first", async (t) => {
  await isolated(t, async (f) => {
    let firstAttempts = 0;
    f.resolveOverride = async (id) => {
      if (id === launchId(1) && firstAttempts++ === 0) throw new ApiLaunchError("pending", "wait", true);
      return { candidate: f.launches.get(id)!, deployment: deployment() };
    };
    const engine = f.create(); await engine.start("live");
    f.publish(2, 102n); f.publish(1, 101n); f.head = 102n;
    await advance(t);
    assert.equal(new ApiSession("live").pending().length, 2);
    assert.equal(f.quotes.length, 0);
    assert.deepEqual(f.broadcasts, []);
    await advance(t);
    assert.equal(engine.state.phase, "confirmed", JSON.stringify(engine.logs));
    assert.equal(new Journal().state.token, candidate(1).token);
    assert.equal(f.quotes.length, 1);
  });
});

test("permanent API evidence rejection is recorded without a quote", async (t) => {
  await isolated(t, async (f) => {
    f.resolveOverride = async () => { throw new ApiLaunchError("bad_provenance", "凭据不一致", false); };
    const engine = f.create(); await engine.start("live");
    f.publish(); await advance(t);
    assert.equal(new ApiSession("live").state!.decisions[launchId(1)], "凭据不一致");
    assert.equal(f.quotes.length, 0);
    assert.deepEqual(f.quotes, []);
    assert.deepEqual(f.broadcasts, []);
  });
});

test("API live mode reports unknown tax and has no runtime fork dependency", async (t) => {
  await isolated(t, async (f) => {
    const engine = f.create({ taxCheck: "off" });
    const checks = await engine.check();
    assert.equal(checks.ok, true);
    assert.match(checks.checks.find((item) => item.name === "税率状态")!.detail, /未检测/);
    await engine.start("live");
    assert.ok(engine.logs.some((entry) => entry.event === "tax_check_disabled"));
    f.publish(); await advance(t);
    assert.equal(f.broadcasts.length, 1);
  });
});

test("a failed first quote stops the session without buying the next token", async (t) => {
  await isolated(t, async (f) => {
    f.client.simulateContract = (async () => { throw Error("quote failed"); }) as typeof f.client.simulateContract;
    const engine = f.create(); await engine.start("live");
    f.publish(1, 101n); f.publish(2, 102n); await advance(t);
    assert.equal(engine.running, false);
    assert.equal(engine.state.phase, "failed");
    assert.equal(new Journal().state.token, candidate(1).token);
    assert.deepEqual(f.broadcasts, []);
  });
});

test("live execution retains resolver and pinned-protocol verification", async (t) => {
  await isolated(t, async (f) => {
    const engine = f.create({ taxCheck: "off" });
    assert.equal((await engine.check()).ok, true);
    await engine.start("live");
    const readsBefore = f.protocolReads;
    f.publish(); await advance(t);
    assert.equal(engine.state.phase, "confirmed", JSON.stringify(engine.logs));
    assert.deepEqual(f.resolutions, [launchId(1)]);
    assert.ok(f.protocolReads >= readsBefore + 8, "protocol is checked before selection and immediately before signing");
    assert.equal(f.broadcasts.length, 1);
  });
});

test("stop while API resolution is in flight aborts and never broadcasts", async (t) => {
  await isolated(t, async (f) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.resolveOverride = async (id) => { await gate; return { candidate: f.launches.get(id)!, deployment: deployment() }; };
    const engine = f.create(); await engine.start("live");
    f.publish(); await advance(t);
    assert.equal(engine.state.phase, "validating");
    try { engine.stop(); assert.equal(f.resolveSignals[0]?.aborted, true); }
    finally { release(); }
    await settle(); await advance(t, 6000);
    assert.equal(engine.running, false);
    assert.equal(engine.canConfigure, true);
    assert.deepEqual(f.quotes, []);
    assert.deepEqual(f.broadcasts, []);
    assert.equal(new Journal().state.phase, "idle");
  });
});

test("wrong-chain resolved deployment is rejected before signing", async (t) => {
  await isolated(t, async (f) => {
    f.resolveOverride = async (id) => ({ candidate: f.launches.get(id)!, deployment: { ...deployment(), chainId: 11155111 } as unknown as Deployment });
    const engine = f.create(); await engine.start("live");
    f.publish(); await advance(t);
    assert.match(new ApiSession("live").state!.decisions[launchId(1)]!, /不一致/);
    assert.deepEqual(f.broadcasts, []);
  });
});

test("changed protocol code after resolution invalidates the transaction", async (t) => {
  await isolated(t, async (f) => {
    f.resolveOverride = async (id) => {
      f.codeOverrides.set(trustedUniswap().router.address, "0x6001");
      return { candidate: f.launches.get(id)!, deployment: deployment() };
    };
    const engine = f.create(); await engine.start("live");
    f.publish(); await advance(t);
    assert.equal(engine.state.phase, "failed");
    assert.deepEqual(f.quotes, []);
    assert.deepEqual(f.broadcasts, []);
  });
});

test("resolver token mismatch is rejected before quoting", async (t) => {
  await isolated(t, async (f) => {
    const engine = f.create(); await engine.start("live");
    f.publish(); f.rows[0]!.token = address("9"); await advance(t);
    assert.equal(f.quotes.length, 0);
    assert.deepEqual(f.broadcasts, []);
    assert.match(new ApiSession("live").state!.decisions[launchId(1)]!, /不一致/);
  });
});

test("a campaign keeps its original nested filters despite mutation during resolution", async (t) => {
  await isolated(t, async (f) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.resolveOverride = async (id) => { await gate; return { candidate: f.launches.get(id)!, deployment: deployment() }; };
    const engine = f.create({ allowedKinds: ["custom_token"] });
    await engine.start("live");
    f.publish(); await advance(t);
    assert.equal(f.resolutions.length, 1);
    engine.config.allowedKinds.push("evm_project");
    release(); await settle();
    assert.equal(f.broadcasts.length, 0);
    assert.equal(f.quotes.length, 0);
    assert.match(new ApiSession("live").state!.decisions[launchId(1)]!, /类型/);
  });
});

test("a campaign pins its spending amount and wallet before asynchronous resolution", async (t) => {
  await isolated(t, async (f) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.resolveOverride = async (id) => { await gate; return { candidate: f.launches.get(id)!, deployment: deployment() }; };
    const engine = f.create({ buyAmountEth: "0.01" });
    await engine.start("live");
    f.publish(); await advance(t);
    engine.config = configSchema.parse({ ...engine.config, buyAmountEth: "0.5", taxCheck: "off" });
    process.env.TRADING_PRIVATE_KEY = `0x${"22".repeat(32)}`;
    release(); await settle();
    assert.equal(f.broadcasts.length, 1);
    assert.equal(parseTransaction(f.broadcasts[0]!).value, parseEther("0.01"));
    assert.equal(await recoverTransactionAddress({ serializedTransaction: f.broadcasts[0]! as `0x02${string}` }), wallet);
  });
});

test("a newly learned earlier launch after the claim prevents signing the later token", async (t) => {
  await isolated(t, async (f) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const quote = f.client.simulateContract;
    f.client.simulateContract = (async (...args: Parameters<typeof quote>) => {
      await gate; return quote(...args);
    }) as unknown as typeof quote;
    const engine = f.create(); await engine.start("live");
    f.publish(2, 102n); await advance(t);
    assert.equal(new Journal().state.phase, "claimed");
    f.publish(1, 101n); f.head = 102n; await advance(t);
    release(); await settle();
    assert.equal(f.broadcasts.length, 0);
    assert.equal(new Journal().state.phase, "failed");
    assert.equal(engine.running, false);
  });
});

test("an API withdrawal during resolution invalidates the pending live evidence", async (t) => {
  await isolated(t, async (f) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.resolveOverride = async (id) => { await gate; return { candidate: f.launches.get(id)!, deployment: deployment() }; };
    const engine = f.create(); await engine.start("live");
    f.publish(); await advance(t);
    f.rows = [hint(1, { status: "abandoned" })]; await advance(t);
    release(); await settle();
    assert.equal(f.broadcasts.length, 0);
    assert.equal(new Journal().state.phase, "idle");
    assert.equal(new ApiSession("live").pending().length, 0);
  });
});

test("failure to persist newly observed launches stops an in-flight transaction", async (t) => {
  await isolated(t, async (f) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.resolveOverride = async (id) => { await gate; return { candidate: f.launches.get(id)!, deployment: deployment() }; };
    const engine = f.create(); await engine.start("live");
    f.publish(2, 102n); await advance(t);
    const enqueue = t.mock.method(ApiSession.prototype, "enqueue", () => { throw Error("fixture disk full"); });
    f.publish(1, 101n); f.head = 102n;
    await advance(t);
    enqueue.mock.restore();
    release(); await settle();
    assert.equal(engine.running, false);
    assert.equal(engine.state.phase, "failed");
    assert.equal(f.broadcasts.length, 0);
    assert.equal(new Journal().state.phase, "idle");
  });
});

test("stop during quote preparation leaves the one-shot journal claimed and never broadcasts", async (t) => {
  await isolated(t, async (f) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const quote = f.client.simulateContract;
    f.client.simulateContract = (async (...args: Parameters<typeof quote>) => {
      await gate; return quote(...args);
    }) as unknown as typeof quote;
    const engine = f.create(); await engine.start("live");
    f.publish(); await advance(t);
    assert.equal(new Journal().state.phase, "claimed");
    engine.stop();
    await assert.rejects(engine.start("live"), /运行|结束/);
    release(); await settle();
    assert.equal(f.broadcasts.length, 0);
    assert.equal(new Journal().state.phase, "claimed");
    assert.equal(engine.canConfigure, true);
    await assert.rejects(engine.start("live"), /检查|交易记录/);
  });
});

// Public pinned Uniswap runtime fixture; tests never query a real RPC.
const PROTOCOL_CODE_GZIP = "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";

test("API cache lifetime never adds ten seconds to the mainnet poll cadence", async t => {
  await isolated(t, async f => {
    f.cacheMaxAgeSeconds = 10;
    const engine = f.create({pollIntervalMs: 2000}); await engine.start("live");
    const before = f.snapshots;
    await advance(t, 2000);
    assert.equal(f.snapshots, before + 1);
    await advance(t, 2000);
    assert.equal(f.snapshots, before + 2);
  });
});

test("slow snapshots remain single-flight and server Retry-After pauses all discovery", async t => {
  await isolated(t, async f => {
    const engine = f.create(); await engine.start("live");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.snapshotOverride = async () => { await gate; throw new ApiHttpError(429, 2 ** 31 + 1000); };
    await advance(t);
    const activeCount = f.snapshots;
    await advance(t, 6000); assert.equal(f.snapshots, activeCount);
    release(); await settle();
    await advance(t, 60_000); assert.equal(f.snapshots, activeCount);
    engine.stop(); await advance(t, 60_000); assert.equal(f.snapshots, activeCount);
    assert.equal(f.broadcasts.length, 0);
  });
});

test("bounded mainnet resolution completes the full batch before chain-first selection", async t => {
  await isolated(t, async f => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let concurrent = 0, maximum = 0;
    f.resolveOverride = async id => {
      concurrent++; maximum = Math.max(maximum, concurrent);
      await gate; concurrent--;
      return {candidate: f.launches.get(id)!, deployment: deployment()};
    };
    const engine = f.create(); await engine.start("live");
    f.publish(3, 103n); f.publish(2, 102n); f.publish(1, 101n); f.head = 103n;
    await advance(t); assert.equal(maximum, 2); assert.equal(f.resolutions.length, 2);
    assert.equal(new Journal().state.phase, "idle");
    release(); await settle();
    assert.equal(f.resolutions.length, 3); assert.equal(maximum, 2);
    assert.equal(engine.state.phase, "confirmed", JSON.stringify(engine.logs));
    assert.equal(new Journal().state.token, candidate(1).token);
    assert.equal(f.broadcasts.length, 1);
  });
});

test("a completed final snapshot catches withdrawal before any transaction is signed", async t => {
  await isolated(t, async f => {
    const engine = f.create(); await engine.start("live");
    const originalEstimate = f.client.estimateGas;
    f.client.estimateGas = (async (...args: Parameters<typeof originalEstimate>) => {
      f.rows = [hint(1, {status: "abandoned"})];
      return originalEstimate(...args);
    }) as typeof originalEstimate;
    f.publish(); await advance(t);
    assert.deepEqual(f.broadcasts, []);
    assert.equal(engine.state.phase, "failed");
  });
});

test("final nonce and balance are read after slow protocol preparation", async t => {
  await isolated(t, async f => {
    let latestReads = 0;
    const getCode = f.client.getCode;
    f.client.getCode = (async (...args: Parameters<typeof getCode>) => {
      if (f.quotes.length) latestReads = 1;
      return getCode(...args);
    }) as typeof getCode;
    f.client.getTransactionCount = (async () => latestReads) as typeof f.client.getTransactionCount;
    const engine = f.create(); await engine.start("live");
    f.publish(); await advance(t);
    assert.equal(engine.state.phase, "confirmed", JSON.stringify(engine.logs));
    assert.equal(parseTransaction(f.broadcasts[0]!).nonce, 1);
  });
});

test("a reorg during final protocol reads blocks signing despite successful earlier checks", async t => {
  await isolated(t, async f => {
    const getCode = f.client.getCode;
    f.client.getCode = (async (...args: Parameters<typeof getCode>) => {
      if (f.quotes.length) f.forkHashes.set(101n, blockHash(101n, 99));
      return getCode(...args);
    }) as typeof getCode;
    const engine = f.create(); await engine.start("live");
    f.publish(); await advance(t);
    assert.deepEqual(f.broadcasts, []);
    assert.equal(engine.state.phase, "failed");
  });
});

test("failed protocol checks drain siblings before releasing the mainnet execution lock", async t => {
  await isolated(t, async f => {
    const engine = f.create(); await engine.start("live");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const getCode = f.client.getCode;
    f.client.getCode = (async (args: Parameters<typeof getCode>[0]) => {
      if (args.address.toLowerCase() === trustedUniswap().router.address) await gate;
      if (args.address.toLowerCase() === trustedUniswap().quoter.address) throw Error("protocol read failed");
      return getCode(args);
    }) as typeof getCode;
    f.publish(); await advance(t);
    assert.equal(engine.canConfigure, false);
    engine.stop(); await settle();
    assert.equal(engine.canConfigure, false, "stop must still await the unfinished verification sibling");
    release(); await settle();
    assert.equal(engine.canConfigure, true);
    assert.deepEqual(f.quotes, []); assert.deepEqual(f.broadcasts, []);
  });
});

test("mainnet uses competitive fee history without exceeding unchanged spending caps", async t => {
  await isolated(t, async f => {
    f.client.getFeeHistory = (async () => ({reward: [[10_000_000_000n]], gasUsedRatio: [1], baseFeePerGas: [1_000_000_000n, 1_000_000_000n], oldestBlock: 100n})) as typeof f.client.getFeeHistory;
    const engine = f.create({feeStrategy: "competitive", priorityFeeGwei: "2", maxFeeGwei: "30"});
    await engine.start("live"); f.publish(); await advance(t);
    const transaction = parseTransaction(f.broadcasts[0]!);
    assert.equal(transaction.maxPriorityFeePerGas, 2_000_000_000n);
    assert.equal(transaction.maxFeePerGas, 30_000_000_000n);
    assert.equal(transaction.value, parseEther("0.01"));
    assert.ok(transaction.gas! * transaction.maxFeePerGas! <= parseEther(engine.config.maxGasEth));
    assert.ok(engine.logs.some(row => row.event === "fee_selected" && row.capped === true));
  });
});

test("withdrawal and identical reappearance still invalidate an in-flight API revision", async t => {
  await isolated(t, async f => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.resolveOverride = async id => { await gate; return {candidate: f.launches.get(id)!, deployment: deployment()}; };
    const engine = f.create(); await engine.start("live");
    f.publish(); await advance(t);
    f.rows = [hint(1, {status: "abandoned"})]; await advance(t);
    f.rows = [hint(1)]; await advance(t);
    release(); await settle();
    assert.deepEqual(f.quotes, []); assert.deepEqual(f.broadcasts, []);
    assert.equal(new Journal().state.phase, "idle");
    await advance(t);
    assert.equal(f.resolutions.length, 2);
    assert.equal(engine.state.phase, "confirmed", JSON.stringify(engine.logs));
  });
});

test("permanent resolver identity rejection still preserves an accompanying server cooldown", async t => {
  await isolated(t, async f => {
    f.resolveOverride = async id => {
      if (id === launchId(1)) throw new ApiLaunchError("bad_identity", "identity mismatch", false, 60_000);
      return {candidate: f.launches.get(id)!, deployment: deployment()};
    };
    const engine = f.create(); await engine.start("live");
    f.publish(1, 101n); f.publish(2, 102n); await advance(t);
    assert.equal(new ApiSession("live").state!.decisions[launchId(1)], "identity mismatch");
    assert.equal(new Journal().state.phase, "idle", "a later valid candidate must wait out the server cooldown before claim");
    const snapshots = f.snapshots, resolutions = f.resolutions.length;
    await advance(t, 3000);
    assert.equal(f.snapshots, snapshots); assert.equal(f.resolutions.length, resolutions);
    assert.deepEqual(f.quotes, []); assert.deepEqual(f.broadcasts, []);
  });
});

test("a resolver cooldown survives discarding an obsolete API batch revision", async t => {
  await isolated(t, async f => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.resolveOverride = async () => { await gate; throw new ApiLaunchError("api_unavailable", "slow down", true, 60_000); };
    const engine = f.create(); await engine.start("live");
    f.publish(1, 101n); await advance(t);
    f.publish(2, 102n); await advance(t);
    const snapshots = f.snapshots, resolutions = f.resolutions.length;
    release(); await settle(); await advance(t, 3000);
    assert.equal(f.snapshots, snapshots); assert.equal(f.resolutions.length, resolutions);
    assert.equal(new Journal().state.phase, "idle");
    assert.deepEqual(f.quotes, []); assert.deepEqual(f.broadcasts, []);
  });
});

test("maximum safe Retry-After cannot overflow the mainnet cooldown deadline", async t => {
  t.mock.method(performance, "now", () => 1000);
  await isolated(t, async f => {
    const engine = f.create(); await engine.start("live");
    f.snapshotOverride = async () => { throw new ApiHttpError(429, Number.MAX_SAFE_INTEGER); };
    await advance(t);
    const snapshots = f.snapshots;
    await advance(t, 60_000);
    assert.equal(f.snapshots, snapshots, "extreme cooldown is retained without an overflowing timer or retry storm");
    assert.equal(engine.running, true);
    assert.equal(engine.state.phase, "watching");
    assert.equal(new Journal().state.phase, "idle");
    engine.stop(); await advance(t, 60_000);
    assert.equal(f.snapshots, snapshots);
    assert.deepEqual(f.broadcasts, []);
  });
});

test("two-hour delayed launch is durably rejected without quoting or signing", async t => {
  await isolated(t, async f => {
    const engine = f.create(); await engine.start("live");
    f.publish(1, 101n); f.head = 701n; await advance(t);
    assert.equal(f.quotes.length, 0); assert.equal(f.broadcasts.length, 0);
    assert.match(new ApiSession("live").state!.decisions[launchId(1)]!, /时效上限/);
    engine.stop();
    const restarted = f.create(); await restarted.start("live"); await advance(t);
    assert.equal(f.broadcasts.length, 0);
    assert.equal(new ApiSession("live").pending().length, 0);
  });
});

test("wall clock rejects stale launch even if the RPC head is frozen", async t => {
  await isolated(t, async f => {
    const engine = f.create(); await engine.start("live"); f.publish();
    f.nowMs = Number(1_800_000_000n + 12n * 101n + 121n) * 1000;
    await advance(t);
    assert.equal(f.broadcasts.length, 0);
    assert.match(new ApiSession("live").state!.decisions[launchId(1)]!, /时效上限/);
  });
});

test("a temporarily lagging admission head cannot permanently reject the first launch or buy the second", async t => {
  await isolated(t, async f => {
    const engine = f.create(); await engine.start("live");
    f.publish(1, 101n); f.publish(2, 102n);
    const getBlock = f.client.getBlock;
    let lagged = false;
    f.client.getBlock = (async (args?: Parameters<typeof getBlock>[0]) => {
      if (!lagged && args?.blockNumber === undefined) {
        lagged = true;
        return getBlock({ blockNumber: 100n });
      }
      return getBlock(args);
    }) as typeof getBlock;
    await advance(t);
    assert.equal(lagged, true);
    assert.equal(engine.running, false);
    assert.equal(engine.state.phase, "failed");
    const session = new ApiSession("live");
    assert.equal(session.state!.decisions[launchId(1)], undefined);
    assert.deepEqual(session.pending().map(row => row.id).sort(), [launchId(1), launchId(2)]);
    assert.equal(new Journal().state.phase, "idle");
    assert.deepEqual(f.quotes, []); assert.deepEqual(f.broadcasts, []);
    await advance(t, 6000);
    assert.deepEqual(f.broadcasts, []);
  });
});

test("launch expiry during gas preparation consumes the claim without submission or retry", async t => {
  await isolated(t, async f => {
    f.client.estimateGas = (async () => { f.head += 11n; return 100_000n; }) as typeof f.client.estimateGas;
    const engine = f.create(); await engine.start("live"); f.publish(); await advance(t);
    assert.equal(engine.state.phase, "failed");
    assert.match(String(engine.state.reason), /时效上限/);
    assert.equal(f.broadcasts.length, 0);
    await assert.rejects(f.create().start("live"), /实盘检查未通过/);
  });
});

test("fresh launch transaction expires no later than launch lifetime", async t => {
  await isolated(t, async f => {
    const engine = f.create(); await engine.start("live"); f.publish(); f.head = 109n; await advance(t);
    assert.equal(engine.state.phase, "confirmed", JSON.stringify(engine.logs));
    assert.equal(f.broadcasts.length, 1);
    const signed = parseTransaction(f.broadcasts[0]!);
    const decoded = decodeFunctionData({ abi: routerAbi, data: signed.data! });
    assert.equal(decoded.args[2], 1_800_000_000n + 12n * 101n + 120n);
  });
});


test("API can arm before a mainnet manifest and buy a resolver-verified new Hook without manual allowlisting", async t => {
  await isolated(t, async f => {
    const engine = f.create({ allowedHooks: [], allowedKinds: ["univ4_hook"] });
    assert.equal(existsSync("config/mainnet.json"), false);
    await engine.start("live");
    assert.equal(engine.running, true);
    const launch = candidate();
    launch.kind = "univ4_hook";
    launch.pool = {...launch.pool, hooks: address("d")};
    launch.poolId = poolId(launch.pool);
    f.publish();
    f.launches.set(launchId(1), launch);
    f.rows[0]!.kind = "univ4_hook";
    await advance(t);
    assert.deepEqual(f.resolutions, [launchId(1)], "automatic official identity verification still runs");
    assert.equal(engine.state.phase, "confirmed", JSON.stringify(engine.logs));
    assert.equal(f.broadcasts.length, 1);
    assert.ok(parseTransaction(f.broadcasts[0]!).data!.toLowerCase().includes(address("d").slice(2)));
    assert.equal(existsSync("config/mainnet.json"), false);
  });
});

for (const nextHead of [102n, 103n]) test(`slow final nonce reads refresh head ${nextHead}, then sign once and broadcast identical bytes in parallel`, async t => {
  await isolated(t, async f => {
    let releaseNonce!: () => void, releaseSlowBroadcast!: () => void;
    const nonceGate = new Promise<void>(resolve => { releaseNonce = resolve; });
    const broadcastGate = new Promise<void>(resolve => { releaseSlowBroadcast = resolve; });
    let nonceReads = 0, nonceReleased = false;
    const observedHeads: bigint[] = [];
    const getBlock = f.client.getBlock;
    f.client.getBlock = (async (args?: Parameters<typeof getBlock>[0]) => {
      const block = await getBlock(args);
      if (nonceReleased && args?.blockNumber === undefined) observedHeads.push(block.number!);
      return block;
    }) as typeof getBlock;
    f.client.getTransactionCount = (async () => { nonceReads++; await nonceGate; return 0; }) as typeof f.client.getTransactionCount;
    f.client.sendRawTransaction = (async ({serializedTransaction}: {serializedTransaction: Hex}) => {
      f.broadcasts.push(serializedTransaction);
      if (f.broadcasts.length === 1) await broadcastGate;
      return keccak256(serializedTransaction);
    }) as typeof f.client.sendRawTransaction;
    const newBaseFee = nextHead === 102n ? 2_800_000_000n : 2_900_000_000n;
    f.baseFees.set(nextHead, newBaseFee);
    const engine = f.create({ rpcHttpUrls: ["https://fixture-a.invalid", "https://fixture-b.invalid"],
      maxFeeGwei: "3", priorityFeeGwei: "2", feeStrategy: "competitive" });
    await engine.start("live");
    // Only the public, unfunded fixture account is observed; no real wallet is used.
    const account = (engine as unknown as {runAccount: ReturnType<typeof privateKeyToAccount>}).runAccount;
    const sign = t.mock.method(account, "signTransaction");
    try {
      f.publish(); await advance(t);
      assert.equal(nonceReads, 2);
      assert.equal(sign.mock.callCount(), 0);
      assert.deepEqual(f.broadcasts, []);
      f.head = nextHead;
      nonceReleased = true; releaseNonce(); await settle();
      assert.equal(engine.state.phase, "confirmed", JSON.stringify(engine.logs));
      assert.ok(observedHeads.includes(nextHead), "getBlock must run after the slow nonce batch completes");
      assert.equal(sign.mock.callCount(), 1);
      assert.equal(f.broadcasts.length, 2, "the second provider must finish while the first send is still pending");
      assert.equal(new Set(f.broadcasts).size, 1);
      const signed = parseTransaction(f.broadcasts[0]!);
      assert.equal(signed.nonce, 0);
      assert.equal(signed.maxPriorityFeePerGas, 3_000_000_000n - newBaseFee, "tip headroom must use the refreshed base fee");
      assert.equal(signed.maxFeePerGas, 3_000_000_000n);
      assert.ok(signed.gas! * signed.maxFeePerGas! <= parseEther(engine.config.maxGasEth));
      assert.equal(signed.value, parseEther("0.01"));
      await advance(t, 6000);
      assert.equal(sign.mock.callCount(), 1); assert.equal(f.broadcasts.length, 2);
      await assert.rejects(engine.start("live"));
    } finally { releaseNonce(); releaseSlowBroadcast(); await settle(); }
  });
});

test("a deadline that expires during the final nonce batch prevents any signature or public broadcast", async t => {
  await isolated(t, async f => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let nonceReads = 0;
    f.client.getTransactionCount = (async () => { nonceReads++; await gate; return 0; }) as typeof f.client.getTransactionCount;
    const engine = f.create({deadlineSeconds: 20, maxLaunchAgeSeconds: 300});
    await engine.start("live");
    const account = (engine as unknown as {runAccount: ReturnType<typeof privateKeyToAccount>}).runAccount;
    const sign = t.mock.method(account, "signTransaction");
    try {
      f.publish(); await advance(t); assert.equal(nonceReads, 2);
      f.head = 103n; // 24 seconds after the launch: young enough, but the quote deadline has expired.
      release(); await settle();
      assert.equal(engine.state.phase, "failed", JSON.stringify(engine.logs));
      assert.equal(sign.mock.callCount(), 0); assert.deepEqual(f.broadcasts, []);
      assert.equal(new Journal().state.txHash, undefined);
      await advance(t, 6000); assert.deepEqual(f.broadcasts, []);
      await assert.rejects(f.create().start("live"), /实盘检查未通过/);
    } finally { release(); await settle(); }
  });
});

test("an uncertain public broadcast retains one raw transaction and never retries the consumed attempt", async t => {
  await isolated(t, async f => {
    f.client.sendRawTransaction = (async ({serializedTransaction}: {serializedTransaction: Hex}) => {
      f.broadcasts.push(serializedTransaction); throw Error("fixture transport response lost");
    }) as typeof f.client.sendRawTransaction;
    const engine = f.create({rpcHttpUrls: ["https://fixture-a.invalid", "https://fixture-b.invalid"]});
    await engine.start("live");
    const account = (engine as unknown as {runAccount: ReturnType<typeof privateKeyToAccount>}).runAccount;
    const sign = t.mock.method(account, "signTransaction");
    f.publish(); await advance(t);
    assert.equal(engine.state.phase, "uncertain");
    assert.equal(sign.mock.callCount(), 1); assert.equal(f.broadcasts.length, 2);
    assert.equal(new Set(f.broadcasts).size, 1);
    await advance(t, 6000); await assert.rejects(f.create().start("live"), /实盘检查未通过/);
    assert.equal(sign.mock.callCount(), 1); assert.equal(f.broadcasts.length, 2);
  });
});

for (const refreshedHead of [101n, 102n]) test(`a reorg during slow nonce reads is rejected when refreshed head is ${refreshedHead}`, async t => {
  await isolated(t, async f => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let nonceReads = 0;
    f.client.getTransactionCount = (async () => { nonceReads++; await gate; return 0; }) as typeof f.client.getTransactionCount;
    const engine = f.create(); await engine.start("live");
    const account = (engine as unknown as {runAccount: ReturnType<typeof privateKeyToAccount>}).runAccount;
    const sign = t.mock.method(account, "signTransaction");
    try {
      f.publish(); await advance(t);
      assert.equal(nonceReads, 2); assert.equal(sign.mock.callCount(), 0);
      // Earlier launch/quote reads still refer to the original block 101. A
      // numerically newer head alone cannot prove those reads remain canonical.
      f.forkHashes.set(101n, blockHash(101n, 77));
      f.head = refreshedHead;
      release(); await settle();
      assert.equal(engine.state.phase, "failed", JSON.stringify(engine.logs));
      assert.equal(sign.mock.callCount(), 0); assert.deepEqual(f.broadcasts, []);
      assert.equal(new Journal().state.txHash, undefined);
      await advance(t, 6000); assert.deepEqual(f.broadcasts, []);
    } finally { release(); await settle(); }
  });
});
