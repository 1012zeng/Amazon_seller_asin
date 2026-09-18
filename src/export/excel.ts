import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import type { RunStore } from "../database/run-store.js";
import type { AppConfig, ExportRow } from "../shared/types.js";
import { listingAgeDays } from "../stages/filter.js";

export const EXPORT_HEADERS = ["站点", "图片", "ASIN(超链)", "店铺", "卖家首页", "子体销量", "近7天是否日均3单+", "销售单价（EUR）", "上架时间", "评论数量", "评分", "配送方式", "变体数", "标题", "类目", "五点", "详情", "品牌", "品牌链接"] as const;
export const EXPORT_SHEET_NAMES = ["产品数据", "0-30天", "31-365天", "366-550天", "551-720天"] as const;
type ExportSheetName = (typeof EXPORT_SHEET_NAMES)[number];
type StreamingWorksheet = ReturnType<ExcelJS.stream.xlsx.WorkbookWriter["addWorksheet"]>;
const MAX_DATA_ROWS = 1_048_575;
const MAX_CELL_TEXT_LENGTH = 32_767;
const COLUMN_WIDTHS = [16, 42, 18, 26, 48, 14, 18, 18, 16, 14, 10, 14, 12, 52, 36, 64, 64, 24, 56] as const;
const BEIJING_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function beijingMinuteTimestamp(date: Date): string {
  const parts = Object.fromEntries(BEIJING_TIME_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
}

function hyperlink(text: string, target: string): ExcelJS.CellHyperlinkValue | string {
  return target ? { text, hyperlink: target } : text;
}

function checkedText(value: string, asin: string, label: string): string {
  if (value.length > MAX_CELL_TEXT_LENGTH) throw new Error(`Excel cell text exceeds 32767 characters: asin=${asin}, column=${label}`);
  return value;
}

function featureText(value: string | null, asin: string): string {
  if (value === null) return "";
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`Invalid features_json for ASIN ${asin}`); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error(`Invalid features_json for ASIN ${asin}`);
  return checkedText(parsed.join("\n"), asin, "五点");
}

function ageSheetName(row: ExportRow, asOfDate: string, config: AppConfig): Exclude<ExportSheetName, "产品数据"> {
  const age = listingAgeDays(row.date_first_available, asOfDate);
  if (age === null || age < 0 || age > config.filters.maxAgeDays) {
    throw new Error(`Export row is outside listing-age sheets: asin=${row.asin}, date=${row.date_first_available}, age=${age ?? "invalid"}`);
  }
  if (age <= 30) return "0-30天";
  if (age <= 365) return "31-365天";
  if (age <= 550) return "366-550天";
  return "551-720天";
}

function addExportSheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, name: ExportSheetName): StreamingWorksheet {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  sheet.columns = COLUMN_WIDTHS.map((width) => ({ width }));
  const header = sheet.addRow([...EXPORT_HEADERS]);
  header.height = 24;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  header.commit();
  return sheet;
}

function exportValues(row: ExportRow, config: AppConfig): ExcelJS.CellValue[] {
  return [
    hyperlink(row.site, config.amazon.marketplace), hyperlink(row.image_url, row.image_url), hyperlink(row.asin, row.product_url), row.store_name,
    hyperlink(row.store_url, row.store_url), row.child_sales_30d ?? "", row.sales_7d_minimum_met ?? "", row.unit_price_cents / 100,
    new Date(`${row.date_first_available}T00:00:00.000Z`), row.review_count, row.rating, row.fulfillment, row.variation_count,
    checkedText(row.title, row.asin, "标题"), checkedText(row.category, row.asin, "类目"), featureText(row.features_json, row.asin),
    checkedText(row.overviews ?? "", row.asin, "详情"), checkedText(row.brand, row.asin, "品牌"),
    hyperlink(checkedText(row.brand_url, row.asin, "品牌链接"), row.brand_url),
  ];
}

function addExportRow(sheet: StreamingWorksheet, values: ExcelJS.CellValue[]): void {
  const output = sheet.addRow(values);
  output.getCell(6).numFmt = "#,##0";
  output.getCell(8).numFmt = "€0.00";
  output.getCell(9).numFmt = "yyyy-mm-dd";
  output.getCell(10).numFmt = "#,##0";
  output.getCell(11).numFmt = "0.0";
  output.getCell(13).numFmt = "#,##0";
  output.eachCell((cell: ExcelJS.Cell) => { cell.alignment = { vertical: "top" }; });
  for (let column = 14; column <= 19; column += 1) output.getCell(column).alignment = { vertical: "top", wrapText: true };
  output.commit();
}

export async function writeExcelExport(store: RunStore, exportedAt = new Date()): Promise<string> {
  if (store.source.stageStatus("detail") !== "completed") throw new Error("Export requires completed ASIN detail stage");
  if (!store.enrichments.isTerminal() || !store.sales.isTerminal() || !store.details.isTerminal()) throw new Error("Export refused because downstream tasks are not terminal");
  const rows = store.exports.rows();
  if (rows.length > MAX_DATA_ROWS) throw new Error(`Excel row limit exceeded: ${rows.length} > ${MAX_DATA_ROWS}`);
  const config = store.getRunConfig();
  const exportDir = path.join(store.runDir, "exports");
  mkdirSync(exportDir, { recursive: true });
  const target = path.join(exportDir, `德国通过店铺去爬取ASIN-产品数据-${beijingMinuteTimestamp(exportedAt)}.xlsx`);
  const temporary = path.join(exportDir, `.export.${process.pid}.${Date.now()}.tmp.xlsx`);
  rmSync(temporary, { force: true });
  try {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: temporary, useStyles: true, useSharedStrings: false });
    const sheets = new Map<ExportSheetName, StreamingWorksheet>(
      EXPORT_SHEET_NAMES.map((name) => [name, addExportSheet(workbook, name)]),
    );
    const rowCounts = new Map<ExportSheetName, number>(EXPORT_SHEET_NAMES.map((name) => [name, 0]));
    const asOfDate = store.getAsOfDate();
    for (const row of rows) {
      const bandName = ageSheetName(row, asOfDate, config);
      const values = exportValues(row, config);
      addExportRow(sheets.get("产品数据")!, values);
      addExportRow(sheets.get(bandName)!, values);
      rowCounts.set("产品数据", rowCounts.get("产品数据")! + 1);
      rowCounts.set(bandName, rowCounts.get(bandName)! + 1);
    }
    const segmentedCount = EXPORT_SHEET_NAMES.slice(1).reduce((sum, name) => sum + rowCounts.get(name)!, 0);
    if (segmentedCount !== rows.length) throw new Error(`Export age-sheet row mismatch: total=${rows.length}, segmented=${segmentedCount}`);
    for (const name of EXPORT_SHEET_NAMES) {
      const sheet = sheets.get(name)!;
      sheet.autoFilter = { from: "A1", to: `S${rowCounts.get(name)! + 1}` };
      sheet.commit();
    }
    await workbook.commit();
    renameSync(temporary, target);
    return target;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
