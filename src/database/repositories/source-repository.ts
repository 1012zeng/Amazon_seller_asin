import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { AppConfig, ProductSeed, SourceInputStats, StageName, StageStatus, StoreRuntimeMetrics } from "../../shared/types.js";
import { STAGES } from "../../shared/types.js";
import { SCHEMA_VERSION } from "../run-database.js";
import { codeFingerprint, effectiveConfigHash, releaseInfo, runContractHash, WORKFLOW } from "../../shared/provenance.js";
import type { SellerLibraryInput } from "../../input/seller-library.js";

function nowIso(): string { return new Date().toISOString(); }

export class SourceRepository {
  constructor(private readonly db: Database.Database) {}

  initialize(runId: string, config: AppConfig, sourceHash: string, productSeeds: ProductSeed[], stats: SourceInputStats, startedAt = nowIso()): void {
    const asOfDate = startedAt.slice(0, 10);
    const fingerprint = codeFingerprint();
    const contractHash = runContractHash(config, sourceHash, asOfDate, fingerprint);
    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM run_meta").get()) throw new Error("Run database is already initialized");
      this.db.prepare(`INSERT INTO run_meta(singleton,run_id,status,current_stage,config_path,config_hash,config_json,contract_hash,source_path,source_hash,source_sheet,source_stats_json,run_started_at,as_of_date,created_at,updated_at,workflow,code_fingerprint,effective_config_hash,release_json)
        VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, "running", "import", config.configPath, config.configHash, JSON.stringify(config), contractHash, config.source.path, sourceHash, config.source.sheet, JSON.stringify(stats), startedAt, asOfDate, startedAt, startedAt, WORKFLOW, fingerprint, effectiveConfigHash(config), JSON.stringify(releaseInfo()));
      const stage = this.db.prepare("INSERT INTO run_stages(stage,status,started_at,completed_at,updated_at) VALUES(?,?,?,?,?)");
      for (const name of STAGES) stage.run(name, name === "import" ? "completed" : "pending", name === "import" ? startedAt : "", name === "import" ? startedAt : "", startedAt);
      const insertProduct = this.db.prepare(`INSERT INTO source_products(asin,source_row,source_url,input_kind,expected_seller_id,expected_seller_name,expected_seller_profile_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`);
      for (const seed of productSeeds) {
        insertProduct.run(
          seed.asin,
          seed.sourceRow,
          seed.sourceUrl,
          seed.inputKind ?? "product_link",
          seed.expectedSellerId ?? "",
          seed.expectedSellerName ?? "",
          seed.expectedSellerProfileUrl ?? "",
          startedAt,
          startedAt,
        );
      }
    })();
  }

  initializeSellers(runId: string, config: AppConfig, input: SellerLibraryInput, startedAt = nowIso()): void {
    this.db.transaction(() => {
      this.initialize(runId, config, input.sourceHash, [], input.stats, startedAt);
      const insertRow = this.db.prepare("INSERT INTO source_seller_inputs(source_row,raw_name,raw_link,seller_id,status,first_source_row,selected) VALUES(?,?,?,?,?,?,?)");
      for (const row of input.rows) insertRow.run(row.sourceRow, row.rawName, row.rawLink, row.sellerId, row.status, row.firstSourceRow, row.selected ? 1 : 0);
      const insertStore = this.db.prepare(`INSERT INTO source_stores(seller_id,source_row,source_name,source_profile_url,store_url,verified_source_asin,input_seller_id,identity_status,created_at,updated_at) VALUES(?,?,?,?,?,'',?,'direct_input',?,?)`);
      const insertPage = this.db.prepare("INSERT INTO store_pages(seller_id,crawl_round,page,url,created_at,updated_at) VALUES(?,1,1,?,?,?)");
      for (const seller of input.sellers) {
        insertStore.run(seller.sellerId, seller.sourceRow, seller.sourceName, seller.profileUrl, seller.storeUrl, seller.sellerId, startedAt, startedAt);
        insertPage.run(seller.sellerId, seller.storeUrl, startedAt, startedAt);
      }
      this.setStage("seller_discovery", "skipped", "直接卖家输入，无需产品核验");
      this.setStage("history_filter", "skipped", "本流程禁用历史数据库");
    })();
  }

  getRunId(): string {
    const row = this.db.prepare("SELECT run_id FROM run_meta WHERE singleton=1").get() as { run_id: string } | undefined;
    if (!row) throw new Error("Run metadata is missing");
    return row.run_id;
  }

  getConfig(): AppConfig {
    const row = this.db.prepare("SELECT config_json FROM run_meta WHERE singleton=1").get() as { config_json: string } | undefined;
    if (!row) throw new Error("Run metadata is missing");
    return JSON.parse(row.config_json) as AppConfig;
  }

  getMeta(): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM run_meta WHERE singleton=1").get() as Record<string, unknown> | undefined;
    if (!row) throw new Error("Run metadata is missing");
    return row;
  }

  setStage(stage: StageName, status: StageStatus, error = ""): void {
    const now = nowIso();
    const completed = ["completed", "partial", "failed", "skipped"].includes(status) ? now : "";
    this.db.transaction(() => {
      this.db.prepare(`UPDATE run_stages SET status=?,error=?,started_at=CASE WHEN started_at='' AND ?='running' THEN ? ELSE started_at END,completed_at=CASE WHEN ?<>'' THEN ? ELSE completed_at END,updated_at=? WHERE stage=?`)
        .run(status, error.slice(0, 4_000), status, now, completed, completed, now, stage);
      this.db.prepare("UPDATE run_meta SET current_stage=?,status=?,updated_at=? WHERE singleton=1")
        .run(stage, status === "failed" ? "failed" : status === "paused" ? "paused" : "running", now);
    })();
  }

  stageStatus(stage: StageName): string {
    return (this.db.prepare("SELECT status FROM run_stages WHERE stage=?").get(stage) as { status: string }).status;
  }

  sealStoreSnapshot(): void {
    const now = nowIso();
    this.db.prepare("UPDATE run_meta SET store_snapshot_sealed_at=CASE WHEN store_snapshot_sealed_at='' THEN ? ELSE store_snapshot_sealed_at END,updated_at=? WHERE singleton=1").run(now, now);
  }

  isStoreSnapshotSealed(): boolean {
    const row = this.db.prepare("SELECT store_snapshot_sealed_at FROM run_meta WHERE singleton=1").get() as { store_snapshot_sealed_at: string };
    return row.store_snapshot_sealed_at !== "";
  }

  setPartial(partial: boolean): void {
    this.db.prepare("UPDATE run_meta SET partial=CASE WHEN partial=1 OR ?=1 THEN 1 ELSE 0 END,updated_at=? WHERE singleton=1").run(partial ? 1 : 0, nowIso());
  }

  isPartial(): boolean {
    return Boolean((this.db.prepare("SELECT partial FROM run_meta WHERE singleton=1").get() as { partial: number }).partial);
  }

  setSellerDiscoveryRuntimeMetrics(metrics: StoreRuntimeMetrics): void {
    this.db.prepare("UPDATE run_meta SET seller_discovery_runtime_json=?,updated_at=? WHERE singleton=1").run(JSON.stringify(metrics), nowIso());
  }

  setStoreRuntimeMetrics(metrics: StoreRuntimeMetrics): void {
    this.db.prepare("UPDATE run_meta SET store_runtime_json=?,updated_at=? WHERE singleton=1").run(JSON.stringify(metrics), nowIso());
  }

  markExported(complete: boolean): void {
    const now = nowIso();
    this.db.prepare("UPDATE run_meta SET status=?,complete=?,partial=?,updated_at=? WHERE singleton=1").run(complete ? "completed" : "partial", complete ? 1 : 0, complete ? 0 : 1, now);
  }
}
