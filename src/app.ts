import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RunStore } from "./database/run-store.js";
import { writeExcelExport } from "./export/excel.js";
import { readSellerLibrary } from "./input/seller-library.js";
import { loadConfig, projectRoot, type ConfigOverrides } from "./shared/config.js";
import { appendEvent, truncateError, writeSummary } from "./shared/utils.js";
import { runEnrichmentStage } from "./stages/enrich.js";
import { runDetailStage } from "./stages/detail.js";
import { runFilterStage } from "./stages/filter.js";
import { runPrefilterStage } from "./stages/prefilter.js";
import { runSales7dStage } from "./stages/sales-7d.js";
import { runStoreStage } from "./stages/stores.js";

function validateRunId(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`Invalid run ID: ${runId}`);
  return runId;
}
function registryPath(runId: string): string { return path.join(projectRoot, "output", "run-index", `${validateRunId(runId)}.json`); }
function independentPath(value: string): string {
  const resolved = path.resolve(value);
  const relative = path.relative(projectRoot, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("运行输出必须位于独立项目目录内");
  return resolved;
}
function registerRun(runId: string, runDir: string): void {
  const target = registryPath(runId);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ runId, runDir: path.resolve(runDir) }, null, 2)}\n`, "utf8");
}
export function resolveRunDir(runId: string): string {
  validateRunId(runId);
  const direct = path.join(projectRoot, "output", "runs", runId);
  if (existsSync(path.join(direct, "state.sqlite"))) return direct;
  const index = registryPath(runId);
  if (existsSync(index)) {
    const value = JSON.parse(readFileSync(index, "utf8")) as { runDir?: unknown };
    if (typeof value.runDir === "string" && existsSync(path.join(value.runDir, "state.sqlite"))) return independentPath(value.runDir);
  }
  throw new Error(`Run not found: ${runId}`);
}
export function openRun(runId: string, readonly = false): RunStore { return new RunStore(resolveRunDir(runId), { readonly }); }
function newRunId(): string { return `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomUUID().slice(0, 8)}`; }

export interface NewRunOptions extends ConfigOverrides { configPath?: string }
export async function inspectInput(options: NewRunOptions = {}): Promise<number> {
  const config = loadConfig(options.configPath, options);
  const input = await readSellerLibrary(config.source.path, config.source.sheet, config.source.limit);
  console.log(JSON.stringify({ source: config.source.path, sheet: config.source.sheet, sha256: input.sourceHash, stats: input.stats, firstSeller: input.sellers[0] }, null, 2));
  return 0;
}
export async function initializeRun(options: NewRunOptions = {}): Promise<string> {
  const config = loadConfig(options.configPath, options);
  independentPath(config.output.root);
  const input = await readSellerLibrary(config.source.path, config.source.sheet, config.source.limit);
  const runId = newRunId();
  const runDir = path.join(config.output.root, "runs", runId);
  const store = new RunStore(runDir);
  try {
    store.source.initializeSellers(runId, config, input);
    appendEvent(runDir, "run_initialized", { runId, sourcePath: config.source.path, sourceHash: input.sourceHash, sourceStats: input.stats });
    appendEvent(runDir, "seller_discovery_skipped", { reason: "direct_seller_input" });
    appendEvent(runDir, "history_filter_skipped", { reason: "disabled_for_seller_library", queried: false });
    writeSummary(store);
    registerRun(runId, runDir);
    console.log(`run_id=${runId}`);
    return runId;
  } finally { store.close(); }
}

async function withRun(runId: string, command: (store: RunStore) => Promise<number>): Promise<number> {
  const store = openRun(runId);
  try { return await command(store); } finally { store.close(); }
}
export async function storesCommand(runId: string): Promise<number> { return withRun(runId, runStoreStage); }
export async function prefilterCommand(runId: string): Promise<number> { return withRun(runId, runPrefilterStage); }
export async function enrichCommand(runId: string): Promise<number> { return withRun(runId, runEnrichmentStage); }
export async function filterCommand(runId: string): Promise<number> { return withRun(runId, runFilterStage); }
export async function sales7dCommand(runId: string): Promise<number> { return withRun(runId, runSales7dStage); }
export async function detailCommand(runId: string): Promise<number> { return withRun(runId, runDetailStage); }

export async function exportCommand(runId: string): Promise<number> {
  return withRun(runId, async (store) => {
    try {
      store.setStage("export", "running");
      const file = await writeExcelExport(store);
      store.setStage("export", "completed");
      const partial = store.source.isPartial() || store.stores.failedStores().length > 0;
      store.source.markExported(!partial);
      appendEvent(store.runDir, "export_completed", { file: path.basename(file), rows: store.exports.count(), partial });
      writeSummary(store);
      console.log(file);
      return partial ? 2 : 0;
    } catch (error) {
      store.setStage("export", "failed", truncateError(error));
      appendEvent(store.runDir, "export_failed", { error: truncateError(error) });
      writeSummary(store);
      return 1;
    }
  });
}

export function statusCommand(runId: string): number {
  const store = openRun(runId, true);
  try { console.log(JSON.stringify(store.summary(), null, 2)); return 0; } finally { store.close(); }
}
