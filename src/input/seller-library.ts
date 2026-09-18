import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { canonicalSellerProfileUrl, extractSellerId } from "../amazon/product-seller.js";
import type { SourceInputStats } from "../shared/types.js";

export interface SellerSeed {
  sellerId: string;
  sourceRow: number;
  sourceName: string;
  sourceUrl: string;
  profileUrl: string;
  storeUrl: string;
}
export interface SellerInputRow {
  sourceRow: number;
  rawName: string;
  rawLink: string;
  sellerId: string;
  status: "valid" | "duplicate" | "blank";
  firstSourceRow: number | null;
  selected: boolean;
}
export interface SellerLibraryInput {
  sellers: SellerSeed[];
  rows: SellerInputRow[];
  sourceHash: string;
  stats: SourceInputStats & { blankRows: number; selectedStores: number };
}

export async function readSellerLibrary(file: string, sheetName = "卖家数据", limit = 0): Promise<SellerLibraryInput> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("卖家数量限制必须是非负整数");
  const bytes = readFileSync(file);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`找不到工作表：${sheetName}`);
  const bySeller = new Map<string, SellerSeed>();
  const rows: SellerInputRow[] = [];
  const errors: string[] = [];
  for (let sourceRow = 2; sourceRow <= sheet.rowCount; sourceRow++) {
    const cell = sheet.getCell(sourceRow, 2);
    const rawName = cell.text;
    const value = cell.value;
    const rawLink = value && typeof value === "object" && "hyperlink" in value ? String(value.hyperlink) : rawName;
    if (!rawLink.trim() && !rawName.trim()) {
      rows.push({ sourceRow, rawName, rawLink, sellerId: "", status: "blank", firstSourceRow: null, selected: false });
      continue;
    }
    try {
      if (value && typeof value === "object" && !("hyperlink" in value)) throw new Error("B 列需要超链接、链接文本或卖家 ID，不支持公式或富文本");
      const text = rawLink.trim();
      let sellerId = "";
      if (/^[A-Z0-9]{10,20}$/.test(text)) sellerId = text;
      else {
        const url = new URL(text);
        if (!['https:', 'http:'].includes(url.protocol) || !["www.amazon.de", "amazon.de"].includes(url.hostname) || url.username || url.password) throw new Error("卖家链接必须属于 Amazon.de");
        sellerId = extractSellerId(text, "https://www.amazon.de") ?? "";
      }
      if (!sellerId) throw new Error("无法提取有效卖家 ID");
      const previous = bySeller.get(sellerId);
      rows.push({ sourceRow, rawName, rawLink, sellerId, status: previous ? "duplicate" : "valid", firstSourceRow: previous?.sourceRow ?? sourceRow, selected: false });
      if (!previous) bySeller.set(sellerId, {
        sellerId, sourceRow, sourceName: rawName.trim() || sellerId, sourceUrl: rawLink,
        profileUrl: canonicalSellerProfileUrl("https://www.amazon.de", "A1PA6795UKMFR9", sellerId),
        storeUrl: `https://www.amazon.de/s?me=${sellerId}&marketplaceID=A1PA6795UKMFR9`,
      });
    } catch (error) { errors.push(`第 ${sourceRow} 行：${error instanceof Error ? error.message : String(error)}`); }
  }
  if (errors.length) throw new Error(`源 Excel 校验失败（${errors.length} 行）：\n${errors.join("\n")}`);
  const all = [...bySeller.values()];
  if (!all.length) throw new Error("源 Excel B 列没有有效卖家");
  const sellers = limit ? all.slice(0, limit) : all;
  const selected = new Set(sellers.map(seller => seller.sellerId));
  for (const row of rows) row.selected = selected.has(row.sellerId);
  const duplicateRows = rows.filter(row => row.status === "duplicate").length;
  return { sellers, rows, sourceHash: createHash("sha256").update(bytes).digest("hex"), stats: {
    format: "seller_library", sourceRows: rows.length, duplicateRows, duplicateAsins: 0, duplicateSellers: duplicateRows,
    uniqueProducts: 0, uniqueStores: all.length, appliedLimit: limit,
    blankRows: rows.filter(row => row.status === "blank").length, selectedStores: sellers.length,
  } };
}
