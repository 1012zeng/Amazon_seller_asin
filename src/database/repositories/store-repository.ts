import type Database from "better-sqlite3";
import { canonicalStorePageUrl } from "../../amazon/product-seller.js";
import type { AppConfig, StorePageParseResult, StorePageWarning } from "../../shared/types.js";

interface CountRow { count: number }
interface PageState { status: string; attempts: number; blocked_count: number }
interface PaginationState { pagination_mode: PaginationMode; expected_last_page: number | null }
interface PriorPageStats {
  pages: number;
  occurrences: number;
  totals: number;
  reported_total: number | null;
  missing_totals: number;
}

export type StoreCrawlRound = 1 | 2;
export type PaginationMode = "unknown" | "fixed_total" | "next_fallback";
export interface StorePageTask { sellerId: string; crawlRound: StoreCrawlRound; page: number; url: string }
export interface PaginationBoundary { mode: Exclude<PaginationMode, "unknown">; expectedLastPage: number | null }
export interface StorePageApplyResult {
  applied: boolean;
  status: "success" | "retry" | "incomplete";
  reason: string;
  warnings: StorePageWarning[];
  boundary: PaginationBoundary | null;
}

function nowIso(): string { return new Date().toISOString(); }
function truncate(value: unknown): string { return (value instanceof Error ? value.message : String(value ?? "")).slice(0, 4_000); }
function warning(code: string, message: string): StorePageWarning { return { code, message }; }

export class StoreRepository {
  constructor(private readonly db: Database.Database, private readonly getConfig: () => AppConfig) {}

  private get schemaVersion(): number { return this.db.pragma("user_version", { simple: true }) as number; }

  pageCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT status,COUNT(*) count FROM store_pages GROUP BY status ORDER BY status").all() as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  pageCountsByRound(): Record<string, Record<string, number>> {
    if (this.schemaVersion < 5) return { "1": this.pageCounts() };
    const rows = this.db.prepare("SELECT crawl_round,status,COUNT(*) count FROM store_pages GROUP BY crawl_round,status ORDER BY crawl_round,status").all() as Array<{ crawl_round: number; status: string; count: number }>;
    const result: Record<string, Record<string, number>> = {};
    for (const row of rows) (result[String(row.crawl_round)] ??= {})[row.status] = row.count;
    return result;
  }

  completenessSummary(): Record<string, unknown> {
    if (this.schemaVersion < 3) {
      const totalStores = (this.db.prepare("SELECT COUNT(*) count FROM source_stores").get() as CountRow).count;
      return { exactCompleted: 0, structurallyCompleted: 0, countMismatch: 0, missingExactTotal: 0, totalStores };
    }
    if (this.schemaVersion < 10) {
      const rows = this.db.prepare("SELECT status,crawl_round,completeness_evidence FROM source_stores").all() as Array<{ status: string; crawl_round: number; completeness_evidence: string }>;
      let exactCompleted = 0;
      let structurallyCompleted = 0;
      let countMismatch = 0;
      let missingExactTotal = 0;
      let secondPassAttempted = 0;
      let secondPassExactCompleted = 0;
      let secondPassPartial = 0;
      for (const row of rows) {
        if (row.crawl_round === 2) secondPassAttempted += 1;
        if (!row.completeness_evidence) continue;
        try {
          const evidence = JSON.parse(row.completeness_evidence) as { exact?: boolean; structural?: boolean; reasonCode?: string };
          if (evidence.exact) exactCompleted += 1;
          if (evidence.structural) structurallyCompleted += 1;
          if (["count_mismatch", "reported_total_changed"].includes(evidence.reasonCode ?? "")) countMismatch += 1;
          if (evidence.reasonCode === "missing_reported_total") missingExactTotal += 1;
          if (row.crawl_round === 2 && evidence.exact) secondPassExactCompleted += 1;
          if (row.crawl_round === 2 && row.status === "partial") secondPassPartial += 1;
        } catch { /* Invalid historical evidence remains visible in the database. */ }
      }
      return { exactCompleted, structurallyCompleted, countMismatch, missingExactTotal, secondPassAttempted, secondPassExactCompleted, secondPassPartial, totalStores: rows.length };
    }

    const rows = this.db.prepare("SELECT status,pagination_warning_count,completeness_evidence FROM source_stores").all() as Array<{ status: string; pagination_warning_count: number; completeness_evidence: string }>;
    const warningCodes: Record<string, number> = {};
    for (const row of this.db.prepare("SELECT warnings_json FROM store_pages WHERE warnings_json<>'[]'").all() as Array<{ warnings_json: string }>) {
      for (const item of JSON.parse(row.warnings_json) as StorePageWarning[]) warningCodes[item.code] = (warningCodes[item.code] ?? 0) + 1;
    }
    let exactCompleted = 0;
    let structurallyCompleted = 0;
    let countMismatch = 0;
    let missingExactTotal = 0;
    for (const row of rows) {
      if (!row.completeness_evidence) continue;
      try {
        const evidence = JSON.parse(row.completeness_evidence) as { exact?: boolean; traversalComplete?: boolean; warningCodes?: string[] };
        if (evidence.exact) exactCompleted += 1;
        if (evidence.traversalComplete) structurallyCompleted += 1;
        if (evidence.warningCodes?.some((code) => ["count_mismatch", "reported_total_changed"].includes(code))) countMismatch += 1;
        if (evidence.warningCodes?.includes("missing_reported_total")) missingExactTotal += 1;
      } catch { /* Invalid evidence remains visibly absent from the counts. */ }
    }
    return {
      exactCompleted,
      structurallyCompleted,
      countMismatch,
      missingExactTotal,
      storesWithWarnings: rows.filter((row) => row.pagination_warning_count > 0).length,
      totalWarnings: rows.reduce((sum, row) => sum + row.pagination_warning_count, 0),
      warningCodes,
      totalStores: rows.length,
    };
  }

  failedStores(): Array<Record<string, unknown>> {
    if (this.schemaVersion < 3) return this.db.prepare("SELECT seller_id,source_row,source_name,status,error FROM source_stores WHERE status='partial' ORDER BY source_row").all() as Array<Record<string, unknown>>;
    if (this.schemaVersion < 5) return this.db.prepare("SELECT seller_id,source_row,source_name,status,error,completeness_evidence FROM source_stores WHERE status='partial' ORDER BY source_row").all() as Array<Record<string, unknown>>;
    if (this.schemaVersion < 10) return this.db.prepare("SELECT seller_id,source_row,source_name,status,crawl_round,error,first_pass_evidence,completeness_evidence FROM source_stores WHERE status='partial' ORDER BY source_row").all() as Array<Record<string, unknown>>;
    if (this.schemaVersion < 12) return this.db.prepare("SELECT seller_id,source_row,source_name,status,crawl_round,pagination_mode,expected_last_page,pagination_warning_count,error,completeness_evidence FROM source_stores WHERE status='partial' ORDER BY source_row").all() as Array<Record<string, unknown>>;
    return this.db.prepare("SELECT seller_id,source_row,source_name,verified_source_asin,input_seller_id,identity_status,status,crawl_round,pagination_mode,expected_last_page,pagination_warning_count,error,completeness_evidence FROM source_stores WHERE status='partial' ORDER BY source_row").all() as Array<Record<string, unknown>>;
  }

  occurrenceCount(): number {
    return (this.db.prepare("SELECT COUNT(*) count FROM store_asin_occurrences").get() as CountRow).count;
  }

  isTerminal(): boolean {
    return !(this.db.prepare("SELECT 1 FROM store_pages WHERE status IN ('pending','retry','blocked') LIMIT 1").get());
  }

  pendingPages(limit: number): StorePageTask[] {
    const rows = this.db.prepare(`SELECT store_pages.seller_id,store_pages.crawl_round,store_pages.page,store_pages.url
      FROM store_pages JOIN source_stores USING(seller_id)
      WHERE store_pages.status IN ('pending','retry','blocked') AND (store_pages.available_at='' OR store_pages.available_at<=?)
      ORDER BY source_stores.source_row,store_pages.crawl_round,store_pages.page LIMIT ?`)
      .all(nowIso(), limit) as Array<{ seller_id: string; crawl_round: StoreCrawlRound; page: number; url: string }>;
    return rows.map((row) => ({ sellerId: row.seller_id, crawlRound: row.crawl_round, page: row.page, url: row.url }));
  }

  private assertSingleRound(crawlRound: StoreCrawlRound): void {
    if (crawlRound !== 1) throw new Error("Schema v10 store crawling only permits crawl_round=1");
  }

  private saveOccurrences(sellerId: string, crawlRound: StoreCrawlRound, page: number, result: StorePageParseResult, now: string): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO store_asin_occurrences(seller_id,asin,crawl_round,page,position,title,listing_product_url,product_url,image_url,review_count,rating,price_text,price_cents,captured_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const item of result.occurrences) {
      if (item.sellerId !== sellerId || item.page !== page) throw new Error("Store occurrence identity mismatch");
      insert.run(sellerId, item.asin, crawlRound, page, item.position, item.title, item.listingProductUrl, item.productUrl, item.imageUrl, item.reviewCount, item.rating, item.priceText, item.priceCents, now);
    }
  }

  private pageCount(sellerId: string, crawlRound: StoreCrawlRound): number {
    return (this.db.prepare("SELECT COUNT(*) count FROM store_pages WHERE seller_id=? AND crawl_round=? AND status IN ('success','incomplete')").get(sellerId, crawlRound) as CountRow).count;
  }

  private warningState(sellerId: string): { total: number; codes: string[]; counts: Record<string, number> } {
    const counts: Record<string, number> = {};
    let total = 0;
    const rows = this.db.prepare("SELECT warnings_json FROM store_pages WHERE seller_id=? AND warnings_json<>'[]' ORDER BY crawl_round,page").all(sellerId) as Array<{ warnings_json: string }>;
    for (const row of rows) {
      for (const item of JSON.parse(row.warnings_json) as StorePageWarning[]) {
        total += 1;
        counts[item.code] = (counts[item.code] ?? 0) + 1;
      }
    }
    return { total, codes: Object.keys(counts).sort(), counts };
  }

  private updateWarningCount(sellerId: string, now: string): void {
    this.db.prepare("UPDATE source_stores SET pagination_warning_count=?,updated_at=? WHERE seller_id=?").run(this.warningState(sellerId).total, now, sellerId);
  }

  private evidence(sellerId: string, crawlRound: StoreCrawlRound, traversalComplete: boolean, failureCode: string, failureReason: string): string {
    const source = this.db.prepare("SELECT pagination_mode,expected_last_page FROM source_stores WHERE seller_id=?").get(sellerId) as PaginationState;
    const all = this.db.prepare("SELECT COUNT(*) occurrences,COUNT(DISTINCT asin) unique_asins FROM store_asin_occurrences WHERE seller_id=?").get(sellerId) as { occurrences: number; unique_asins: number };
    const round = this.db.prepare("SELECT COUNT(*) occurrences,COUNT(DISTINCT asin) unique_asins FROM store_asin_occurrences WHERE seller_id=? AND crawl_round=?").get(sellerId, crawlRound) as { occurrences: number; unique_asins: number };
    const totals = this.db.prepare("SELECT COUNT(DISTINCT reported_total) totals,MIN(reported_total) reported_total,SUM(CASE WHEN reported_total IS NULL THEN 1 ELSE 0 END) missing_totals FROM store_pages WHERE seller_id=? AND crawl_round=? AND status IN ('success','incomplete')").get(sellerId, crawlRound) as { totals: number; reported_total: number | null; missing_totals: number };
    const warnings = this.warningState(sellerId);
    const exact = traversalComplete && warnings.total === 0 && totals.totals === 1 && totals.missing_totals === 0 && totals.reported_total === round.occurrences;
    return JSON.stringify({
      crawlRound,
      exact,
      structural: traversalComplete,
      traversalComplete,
      boundarySource: source.pagination_mode,
      expectedLastPage: source.expected_last_page,
      fetchedPages: this.pageCount(sellerId, crawlRound),
      reasonCode: failureCode || warnings.codes[0] || "",
      reason: failureReason,
      reportedTotal: totals.totals === 1 ? totals.reported_total : null,
      warningCodes: warnings.codes,
      warningCounts: warnings.counts,
      roundOccurrenceCount: round.occurrences,
      roundUniqueAsins: round.unique_asins,
      occurrenceCount: all.occurrences,
      uniqueAsins: all.unique_asins,
    });
  }

  private captureSql(status: string, result: StorePageParseResult, warnings: StorePageWarning[], error: string, now: string, sellerId: string, crawlRound: StoreCrawlRound, page: number, attempts?: number): void {
    const attemptsClause = attempts === undefined ? "" : ",attempts=@attempts";
    this.db.prepare(`UPDATE store_pages SET status=@status,result_count=@resultCount,next_url=@nextUrl,page_signature=@signature,http_status=@httpStatus,response_bytes=@responseBytes,fetch_ms=@fetchMs,reported_total=@reportedTotal,visible_last_page=@visibleLastPage,warnings_json=@warningsJson,endpoint_port=@endpointPort,available_at='',error=@error,updated_at=@now${attemptsClause} WHERE seller_id=@sellerId AND crawl_round=@crawlRound AND page=@page`).run({
      status,
      resultCount: result.occurrences.length,
      nextUrl: result.nextUrl,
      signature: result.signature,
      httpStatus: result.httpStatus || null,
      responseBytes: result.responseBytes,
      fetchMs: result.fetchMs,
      reportedTotal: result.reportedTotal,
      visibleLastPage: result.visibleLastPage,
      warningsJson: JSON.stringify(warnings),
      endpointPort: result.endpointPort || null,
      error: truncate(error),
      now,
      sellerId,
      crawlRound,
      page,
      ...(attempts === undefined ? {} : { attempts }),
    });
    this.updateWarningCount(sellerId, now);
  }

  private finishIncomplete(sellerId: string, crawlRound: StoreCrawlRound, reasonCode: string, reason: string, now: string, warnings: StorePageWarning[], boundary: PaginationBoundary | null): StorePageApplyResult {
    const evidence = this.evidence(sellerId, crawlRound, false, reasonCode, reason);
    this.db.prepare("UPDATE source_stores SET status='partial',crawl_round=1,page_count=?,completeness_evidence=?,error=?,updated_at=? WHERE seller_id=?")
      .run(this.pageCount(sellerId, crawlRound), evidence, truncate(reason), now, sellerId);
    return { applied: true, status: "incomplete", reason, warnings, boundary };
  }

  private terminalResult(status: string): StorePageApplyResult | null {
    if (status === "success") return { applied: false, status: "success", reason: "", warnings: [], boundary: null };
    if (["incomplete", "failed", "unavailable", "blocked_exhausted"].includes(status)) return { applied: false, status: "incomplete", reason: "", warnings: [], boundary: null };
    return null;
  }

  private overlapCount(sellerId: string, crawlRound: StoreCrawlRound, result: StorePageParseResult): number {
    const asins = [...new Set(result.occurrences.map((item) => item.asin))];
    if (asins.length === 0) return 0;
    const placeholders = asins.map(() => "?").join(",");
    return (this.db.prepare(`SELECT COUNT(DISTINCT asin) count FROM store_asin_occurrences WHERE seller_id=? AND crawl_round=? AND asin IN (${placeholders})`).get(sellerId, crawlRound, ...asins) as CountRow).count;
  }

  applySuccess(sellerId: string, crawlRound: StoreCrawlRound, page: number, result: StorePageParseResult): StorePageApplyResult {
    if (result.kind !== "success") throw new Error(`Cannot save ${result.kind} as store success`);
    this.assertSingleRound(crawlRound);
    const config = this.getConfig();
    return this.db.transaction((): StorePageApplyResult => {
      const task = this.db.prepare("SELECT status,attempts,blocked_count FROM store_pages WHERE seller_id=? AND crawl_round=? AND page=?").get(sellerId, crawlRound, page) as PageState | undefined;
      if (!task) throw new Error(`Unknown store page ${sellerId}:${crawlRound}:${page}`);
      const terminal = this.terminalResult(task.status);
      if (terminal) return terminal;

      const now = nowIso();
      let pagination = this.db.prepare("SELECT pagination_mode,expected_last_page FROM source_stores WHERE seller_id=?").get(sellerId) as PaginationState | undefined;
      if (!pagination) throw new Error(`Unknown source store ${sellerId}`);
      let boundary: PaginationBoundary | null = null;
      if (pagination.pagination_mode === "unknown") {
        const mode: PaginationBoundary["mode"] = result.visibleLastPage === null ? "next_fallback" : "fixed_total";
        const expectedLastPage = mode === "fixed_total" ? result.visibleLastPage : null;
        this.db.prepare("UPDATE source_stores SET pagination_mode=?,expected_last_page=?,updated_at=? WHERE seller_id=?")
          .run(mode, expectedLastPage, now, sellerId);
        pagination = { pagination_mode: mode, expected_last_page: expectedLastPage };
        boundary = { mode, expectedLastPage };
      }

      const prior = this.db.prepare("SELECT COUNT(*) pages,COALESCE(SUM(result_count),0) occurrences,COUNT(DISTINCT reported_total) totals,MIN(reported_total) reported_total,SUM(CASE WHEN reported_total IS NULL THEN 1 ELSE 0 END) missing_totals FROM store_pages WHERE seller_id=? AND crawl_round=? AND page<? AND status='success'").get(sellerId, crawlRound, page) as PriorPageStats;
      const collision = result.signature ? this.db.prepare("SELECT page FROM store_pages WHERE seller_id=? AND crawl_round=? AND page<>? AND page_signature=? AND status='success'").get(sellerId, crawlRound, page, result.signature) as { page: number } | undefined : undefined;
      const warnings: StorePageWarning[] = [];
      if (collision) warnings.push(warning("repeated_page_signature", `Page signature repeats page ${collision.page}`));
      const overlap = this.overlapCount(sellerId, crawlRound, result);
      if (overlap > 0) warnings.push(warning("cross_page_asin_overlap", `${overlap} ASINs already appeared on earlier pages`));
      if (pagination.pagination_mode === "fixed_total" && result.visibleLastPage !== null && result.visibleLastPage !== pagination.expected_last_page) {
        warnings.push(warning("visible_last_page_changed", `Visible last page changed from ${pagination.expected_last_page} to ${result.visibleLastPage}`));
      }
      if (result.reportedTotal === null) warnings.push(warning("missing_reported_total", "This page did not expose an exact result total"));
      else if (prior.totals > 1 || (prior.pages > 0 && prior.reported_total !== result.reportedTotal)) warnings.push(warning("reported_total_changed", `Reported total changed to ${result.reportedTotal}`));

      const fixedLastPage = pagination.pagination_mode === "fixed_total" ? pagination.expected_last_page : null;
      let effectiveNextUrl = result.nextUrl;
      let effectiveCompletenessError = result.completenessError;
      if (fixedLastPage !== null && page < fixedLastPage && result.occurrences.length > 0 && (!effectiveNextUrl || effectiveCompletenessError)) {
        effectiveNextUrl = canonicalStorePageUrl(config.amazon.marketplace, config.amazon.marketplaceId, sellerId, page + 1);
        effectiveCompletenessError = "";
        warnings.push(warning("canonical_next_recovery", `Recovered missing or invalid Next link with canonical page ${page + 1} URL`));
      }
      const effectiveResult = effectiveNextUrl === result.nextUrl && effectiveCompletenessError === result.completenessError
        ? result
        : { ...result, nextUrl: effectiveNextUrl, completenessError: effectiveCompletenessError };
      let nextPage: number | null = null;
      if (effectiveNextUrl) nextPage = Number(new URL(effectiveNextUrl).searchParams.get("page"));
      const shouldContinue = fixedLastPage !== null ? page < fixedLastPage : Boolean(effectiveNextUrl);
      if (result.zeroResults && shouldContinue) warnings.push(warning("zero_results_before_last_page", "A valid intermediate page contained zero product cards"));

      let structuralReasonCode = "";
      let structuralReason = "";
      let retryableStructural = false;
      const verified = this.db.prepare("SELECT verified_source_asin FROM source_stores WHERE seller_id=?").get(sellerId) as { verified_source_asin: string };
      if (page === 1 && verified.verified_source_asin && result.occurrences.length === 0 && !result.nextUrl) {
        structuralReasonCode = result.zeroResults ? "verified_seller_zero_results" : "verified_seller_empty_results";
        structuralReason = `Amazon returned an empty terminal page for verified seller ${sellerId}, although source ASIN ${verified.verified_source_asin} resolved to this seller`;
        retryableStructural = true;
      } else if (prior.pages !== page - 1) {
        structuralReasonCode = "page_gap";
        structuralReason = `Expected ${page - 1} completed prior pages, found ${prior.pages}`;
      } else if (fixedLastPage !== null) {
        if (page > fixedLastPage) {
          structuralReasonCode = "page_beyond_expected_last_page";
          structuralReason = `Page ${page} is beyond frozen last page ${fixedLastPage}`;
        } else if (page < fixedLastPage) {
          if (effectiveCompletenessError) {
            structuralReasonCode = "invalid_next";
            structuralReason = effectiveCompletenessError;
            retryableStructural = true;
          } else if (!effectiveNextUrl) {
            structuralReasonCode = "missing_next_before_last_page";
            structuralReason = `Page ${page} has no valid Next link before frozen last page ${fixedLastPage}`;
            retryableStructural = true;
          }
        } else if (effectiveNextUrl) {
          warnings.push(warning("next_beyond_last_page", `Ignored Next link beyond frozen last page ${fixedLastPage}`));
        } else if (effectiveCompletenessError) {
          warnings.push(warning("invalid_next_on_last_page", "Ignored invalid Next link on the frozen last page"));
        }
      } else if (effectiveCompletenessError) {
        structuralReasonCode = "invalid_next";
        structuralReason = effectiveCompletenessError;
        retryableStructural = true;
      } else if (effectiveNextUrl && nextPage !== null && nextPage > config.stores.fallbackMaxPagesPerStore) {
        structuralReasonCode = "fallback_page_cap";
        structuralReason = `Fallback Next traversal reached the ${config.stores.fallbackMaxPagesPerStore}-page safety limit`;
      }

      if (!structuralReason && shouldContinue && effectiveNextUrl && nextPage !== null && config.stores.maxPagesPerStore > 0 && nextPage > config.stores.maxPagesPerStore) {
        structuralReasonCode = "max_pages_reached";
        structuralReason = `Configured page limit ${config.stores.maxPagesPerStore} stopped the crawl before page ${nextPage}`;
      }

      if (structuralReason) {
        const attempts = task.attempts + 1;
        if (retryableStructural && attempts < config.stores.maxRetries) {
          this.captureSql("retry", effectiveResult, warnings, structuralReason, now, sellerId, crawlRound, page, attempts);
          return { applied: false, status: "retry", reason: structuralReason, warnings, boundary };
        }
        this.saveOccurrences(sellerId, crawlRound, page, effectiveResult, now);
        this.captureSql("incomplete", effectiveResult, warnings, structuralReason, now, sellerId, crawlRound, page, attempts);
        return this.finishIncomplete(sellerId, crawlRound, structuralReasonCode, structuralReason, now, warnings, boundary);
      }

      const terminalPage = fixedLastPage !== null ? page === fixedLastPage : !effectiveNextUrl;
      if (terminalPage && result.reportedTotal !== null && prior.occurrences + result.occurrences.length !== result.reportedTotal) {
        warnings.push(warning("count_mismatch", `Amazon reported ${result.reportedTotal} results but ${prior.occurrences + result.occurrences.length} occurrences were captured`));
      }

      this.saveOccurrences(sellerId, crawlRound, page, effectiveResult, now);
      this.captureSql("success", effectiveResult, warnings, "", now, sellerId, crawlRound, page);
      if (result.displayedName && !/^(?:amazon|amazon resale|learn more about the seller)$/i.test(result.displayedName)) {
        this.db.prepare("UPDATE source_stores SET live_name=?,updated_at=? WHERE seller_id=?").run(result.displayedName, now, sellerId);
      }
      if (!terminalPage && effectiveNextUrl && nextPage !== null) {
        this.db.prepare("INSERT OR IGNORE INTO store_pages(seller_id,crawl_round,page,url,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(sellerId, 1, nextPage, effectiveNextUrl, now, now);
      } else {
        const evidence = this.evidence(sellerId, crawlRound, true, "", "");
        this.db.prepare("UPDATE source_stores SET status='success',crawl_round=1,page_count=?,completeness_evidence=?,error='',updated_at=? WHERE seller_id=?")
          .run(this.pageCount(sellerId, crawlRound), evidence, now, sellerId);
      }
      return { applied: true, status: "success", reason: "", warnings, boundary };
    })();
  }

  applyFailure(sellerId: string, crawlRound: StoreCrawlRound, page: number, kind: "blocked" | "unavailable" | "error", error: unknown, capture?: StorePageParseResult): StorePageApplyResult {
    this.assertSingleRound(crawlRound);
    const config = this.getConfig();
    return this.db.transaction((): StorePageApplyResult => {
      const row = this.db.prepare("SELECT status,attempts,blocked_count FROM store_pages WHERE seller_id=? AND crawl_round=? AND page=?").get(sellerId, crawlRound, page) as PageState | undefined;
      if (!row) throw new Error(`Unknown store page ${sellerId}:${crawlRound}:${page}`);
      const terminal = this.terminalResult(row.status);
      if (terminal) return terminal;

      const now = nowIso();
      let status = "";
      let attempts = row.attempts;
      let blocked = row.blocked_count;
      let availableAt = "";
      if (kind === "blocked") {
        blocked += 1;
        status = blocked >= config.stores.maxBlockedAttempts ? "blocked_exhausted" : "blocked";
        if (status === "blocked") availableAt = new Date(Date.now() + config.stores.blockedDelayMs).toISOString();
      } else if (kind === "unavailable") {
        attempts += 1;
        blocked = 0;
        status = "unavailable";
      } else {
        attempts += 1;
        blocked = 0;
        status = attempts >= config.stores.maxRetries ? "failed" : "retry";
      }
      const message = truncate(error);
      this.db.prepare(`UPDATE store_pages SET status=?,attempts=?,blocked_count=?,available_at=?,error=?,http_status=COALESCE(?,http_status),response_bytes=COALESCE(?,response_bytes),fetch_ms=COALESCE(?,fetch_ms),reported_total=COALESCE(?,reported_total),visible_last_page=COALESCE(?,visible_last_page),endpoint_port=COALESCE(?,endpoint_port),updated_at=? WHERE seller_id=? AND crawl_round=? AND page=?`)
        .run(status, attempts, blocked, availableAt, message, capture?.httpStatus || null, capture?.responseBytes ?? null, capture?.fetchMs ?? null, capture?.reportedTotal ?? null, capture?.visibleLastPage ?? null, capture?.endpointPort || null, now, sellerId, crawlRound, page);
      if (["failed", "unavailable", "blocked_exhausted"].includes(status)) {
        const reasonCode = status === "unavailable" ? "unavailable" : status;
        return this.finishIncomplete(sellerId, crawlRound, reasonCode, message, now, [], null);
      }
      return { applied: true, status: "retry", reason: message, warnings: [], boundary: null };
    })();
  }
}
