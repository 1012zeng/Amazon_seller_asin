import type Database from "better-sqlite3";
import type { CompetitorLookupResult } from "../../shared/types.js";

function nowIso(): string { return new Date().toISOString(); }

export interface McpBatchTask { round: 1 | 2; ordinal: number; asins: string[] }

export class EnrichmentRepository {
  constructor(private readonly db: Database.Database) {}

  hasRound(round: 1 | 2): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM mcp_batches WHERE round=? LIMIT 1").get(round));
  }

  materialize(round: 1 | 2, asins: string[], batchSize: number): void {
    this.db.transaction(() => {
      if (this.hasRound(round)) return;
      const now = nowIso();
      const addBatch = this.db.prepare("INSERT INTO mcp_batches(round,batch_ordinal,created_at,updated_at) VALUES(?,?,?,?)");
      const addItem = this.db.prepare("INSERT INTO mcp_batch_items(round,batch_ordinal,item_ordinal,asin) VALUES(?,?,?,?)");
      for (let offset = 0, ordinal = 1; offset < asins.length; offset += batchSize, ordinal += 1) {
        addBatch.run(round, ordinal, now, now);
        asins.slice(offset, offset + batchSize).forEach((asin, index) => addItem.run(round, ordinal, index + 1, asin));
      }
    })();
  }

  nextBatch(round: 1 | 2): McpBatchTask | null {
    const row = this.db.prepare("SELECT batch_ordinal FROM mcp_batches WHERE round=? AND state IN ('pending','failed','running') ORDER BY batch_ordinal LIMIT 1").get(round) as { batch_ordinal: number } | undefined;
    if (!row) return null;
    const asins = (this.db.prepare("SELECT asin FROM mcp_batch_items WHERE round=? AND batch_ordinal=? ORDER BY item_ordinal").all(round, row.batch_ordinal) as Array<{ asin: string }>).map((item) => item.asin);
    return { round, ordinal: row.batch_ordinal, asins };
  }

  beginBatch(task: McpBatchTask): void {
    this.db.prepare("UPDATE mcp_batches SET state='running',attempt_count=attempt_count+1,last_error='',updated_at=? WHERE round=? AND batch_ordinal=?").run(nowIso(), task.round, task.ordinal);
  }

  failBatch(task: McpBatchTask, error: unknown): void {
    const message = (error instanceof Error ? error.message : String(error ?? "")).slice(0, 4_000);
    this.db.prepare("UPDATE mcp_batches SET state='failed',last_error=?,updated_at=? WHERE round=? AND batch_ordinal=?").run(message, nowIso(), task.round, task.ordinal);
  }

  commitBatch(task: McpBatchTask, result: CompetitorLookupResult): number {
    if (result.items.some((item) => item.status === "upstream_error")) throw new Error("Cannot business-commit a lookup response containing upstream_error");
    return this.db.transaction(() => {
      const now = nowIso();
      const updateItem = this.db.prepare("UPDATE mcp_batch_items SET status=?,error_code=?,error_message=? WHERE round=? AND batch_ordinal=? AND item_ordinal=? AND asin=?");
      const upsert = this.db.prepare(`INSERT INTO enrichments(asin,title,node_label_path,brand,brand_url,image_url,bsr_rank,child_sales_30d,available_date,fulfillment,variation_count,buybox_seller_id,buybox_seller_name,enriched_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(asin) DO UPDATE SET title=excluded.title,node_label_path=excluded.node_label_path,brand=excluded.brand,brand_url=excluded.brand_url,image_url=excluded.image_url,bsr_rank=excluded.bsr_rank,child_sales_30d=excluded.child_sales_30d,available_date=excluded.available_date,fulfillment=excluded.fulfillment,variation_count=excluded.variation_count,buybox_seller_id=excluded.buybox_seller_id,buybox_seller_name=excluded.buybox_seller_name,enriched_at=excluded.enriched_at`);
      const auditEnrichment = this.db.prepare(`UPDATE asin_candidates SET enriched_image_url=?,title=?,category=?,brand=?,brand_url=?,bsr_rank=?,child_sales_30d=?,available_date=?,fulfillment=?,variation_count=?,buybox_seller_id=?,buybox_seller_name=? WHERE asin=?`);
      result.items.forEach((item, index) => {
        updateItem.run(item.status, item.errorCode, item.errorMessage, task.round, task.ordinal, index + 1, item.asin);
        if (item.status === "ok") {
          upsert.run(item.asin, item.title, item.nodeLabelPath, item.brand, item.brandUrl, item.imageUrl, item.bsrRank, item.childSales30d, item.availableDate, item.fulfillment, item.variationCount, item.buyboxSellerId, item.buyboxSellerName, now);
          auditEnrichment.run(item.imageUrl, item.title, item.nodeLabelPath, item.brand, item.brandUrl, item.bsrRank, item.childSales30d, item.availableDate, item.fulfillment, item.variationCount, item.buyboxSellerId, item.buyboxSellerName, item.asin);
          this.db.prepare("UPDATE asin_candidates SET state='mcp_ok',filter_stage='',filter_reason='',updated_at=? WHERE asin=?").run(now, item.asin);
        } else {
          const state = task.round === 1 ? "round1_not_found" : "mcp_unavailable";
          this.db.prepare("UPDATE asin_candidates SET state=?,filter_stage='enrich',filter_reason='not_found',updated_at=? WHERE asin=?").run(state, now, item.asin);
        }
      });
      this.db.prepare("UPDATE mcp_batches SET state='completed',success_count=?,not_found_count=?,error_count=0,last_error='',completed_at=?,updated_at=? WHERE round=? AND batch_ordinal=?")
        .run(result.succeeded, result.missing, now, now, task.round, task.ordinal);
      return result.succeeded;
    })();
  }

  consecutiveEmptyRound2(): number {
    const rows = this.db.prepare("SELECT success_count FROM mcp_batches WHERE round=2 AND state='completed' ORDER BY batch_ordinal DESC").all() as Array<{ success_count: number }>;
    let count = 0;
    for (const row of rows) {
      if (row.success_count !== 0) break;
      count += 1;
    }
    return count;
  }

  stopRemainingRound2(reason: string): number {
    return this.db.transaction(() => {
      const now = nowIso();
      const asins = this.db.prepare("SELECT i.asin FROM mcp_batch_items i JOIN mcp_batches b USING(round,batch_ordinal) WHERE i.round=2 AND b.state IN ('pending','failed')").all() as Array<{ asin: string }>;
      this.db.prepare("UPDATE mcp_batch_items SET status='skipped',error_code=?,error_message=? WHERE round=2 AND status='pending'").run(reason, reason);
      this.db.prepare("UPDATE mcp_batches SET state='skipped',stop_reason=?,completed_at=?,updated_at=? WHERE round=2 AND state IN ('pending','failed')").run(reason, now, now);
      const update = this.db.prepare("UPDATE asin_candidates SET state='mcp_unavailable',filter_stage='enrich',filter_reason=?,updated_at=? WHERE asin=?");
      for (const row of asins) update.run(reason, now, row.asin);
      return asins.length;
    })();
  }

  isTerminal(): boolean {
    return !(this.db.prepare("SELECT 1 FROM mcp_batches WHERE state IN ('pending','running','failed') LIMIT 1").get());
  }

  counts(): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT round,state,COUNT(*) count,COALESCE(SUM(success_count),0) success_count,COALESCE(SUM(not_found_count),0) not_found_count FROM mcp_batches GROUP BY round,state ORDER BY round,state").all() as Array<Record<string, unknown>>;
  }
}
