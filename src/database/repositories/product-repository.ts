import type Database from "better-sqlite3";
import type { AppConfig, ProductSellerResult } from "../../shared/types.js";

function nowIso(): string { return new Date().toISOString(); }
function truncate(value: unknown): string { return (value instanceof Error ? value.message : String(value ?? "")).slice(0, 4_000); }

export interface ProductSellerTask {
  asin: string;
  sourceRow: number;
  url: string;
  attempts: number;
  inputKind: "product_link" | "seller_link_verification";
  expectedSellerId: string;
  expectedSellerName: string;
  expectedSellerProfileUrl: string;
}

export class ProductRepository {
  constructor(private readonly db: Database.Database, private readonly getConfig: () => AppConfig) {}

  private get schemaVersion(): number { return this.db.pragma("user_version", { simple: true }) as number; }

  resetInterrupted(): number {
    return this.db.prepare("UPDATE source_products SET status='retry',error='Interrupted seller discovery task was requeued',updated_at=? WHERE status='running'").run(nowIso()).changes;
  }

  next(): ProductSellerTask | null {
    const row = this.db.prepare("SELECT asin,source_row,source_url,attempts,input_kind,expected_seller_id,expected_seller_name,expected_seller_profile_url FROM source_products WHERE status IN ('pending','retry') ORDER BY source_row LIMIT 1").get() as {
      asin: string; source_row: number; source_url: string; attempts: number; input_kind: ProductSellerTask["inputKind"];
      expected_seller_id: string; expected_seller_name: string; expected_seller_profile_url: string;
    } | undefined;
    return row ? {
      asin: row.asin,
      sourceRow: row.source_row,
      url: row.source_url,
      attempts: row.attempts,
      inputKind: row.input_kind,
      expectedSellerId: row.expected_seller_id,
      expectedSellerName: row.expected_seller_name,
      expectedSellerProfileUrl: row.expected_seller_profile_url,
    } : null;
  }

  begin(asin: string): void {
    const changed = this.db.prepare("UPDATE source_products SET status='running',attempts=attempts+1,error='',updated_at=? WHERE asin=? AND status IN ('pending','retry')").run(nowIso(), asin).changes;
    if (changed !== 1) throw new Error(`Source product is not pending: ${asin}`);
  }

  complete(task: ProductSellerTask, result: ProductSellerResult): { newStore: boolean; sellerMatch: boolean | null } {
    if (result.kind !== "success" || result.asin !== task.asin || !result.sellerId) throw new Error("Product seller result identity mismatch");
    const now = nowIso();
    return this.db.transaction(() => {
      const sellerMatch = task.expectedSellerId ? task.expectedSellerId === result.sellerId : null;
      const identityStatus = sellerMatch === null ? "not_provided" : sellerMatch ? "matched" : "mismatched";
      const updated = this.db.prepare(`UPDATE source_products SET status='success',seller_id=?,seller_name=?,seller_profile_url=?,store_url=?,http_status=?,response_bytes=?,fetch_ms=?,endpoint_port=?,seller_match=?,error='',updated_at=?,completed_at=? WHERE asin=? AND status='running'`)
        .run(result.sellerId, result.sellerName, result.sellerProfileUrl, result.storeUrl, result.httpStatus, result.responseBytes, result.fetchMs, result.endpointPort, sellerMatch === null ? null : sellerMatch ? 1 : 0, now, now, task.asin);
      if (updated.changes !== 1) throw new Error(`Source product is not running: ${task.asin}`);
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO source_stores(seller_id,source_row,source_name,source_profile_url,store_url,verified_source_asin,input_seller_id,identity_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(result.sellerId, task.sourceRow, result.sellerName || result.sellerId, result.sellerProfileUrl, result.storeUrl, task.asin, task.expectedSellerId, identityStatus, now, now);
      this.db.prepare("INSERT OR IGNORE INTO store_pages(seller_id,crawl_round,page,url,created_at,updated_at) VALUES(?,1,1,?,?,?)")
        .run(result.sellerId, result.storeUrl, now, now);
      return { newStore: inserted.changes === 1, sellerMatch };
    })();
  }

  fail(task: ProductSellerTask, result: ProductSellerResult | undefined, error: unknown): "retry" | "failed" | "unavailable" {
    const config = this.getConfig();
    const row = this.db.prepare("SELECT attempts FROM source_products WHERE asin=? AND status='running'").get(task.asin) as { attempts: number } | undefined;
    if (!row) throw new Error(`Source product is not running: ${task.asin}`);
    const terminalUnavailable = result?.kind === "unavailable";
    const status = terminalUnavailable ? "unavailable" : row.attempts >= config.stores.maxRetries ? "failed" : "retry";
    const now = nowIso();
    this.db.prepare(`UPDATE source_products SET status=?,http_status=COALESCE(?,http_status),response_bytes=COALESCE(?,response_bytes),fetch_ms=COALESCE(?,fetch_ms),endpoint_port=COALESCE(?,endpoint_port),error=?,updated_at=?,completed_at=? WHERE asin=?`)
      .run(status, result?.httpStatus || null, result?.responseBytes ?? null, result?.fetchMs ?? null, result?.endpointPort || null, truncate(error), now, status === "retry" ? "" : now, task.asin);
    return status;
  }

  isTerminal(): boolean {
    return !this.db.prepare("SELECT 1 FROM source_products WHERE status IN ('pending','retry','running') LIMIT 1").get();
  }

  counts(): Record<string, number> {
    if (this.schemaVersion < 8) return {};
    const rows = this.db.prepare("SELECT status,COUNT(*) count FROM source_products GROUP BY status ORDER BY status").all() as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  failed(): Array<Record<string, unknown>> {
    if (this.schemaVersion < 8) return [];
    if (this.schemaVersion >= 12) return this.db.prepare("SELECT asin,source_row,source_url,input_kind,expected_seller_id,status,attempts,error FROM source_products WHERE status IN ('failed','unavailable') ORDER BY source_row").all() as Array<Record<string, unknown>>;
    return this.db.prepare("SELECT asin,source_row,source_url,status,attempts,error FROM source_products WHERE status IN ('failed','unavailable') ORDER BY source_row").all() as Array<Record<string, unknown>>;
  }

  identitySummary(): Record<string, number> {
    if (this.schemaVersion < 12) return {};
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN input_kind='seller_link_verification' THEN 1 ELSE 0 END) candidate_verifications,
      SUM(CASE WHEN seller_match=1 THEN 1 ELSE 0 END) matched,
      SUM(CASE WHEN seller_match=0 THEN 1 ELSE 0 END) mismatched,
      SUM(CASE WHEN input_kind='seller_link_verification' AND seller_match IS NULL THEN 1 ELSE 0 END) unresolved
      FROM source_products`).get() as { candidate_verifications: number | null; matched: number | null; mismatched: number | null; unresolved: number | null };
    return {
      candidateVerifications: row.candidate_verifications ?? 0,
      matched: row.matched ?? 0,
      mismatched: row.mismatched ?? 0,
      unresolved: row.unresolved ?? 0,
    };
  }

  storeCount(): number {
    return (this.db.prepare("SELECT COUNT(*) count FROM source_stores").get() as { count: number }).count;
  }
}
