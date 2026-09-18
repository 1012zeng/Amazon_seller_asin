import { describe, expect, it, vi } from "vitest";
import { normalizeStoreSnapshot, parseExactResultTotal, parseVisibleLastPage, validateNextStoreUrl } from "../../src/amazon/parsing.js";
import { validateStoreResponseEnvelope } from "../../src/browser/fetch.js";
import { AdaptiveConcurrencyController, isPeerRecoveryInterruption, recoveryPlan, selectDispatchableTasks, SingleFlight, StartRateLimiter } from "../../src/browser/store-scheduler.js";
import { RunDatabase } from "../../src/database/run-database.js";
import { RunStore } from "../../src/database/run-store.js";
import { occurrence, pageResult, runFixture } from "./helpers.js";

const MARKETPLACE = "https://www.amazon.de";
const MARKETPLACE_ID = "A1PA6795UKMFR9";

function items(sellerId: string, count: number, page: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => occurrence(sellerId, `B${String(offset + index).padStart(9, "0")}`, { page, position: index + 1 }));
}

describe("single-session store scheduling", () => {
  it("starts requests no faster than two per second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new StartRateLimiter(2);
    const starts: number[] = [];
    const requests = Array.from({ length: 3 }, async () => { await limiter.acquire(); starts.push(Date.now()); });
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(requests);
    expect(starts).toEqual([0, 500, 1_000]);
    vi.useRealTimers();
  });

  it("keeps one page per seller while filling capacity with different sellers", () => {
    const tasks = [
      { sellerId: "A", crawlRound: 1 as const, page: 1, url: "a1" }, { sellerId: "A", crawlRound: 1 as const, page: 2, url: "a2" },
      { sellerId: "B", crawlRound: 1 as const, page: 1, url: "b1" }, { sellerId: "C", crawlRound: 1 as const, page: 1, url: "c1" },
    ];
    expect(selectDispatchableTasks(tasks, new Set(), new Set(), 3).map((task) => `${task.sellerId}:${task.page}`)).toEqual(["A:1", "B:1", "C:1"]);
    expect(selectDispatchableTasks(tasks, new Set(["A"]), new Set(), 3).map((task) => task.sellerId)).toEqual(["B", "C"]);
  });

  it("drops immediately to one and recovers one level per ten successes after cooldown", () => {
    const controller = new AdaptiveConcurrencyController({ initial: 3, min: 1, max: 3, successWindowPages: 10, cooldownMs: 60_000 });
    expect(controller.onSoftFailure(0)).toBe(2);
    expect(controller.onHardFailure(0)).toBe(1);
    for (let index = 0; index < 20; index += 1) controller.onSuccess(59_999);
    expect(controller.current).toBe(1);
    for (let index = 0; index < 10; index += 1) controller.onSuccess(60_000);
    expect(controller.current).toBe(2);
    for (let index = 0; index < 10; index += 1) controller.onSuccess(60_000);
    expect(controller.current).toBe(3);
  });

  it("coalesces recovery and orders refresh, two restarts, then proxy failover", async () => {
    const singleFlight = new SingleFlight();
    let releases!: () => void;
    let calls = 0;
    const operation = () => { calls += 1; return new Promise<void>((resolve) => { releases = resolve; }); };
    const first = singleFlight.run(operation);
    const peer = singleFlight.run(operation);
    expect(peer).toBe(first);
    expect(calls).toBe(1);
    releases();
    await Promise.all([first, peer]);
    expect(recoveryPlan(0, 4, 1, 2)).toEqual([
      { kind: "refresh", proxyIndex: 0 }, { kind: "restart", proxyIndex: 0 }, { kind: "restart", proxyIndex: 0 },
      { kind: "switch", proxyIndex: 1 }, { kind: "switch", proxyIndex: 2 }, { kind: "switch", proxyIndex: 3 },
    ]);
    expect(isPeerRecoveryInterruption(3, 4)).toBe(true);
    expect(isPeerRecoveryInterruption(4, 4)).toBe(false);
  });
});

describe("store response and pagination integrity", () => {
  it("parses exact totals and requires a strict next page on the same seller and marketplace", () => {
    expect(parseExactResultTotal("1-16 of 23 results")).toBe(23);
    expect(parseExactResultTotal("14 results")).toBe(14);
    expect(parseExactResultTotal("No approximate total here")).toBeNull();
    expect(parseVisibleLastPage(["Zurück", "1", "2", "3", "…", "98", "Weiter"])).toBe(98);
    expect(parseVisibleLastPage(["Zurück", "Weiter"])).toBeNull();
    const current = `${MARKETPLACE}/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=1`;
    expect(validateNextStoreUrl(`/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=2`, current, "A123456789", 1, MARKETPLACE, MARKETPLACE_ID)).toContain("page=2");
    expect(validateNextStoreUrl(`/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=3`, current, "A123456789", 1, MARKETPLACE, MARKETPLACE_ID)).toBe("");
    expect(validateNextStoreUrl(`/s?me=OTHER&marketplaceID=${MARKETPLACE_ID}&page=2`, current, "A123456789", 1, MARKETPLACE, MARKETPLACE_ID)).toBe("");
  });

  it("accepts HTTP 202 with valid search cards and marks a skipped Next as incomplete", () => {
    const current = `${MARKETPLACE}/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=1`;
    const result = normalizeStoreSnapshot({
      status: 202, url: current, blocked: false, hasSearch: true, zeroResults: false, displayedName: "Store",
      resultSummaryText: "1-1 of 2 results", nextHref: `/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}&page=3`, paginationTexts: ["1", "2"],
      cards: [{ asin: "B012345678", title: "P", listingHref: "/dp/B012345678", imageUrl: "", reviewText: "1", ratingText: "4", priceText: "9,99 €" }],
      responseBytes: 1_000, fetchMs: 20, contentType: "text/html", declaredLength: null,
    }, "A123456789", 1, MARKETPLACE, MARKETPLACE_ID);
    expect(result).toMatchObject({ kind: "success", httpStatus: 202, reportedTotal: 2, nextUrl: "", completenessError: "Invalid or non-sequential Next URL" });
  });

  it("keeps 404 terminal and treats blocked responses as blocked even if cards are present", () => {
    const base = {
      url: `${MARKETPLACE}/s?me=A123456789&marketplaceID=${MARKETPLACE_ID}`, hasSearch: true, zeroResults: false, displayedName: "", resultSummaryText: "1 result", nextHref: "", paginationTexts: [],
      cards: [{ asin: "B012345678", title: "P", listingHref: "/dp/B012345678", imageUrl: "", reviewText: "1", ratingText: "4", priceText: "9,99 €" }],
      responseBytes: 1_000, fetchMs: 20, contentType: "text/html", declaredLength: null,
    };
    expect(normalizeStoreSnapshot({ ...base, status: 404, blocked: false }, "A123456789", 1, MARKETPLACE, MARKETPLACE_ID).kind).toBe("unavailable");
    expect(normalizeStoreSnapshot({ ...base, status: 503, blocked: true }, "A123456789", 1, MARKETPLACE, MARKETPLACE_ID).kind).toBe("blocked");
  });

  it("rejects non-HTML and declared or actual bodies above 5 MiB", () => {
    const limit = 5_242_880;
    expect(() => validateStoreResponseEnvelope("application/json", null, 10, limit)).toThrow(/Content-Type/);
    expect(() => validateStoreResponseEnvelope("text/html", limit + 1, 10, limit)).toThrow(/declared/);
    expect(() => validateStoreResponseEnvelope("text/html; charset=UTF-8", null, limit + 1, limit)).toThrow(/actual/);
    expect(() => validateStoreResponseEnvelope("text/html; charset=UTF-8", 500, 1_000, limit)).not.toThrow();
  });
});

describe("store pagination and structural recovery", () => {
  it("persists different sellers correctly when their requests finish out of source order", () => {
    const { store } = runFixture();
    store.stores.applySuccess("B123456789", 1, 1, pageResult({ occurrences: [occurrence("B123456789", "B000000002")], signature: "b" }));
    store.stores.applySuccess("A123456789", 1, 1, pageResult({ occurrences: [occurrence("A123456789", "B000000001")], signature: "a" }));
    const stores = store.db.prepare("SELECT seller_id,status FROM source_stores ORDER BY source_row").all();
    expect(stores).toEqual([{ seller_id: "A123456789", status: "success" }, { seller_id: "B123456789", status: "success" }]);
    expect(store.db.prepare("SELECT seller_id,asin FROM store_asin_occurrences ORDER BY seller_id").all()).toEqual([
      { seller_id: "A123456789", asin: "B000000001" }, { seller_id: "B123456789", asin: "B000000002" },
    ]);
    store.close();
  });

  it("records exact evidence when a 16+7 page store happens to reconcile", () => {
    const { store } = runFixture();
    const sellerId = "A123456789";
    const nextUrl = `${MARKETPLACE}/s?me=${sellerId}&marketplaceID=${MARKETPLACE_ID}&page=2`;
    expect(store.stores.applySuccess(sellerId, 1, 1, pageResult({ occurrences: items(sellerId, 16, 1), signature: "p1", nextUrl, reportedTotal: 23 })).status).toBe("success");
    expect(store.pendingStorePages(10)).toContainEqual({ sellerId, crawlRound: 1, page: 2, url: nextUrl });
    expect(store.stores.applySuccess(sellerId, 1, 2, pageResult({ occurrences: items(sellerId, 7, 2, 16), signature: "p2", reportedTotal: 23 })).status).toBe("success");
    const source = store.db.prepare("SELECT status,page_count,completeness_evidence FROM source_stores WHERE seller_id=?").get(sellerId) as { status: string; page_count: number; completeness_evidence: string };
    expect(source).toMatchObject({ status: "success", page_count: 2 });
    expect(JSON.parse(source.completeness_evidence)).toMatchObject({ exact: true, structural: true, reportedTotal: 23, occurrenceCount: 23, uniqueAsins: 23 });
    const metadata = store.db.prepare("SELECT http_status,response_bytes,fetch_ms,reported_total,endpoint_port FROM store_pages WHERE seller_id=? AND crawl_round=1 AND page=2").get(sellerId);
    expect(metadata).toMatchObject({ http_status: 200, response_bytes: 1_000, fetch_ms: 100, reported_total: 23, endpoint_port: 7901 });
    store.close();
  });

  it.each([
    ["missing_reported_total", pageResult({ occurrences: [occurrence("A123456789", "B000000001")], reportedTotal: null })],
    ["count_mismatch", pageResult({ occurrences: [occurrence("A123456789", "B000000001")], reportedTotal: 2 })],
  ])("keeps best-effort results without blocking for %s", (reasonCode, result) => {
    const { store } = runFixture();
    expect(store.stores.applySuccess("A123456789", 1, 1, result).status).toBe("success");
    const source = store.db.prepare("SELECT status,crawl_round,completeness_evidence FROM source_stores WHERE seller_id='A123456789'").get() as { status: string; crawl_round: number; completeness_evidence: string };
    expect(source).toMatchObject({ status: "success", crawl_round: 1 });
    expect(JSON.parse(source.completeness_evidence)).toMatchObject({ crawlRound: 1, exact: false, structural: true, reasonCode, occurrenceCount: 1 });
    expect(store.stores.occurrenceCount()).toBe(1);
    expect(store.stores.failedStores()).toHaveLength(0);
    store.close();
  });

  it("freezes page 1 at 98 pages and never schedules page 99 or another round", () => {
    const { store } = runFixture();
    const sellerId = "A123456789";
    for (let page = 1; page <= 98; page += 1) {
      const nextUrl = `${MARKETPLACE}/s?me=${sellerId}&marketplaceID=${MARKETPLACE_ID}&page=${page + 1}`;
      const applied = store.stores.applySuccess(sellerId, 1, page, pageResult({
        occurrences: items(sellerId, 1, page, page),
        signature: `p${page}`,
        reportedTotal: 98,
        visibleLastPage: 98,
        nextUrl,
      }));
      expect(applied.status).toBe("success");
    }
    const source = store.db.prepare("SELECT status,crawl_round,pagination_mode,expected_last_page,page_count,pagination_warning_count,completeness_evidence FROM source_stores WHERE seller_id=?").get(sellerId) as Record<string, unknown>;
    expect(source).toMatchObject({ status: "success", crawl_round: 1, pagination_mode: "fixed_total", expected_last_page: 98, page_count: 98, pagination_warning_count: 1 });
    expect(JSON.parse(String(source.completeness_evidence))).toMatchObject({ traversalComplete: true, boundarySource: "fixed_total", expectedLastPage: 98, fetchedPages: 98 });
    expect(store.db.prepare("SELECT 1 FROM store_pages WHERE seller_id=? AND page=99").get(sellerId)).toBeUndefined();
    expect(store.db.prepare("SELECT 1 FROM store_pages WHERE seller_id=? AND crawl_round=2").get(sellerId)).toBeUndefined();
    expect(JSON.parse((store.db.prepare("SELECT warnings_json FROM store_pages WHERE seller_id=? AND page=98").get(sellerId) as { warnings_json: string }).warnings_json)).toContainEqual(expect.objectContaining({ code: "next_beyond_last_page" }));
    store.close();
  });

  it("recovers a missing Next with a canonical seller page URL without weakening the frozen boundary", () => {
    const { store } = runFixture();
    const sellerId = "A123456789";
    const broken = pageResult({ occurrences: items(sellerId, 1, 1), signature: "p1", reportedTotal: 3, visibleLastPage: 3 });
    const first = store.stores.applySuccess(sellerId, 1, 1, broken);
    expect(first.status).toBe("success");
    expect(first.warnings).toContainEqual(expect.objectContaining({ code: "canonical_next_recovery" }));
    expect(store.pendingStorePages(10)).toContainEqual({
      sellerId, crawlRound: 1, page: 2,
      url: `${MARKETPLACE}/s?me=${sellerId}&marketplaceID=${MARKETPLACE_ID}&page=2`,
    });
    store.close();
  });

  it("still retries and seals partial when an intermediate page is genuinely empty", () => {
    const { store } = runFixture();
    const sellerId = "A123456789";
    const broken = pageResult({ occurrences: [], signature: "empty", reportedTotal: 0, visibleLastPage: 3, zeroResults: true });
    expect(store.stores.applySuccess(sellerId, 1, 1, broken).status).toBe("retry");
    expect(store.stores.applySuccess(sellerId, 1, 1, broken).status).toBe("incomplete");
    const source = store.db.prepare("SELECT status,completeness_evidence FROM source_stores WHERE seller_id=?").get(sellerId) as Record<string, unknown>;
    expect(source).toMatchObject({ status: "partial" });
    expect(JSON.parse(String(source.completeness_evidence))).toMatchObject({ traversalComplete: false, reasonCode: "missing_next_before_last_page" });
    store.close();
  });

  it("resumes the persisted next page in the same single pass", () => {
    const { store } = runFixture();
    const runDir = store.runDir;
    const sellerId = "A123456789";
    const page2Url = `${MARKETPLACE}/s?me=${sellerId}&marketplaceID=${MARKETPLACE_ID}&page=2`;
    store.stores.applySuccess(sellerId, 1, 1, pageResult({ occurrences: items(sellerId, 1, 1), signature: "p1", reportedTotal: 3, visibleLastPage: 3, nextUrl: page2Url }));
    store.close();

    const resumed = new RunStore(runDir);
    expect(resumed.pendingStorePages(10)).toContainEqual({ sellerId, crawlRound: 1, page: 2, url: page2Url });
    const page3Url = `${MARKETPLACE}/s?me=${sellerId}&marketplaceID=${MARKETPLACE_ID}&page=3`;
    resumed.stores.applySuccess(sellerId, 1, 2, pageResult({ occurrences: items(sellerId, 1, 2, 1), signature: "p2", reportedTotal: 3, visibleLastPage: 3, nextUrl: page3Url }));
    expect(resumed.stores.applySuccess(sellerId, 1, 3, pageResult({ occurrences: items(sellerId, 1, 3, 2), signature: "p3", reportedTotal: 3, visibleLastPage: 3 })).status).toBe("success");
    expect(resumed.stores.failedStores()).toHaveLength(0);
    expect(resumed.db.prepare("SELECT page_count FROM source_stores WHERE seller_id=?").get(sellerId)).toEqual({ page_count: 3 });
    resumed.close();
  });

  it("freezes the first-page boundary and persists drift and repeated-page warnings", () => {
    const { store } = runFixture();
    const sellerId = "A123456789";
    const page2Url = `${MARKETPLACE}/s?me=${sellerId}&marketplaceID=${MARKETPLACE_ID}&page=2`;
    const page3Url = `${MARKETPLACE}/s?me=${sellerId}&marketplaceID=${MARKETPLACE_ID}&page=3`;
    const page4Url = `${MARKETPLACE}/s?me=${sellerId}&marketplaceID=${MARKETPLACE_ID}&page=4`;
    store.stores.applySuccess(sellerId, 1, 1, pageResult({ occurrences: items(sellerId, 1, 1), signature: "same", nextUrl: page2Url, reportedTotal: 2, visibleLastPage: 3 }));
    const second = store.stores.applySuccess(sellerId, 1, 2, pageResult({ occurrences: items(sellerId, 1, 2, 1), signature: "same", nextUrl: page3Url, reportedTotal: 3, visibleLastPage: 170 }));
    expect(second.status).toBe("success");
    expect(second.warnings.map((item) => item.code)).toEqual(expect.arrayContaining(["repeated_page_signature", "visible_last_page_changed", "reported_total_changed"]));
    const third = store.stores.applySuccess(sellerId, 1, 3, pageResult({ occurrences: items(sellerId, 1, 3, 2), signature: "p3", nextUrl: page4Url, reportedTotal: 3, visibleLastPage: 89 }));
    expect(third.status).toBe("success");
    expect(third.warnings.map((item) => item.code)).toEqual(expect.arrayContaining(["visible_last_page_changed", "next_beyond_last_page"]));
    const source = store.db.prepare("SELECT status,crawl_round,pagination_mode,expected_last_page,page_count,pagination_warning_count,completeness_evidence FROM source_stores WHERE seller_id=?").get(sellerId) as Record<string, unknown>;
    expect(source).toMatchObject({ status: "success", crawl_round: 1, pagination_mode: "fixed_total", expected_last_page: 3, page_count: 3, pagination_warning_count: 6 });
    expect(JSON.parse(String(source.completeness_evidence))).toMatchObject({ exact: false, traversalComplete: true, expectedLastPage: 3, warningCodes: expect.arrayContaining(["repeated_page_signature", "visible_last_page_changed", "reported_total_changed", "next_beyond_last_page"]) });
    expect(store.db.prepare("SELECT 1 FROM store_pages WHERE seller_id=? AND page=4").get(sellerId)).toBeUndefined();
    expect(store.stores.completenessSummary()).toMatchObject({ storesWithWarnings: 1, totalWarnings: 6 });
    store.close();
  });

  it("uses Next fallback when no page total is visible and stops partial at its safety cap", () => {
    const { store } = runFixture();
    const sellerId = "A123456789";
    const config = store.getRunConfig();
    config.stores.fallbackMaxPagesPerStore = 2;
    store.db.prepare("UPDATE run_meta SET config_json=? WHERE singleton=1").run(JSON.stringify(config));
    const page2Url = `${MARKETPLACE}/s?me=${sellerId}&marketplaceID=${MARKETPLACE_ID}&page=2`;
    const page3Url = `${MARKETPLACE}/s?me=${sellerId}&marketplaceID=${MARKETPLACE_ID}&page=3`;
    const first = store.stores.applySuccess(sellerId, 1, 1, pageResult({ occurrences: items(sellerId, 1, 1), signature: "p1", nextUrl: page2Url, reportedTotal: 2 }));
    expect(first.boundary).toEqual({ mode: "next_fallback", expectedLastPage: null });
    expect(store.stores.applySuccess(sellerId, 1, 2, pageResult({ occurrences: items(sellerId, 1, 2, 1), signature: "p2", nextUrl: page3Url, reportedTotal: 2 })).status).toBe("incomplete");
    const source = store.db.prepare("SELECT status,pagination_mode,expected_last_page,page_count,completeness_evidence FROM source_stores WHERE seller_id=?").get(sellerId) as Record<string, unknown>;
    expect(source).toMatchObject({ status: "partial", pagination_mode: "next_fallback", expected_last_page: null, page_count: 2 });
    expect(JSON.parse(String(source.completeness_evidence))).toMatchObject({ traversalComplete: false, reasonCode: "fallback_page_cap", fetchedPages: 2 });
    expect(store.db.prepare("SELECT 1 FROM store_pages WHERE seller_id=? AND page=3").get(sellerId)).toBeUndefined();
    expect(store.db.prepare("SELECT 1 FROM store_pages WHERE seller_id=? AND crawl_round=2").get(sellerId)).toBeUndefined();
    store.close();
  });

  it.each([9, 13, 14, 15, 16, 17, 18])("refuses incompatible schema v%d without migrating it", (schemaVersion) => {
    const { store } = runFixture();
    const runDir = store.runDir;
    store.db.pragma(`user_version = ${schemaVersion}`);
    store.close();
    expect(() => new RunDatabase(runDir)).toThrow(new RegExp(`schema ${schemaVersion} is incompatible`, "i"));
    expect(() => new RunDatabase(runDir, { readonly: true })).toThrow(new RegExp(`schema ${schemaVersion} is incompatible`, "i"));
  });
});
