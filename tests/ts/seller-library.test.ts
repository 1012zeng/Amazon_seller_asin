import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { readSellerLibrary } from "../../src/input/seller-library.js";
import { RunStore } from "../../src/database/run-store.js";
import { runFixture } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function workbook(values: ExcelJS.CellValue[]): Promise<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), "seller-input-")); roots.push(root);
  const file = path.join(root, "input.xlsx");
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("卖家数据");
  sheet.getCell("B1").value = "卖家名称";
  for (let i = 0; i < values.length; i++) { sheet.getCell(i + 2, 1).value = i + 1; sheet.getCell(i + 2, 2).value = values[i]!; }
  await book.xlsx.writeFile(file); return file;
}
describe("seller library B-column input", () => {
  it("prefers hyperlinks, retains source rows, deduplicates sellers and limits tasks only", async () => {
    const file = await workbook([
      { text: "First seller", hyperlink: "https://www.amazon.de/s?me=A123456789" },
      "A123456789", null, "https://www.amazon.de/sp?seller=B123456789", "C123456789",
    ]);
    const input = await readSellerLibrary(file, "卖家数据", 1);
    expect(input.stats).toMatchObject({ sourceRows: 5, uniqueStores: 3, selectedStores: 1, duplicateSellers: 1, blankRows: 1 });
    expect(input.sellers).toHaveLength(1);
    expect(input.sellers[0]).toMatchObject({ sellerId: "A123456789", sourceName: "First seller", sourceRow: 2 });
    expect(input.rows.map(row => [row.status, row.selected])).toEqual([["valid", true], ["duplicate", true], ["blank", false], ["valid", false], ["valid", false]]);
    const fixture = runFixture(); fixture.store.close();
    const store = new RunStore(path.join(fixture.root, "direct"));
    try {
      store.source.initializeSellers("direct", { ...fixture.config, source: { path: file, sheet: "卖家数据", limit: 1 } }, input);
      expect(store.products.counts()).toEqual({});
      expect(store.stores.pageCounts()).toEqual({ pending: 1 });
      expect(store.db.prepare("SELECT COUNT(*) n FROM source_seller_inputs").get()).toEqual({ n: 5 });
      expect(store.db.prepare("SELECT verified_source_asin,identity_status FROM source_stores").get()).toEqual({ verified_source_asin: "", identity_status: "direct_input" });
      expect(store.source.stageStatus("seller_discovery")).toBe("skipped");
      expect(store.source.stageStatus("history_filter")).toBe("skipped");
      expect(store.database.integrityCheck()).toBe("ok");
    } finally { store.close(); }
  });
  it.each(["https://www.amazon.com/s?me=A123456789", "https://amazon.de.example.invalid/s?me=A123456789", "seller name", "https://www.amazon.de/s?k=abc"])("rejects invalid input even beyond --limit: %s", async value => {
    const file = await workbook(["A123456789", value]);
    await expect(readSellerLibrary(file, "卖家数据", 1)).rejects.toThrow("第 3 行");
  });
  it("does not execute workbook formulas", async () => {
    const file = await workbook([{ formula: 'HYPERLINK("https://www.amazon.de/s?me=A123456789","name")', result: "name" }]);
    await expect(readSellerLibrary(file)).rejects.toThrow("不支持公式");
  });
  it("rejects missing worksheets and empty data", async () => {
    const file = await workbook([null]);
    await expect(readSellerLibrary(file, "missing")).rejects.toThrow("找不到工作表");
    await expect(readSellerLibrary(file)).rejects.toThrow("没有有效卖家");
  });
});
