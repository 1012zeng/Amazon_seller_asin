import { pathToFileURL } from "node:url";
import { detailCommand, enrichCommand, exportCommand, filterCommand, inspectInput, prefilterCommand, sales7dCommand, statusCommand, storesCommand, type NewRunOptions } from "./app.js";
import { pipelineCommand } from "./pipeline.js";
const usage = "命令：inspect-input、pipeline、stores、prefilter、enrich、filter、sales-7d、detail、export、status";
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  if (command === "--help" || command === "help") { console.log(usage); return 0; }
  const options = new Map<string, string>();
  const allowed = command === "pipeline" ? ["--input", "--config", "--limit", "--resume"] : command === "inspect-input" ? ["--input", "--config", "--limit"] : ["--run"];
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!; const value = args[i + 1];
    if (!allowed.includes(name) || options.has(name) || !value || value.startsWith("--")) throw new Error(`参数无效或重复：${name}`);
    options.set(name, value);
  }
  const fresh: NewRunOptions = {};
  if (options.has("--input")) fresh.inputPath = options.get("--input")!;
  if (options.has("--config")) fresh.configPath = options.get("--config")!;
  if (options.has("--limit")) {
    if (!/^\d+$/.test(options.get("--limit")!) || !Number.isSafeInteger(Number(options.get("--limit")))) throw new Error("--limit 必须是非负整数");
    fresh.limit = Number(options.get("--limit"));
  }
  if (command === "inspect-input") return inspectInput(fresh);
  if (command === "pipeline") return pipelineCommand(options.has("--resume") ? { ...fresh, resumeRunId: options.get("--resume")! } : fresh);
  const stages: Record<string, (id: string) => number | Promise<number>> = {
    stores: storesCommand, prefilter: prefilterCommand, enrich: enrichCommand, filter: filterCommand,
    "sales-7d": sales7dCommand, detail: detailCommand, export: exportCommand, status: statusCommand,
  };
  if (!command || !stages[command]) throw new Error(usage);
  const runId = options.get("--run");
  if (!runId) throw new Error("该命令需要 --run <运行ID>");
  return stages[command](runId);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  });
}
