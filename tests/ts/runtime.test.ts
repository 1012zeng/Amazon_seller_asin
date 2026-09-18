import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RunStore } from "../../src/database/run-store.js";
import { loadConfig, projectRoot } from "../../src/shared/config.js";
import { pipelineCommand, type PipelineCommands } from "../../src/pipeline.js";
import { main } from "../../src/cli.js";
import { runFixture, occurrence, pageResult } from "./helpers.js";

describe("isolated workflow and resume contracts", () => {
  it("reopens compatible runs with a frozen reference date and no historical database", () => {
    const { store } = runFixture(); const dir = store.runDir;
    expect(store.summary()).toMatchObject({ schemaVersion: 18, historyFilter: { enabled: false, status: "skipped" } });
    expect(store.db.prepare("SELECT COUNT(*) n FROM source_products").get()).toEqual({ n: 0 });
    store.close(); const reopened = new RunStore(dir);
    try { expect(reopened.getAsOfDate()).toBe("2026-08-13"); expect(reopened.database.integrityCheck()).toBe("ok"); } finally { reopened.close(); }
    expect(existsSync(path.join(projectRoot, "src/history"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")).dependencies.mysql2).toBeUndefined();
  });
  it.each(["workflow", "code_fingerprint", "effective_config_hash", "contract_hash"])("refuses changed %s without mutating the run", field => {
    const { store } = runFixture(); const dir = store.runDir;
    store.db.prepare(`UPDATE run_meta SET ${field}='changed'`).run(); store.close();
    expect(() => new RunStore(dir)).toThrow(/Resume refused/);
    const read = new RunStore(dir, { readonly: true });
    try { expect(read.source.getMeta()[field]).toBe("changed"); } finally { read.close(); }
  });
  it.each(["source", "config"])("refuses edited %s files", kind => {
    const { store, config } = runFixture(); const dir = store.runDir; store.close();
    const file = kind === "source" ? config.source.path : config.configPath;
    writeFileSync(file, readFileSync(file, "utf8") + "\n");
    expect(() => new RunStore(dir)).toThrow(/Resume refused/);
  });
  it("refuses edits to saved effective config", () => {
    const { store, config } = runFixture(); const dir = store.runDir;
    config.filters.maxAgeDays = 720;
    store.db.prepare("UPDATE run_meta SET config_json=?").run(JSON.stringify(config)); store.close();
    expect(() => new RunStore(dir)).toThrow(/persisted configuration changed/);
  });
  it("rejects old rule knobs and changes to fixed business rules", () => {
    const { store, config } = runFixture(); store.close();
    const text = readFileSync(config.configPath, "utf8");
    writeFileSync(config.configPath, text.replace("maxAgeDays: 180", "maxAgeDays: 181"));
    expect(() => loadConfig(config.configPath)).toThrow(/Filtering rules/);
    writeFileSync(config.configPath, text.replace("maxAgeDays: 180", "maxAgeDays: 180\n  firstSalesBandMaxAgeDays: 365"));
    expect(() => loadConfig(config.configPath)).toThrow(/was removed/);
  });
  it("preserves inclusive initial price/rating and exclusive review boundaries", () => {
    const { store } = runFixture(); const sellerId = "A123456789";
    try {
      const patches = [
        { priceCents: 799, rating: 3.5, reviewCount: 299 }, { priceCents: 6000 },
        { priceCents: 798 }, { priceCents: 6001 }, { rating: 3.49 }, { reviewCount: 300 },
      ];
      store.stores.applySuccess(sellerId, 1, 1, pageResult({ occurrences: patches.map((patch, i) => occurrence(sellerId, `B00000000${i}`, { ...patch, position: i + 1 })) }));
      expect(store.candidates.prefilter()).toMatchObject({ occurrenceCount: 6, uniqueCandidates: 2 });
      expect(store.candidates.listAsinsByState("mcp_pending")).toEqual(["B000000000", "B000000001"]);
    } finally { store.close(); }
  });
});

describe("pipeline and CLI", () => {
  function commands(): PipelineCommands {
    const success = () => vi.fn(async () => 0);
    return { initialize: vi.fn(async () => "run"), stores: success(), prefilter: success(), enrich: success(), filter: success(), sales7d: success(), detail: success(), export: success(), stageStatus: () => "pending" };
  }
  it("executes the new full chain without product discovery or history", async () => {
    const c = commands(); expect(await pipelineCommand({ inputPath: "input.xlsx", limit: 1 }, c)).toBe(0);
    expect(c.initialize).toHaveBeenCalledWith({ inputPath: "input.xlsx", limit: 1 });
    for (const stage of [c.stores, c.prefilter, c.enrich, c.filter, c.sales7d, c.detail, c.export]) expect(stage).toHaveBeenCalledOnce();
  });
  it("stops after paused sales and does not detail/export pending products", async () => {
    const c = commands(); c.sales7d = vi.fn(async () => 2);
    expect(await pipelineCommand({}, c)).toBe(2); expect(c.detail).not.toHaveBeenCalled(); expect(c.export).not.toHaveBeenCalled();
  });
  it("skips completed stages while resuming and propagates partial store output", async () => {
    const c = commands(); c.stageStatus = (_id, stage) => ["stores", "prefilter", "enrich", "filter"].includes(stage) ? "completed" : "paused";
    expect(await pipelineCommand({ resumeRunId: "run" }, c)).toBe(0); expect(c.initialize).not.toHaveBeenCalled(); expect(c.stores).not.toHaveBeenCalled();
    const partial = commands(); partial.stores = vi.fn(async () => 2); expect(await pipelineCommand({}, partial)).toBe(2);
  });
  it.each([["--config", "other.yaml"], ["--input", "other.xlsx"], ["--limit", "1"]])("rejects resume combined with %s", async (flag, value) => {
    await expect(main(["pipeline", "--resume", "run", flag!, value!])).rejects.toThrow("续跑不能同时指定");
  });
  it.each([["pipeline", "--limt", "1"], ["inspect-input", "--limit", "-1"], ["pipeline", "--limit", "1", "--limit", "2"], ["history-filter", "--run", "run"]])("rejects invalid CLI options: %s", async (...args) => {
    await expect(main(args)).rejects.toThrow();
  });
});
