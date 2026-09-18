import type Database from "better-sqlite3";
import type { AppConfig } from "../../shared/types.js";

function nowIso(): string { return new Date().toISOString(); }
interface CountRow { count: number }

export interface FilterCandidateRow {
  asin: string; seller_id: string; occurrence_id: number; image_url: string; source_name: string; live_name: string; source_profile_url: string;
  price_cents: number; review_count: number; rating: number; enriched_image_url: string; child_sales_30d: number | null;
  available_date: string; fulfillment: string; variation_count: number | null; title: string; node_label_path: string; brand: string; brand_url: string;
}

export class CandidateRepository {
  constructor(private readonly db: Database.Database, private readonly getConfig: () => AppConfig) {}

  private get schemaVersion(): number { return this.db.pragma("user_version", { simple: true }) as number; }

  prefilter(): { occurrenceCount: number; eligibleOccurrences: number; uniqueCandidates: number } {
    const f = this.getConfig().filters;
    return this.db.transaction(() => {
      if ((this.db.prepare("SELECT COUNT(*) count FROM asin_candidates").get() as CountRow).count > 0) return this.prefilterCounts();
      const now = nowIso();
      this.db.prepare(`WITH eligible AS (
        SELECT o.id,o.asin,o.seller_id,s.source_row,o.page,o.position,o.title,o.listing_product_url,o.product_url,o.image_url,o.review_count,o.rating,o.price_text,o.price_cents,
          ROW_NUMBER() OVER(PARTITION BY o.asin ORDER BY s.source_row,o.page,o.position,o.seller_id,o.id) choice
        FROM store_asin_occurrences o JOIN source_stores s ON s.seller_id=o.seller_id
        WHERE o.rating IS NOT NULL AND o.rating>=? AND o.review_count IS NOT NULL AND o.review_count<? AND o.price_cents IS NOT NULL AND o.price_cents>=? AND o.price_cents<=?
      ) INSERT INTO asin_candidates(
        asin,seller_id,occurrence_id,state,created_at,updated_at,
        store_name,store_url,seller_profile_url,page,position,listing_title,listing_product_url,product_url,image_url,
        review_count,rating,price_text,price_cents
      )
        SELECT e.asin,e.seller_id,e.id,'mcp_pending',?,?,
          CASE WHEN s.live_name<>'' THEN s.live_name ELSE s.source_name END,s.store_url,s.source_profile_url,
          e.page,e.position,e.title,e.listing_product_url,e.product_url,e.image_url,e.review_count,e.rating,e.price_text,e.price_cents
        FROM eligible e JOIN source_stores s ON s.seller_id=e.seller_id WHERE e.choice=1 ORDER BY e.source_row,e.page,e.position,e.seller_id`)
        .run(f.minRatingInclusive, f.maxReviewCountExclusive, f.minPriceCentsInclusive, f.maxPriceCentsInclusive, now, now);
      return this.prefilterCounts();
    })();
  }

  private prefilterCounts(): { occurrenceCount: number; eligibleOccurrences: number; uniqueCandidates: number } {
    const f = this.getConfig().filters;
    const occurrenceCount = (this.db.prepare("SELECT COUNT(*) count FROM store_asin_occurrences").get() as CountRow).count;
    const eligibleOccurrences = (this.db.prepare("SELECT COUNT(*) count FROM store_asin_occurrences WHERE rating IS NOT NULL AND rating>=? AND review_count IS NOT NULL AND review_count<? AND price_cents IS NOT NULL AND price_cents>=? AND price_cents<=?").get(f.minRatingInclusive, f.maxReviewCountExclusive, f.minPriceCentsInclusive, f.maxPriceCentsInclusive) as CountRow).count;
    const uniqueCandidates = (this.db.prepare("SELECT COUNT(*) count FROM asin_candidates").get() as CountRow).count;
    return { occurrenceCount, eligibleOccurrences, uniqueCandidates };
  }

  listAsinsByState(state: string): string[] {
    return (this.db.prepare("SELECT asin FROM asin_candidates WHERE state=? ORDER BY asin").all(state) as Array<{ asin: string }>).map((row) => row.asin);
  }

  setState(asin: string, state: string, stage = "", reason = "", ageDays: number | null = null): void {
    this.db.prepare("UPDATE asin_candidates SET state=?,filter_stage=?,filter_reason=?,age_days=?,updated_at=? WHERE asin=?").run(state, stage, reason, ageDays, nowIso(), asin);
  }

  filterRows(): FilterCandidateRow[] {
    return this.queryFilterRows("c.state='mcp_ok'");
  }

  filterRow(asin: string): FilterCandidateRow | undefined {
    return this.queryFilterRows("c.asin=?", asin)[0];
  }

  private queryFilterRows(predicate: string, ...values: string[]): FilterCandidateRow[] {
    return this.db.prepare(`SELECT c.asin,c.seller_id,c.occurrence_id,o.image_url,s.source_name,s.live_name,s.source_profile_url,o.price_cents,o.review_count,o.rating,
      e.image_url enriched_image_url,e.child_sales_30d,e.available_date,e.fulfillment,e.variation_count,e.title,e.node_label_path,e.brand,e.brand_url
      FROM asin_candidates c JOIN store_asin_occurrences o ON o.id=c.occurrence_id JOIN source_stores s ON s.seller_id=c.seller_id JOIN enrichments e ON e.asin=c.asin
      WHERE ${predicate} ORDER BY c.asin`).all(...values) as FilterCandidateRow[];
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare("SELECT state,COUNT(*) count FROM asin_candidates GROUP BY state ORDER BY state").all() as Array<{ state: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
  }

  prefilterReasonCounts(): Record<string, number> {
    const f = this.getConfig().filters;
    if (this.schemaVersion < 8) {
      const legacy = f as unknown as { maxReviewCount: number; minRatingExclusive: number; minPricePence: number; maxPricePence: number };
      const rows = this.db.prepare(`SELECT reason,COUNT(*) count FROM (
        SELECT CASE
          WHEN rating IS NULL THEN 'rating_missing'
          WHEN rating<=? THEN 'rating_lte_min'
          WHEN review_count IS NULL THEN 'review_count_missing'
          WHEN review_count>? THEN 'review_count_gt_max'
          WHEN price_pence IS NULL THEN 'gbp_price_missing'
          WHEN price_pence<? THEN 'gbp_price_lt_min'
          WHEN price_pence>? THEN 'gbp_price_gt_max'
          ELSE 'eligible'
        END reason FROM store_asin_occurrences
      ) GROUP BY reason ORDER BY reason`).all(legacy.minRatingExclusive, legacy.maxReviewCount, legacy.minPricePence, legacy.maxPricePence) as Array<{ reason: string; count: number }>;
      return Object.fromEntries(rows.map((row) => [row.reason, row.count]));
    }
    const rows = this.db.prepare(`SELECT reason,COUNT(*) count FROM (
      SELECT CASE
        WHEN rating IS NULL THEN 'rating_missing'
        WHEN rating<? THEN 'rating_lt_min'
        WHEN review_count IS NULL THEN 'review_count_missing'
        WHEN review_count>=? THEN 'review_count_gte_max'
        WHEN price_cents IS NULL THEN 'eur_price_missing'
        WHEN price_cents<? THEN 'eur_price_lt_min'
        WHEN price_cents>? THEN 'eur_price_gt_max'
        ELSE 'eligible'
      END reason FROM store_asin_occurrences
    ) GROUP BY reason ORDER BY reason`).all(f.minRatingInclusive, f.maxReviewCountExclusive, f.minPriceCentsInclusive, f.maxPriceCentsInclusive) as Array<{ reason: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.reason, row.count]));
  }
}
