import assert from "node:assert/strict";
import test from "node:test";
import { zeroAddress } from "viem";
import {
  checkApiProtocolCompatibility, protocolSources, type ProtocolLaunchKind,
} from "../src/protocol-compatibility.js";

const allKinds: ProtocolLaunchKind[] = ["evm_project", "custom_token", "univ4_hook"];
function fixture(chainId = 11155111) {
  const capabilities = {
    // Payment is on mainnet even when launches are on Sepolia.
    actions: [{ payment: { network: "eip155:1" } }],
    launches: { defaultChainId: 11155111, chains: [{
      chainId, testnet: chainId === 11155111, kinds: [...allKinds],
      pairings: [{ pairWith: "eth", currency: zeroAddress as string, kinds: [...allKinds] }],
    }] },
  };
  const policies = { count: 3, policies: allKinds.map((kind, index) => ({
    kind, version: index + 5,
    params: { kind, chainId: chainId as number | undefined, feeTiers: [500, 3000, 10000], pairedCurrencyAllowlist: [zeroAddress as string] },
  })) };
  const requests: string[] = [];
  const fetchImpl = (async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.ok(Object.values(protocolSources).includes(url as typeof protocolSources.capabilities));
    return new Response(JSON.stringify(url === protocolSources.capabilities ? capabilities : policies));
  }) as typeof fetch;
  const check = (target: 1 | 11155111 = 11155111, allowedKinds = allKinds) =>
    checkApiProtocolCompatibility({ chainId: target, allowedKinds }, { fetchImpl });
  return { capabilities, policies, requests, fetchImpl, check };
}

test("Sepolia payment on Ethereum does not advertise a mainnet launch deployment", async () => {
  const f = fixture();
  const report = await f.check(1);
  assert.equal(report.ok, false);
  assert.deepEqual(report.advertisedChainIds, [11155111]);
  assert.deepEqual(report.policies, []);
  assert.equal(report.checks.length, 4);
  assert.ok(report.checks.every((check) => !check.ok));
  assert.equal(report.missingEvidence.length, 4);
  assert.deepEqual(f.requests.sort(), Object.values(protocolSources).sort());
});

test("currently reviewed Sepolia project policies and the chain-scoped hook policy pass preflight only", async () => {
  const report = await fixture().check();
  assert.equal(report.ok, true);
  assert.deepEqual(report.policies, [
    { kind: "evm_project", version: 5 }, { kind: "custom_token", version: 6 }, { kind: "univ4_hook", version: 7 },
  ]);
  assert.deepEqual(report.missingEvidence, []);
  assert.ok(report.checks.slice(1).every((check) => check.detail.includes("实际候选仍须通过完整链上核验")));
});

test("new mainnet advertisement does not promote Sepolia guard identities", async () => {
  const report = await fixture(1).check(1, ["evm_project", "custom_token"]);
  assert.equal(report.ok, false);
  assert.equal(report.checks[0]!.ok, true);
  assert.equal(report.missingEvidence.length, 2);
  assert.ok(report.missingEvidence.every((detail) => detail.includes("代码指纹及池费用语义")));
});

test("explicit legacy mainnet policy remains possible without borrowing another chain's guard", async () => {
  const f = fixture(1);
  f.policies.policies[0]!.version = 3;
  const report = await f.check(1, ["evm_project"]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.policies, [{ kind: "evm_project", version: 3 }]);
});

test("an unscoped or wrong-kind policy cannot authorize the requested chain", async () => {
  for (const mutation of ["unscoped", "wrong-chain", "wrong-kind"] as const) {
    const f = fixture(1);
    const policy = f.policies.policies[2]!;
    if (mutation === "unscoped") delete policy.params.chainId;
    if (mutation === "wrong-chain") policy.params.chainId = 11155111;
    if (mutation === "wrong-kind") policy.params.kind = "custom_token";
    assert.equal((await f.check(1, ["univ4_hook"])).ok, false, mutation);
  }
});

test("a newer unknown project policy supersedes a reviewed old version on the same chain", async () => {
  const f = fixture();
  f.policies.policies.push({ ...f.policies.policies[0]!, version: 8 });
  f.policies.count++;
  const report = await f.check(11155111, ["evm_project"]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.policies, [{ kind: "evm_project", version: 8 }]);
});

test("a newer policy on another chain does not shadow the chain-scoped legacy policy", async () => {
  const f = fixture(1);
  f.policies.policies[0]!.version = 3;
  f.policies.policies.push({ ...f.policies.policies[0]!, version: 8,
    params: { ...f.policies.policies[0]!.params, chainId: 11155111 } });
  f.policies.count++;
  assert.equal((await f.check(1, ["evm_project"])).ok, true);
});

test("native ETH, kind advertisement, testnet designation and reviewed admission fee must agree", async () => {
  for (const mutation of ["kind", "pair-kind", "currency", "pair-label", "policy-currency", "testnet", "fee"] as const) {
    const f = fixture();
    const chain = f.capabilities.launches.chains[0]!;
    if (mutation === "kind") chain.kinds = ["univ4_hook"];
    if (mutation === "pair-kind") chain.pairings[0]!.kinds = ["univ4_hook"];
    if (mutation === "currency") chain.pairings[0]!.currency = `0x${"1".repeat(40)}`;
    if (mutation === "pair-label") chain.pairings[0]!.pairWith = "imd";
    if (mutation === "policy-currency") f.policies.policies[0]!.params.pairedCurrencyAllowlist = [`0x${"1".repeat(40)}`];
    if (mutation === "testnet") chain.testnet = false;
    if (mutation === "fee") f.policies.policies[0]!.params.feeTiers = [500];
    assert.equal((await f.check(11155111, ["evm_project"])).ok, false, mutation);
  }
});

test("incomplete counts and duplicate chain or policy identities fail closed", async () => {
  for (const mutation of ["count", "chain", "policy"] as const) {
    const f = fixture();
    if (mutation === "count") f.policies.count++;
    if (mutation === "chain") f.capabilities.launches.chains.push(f.capabilities.launches.chains[0]!);
    if (mutation === "policy") { f.policies.policies.push(f.policies.policies[0]!); f.policies.count++; }
    assert.equal((await f.check()).ok, false, mutation);
  }
});

test("unavailable, oversized and malformed official responses produce safe failed reports", async () => {
  for (const failure of ["network", "http", "oversized", "json", "schema"] as const) {
    const f = fixture();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === protocolSources.capabilities) return f.fetchImpl(input, init);
      if (failure === "network") throw Error("sensitive upstream debug detail");
      if (failure === "http") return new Response("sensitive upstream debug detail", { status: 503 });
      if (failure === "oversized") return new Response(" ".repeat(1_000_001));
      if (failure === "json") return new Response("invalid JSON");
      return new Response(JSON.stringify({ policies: [] }));
    }) as typeof fetch;
    const report = await checkApiProtocolCompatibility({ chainId: 1, allowedKinds: allKinds }, { fetchImpl });
    assert.equal(report.ok, false, failure);
    assert.equal(JSON.stringify(report).includes("sensitive upstream"), false);
    assert.ok(report.missingEvidence.length);
  }
});

test("an aborted check cannot succeed or start outbound requests", async () => {
  const f = fixture();
  const report = await checkApiProtocolCompatibility({ chainId: 11155111, allowedKinds: allKinds,
    signal: AbortSignal.abort() }, { fetchImpl: f.fetchImpl });
  assert.equal(report.ok, false);
  assert.equal(f.requests.length, 0);
});

test("invalid or empty target kinds fail before network access", async () => {
  for (const selected of [[], ["evm_project", "evm_project"], ["arbitrary-kind"]]) {
    const f = fixture();
    await assert.rejects(f.check(1, selected as ProtocolLaunchKind[]), /Invalid protocol compatibility target/);
    assert.deepEqual(f.requests, []);
  }
});
