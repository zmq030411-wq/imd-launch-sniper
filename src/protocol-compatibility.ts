import { z } from "zod";
import { zeroAddress } from "viem";
import { readBoundedJson } from "./bounded-json.js";
import { reviewedProjectDeployments } from "./protocol-version.js";

export const protocolSources = Object.freeze({
  capabilities: "https://api.imd.fun/requests/capabilities",
  policies: "https://api.imd.fun/launch/policies",
});
const launchKinds = ["evm_project", "custom_token", "univ4_hook"] as const;
export type ProtocolLaunchKind = typeof launchKinds[number];
export type ProtocolCompatibilityOptions = {
  chainId: 1 | 11155111;
  allowedKinds: readonly ProtocolLaunchKind[];
  signal?: AbortSignal;
};
export type ProtocolCompatibilityReport = {
  ok: boolean;
  checkedAt: string;
  chainId: 1 | 11155111;
  sources: typeof protocolSources;
  advertisedChainIds: number[];
  policies: Array<{ kind: ProtocolLaunchKind; version: number }>;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  missingEvidence: string[];
};

const identifier = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const label = z.string().min(1).max(128);
const kinds = z.array(label).min(1).max(32);
const capabilitiesSchema = z.object({
  launches: z.object({
    chains: z.array(z.object({
      chainId: identifier,
      testnet: z.boolean(),
      kinds,
      pairings: z.array(z.object({
        pairWith: label,
        currency: z.string().regex(/^0x[\da-fA-F]{40}$/),
        kinds,
      })).max(32),
    })).max(64),
  }),
});
const policiesSchema = z.object({
  count: z.number().int().min(0).max(256),
  policies: z.array(z.object({
    version: identifier,
    kind: label,
    params: z.object({
      kind: label,
      // Never infer the launch chain from IMD payment.network or an old unscoped policy.
      chainId: identifier.optional(),
      feeTiers: z.array(z.number().int().min(0).max(0xffffff)).max(32),
      pairedCurrencyAllowlist: z.array(z.string().regex(/^0x[\da-fA-F]{40}$/)).max(32),
    }),
  })).max(256),
});

/** Read-only readiness evidence. Success never replaces per-launch receipt/code checks. */
export async function checkApiProtocolCompatibility(
  options: ProtocolCompatibilityOptions,
  dependencies: { fetchImpl?: typeof fetch } = {},
): Promise<ProtocolCompatibilityReport> {
  const { chainId } = options;
  if (![1, 11155111].includes(chainId) || !options.allowedKinds.length ||
      options.allowedKinds.length > launchKinds.length || new Set(options.allowedKinds).size !== options.allowedKinds.length ||
      options.allowedKinds.some((kind) => !launchKinds.includes(kind)))
    throw Error("Invalid protocol compatibility target");
  const selectedKinds = [...options.allowedKinds];
  const report: ProtocolCompatibilityReport = {
    ok: false, checkedAt: new Date().toISOString(), chainId, sources: protocolSources,
    advertisedChainIds: [], policies: [], checks: [], missingEvidence: [],
  };
  const add = (name: string, ok: boolean, detail: string) => {
    report.checks.push({ name, ok, detail });
    if (!ok) report.missingEvidence.push(detail);
  };
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const read = async (url: string) => {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000);
    signal.throwIfAborted();
    const response = await fetchImpl(url, { signal, redirect: "error", headers: { accept: "application/json" } });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw Error("Official compatibility source unavailable");
    }
    return readBoundedJson(response, 1_000_000, signal);
  };
  const results = await Promise.allSettled([
    read(protocolSources.capabilities), read(protocolSources.policies),
  ]);
  if (options.signal?.aborted) {
    add("协议检查", false, "协议兼容检查已取消，未建立可交易的网络证据");
    return report;
  }
  const capabilities = results[0].status === "fulfilled"
    ? capabilitiesSchema.safeParse(results[0].value) : null;
  const policies = results[1].status === "fulfilled"
    ? policiesSchema.safeParse(results[1].value) : null;
  if (!capabilities?.success || new Set(capabilities.data.launches.chains.map((chain) => chain.chainId)).size !== capabilities.data.launches.chains.length)
    add("官方发射网络", false, "官方发射网络资料不可用、重复或格式不完整；不能用主网付款信息推断发射网络");
  if (!policies?.success || policies.data.count !== policies.data.policies.length ||
      new Set(policies.data.policies.map((policy) => `${policy.params.chainId}:${policy.kind}:${policy.version}`)).size !== policies.data.policies.length)
    add("官方发射政策", false, "官方发射政策不可用、重复或列表不完整，无法确认目标链的政策版本");
  if (report.checks.length) return report;
  const chains = capabilities!.data!.launches.chains;
  const entries = policies!.data!.policies;
  report.advertisedChainIds = chains.map((chain) => chain.chainId).sort((a, b) => a - b);
  const target = chains.find((chain) => chain.chainId === chainId);
  add("官方发射网络", !!target && target.testnet === (chainId === 11155111), target
    ? `官方列出发射链 ${chainId}，测试网标记${target.testnet === (chainId === 11155111) ? "一致" : "不一致"}`
    : `官方未公布目标链 ${chainId} 的发射支持；当前公布的发射链：${report.advertisedChainIds.join("、") || "无"}`);
  for (const kind of selectedKinds) {
    const nativePair = target?.pairings.some((pair) => pair.pairWith === "eth" &&
      pair.currency.toLowerCase() === zeroAddress && pair.kinds.includes(kind));
    const candidates = entries.filter((policy) => policy.kind === kind &&
      policy.params.kind === kind && policy.params.chainId === chainId).sort((a, b) => b.version - a.version);
    const policy = candidates[0];
    if (policy) report.policies.push({ kind, version: policy.version });
    const policyNativePair = policy?.params.pairedCurrencyAllowlist.some((currency) => currency.toLowerCase() === zeroAddress);
    if (!target?.kinds.includes(kind) || !nativePair || !policy || !policyNativePair) {
      add(`协议 ${kind}`, false, `目标链 ${chainId} 的 ${kind} 缺少明确的原生 ETH 发射能力或带链 ID 的政策证据`);
      continue;
    }
    // The existing resolver permits legacy projects; do not promote a Sepolia guard to mainnet.
    if (kind !== "univ4_hook" && policy.version >= 5) {
      const reviewed = reviewedProjectDeployments(chainId).find((deployment) =>
        deployment.policyVersions.includes(policy.version) && policy.params.feeTiers.includes(deployment.admissionFee));
      if (!reviewed) {
        add(`协议 ${kind}`, false, `目标链 ${chainId} 的 ${kind} 政策 ${policy.version} 尚无已核验的工厂、登记合约和初始化守卫地址、代码指纹及池费用语义`);
        continue;
      }
    }
    add(`协议 ${kind}`, true, `目标链 ${chainId} 已公布 ${kind} 政策 ${policy.version}；实际候选仍须通过完整链上核验`);
  }
  report.ok = report.checks.every((check) => check.ok);
  return report;
}
