import { z } from "zod";
import { parseEther, parseGwei, type Address, type Hex } from "viem";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  readSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
const decimalPattern = /^\d{1,78}(\.\d{1,18})?$/;
const gasPattern = /^\d{1,78}(\.\d{1,9})?$/;
const decimal = z.string().max(97).regex(decimalPattern);
const gasDecimal = z.string().max(88).regex(gasPattern);
const url = z.string().max(2048).url();
const uint256Max = 2n ** 256n - 1n;
const blockNumber = z
  .string()
  .max(20)
  .regex(/^\d+$/)
  .refine((value) => {
    return /^\d{1,20}$/.test(value) && BigInt(value) <= 2n ** 64n - 1n;
  });
function protocolAllowed(value: string, protocols: string[]) {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const configSchema = z
  .object({
    discoverySource: z.enum(["api", "chain"]).default("api"),
    // Accept older files, but load/save always migrate the retired simulation setting to off.
    taxCheck: z.enum(["simulate", "off"]).default("off"),
    rpcHttpUrls: z
      .array(url.refine((x) => protocolAllowed(x, ["http:", "https:"])))
      .max(5)
      .default(["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"]),
    rpcWsUrls: z
      .array(url.refine((x) => protocolAllowed(x, ["ws:", "wss:"])))
      .max(3)
      .default(["wss://ethereum-rpc.publicnode.com", "wss://eth.drpc.org"]),
    buyAmountEth: decimal.default("0.01"),
    maxFeeGwei: gasDecimal.default("30"),
    priorityFeeGwei: gasDecimal.default("2"),
    feeStrategy: z.enum(["fixed", "competitive"]).default("competitive"),
    maxGasEth: decimal.default("0.005"),
    slippageBps: z.number().int().min(0).max(5000).default(300),
    maxBuyTaxBps: z.number().int().min(0).max(5000).default(0),
    maxSellTaxBps: z.number().int().min(0).max(5000).default(0),
    unknownTaxPolicy: z.literal("reject").default("reject"),
    allowedKinds: z
      .array(z.enum(["evm_project", "custom_token", "univ4_hook"]))
      .min(1)
      .max(3)
      .refine((items) => new Set(items).size === items.length)
      .default(["evm_project", "custom_token", "univ4_hook"]),
    allowedHooks: z
      .array(address)
      .max(128)
      .default(["0x0000000000000000000000000000000000000000"]),
    minLaunchNumber: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(1),
    startBlock: blockNumber.default("0"),
    minLiquidityEth: decimal.default("0"),
    deadlineSeconds: z.number().int().min(20).max(300).default(60),
    maxLaunchAgeSeconds: z.number().int().min(12).max(300).default(120),
    pollIntervalMs: z.number().int().min(1000).max(60000).default(2000),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const k of [
      "buyAmountEth",
      "maxGasEth",
      "minLiquidityEth",
      "maxFeeGwei",
      "priorityFeeGwei",
    ] as const) {
      const gas = k === "maxFeeGwei" || k === "priorityFeeGwei";
      // Refinements also run after format errors; never parse invalid / unbounded strings.
      if (!(gas ? gasPattern : decimalPattern).test(v[k])) continue;
      const amount = gas ? parseGwei(v[k]) : parseEther(v[k]);
      if (
        ["buyAmountEth", "maxGasEth", "maxFeeGwei"].includes(k) &&
        amount === 0n
      )
        ctx.addIssue({ code: "custom", path: [k], message: "必须大于 0" });
      if (amount > uint256Max)
        ctx.addIssue({ code: "custom", path: [k], message: "超过 uint256" });
      if (k === "buyAmountEth" && amount > 2n ** 128n - 1n)
        ctx.addIssue({ code: "custom", path: [k], message: "超过 uint128" });
    }
    if (
      gasPattern.test(v.priorityFeeGwei) &&
      gasPattern.test(v.maxFeeGwei) &&
      parseGwei(v.priorityFeeGwei) > parseGwei(v.maxFeeGwei)
    )
      ctx.addIssue({
        code: "custom",
        path: ["priorityFeeGwei"],
        message: "优先费不能大于最高 Gas 单价",
      });
  });
export type Config = z.infer<typeof configSchema>;
const contract = z.object({ address, codeHash: hash });
export const deploymentSchema = z
  .object({
    chainId: z.literal(1),
    verified: z.literal(true),
    verifiedSource: url,
    poolManager: contract,
    router: contract,
    quoter: contract,
    stateView: contract,
    factories: z
      .array(
        contract.extend({
          // Enables historical code search only after reviewing immutable deployment semantics.
          autoStartSafe: z.boolean().optional(),
          deploymentBlock: blockNumber
            .refine((value) => /^\d{1,20}$/.test(value) && BigInt(value) > 0n)
            .optional(),
        }),
      )
      .min(1)
      .max(128),
    registries: z.array(contract).min(1).max(128),
    deployers: z.array(address).min(1).max(128),
    // Match reviewed bytecode + hook together. Token tax is not inferred from a quote.
    taxPolicies: z
      .array(
        z.object({
          tokenCodeHash: hash,
          hookCodeHash: hash.nullable(),
          immutable: z.literal(true),
          buyTaxBps: z.number().int().min(0).max(10000),
          sellTaxBps: z.number().int().min(0).max(10000),
          source: z.string().min(10).max(4096),
        }),
      )
      .max(1024),
    relayUrl: url
      .refine((value) => protocolAllowed(value, ["https:", "http:"]))
      .default("https://relay.flashbots.net"),
  })
  .strict();
export type Deployment = z.infer<typeof deploymentSchema>;
function readJson(path: string, maximumBytes: number): unknown {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximumBytes)
      throw Error("配置必须是大小受限的普通文件");
    const buffer = Buffer.alloc(maximumBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) return JSON.parse(buffer.toString("utf8", 0, size));
      size += count;
    }
    throw Error("配置文件过大");
  } finally {
    closeSync(fd);
  }
}
export function loadDeployment(): Deployment | null {
  if (!existsSync("config/mainnet.json")) return null;
  return deploymentSchema.parse(readJson("config/mainnet.json", 262144));
}
export function loadConfig(): Config {
  return {
    ...configSchema.parse(
      existsSync("runtime/settings.json")
        ? readJson("runtime/settings.json", 32768)
        : {},
    ),
    taxCheck: "off",
  };
}
export function saveConfig(input: unknown): Config {
  const c: Config = { ...configSchema.parse(input), taxCheck: "off" };
  mkdirSync("runtime", { recursive: true, mode: 0o700 });
  const directory = lstatSync("runtime");
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o022) !== 0
  )
    throw Error("配置目录必须是不可由其他用户写入的本机目录");
  const temporary = `runtime/settings.json.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(c, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, "runtime/settings.json");
    const dirFd = openSync("runtime", "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return c;
}
export const asAddress = (s: string) => s as Address;
export const asHex = (s: string) => s as Hex;
