import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, zeroAddress, type Address, type Hex } from "viem";
import { configSchema, type Config, type Deployment } from "../src/config.js";
import {
  hasReviewedTokenSafetyEvidence,
  tokenSafetyEligibility,
  type TokenSafetyContext,
} from "../src/token-safety.js";
import type { Candidate } from "../src/types.js";

const token = `0x${"11".repeat(20)}` as Address;
const hook = `0x${"22".repeat(20)}` as Address;
const tokenCode: Hex = "0x60006000f3";
const hookCode: Hex = "0x60016000f3";
const candidate: Candidate = {
  id: "1:10:test", token, launchNumber: 10, kind: "custom_token",
  poolId: `0x${"33".repeat(32)}`, launchTxHash: `0x${"44".repeat(32)}`,
  blockNumber: 100n, blockHash: `0x${"55".repeat(32)}`,
  transactionIndex: 0, logIndex: 0,
  pool: { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
};
type Evidence = Deployment["taxPolicies"][number];
function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return { tokenCodeHash: keccak256(tokenCode), hookCodeHash: null, immutable: true,
    buyTaxBps: 0, sellTaxBps: 0, source: "Synthetic unit test review; not a live approval", ...overrides };
}
function setup(options: {
  policies?: Evidence[];
  config?: Partial<Config>;
  tokenCode?: Hex | null;
  hookCode?: Hex | null;
} = {}) {
  const reads: { address: Address; blockNumber: bigint }[] = [];
  const client = {
    async getCode(request: { address: Address; blockNumber: bigint }) {
      reads.push(request);
      return request.address.toLowerCase() === token.toLowerCase()
        ? (options.tokenCode === null ? undefined : options.tokenCode ?? tokenCode)
        : (options.hookCode === null ? undefined : options.hookCode ?? hookCode);
    },
  } as unknown as TokenSafetyContext["client"];
  const ctx: TokenSafetyContext = {
    client, config: configSchema.parse({ discoverySource: "chain", ...options.config }),
    deployment: { taxPolicies: options.policies ?? [evidence()] },
  };
  return { ctx, reads };
}

test("advanced chain admission rejects missing reviewed evidence before RPC", async () => {
  assert.equal(hasReviewedTokenSafetyEvidence(null), false);
  assert.equal(hasReviewedTokenSafetyEvidence(undefined), false);
  const { ctx, reads } = setup({ policies: [] });
  assert.equal(hasReviewedTokenSafetyEvidence(ctx.deployment), false);
  assert.match((await tokenSafetyEligibility(candidate, ctx))!, /税率未知/);
  assert.deepEqual(reads, []);
});

test("only exact reviewed token and null Hook hashes admit an unhooked pool", async () => {
  const { ctx, reads } = setup();
  assert.equal(hasReviewedTokenSafetyEvidence(ctx.deployment), true);
  assert.equal(await tokenSafetyEligibility(candidate, ctx), null);
  assert.deepEqual(reads, [{ address: token, blockNumber: 100n }]);
  const wrongToken = setup({ tokenCode: "0x60026000f3" });
  assert.match((await tokenSafetyEligibility(candidate, wrongToken.ctx))!, /税率未知/);
  const wrongHookEvidence = setup({ policies: [evidence({ hookCodeHash: keccak256(hookCode) })] });
  assert.match((await tokenSafetyEligibility(candidate, wrongHookEvidence.ctx))!, /税率未知/);
});

test("kind and Hook allowlists are enforced before code reads", async () => {
  const kind = setup({ config: { allowedKinds: ["evm_project"] } });
  assert.match((await tokenSafetyEligibility(candidate, kind.ctx))!, /发币类型/);
  assert.deepEqual(kind.reads, []);
  const hooks = setup();
  assert.match((await tokenSafetyEligibility({ ...candidate, pool: { ...candidate.pool, hooks: hook } }, hooks.ctx))!, /Hook 不在白名单/);
  assert.deepEqual(hooks.reads, []);
});

test("rejects pools whose currencies do not identify native ETH and the candidate token", async () => {
  const { ctx, reads } = setup();
  for (const pool of [
    { ...candidate.pool, currency0: hook },
    { ...candidate.pool, currency1: hook },
  ]) assert.match((await tokenSafetyEligibility({ ...candidate, pool }, ctx))!, /不是原生 ETH 池/);
  assert.deepEqual(reads, []);
});

test("Hook evidence is bound to this exact token and checked at the requested final block", async () => {
  const hooked = { ...candidate, pool: { ...candidate.pool, hooks: hook } };
  const { ctx, reads } = setup({
    config: { allowedHooks: [hook] },
    policies: [evidence({ hookCodeHash: keccak256(hookCode) })],
  });
  assert.equal(await tokenSafetyEligibility(hooked, ctx, 105n), null);
  assert.deepEqual(reads, [
    { address: token, blockNumber: 105n }, { address: hook, blockNumber: 105n },
  ]);
  const changed = setup({ config: { allowedHooks: [hook] },
    policies: ctx.deployment.taxPolicies, hookCode: "0x60026000f3" });
  assert.match((await tokenSafetyEligibility(hooked, changed.ctx, 106n))!, /税率未知/);
});

test("matching only the Hook does not approve another token", async () => {
  const { ctx } = setup({ config: { allowedHooks: [hook] }, tokenCode: "0x60026000f3",
    policies: [evidence({ hookCodeHash: keccak256(hookCode) })] });
  assert.match((await tokenSafetyEligibility({ ...candidate, pool: { ...candidate.pool, hooks: hook } }, ctx))!, /税率未知/);
});

test("missing token or Hook code fails closed", async () => {
  for (const value of [null, "0x"] as const) {
    const missingToken = setup({ tokenCode: value });
    assert.match((await tokenSafetyEligibility(candidate, missingToken.ctx))!, /没有代币字节码/);
    const missingHook = setup({ config: { allowedHooks: [hook] }, hookCode: value });
    assert.match((await tokenSafetyEligibility({ ...candidate, pool: { ...candidate.pool, hooks: hook } }, missingHook.ctx))!, /Hook 字节码不可验证/);
  }
});

test("mutable evidence is rejected even when runtime hashes match", async () => {
  const mutable = { ...evidence(), immutable: false } as unknown as Evidence;
  const { ctx } = setup({ policies: [mutable] });
  assert.match((await tokenSafetyEligibility(candidate, ctx))!, /没有不可变税率/);
});

test("both reviewed taxes must fit their configured caps, including the boundary", async () => {
  const policies = [evidence({ buyTaxBps: 100, sellTaxBps: 200 })];
  const accepted = setup({ policies, config: { maxBuyTaxBps: 100, maxSellTaxBps: 200 } });
  assert.equal(await tokenSafetyEligibility(candidate, accepted.ctx), null);
  for (const config of [
    { maxBuyTaxBps: 99, maxSellTaxBps: 200 },
    { maxBuyTaxBps: 100, maxSellTaxBps: 199 },
  ]) assert.match((await tokenSafetyEligibility(candidate, setup({ policies, config }).ctx))!, /税率超过设置/);
});

test("conflicting exact-match reviews are rejected instead of selecting the first", async () => {
  const { ctx } = setup({ policies: [evidence(), evidence({ sellTaxBps: 1 })] });
  assert.match((await tokenSafetyEligibility(candidate, ctx))!, /审核证据冲突/);
});

test("malformed reviewed taxes cannot pass numeric comparisons", async () => {
  for (const sellTaxBps of [NaN, -1, 10001, 0.5]) {
    const { ctx } = setup({ policies: [evidence({ sellTaxBps })] });
    assert.match((await tokenSafetyEligibility(candidate, ctx))!, /审核证据无效/);
  }
});

test("standard delegation wrappers cannot be approved solely through their own hashes", async () => {
  const wrappers: Hex[] = [
    `0xef0100${"77".repeat(20)}`,
    `0x363d3d373d3d3d363d73${"77".repeat(20)}5af43d82803e903d91602b57fd5bf3`,
  ];
  for (const code of wrappers) {
    const tokenProxy = setup({ tokenCode: code, policies: [evidence({ tokenCodeHash: keccak256(code) })] });
    assert.match((await tokenSafetyEligibility(candidate, tokenProxy.ctx))!, /使用委托代码/);
    const hookProxy = setup({ config: { allowedHooks: [hook] }, hookCode: code,
      policies: [evidence({ hookCodeHash: keccak256(code) })] });
    assert.match((await tokenSafetyEligibility({ ...candidate, pool: { ...candidate.pool, hooks: hook } }, hookProxy.ctx))!, /使用委托代码/);
  }
});

test("a subsequent check rereads code instead of reusing an earlier admission", async () => {
  const { ctx } = setup();
  let reads = 0;
  ctx.client = { getCode: async () => ++reads === 1 ? tokenCode : "0x60026000f3" } as TokenSafetyContext["client"];
  assert.equal(await tokenSafetyEligibility(candidate, ctx, 101n), null);
  assert.match((await tokenSafetyEligibility(candidate, ctx, 102n))!, /税率未知/);
  assert.equal(reads, 2);
});
