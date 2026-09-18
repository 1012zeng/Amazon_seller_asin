import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AppConfig, ProductSeed, SourceInputStats, StageName, StageStatus, StorePageParseResult } from "../shared/types.js";
import { loadConfig } from "../shared/config.js";
import { codeFingerprint, effectiveConfigHash, runContractHash, WORKFLOW } from "../shared/provenance.js";
import { RunDatabase, SCHEMA_VERSION } from "./run-database.js";
import { CandidateRepository } from "./repositories/candidate-repository.js";
import { DetailRepository } from "./repositories/detail-repository.js";
import { EnrichmentRepository } from "./repositories/enrichment-repository.js";
import { ExportRepository } from "./repositories/export-repository.js";
import { ProductRepository } from "./repositories/product-repository.js";
import { SalesRepository } from "./repositories/sales-repository.js";
import { SourceRepository } from "./repositories/source-repository.js";
import { StoreRepository } from "./repositories/store-repository.js";
import type { StoreCrawlRound, StorePageApplyResult, StorePageTask } from "./repositories/store-repository.js";

export class RunStore {
  readonly database: RunDatabase;
  readonly db;
  readonly runDir: string;
  readonly source: SourceRepository;
  readonly products: ProductRepository;
  readonly stores: StoreRepository;
  readonly candidates: CandidateRepository;
  readonly details: DetailRepository;
  readonly enrichments: EnrichmentRepository;
  readonly exports: ExportRepository;
  readonly sales: SalesRepository;

  constructor(runDir: string, options: { readonly?: boolean } = {}) {
    this.database = new RunDatabase(runDir, options);
    this.db = this.database.connection;
    this.runDir = this.database.runDir;
    this.source = new SourceRepository(this.db);
    const getConfig = (): AppConfig => this.source.getConfig();
    this.products = new ProductRepository(this.db, getConfig);
    this.stores = new StoreRepository(this.db, getConfig);
    this.candidates = new CandidateRepository(this.db, getConfig);
    this.details = new DetailRepository(this.db);
    this.enrichments = new EnrichmentRepository(this.db);
    this.exports = new ExportRepository(this.db);
    this.sales = new SalesRepository(this.db, this.exports, getConfig);
    if (!options.readonly && this.db.prepare("SELECT 1 FROM run_meta LIMIT 1").get()) {
      try { this.assertResumeContract(); } catch (error) { this.database.close(); throw error; }
    }
  }

  initialize(runId: string, config: AppConfig, sourceHash: string, productSeeds: ProductSeed[], stats: SourceInputStats, startedAt?: string): void {
    this.source.initialize(runId, config, sourceHash, productSeeds, stats, startedAt);
  }

  assertResumeContract(): void {
    const meta = this.source.getMeta() as { config_path: string; config_hash: string; source_path: string; source_hash: string; as_of_date: string; contract_hash: string; workflow: string; code_fingerprint: string; effective_config_hash: string };
    if (meta.workflow !== WORKFLOW) throw new Error("Resume refused: workflow changed; create a new run");
    const fingerprint = codeFingerprint();
    if (fingerprint !== meta.code_fingerprint) throw new Error("Resume refused: runtime code changed; create a new run");
    const saved = this.getRunConfig();
    if (effectiveConfigHash(saved) !== meta.effective_config_hash) throw new Error("Resume refused: persisted configuration changed");
    const current = loadConfig(meta.config_path, { inputPath: meta.source_path, limit: saved.source.limit });
    if (current.configHash !== meta.config_hash) throw new Error("Resume refused: static configuration hash changed");
    const sourceHash = createHash("sha256").update(readFileSync(meta.source_path)).digest("hex");
    if (sourceHash !== meta.source_hash) throw new Error("Resume refused: source Excel SHA-256 changed");
    if (effectiveConfigHash(current) !== meta.effective_config_hash) throw new Error("Resume refused: effective configuration changed");
    const contract = runContractHash(current, sourceHash, meta.as_of_date, fingerprint);
    if (contract !== meta.contract_hash) throw new Error("Resume refused: run contract changed");
  }

  getRunId(): string { return this.source.getRunId(); }
  getRunConfig(): AppConfig { return this.source.getConfig(); }
  getAsOfDate(): string { return String(this.source.getMeta().as_of_date); }
  setStage(stage: StageName, status: StageStatus, error = ""): void { this.source.setStage(stage, status, error); }
  storePageCounts(): Record<string, number> { return this.stores.pageCounts(); }
  storeStageIsTerminal(): boolean { return this.stores.isTerminal(); }
  pendingStorePages(limit: number): StorePageTask[] { return this.stores.pendingPages(limit); }
  applyStorePageSuccess(sellerId: string, crawlRound: StoreCrawlRound, page: number, result: StorePageParseResult): StorePageApplyResult { return this.stores.applySuccess(sellerId, crawlRound, page, result); }
  applyStorePageFailure(sellerId: string, crawlRound: StoreCrawlRound, page: number, kind: "blocked" | "unavailable" | "error", error: unknown, capture?: StorePageParseResult): StorePageApplyResult { return this.stores.applyFailure(sellerId, crawlRound, page, kind, error, capture); }
  close(): void { this.database.close(); }

  summary(): Record<string, unknown> {
    const meta = this.source.getMeta();
    const stages = this.db.prepare(`SELECT stage,status,error,started_at,completed_at,updated_at FROM run_stages ORDER BY CASE stage
      WHEN 'import' THEN 1 WHEN 'seller_discovery' THEN 2 WHEN 'stores' THEN 3 WHEN 'prefilter' THEN 4 WHEN 'history_filter' THEN 5 WHEN 'enrich' THEN 6 WHEN 'filter' THEN 7 WHEN 'sales_7d' THEN 8 WHEN 'detail' THEN 9 WHEN 'export' THEN 10 ELSE 99 END`).all();
    return {
      schemaVersion: this.database.schemaVersion,
      workflow: meta.workflow,
      codeFingerprint: meta.code_fingerprint,
      effectiveConfigHash: meta.effective_config_hash,
      release: JSON.parse(String(meta.release_json)),
      runId: meta.run_id,
      status: meta.status,
      currentStage: meta.current_stage,
      complete: Boolean(meta.complete),
      partial: Boolean(meta.partial),
      runStartedAt: meta.run_started_at,
      asOfDate: meta.as_of_date,
      source: { path: meta.source_path, sheet: meta.source_sheet, sha256: meta.source_hash, stats: JSON.parse(String(meta.source_stats_json)) },
      sellerDiscovery: {
        products: this.products.counts(), failed: this.products.failed(), uniqueStores: this.products.storeCount(),
        identity: this.products.identitySummary(),
        runtime: JSON.parse(String(meta.seller_discovery_runtime_json || "{}")),
      },
      storeSnapshotSealedAt: meta.store_snapshot_sealed_at,
      stages,
      stores: {
        pages: this.stores.pageCounts(), pagesByRound: this.stores.pageCountsByRound(), occurrences: this.stores.occurrenceCount(), failed: this.stores.failedStores(),
        completeness: this.stores.completenessSummary(), runtime: JSON.parse(String(meta.store_runtime_json || "{}")),
      },
      prefilter: this.candidates.prefilterReasonCounts(),
      filterReasons: Object.fromEntries((this.db.prepare("SELECT filter_reason reason,COUNT(*) count FROM asin_candidates WHERE filter_reason<>'' GROUP BY filter_reason ORDER BY filter_reason").all() as Array<{ reason: string; count: number }>).map(row => [row.reason, row.count])),
      historyFilter: { enabled: false, status: this.source.stageStatus("history_filter"), reason: "disabled_for_seller_library" },
      candidates: this.candidates.counts(),
      mcpBatches: this.enrichments.counts(),
      sales7dThresholdTaskStates: this.sales.counts(),
      dailySalesMinimumTaskCounts: this.sales.minimumCounts(),
      asinDetailTaskStates: this.details.counts(),
      cleanedProducts: this.exports.count(),
      integrity: this.database.integrityCheck(),
    };
  }
}
