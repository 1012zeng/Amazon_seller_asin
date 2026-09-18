import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { fixedSales7dWindow } from "../../src/mcp/client.js";
import { listingAgeDays, runFilterStage } from "../../src/stages/filter.js";
import { runSales7dStage } from "../../src/stages/sales-7d.js";
import { runDetailStage } from "../../src/stages/detail.js";
import { writeExcelExport, EXPORT_HEADERS, EXPORT_SHEET_NAMES } from "../../src/export/excel.js";
import type { Sales7dResult } from "../../src/shared/types.js";
import { runFixture, seedCandidates } from "./helpers.js";

function dateForAge(age: number): string { return new Date(Date.parse("2026-08-13T00:00:00Z") - age * 86400000).toISOString().slice(0, 10); }
function enrich(store: ReturnType<typeof runFixture>["store"], asin: string, date: string, sales: number | null, fulfillment = "FBA", variations: number | null = 3): void {
  store.db.prepare("INSERT INTO enrichments(asin,title,brand,brand_url,child_sales_30d,available_date,fulfillment,variation_count,enriched_at) VALUES(?,'标题','品牌','https://www.amazon.de/stores/example',?,?,?,?,'x')").run(asin, sales, date, fulfillment, variations);
  store.candidates.setState(asin, "mcp_ok");
  store.setStage("enrich", "completed");
}
function result(asin: string, outcome: "yes" | "No" = "yes", minimum = 3): Sales7dResult {
  const window = fixedSales7dWindow("2026-08-13");
  return { marketplace: "DE", asin, dataType: "prediction", ...window, dailySalesMinimum: minimum, complete: true, result: outcome,
    days: Array.from({ length: 7 }, (_, i) => ({ date: dateForAge(7 - i), sales: outcome === "yes" ? 0 : 100 })) };
}
describe("180-day all-candidate sales gate", () => {
  it("routes every eligible age and child-sales value through seven-day sales", async () => {
    const { store } = runFixture();
    try {
      const ages = [0, 30, 31, 180]; const sales = [null, 0, 99, 100, 200, 9999];
      const asins = seedCandidates(store, ages.length * sales.length);
      for (const [i, asin] of asins.entries()) enrich(store, asin, dateForAge(ages[Math.floor(i / sales.length)]!), sales[i % sales.length]!);
      expect(await runFilterStage(store)).toBe(0);
      expect(store.candidates.counts()).toEqual({ sales_pending: 24 });
      expect(store.exports.count()).toBe(0);
      const called: string[] = [];
      expect(await runSales7dStage(store, { health: async () => {}, sales7d: async (asin, date, minimum) => {
        expect(date).toBe("2026-08-13"); expect(minimum).toBe(3); called.push(asin); return result(asin, asin === asins[0] ? "No" : "yes");
      } })).toBe(0);
      expect(called).toEqual(asins);
      expect(store.candidates.counts()).toEqual({ filtered_sales: 1, retained: 23 });
      expect(store.exports.count()).toBe(23);
      expect(await runFilterStage(store)).toBe(0);
      expect(await runSales7dStage(store, { health: async () => {}, sales7d: async () => { throw new Error("completed task re-requested"); } })).toBe(0);
      expect(store.db.prepare("SELECT COUNT(*) n,SUM(attempt_count) attempts FROM sales_7d_tasks").get()).toEqual({ n: 24, attempts: 24 });
    } finally { store.close(); }
  });
  it.each([
    [dateForAge(181), "FBA", 3, "age_gt_180"], ["", "FBA", 3, "invalid_available_date"],
    ["2026-02-30", "FBA", 3, "invalid_available_date"], [dateForAge(-1), "FBA", 3, "future_available_date"],
    [dateForAge(10), "FBM", 3, "fulfillment_not_fba"], [dateForAge(10), "FBA", null, "variation_count_missing"],
    [dateForAge(10), "FBA", 4, "variation_count_gt_3"],
  ] as const)("rejects %s/%s/%s before sales", async (date, fulfillment, variations, reason) => {
    const { store } = runFixture();
    try {
      const [asin] = seedCandidates(store, 1); enrich(store, asin!, date, 9999, fulfillment, variations);
      expect(await runFilterStage(store)).toBe(0);
      expect(store.db.prepare("SELECT state,filter_reason FROM asin_candidates").get()).toEqual({ state: "filtered_non_sales", filter_reason: reason });
      expect(store.exports.count()).toBe(0);
    } finally { store.close(); }
  });
  it("keeps failed sales pending and resumes exactly once after an echo mismatch", async () => {
    const { store } = runFixture();
    try {
      const [asin] = seedCandidates(store, 1); enrich(store, asin!, dateForAge(180), 9999); await runFilterStage(store);
      expect(await runSales7dStage(store, { health: async () => {}, sales7d: async () => result(asin!, "yes", 6) })).toBe(2);
      expect(store.candidates.counts()).toEqual({ sales_pending: 1 }); expect(store.exports.count()).toBe(0);
      expect(store.sales.counts()).toEqual({ failed: 1 });
      expect(await runSales7dStage(store, { health: async () => {}, sales7d: async () => { throw new Error("timeout"); } })).toBe(2);
      expect(await runSales7dStage(store, { health: async () => {}, sales7d: async () => result(asin!) })).toBe(0);
      expect(store.db.prepare("SELECT attempt_count,state FROM sales_7d_tasks").get()).toEqual({ attempt_count: 3, state: "retained" });
      expect(store.exports.rows()[0]).toMatchObject({ child_sales_30d: 9999, sales_7d_minimum_met: "yes" });
    } finally { store.close(); }
  });
  it("exports retained products into 19 columns and exactly one of five age sheets", async () => {
    const { store } = runFixture();
    try {
      const ages = [0, 30, 31, 180]; const asins = seedCandidates(store, 4);
      asins.forEach((asin, i) => enrich(store, asin, dateForAge(ages[i]!), i === 0 ? null : 1000));
      await runFilterStage(store);
      await expect(writeExcelExport(store)).rejects.toThrow("detail");
      await runSales7dStage(store, { health: async () => {}, sales7d: async asin => result(asin) });
      await runDetailStage(store, { health: async () => {}, asinDetail: async asin => ({ marketplace: "DE", asin, features: ["特点一"], overviews: "详情" }) });
      const output = await writeExcelExport(store); const book = new ExcelJS.Workbook(); await book.xlsx.readFile(output);
      expect(book.worksheets.map(sheet => sheet.name)).toEqual([...EXPORT_SHEET_NAMES]);
      expect(book.worksheets.map(sheet => sheet.rowCount - 1)).toEqual([4, 2, 2, 0, 0]);
      expect(book.worksheets[0]!.getRow(1).values).toEqual([undefined, ...EXPORT_HEADERS]);
      for (const sheet of book.worksheets) expect(sheet.columnCount).toBe(19);
      for (let row = 2; row <= 5; row++) {
        expect(book.worksheets[0]!.getCell(row, 7).value).toBe("yes");
        expect(book.worksheets[0]!.getCell(row, 19).hyperlink).toBe("https://www.amazon.de/stores/example");
      }
      expect(listingAgeDays(dateForAge(180), store.getAsOfDate())).toBe(180);
      expect(store.database.integrityCheck()).toBe("ok");
    } finally { store.close(); }
  });
});
