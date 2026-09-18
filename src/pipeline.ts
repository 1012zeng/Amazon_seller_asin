import { detailCommand, enrichCommand, exportCommand, filterCommand, initializeRun, openRun, prefilterCommand, sales7dCommand, storesCommand, type NewRunOptions } from "./app.js";
import type { StageName } from "./shared/types.js";
export interface PipelineOptions extends NewRunOptions { resumeRunId?: string }
export interface PipelineCommands {
  initialize: (options: NewRunOptions) => Promise<string>;
  stores: (runId: string) => Promise<number>;
  prefilter: (runId: string) => Promise<number>;
  enrich: (runId: string) => Promise<number>;
  filter: (runId: string) => Promise<number>;
  sales7d: (runId: string) => Promise<number>;
  detail: (runId: string) => Promise<number>;
  export: (runId: string) => Promise<number>;
  stageStatus: (runId: string, stage: StageName) => string;
}
const defaults: PipelineCommands = {
  initialize: initializeRun, stores: storesCommand, prefilter: prefilterCommand, enrich: enrichCommand,
  filter: filterCommand, sales7d: sales7dCommand, detail: detailCommand, export: exportCommand,
  stageStatus: (id, stage) => { const store = openRun(id); try { return store.source.stageStatus(stage); } finally { store.close(); } },
};
export async function pipelineCommand(options: PipelineOptions, commands: PipelineCommands = defaults): Promise<number> {
  if (options.resumeRunId && (options.configPath !== undefined || options.inputPath !== undefined || options.limit !== undefined)) throw new Error("续跑不能同时指定 --config、--input 或 --limit");
  const runId = options.resumeRunId ?? await commands.initialize(options);
  let partial = false;
  const stages = [
    ["stores", commands.stores], ["prefilter", commands.prefilter], ["enrich", commands.enrich],
    ["filter", commands.filter], ["sales_7d", commands.sales7d], ["detail", commands.detail], ["export", commands.export],
  ] as const;
  for (const [name, stage] of stages) {
    const status = commands.stageStatus(runId, name);
    if (status === "completed") continue;
    const code = await stage(runId);
    if (code !== 0) {
      if (code === 2 && (name === "stores" || name === "export")) partial = true;
      else return code;
    }
  }
  console.log(`${partial ? "pipeline_partial" : "pipeline_completed"} run_id=${runId}`);
  return partial ? 2 : 0;
}
