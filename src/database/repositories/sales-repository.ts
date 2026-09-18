import type Database from "better-sqlite3";
import type { AppConfig, Sales7dResult } from "../../shared/types.js";
import { ExportRepository } from "./export-repository.js";
import { CandidateRepository } from "./candidate-repository.js";

function nowIso(): string { return new Date().toISOString(); }

export interface Sales7dTask {
  asin: string;
  dailySalesMinimum: number;
}

export class SalesRepository {
  constructor(private readonly db: Database.Database, private readonly exports: ExportRepository, private readonly getConfig: () => AppConfig) {}

  materialize(asOfDate: string, windowStart: string, windowEnd: string): void {
    const now = nowIso();
    const filters = this.getConfig().filters;
    this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO sales_7d_tasks(asin,as_of_date,window_start,window_end,daily_sales_minimum,created_at,updated_at)
        SELECT asin,?,?,?,?,?,? FROM asin_candidates WHERE state='sales_pending' ORDER BY asin`)
        .run(asOfDate, windowStart, windowEnd, filters.sales7dDailySalesMinimum, now, now);
      this.db.prepare(`UPDATE asin_candidates SET sales_window_start=?,sales_window_end=?,sales_7d_result=NULL,sales_7d_complete=NULL,
        sales_7d_days_json=NULL,sales_7d_minimum_met=NULL,sales_7d_daily_minimum=(SELECT daily_sales_minimum FROM sales_7d_tasks t WHERE t.asin=asin_candidates.asin)
        WHERE state='sales_pending'`).run(windowStart, windowEnd);
    })();
  }

  next(): Sales7dTask | null {
    const row = this.db.prepare("SELECT asin,daily_sales_minimum FROM sales_7d_tasks WHERE state IN ('pending','failed','running') ORDER BY asin LIMIT 1").get() as { asin: string; daily_sales_minimum: number } | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE sales_7d_tasks SET state='running',attempt_count=attempt_count+1,last_error='',updated_at=? WHERE asin=?").run(nowIso(), row.asin);
    return { asin: row.asin, dailySalesMinimum: row.daily_sales_minimum };
  }

  fail(asin: string, error: unknown): void {
    const message = (error instanceof Error ? error.message : String(error ?? "")).slice(0, 4_000);
    this.db.prepare("UPDATE sales_7d_tasks SET state='failed',last_error=?,updated_at=? WHERE asin=?").run(message, nowIso(), asin);
  }

  complete(asin: string, result: Sales7dResult): "retained" | "filtered_no" {
    return this.db.transaction(() => {
      const now = nowIso();
      const task = this.db.prepare("SELECT daily_sales_minimum FROM sales_7d_tasks WHERE asin=?").get(asin) as { daily_sales_minimum: number } | undefined;
      if (!task || task.daily_sales_minimum !== result.dailySalesMinimum) throw new Error(`Sales-7d daily minimum mismatch for ${asin}`);
      const state = result.result === "yes" ? "retained" : "filtered_no";
      const reason = state === "retained" ? "" : `daily_sales_minimum_${result.dailySalesMinimum}_not_met`;
      const daysJson = JSON.stringify(result.days);
      this.db.prepare("UPDATE sales_7d_tasks SET state=?,result=?,days_json=?,filter_reason=?,last_error='',completed_at=?,updated_at=? WHERE asin=?")
        .run(state, result.result, daysJson, reason, now, now, asin);
      this.db.prepare("UPDATE asin_candidates SET sales_7d_result=?,sales_7d_complete=?,sales_7d_daily_minimum=?,sales_window_start=?,sales_window_end=?,sales_7d_days_json=?,sales_7d_minimum_met=?,updated_at=? WHERE asin=?")
        .run(result.result, result.complete ? 1 : 0, result.dailySalesMinimum, result.windowStart, result.windowEnd, daysJson, state === "retained" ? "yes" : null, now, asin);
      if (state === "retained") {
        const row = new CandidateRepository(this.db, this.getConfig).filterRow(asin);
        if (!row) throw new Error(`Missing enriched candidate: ${asin}`);
        const config = this.getConfig();
        this.exports.addFiltered(row, config.amazon.site, new URL(`/dp/${asin}`, config.amazon.marketplace).toString());
        this.exports.setSales7dMinimumMet(asin);
        this.db.prepare("UPDATE asin_candidates SET state='retained',filter_stage='',filter_reason='',updated_at=? WHERE asin=?").run(now, asin);
      } else {
        this.exports.remove(asin);
        this.db.prepare("UPDATE asin_candidates SET state='filtered_sales',filter_stage='sales_7d',filter_reason=?,updated_at=? WHERE asin=?").run(reason, now, asin);
      }
      return state;
    })();
  }

  isTerminal(): boolean { return !(this.db.prepare("SELECT 1 FROM sales_7d_tasks WHERE state IN ('pending','running','failed') LIMIT 1").get()); }
  counts(): Record<string, number> {
    const rows = this.db.prepare("SELECT state,COUNT(*) count FROM sales_7d_tasks GROUP BY state ORDER BY state").all() as Array<{ state: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
  }
  minimumCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT daily_sales_minimum,COUNT(*) count FROM sales_7d_tasks GROUP BY daily_sales_minimum ORDER BY daily_sales_minimum").all() as Array<{ daily_sales_minimum: number; count: number }>;
    return Object.fromEntries(rows.map((row) => [String(row.daily_sales_minimum), row.count]));
  }
}
