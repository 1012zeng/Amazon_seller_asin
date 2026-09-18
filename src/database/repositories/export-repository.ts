import type Database from "better-sqlite3";
import type { ExportRow } from "../../shared/types.js";
import type { FilterCandidateRow } from "./candidate-repository.js";

function nowIso(): string { return new Date().toISOString(); }

export class ExportRepository {
  constructor(private readonly db: Database.Database) {}

  addFiltered(row: FilterCandidateRow, site: string, productUrl: string): void {
    const now = nowIso();
    this.db.prepare(`INSERT INTO cleaned_products(asin,seller_id,occurrence_id,site,image_url,product_url,store_name,store_url,child_sales_30d,sales_7d_minimum_met,unit_price_cents,date_first_available,review_count,rating,fulfillment,variation_count,title,category,brand,brand_url,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(asin) DO UPDATE SET image_url=excluded.image_url,child_sales_30d=excluded.child_sales_30d,date_first_available=excluded.date_first_available,fulfillment=excluded.fulfillment,variation_count=excluded.variation_count,title=excluded.title,category=excluded.category,brand=excluded.brand,brand_url=excluded.brand_url,updated_at=excluded.updated_at`)
      .run(row.asin, row.seller_id, row.occurrence_id, site, row.enriched_image_url || row.image_url, productUrl, row.live_name || row.source_name, row.source_profile_url, row.child_sales_30d, row.price_cents, row.available_date, row.review_count, row.rating, row.fulfillment, row.variation_count, row.title, row.node_label_path, row.brand, row.brand_url, now, now);
  }

  remove(asin: string): void { this.db.prepare("DELETE FROM cleaned_products WHERE asin=?").run(asin); }
  setSales7dMinimumMet(asin: string): void { this.db.prepare("UPDATE cleaned_products SET sales_7d_minimum_met='yes',updated_at=? WHERE asin=?").run(nowIso(), asin); }
  count(): number { return (this.db.prepare("SELECT COUNT(*) count FROM cleaned_products").get() as { count: number }).count; }
  rows(): ExportRow[] { return this.db.prepare("SELECT site,image_url,asin,product_url,store_name,store_url,child_sales_30d,sales_7d_minimum_met,unit_price_cents,date_first_available,review_count,rating,fulfillment,variation_count,title,category,features_json,overviews,brand,brand_url FROM cleaned_products ORDER BY asin").all() as ExportRow[]; }
}
