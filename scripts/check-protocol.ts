import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { checkApiProtocolCompatibility } from "../src/protocol-compatibility.js";

// This command never loads a wallet, imports the trading engine, or sends an RPC transaction.
export async function main(args: string[]) {
  if (args.length > 1 || (args[0] !== undefined && !["1", "11155111"].includes(args[0])))
    throw Error("Usage: tsx scripts/check-protocol.ts [1|11155111]");
  const report = await checkApiProtocolCompatibility({
    chainId: args[0] === "11155111" ? 11155111 : 1,
    allowedKinds: ["evm_project", "custom_token", "univ4_hook"],
  });
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch { console.error("协议检查失败；用法：tsx scripts/check-protocol.ts [1|11155111]"); process.exitCode = 1; }
}
