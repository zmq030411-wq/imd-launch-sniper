type TimedBlock = { number: bigint; timestamp: bigint };

export class LaunchFreshnessError extends Error {
  constructor(readonly code: "expired" | "inconsistent" | "invalid", message: string) {
    super(message);
  }
}

/** Use both canonical chain time and the local clock: a stalled RPC is not fresh evidence. */
export function assertFreshLaunch(
  launch: TimedBlock,
  head: TimedBlock,
  maxAgeSeconds: number,
  nowMs = Date.now(),
) {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 300 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new LaunchFreshnessError("invalid", "发行时效参数或本机时钟无效");
  const now = BigInt(Math.floor(nowMs / 1000));
  if (launch.number < 0n || launch.timestamp < 0n || head.number < launch.number ||
      head.timestamp < launch.timestamp || head.timestamp > now + 15n)
    throw new LaunchFreshnessError("inconsistent", "发行区块、链头或本机时钟不一致，停止追买");
  if ((head.timestamp > now ? head.timestamp : now) >= launch.timestamp + BigInt(maxAgeSeconds))
    throw new LaunchFreshnessError("expired", `发行已达到 ${maxAgeSeconds} 秒时效上限，不追买`);
}

export function launchDeadline(launch: TimedBlock, quote: TimedBlock, maxAgeSeconds: number, quoteSeconds: number): bigint {
  const launchExpiry = launch.timestamp + BigInt(maxAgeSeconds);
  const quoteExpiry = quote.timestamp + BigInt(quoteSeconds);
  return launchExpiry < quoteExpiry ? launchExpiry : quoteExpiry;
}
