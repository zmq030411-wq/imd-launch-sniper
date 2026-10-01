import { keccak256, zeroAddress, type Hex, type PublicClient } from "viem";
import type { Config, Deployment } from "./config.js";
import type { Candidate } from "./types.js";

type ReviewedPolicies = Pick<Deployment, "taxPolicies">;
export interface TokenSafetyContext {
  client: Pick<PublicClient, "getCode">;
  config: Config;
  deployment: ReviewedPolicies;
}

export function hasReviewedTokenSafetyEvidence(
  deployment: ReviewedPolicies | null | undefined,
): boolean {
  return !!deployment?.taxPolicies.length;
}

function knownDelegatingCode(code: Hex): boolean {
  // These exact standardized runtimes delegate to code whose identity is not
  // established by hashing this wrapper. This is not a general proxy detector.
  return /^0xef0100[0-9a-f]{40}$/i.test(code) ||
    /^0x363d3d373d3d3d363d73[0-9a-f]{40}5af43d82803e903d91602b57fd5bf3$/i.test(code);
}

/**
 * Apply the advanced chain mode's operator-reviewed immutable token/Hook
 * evidence to one pinned block. This is not an API discovery prerequisite.
 * Call with the same policy snapshot at admission and again before signing.
 * `immutable` is an audit assertion about the complete token/Hook behavior,
 * including dependencies, upgrade paths and mutable tax controls. A runtime
 * hash alone cannot establish that assertion or prove future sellability.
 * It covers code and tax evidence only; chain admission also checks the launch
 * boundary and configured liquidity requirement in policy.ts.
 */
export async function tokenSafetyEligibility(
  candidate: Candidate,
  { client, config, deployment }: TokenSafetyContext,
  blockNumber: bigint = candidate.blockNumber,
): Promise<string | null> {
  if (!config.allowedKinds.some((kind) => kind === candidate.kind))
    return "发币类型不在范围内";
  if (!config.allowedHooks.some((hook) => hook.toLowerCase() === candidate.pool.hooks.toLowerCase()))
    return "Hook 不在白名单";
  if (candidate.pool.currency0.toLowerCase() !== zeroAddress ||
      candidate.pool.currency1.toLowerCase() !== candidate.token.toLowerCase())
    return "不是原生 ETH 池";
  if (!hasReviewedTokenSafetyEvidence(deployment))
    return "税率未知：没有该代币与 Hook 组合的审核证据";

  const [token, hook] = await Promise.all([
    client.getCode({ address: candidate.token, blockNumber }),
    candidate.pool.hooks.toLowerCase() === zeroAddress
      ? Promise.resolve(null)
      : client.getCode({ address: candidate.pool.hooks, blockNumber }),
  ]);
  if (!token || token === "0x") return "没有代币字节码";
  if (hook === "0x" || hook === undefined) return "Hook 字节码不可验证";
  if (knownDelegatingCode(token) || (hook !== null && knownDelegatingCode(hook)))
    return "代币或 Hook 使用委托代码，无法仅凭运行时代码匹配不可变审核证据";

  const tokenCodeHash = keccak256(token).toLowerCase();
  const hookCodeHash = hook === null ? null : keccak256(hook).toLowerCase();
  const evidence = deployment.taxPolicies.filter((policy) =>
    policy.tokenCodeHash.toLowerCase() === tokenCodeHash &&
    (policy.hookCodeHash?.toLowerCase() ?? null) === hookCodeHash,
  );
  if (!evidence.length)
    return "税率未知：没有该代币与 Hook 组合的审核证据";
  if (evidence.some((policy) => policy.immutable !== true))
    return "税率可能变化：没有不可变税率的审核证据";
  if (evidence.some((policy) =>
    !Number.isInteger(policy.buyTaxBps) || policy.buyTaxBps < 0 || policy.buyTaxBps > 10000 ||
    !Number.isInteger(policy.sellTaxBps) || policy.sellTaxBps < 0 || policy.sellTaxBps > 10000))
    return "税率审核证据无效";
  const first = evidence[0]!;
  if (evidence.some((policy) => policy.buyTaxBps !== first.buyTaxBps || policy.sellTaxBps !== first.sellTaxBps))
    return "相同代币与 Hook 组合的税率审核证据冲突";
  if (first.buyTaxBps > config.maxBuyTaxBps || first.sellTaxBps > config.maxSellTaxBps)
    return "税率超过设置";
  return null;
}
