import type Database from "better-sqlite3";
import type { AsinDetailResult } from "../../shared/types.js";

function nowIso(): string { return new Date().toISOString(); }

export class DetailRepository {
  constructor(private readonly db: Database.Database) {}

  private hasTable(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='asin_detail_tasks'").get());
  }

  materialize(): void {
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO asin_detail_tasks(asin,created_at,updated_at)
        SELECT asin,?,? FROM cleaned_products ORDER BY asin`).run(now, now);
      this.db.prepare("UPDATE asin_candidates SET detail_state='pending',updated_at=? WHERE asin IN (SELECT asin FROM asin_detail_tasks WHERE state IN ('pending','failed','running'))").run(now);
    })();
  }

  next(): string | null {
    const row = this.db.prepare("SELECT asin FROM asin_detail_tasks WHERE state IN ('pending','failed','running') ORDER BY asin LIMIT 1").get() as { asin: string } | undefined;
    if (!row) return null;
    const now = nowIso();
    this.db.prepare("UPDATE asin_detail_tasks SET state='running',attempt_count=attempt_count+1,last_error='',updated_at=? WHERE asin=?").run(now, row.asin);
    this.db.prepare("UPDATE asin_candidates SET detail_state='running',updated_at=? WHERE asin=?").run(now, row.asin);
    return row.asin;
  }

  fail(asin: string, error: unknown): void {
    const message = (error instanceof Error ? error.message : String(error ?? "")).slice(0, 4_000);
    const now = nowIso();
    this.db.prepare("UPDATE asin_detail_tasks SET state='failed',last_error=?,updated_at=? WHERE asin=?").run(message, now, asin);
    this.db.prepare("UPDATE asin_candidates SET detail_state='failed',updated_at=? WHERE asin=?").run(now, asin);
  }

  complete(result: AsinDetailResult): void {
    this.db.transaction(() => {
      const now = nowIso();
      const featuresJson = result.features === null ? null : JSON.stringify(result.features);
      const updated = this.db.prepare("UPDATE cleaned_products SET features_json=?,overviews=?,updated_at=? WHERE asin=?")
        .run(featuresJson, result.overviews, now, result.asin);
      if (updated.changes !== 1) throw new Error(`Detail target is missing from cleaned_products: ${result.asin}`);
      this.db.prepare("UPDATE asin_detail_tasks SET state='completed',last_error='',completed_at=?,updated_at=? WHERE asin=?")
        .run(now, now, result.asin);
      this.db.prepare("UPDATE asin_candidates SET features_json=?,overviews=?,detail_state='completed',updated_at=? WHERE asin=?")
        .run(featuresJson, result.overviews, now, result.asin);
    })();
  }

  isTerminal(): boolean {
    if (!this.hasTable()) return true;
    return !(this.db.prepare("SELECT 1 FROM asin_detail_tasks WHERE state IN ('pending','running','failed') LIMIT 1").get());
  }

  counts(): Record<string, number> {
    if (!this.hasTable()) return {};
    const rows = this.db.prepare("SELECT state,COUNT(*) count FROM asin_detail_tasks GROUP BY state ORDER BY state").all() as Array<{ state: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
  }
}
