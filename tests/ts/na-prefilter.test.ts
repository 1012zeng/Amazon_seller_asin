import { describe, expect, it, vi } from "vitest";
import { DOMParser } from "linkedom";
import type { Page } from "playwright";
import ExcelJS from "exceljs";
import { parseCount, parseRating, parseStorePage, normalizeStoreSnapshot } from "../../src/amazon/parsing.js";
import { fetchStoreSnapshot } from "../../src/browser/fetch.js";
import { runFilterStage } from "../../src/stages/filter.js";
import { runSales7dStage } from "../../src/stages/sales-7d.js";
import { runDetailStage } from "../../src/stages/detail.js";
import { fixedSales7dWindow } from "../../src/mcp/client.js";
import { writeExcelExport } from "../../src/export/excel.js";
import { occurrence, pageResult, runFixture } from "./helpers.js";

describe("NA review/rating prefilter", () => {
  it("does not confuse price links or new-product age text with review counts in either extractor", async () => {
    const url = "https://www.amazon.de/s?me=A123456789&marketplaceID=A1PA6795UKMFR9";
    const html = `<html><body><div id="search">${[false, true].map((hasReviews, i) => `
      <div data-component-type="s-search-result" data-asin="B00000000${i}">
        <h2>Product</h2>
        <a class="s-underline-text" aria-describedby="price-link"><span class="a-price"><span class="a-offscreen">13,49 €</span></span></a>
        <div data-cy="reviews-block">${hasReviews
          ? `<i class="a-icon-star-small"><span class="a-icon-alt">4,5 von 5 Sternen</span></i><a href="/dp/B000000001#customerReviews"><span class="s-underline-text">(299)</span></a>`
          : `<span>Neu auf Amazon im letzten Monat</span>`}</div>
      </div>`).join("")}</div></body></html>`;
    const expected = [{ reviewCount: null, rating: null, priceCents: 1349 }, { reviewCount: 299, rating: 4.5, priceCents: 1349 }];
    const offline = parseStorePage(html, 200, url, "A123456789", 1, "https://www.amazon.de", "A1PA6795UKMFR9");
    expect(offline.occurrences.map(({ reviewCount, rating, priceCents }) => ({ reviewCount, rating, priceCents }))).toEqual(expected);
    vi.stubGlobal("DOMParser", DOMParser);
    vi.stubGlobal("fetch", async () => {
      const response = new Response(html, { headers: { "content-type": "text/html" } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    });
    try {
      const page = { evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg) } as unknown as Page;
      const snapshot = await fetchStoreSnapshot(page, url, 1000, 100_000);
      const live = normalizeStoreSnapshot(snapshot, "A123456789", 1, "https://www.amazon.de", "A1PA6795UKMFR9");
      expect(live.occurrences.map(({ reviewCount, rating, priceCents }) => ({ reviewCount, rating, priceCents }))).toEqual(expected);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(["NA", "N/A", "", null, undefined])("represents %s as null rather than zero", value => {
    expect(parseCount(value)).toBeNull(); expect(parseRating(value)).toBeNull();
  });

  it.each([
    { rating: null, reviewCount: 299, priceCents: 799, pass: true, reason: "eligible" },
    { rating: 3.5, reviewCount: null, priceCents: 6000, pass: true, reason: "eligible" },
    { rating: null, reviewCount: null, priceCents: 1000, pass: true, reason: "eligible" },
    { rating: null, reviewCount: 0, priceCents: 1000, pass: true, reason: "eligible" },
    { rating: 0, reviewCount: null, priceCents: 1000, pass: false, reason: "rating_lt_min" },
    { rating: 3.49, reviewCount: null, priceCents: 1000, pass: false, reason: "rating_lt_min" },
    { rating: null, reviewCount: 300, priceCents: 1000, pass: false, reason: "review_count_gte_max" },
    { rating: null, reviewCount: null, priceCents: null, pass: false, reason: "eur_price_missing" },
    { rating: null, reviewCount: null, priceCents: 798, pass: false, reason: "eur_price_lt_min" },
    { rating: null, reviewCount: null, priceCents: 6001, pass: false, reason: "eur_price_gt_max" },
  ])("applies each known field independently: $rating / $reviewCount / $priceCents", data => {
    const { store } = runFixture();
    try {
      store.stores.applySuccess("A123456789", 1, 1, pageResult({ occurrences: [occurrence("A123456789", "B000000001", data)] }));
      const before = store.db.prepare("SELECT review_count,rating,price_cents FROM store_asin_occurrences").get();
      expect(store.candidates.prefilter()).toEqual({ occurrenceCount: 1, eligibleOccurrences: data.pass ? 1 : 0, uniqueCandidates: data.pass ? 1 : 0 });
      expect(store.candidates.prefilterReasonCounts()).toEqual({ [data.reason]: 1 });
      expect(store.candidates.prefilter().eligibleOccurrences).toBe(data.pass ? 1 : 0);
      expect(store.db.prepare("SELECT review_count,rating,price_cents FROM store_asin_occurrences").get()).toEqual(before);
      if (data.pass) expect(store.db.prepare("SELECT review_count,rating FROM asin_candidates").get()).toEqual({ review_count: data.reviewCount, rating: data.rating });
    } finally { store.close(); }
  });

  it("persists nullable ratings/reviews through sales, detail and Excel without changing zero", async () => {
    const { store } = runFixture();
    try {
      const values = [{ rating: null, reviewCount: null }, { rating: 3.5, reviewCount: null }, { rating: null, reviewCount: 0 }];
      const asins = values.map((_, i) => `B00000000${i}`);
      store.stores.applySuccess("A123456789", 1, 1, pageResult({ occurrences: values.map((value, i) => occurrence("A123456789", asins[i]!, { ...value, position: i + 1 })) }));
      expect(store.candidates.prefilter().uniqueCandidates).toBe(3);
      for (const asin of asins) {
        store.db.prepare("INSERT INTO enrichments(asin,available_date,fulfillment,variation_count,enriched_at) VALUES(?,'2026-08-01','FBA',1,'x')").run(asin);
        store.candidates.setState(asin, "mcp_ok");
      }
      store.setStage("enrich", "completed");
      expect(await runFilterStage(store)).toBe(0);
      expect(store.exports.count()).toBe(0);
      expect(await runSales7dStage(store, { health: async () => {}, sales7d: async (asin, asOfDate, minimum) => ({
        marketplace: "DE", asin, dataType: "prediction", ...fixedSales7dWindow(asOfDate), dailySalesMinimum: minimum, complete: true, result: "yes", days: [],
      }) })).toBe(0);
      expect(store.db.prepare("SELECT review_count,rating FROM cleaned_products ORDER BY asin").all()).toEqual(values.map(value => ({ review_count: value.reviewCount, rating: value.rating })));
      expect(await runDetailStage(store, { health: async () => {}, asinDetail: async asin => ({ marketplace: "DE", asin, features: null, overviews: null }) })).toBe(0);
      const book = new ExcelJS.Workbook(); await book.xlsx.readFile(await writeExcelExport(store));
      for (const name of ["产品数据", "0-30天"]) {
        const sheet = book.getWorksheet(name)!;
        expect([sheet.getCell(2, 10).value, sheet.getCell(2, 11).value]).toEqual(["NA", "NA"]);
        expect([sheet.getCell(3, 10).value, sheet.getCell(3, 11).value]).toEqual(["NA", 3.5]);
        expect([sheet.getCell(4, 10).value, sheet.getCell(4, 11).value]).toEqual([0, "NA"]);
      }
      expect(store.db.prepare("SELECT review_count,rating FROM store_asin_occurrences ORDER BY asin").all()).toEqual(values.map(value => ({ review_count: value.reviewCount, rating: value.rating })));
      expect(store.database.integrityCheck()).toBe("ok");
    } finally { store.close(); }
  });
});
