import { parseEther } from "viem";
import type { Candidate, AdapterContext } from "./types.js";
import { tokenSafetyEligibility } from "./token-safety.js";

/** Admission filters for the advanced chain mode with an operator-reviewed deployment. */
export async function eligibility(candidate: Candidate, ctx: AdapterContext) {
  const { config: c } = ctx;
  if (
    candidate.blockNumber < BigInt(c.startBlock) ||
    candidate.launchNumber < c.minLaunchNumber
  )
    return "上线区块或发射编号早于起点";
  const safetyRejection = await tokenSafetyEligibility(candidate, ctx);
  if (safetyRejection) return safetyRejection;
  // v4 balances are pooled across pools. getBalance(PoolManager) is NOT pool liquidity.
  if (parseEther(c.minLiquidityEth) > 0n)
    return "原生 ETH 实际池储备尚无可验证数据，无法通过最低流动性筛选";
  return null;
}
