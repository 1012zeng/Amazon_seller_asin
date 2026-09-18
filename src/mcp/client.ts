import type { AppConfig, AsinDetailResult, CompetitorLookupItem, CompetitorLookupResult, Sales7dResult } from "../shared/types.js";

export class McpClientError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = "McpClientError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpClientError(`MCP response schema changed: ${label}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, nullable = false): string {
  if (nullable && (value === null || value === undefined)) return "";
  if (typeof value !== "string") throw new McpClientError(`MCP response schema changed: ${label}`);
  return value.trim();
}

function nullableText(value: unknown, label: string): string {
  if (value === null) return "";
  if (typeof value !== "string") throw new McpClientError(`MCP response schema changed: ${label}`);
  return value.trim();
}

function integer(value: unknown, label: string, nullable = false): number | null {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new McpClientError(`MCP response schema changed: ${label}`);
  return Number(value);
}

function isoDate(value: unknown, label: string, nullable = false): string {
  const result = text(value, label, nullable);
  if (!result && nullable) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || new Date(`${result}T00:00:00.000Z`).toISOString().slice(0, 10) !== result) throw new McpClientError(`MCP response schema changed: ${label}`);
  return result;
}

function url(value: unknown, label: string): string {
  const result = text(value, label, true);
  if (!result) return "";
  try {
    const parsed = new URL(result);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    return parsed.toString();
  } catch { throw new McpClientError(`MCP response schema changed: ${label}`); }
}

function nullableUrl(value: unknown, label: string, baseUrl?: string): string {
  if (value === null) return "";
  if (typeof value !== "string") throw new McpClientError(`MCP response schema changed: ${label}`);
  const result = value.trim();
  if (!result) return "";
  try {
    const isSingleSlashPath = result.startsWith("/") && !result.startsWith("//");
    const parsed = baseUrl && isSingleSlashPath
      ? new URL(result, baseUrl)
      : new URL(result);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    if (baseUrl && isSingleSlashPath && parsed.origin !== new URL(baseUrl).origin) throw new Error();
    return parsed.toString();
  } catch { throw new McpClientError(`MCP response schema changed: ${label}`); }
}

function stringArrayOrNull(value: unknown, label: string): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new McpClientError(`MCP response schema changed: ${label}`);
  return [...value];
}

function rawTextOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new McpClientError(`MCP response schema changed: ${label}`);
  return value;
}

function addUtcDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function fixedSales7dWindow(asOfDate: string): { asOfDate: string; windowStart: string; windowEnd: string } {
  isoDate(asOfDate, "as_of_date");
  return { asOfDate, windowStart: addUtcDays(asOfDate, -7), windowEnd: addUtcDays(asOfDate, -1) };
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof McpClientError) {
    if (error.httpStatus) return false;
    const message = error.message;
    return message.includes("MCP request failed") || message.includes("MCP request timed out");
  }
  return false;
}

async function requestJson(config: AppConfig, pathname: string, init: RequestInit): Promise<unknown> {
  const maxRetries = 3;
  const baseDelayMs = 2000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new McpClientError(`MCP request timed out: ${pathname}`)), config.sellerSprite.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(`${config.sellerSprite.serviceUrl}${pathname}`, { ...init, signal: controller.signal });
      } catch (error) {
        lastError = error instanceof McpClientError ? error : new McpClientError(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!isRetryableError(lastError) || attempt === maxRetries) throw lastError;
        continue;
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new McpClientError(`MCP service returned non-JSON HTTP ${response.status}`, response.status);
      }
      if (response.status !== 200) throw new McpClientError(`MCP service returned HTTP ${response.status}`, response.status);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export class SellerSpriteClient {
  constructor(private readonly config: AppConfig) {}

  async health(): Promise<void> {
    const body = object(await requestJson(this.config, "/healthz", { method: "GET" }), "health body");
    if (body.status !== "ok") throw new McpClientError("MCP health check did not return status=ok");
  }

  async competitorLookup(asins: string[]): Promise<CompetitorLookupResult> {
    if (asins.length < 1 || asins.length > this.config.sellerSprite.batchSize) throw new Error(`Lookup batch must contain 1..${this.config.sellerSprite.batchSize} ASINs`);
    const requested = asins.map((asin) => asin.toUpperCase());
    const root = object(await requestJson(this.config, "/v1/competitor-lookup", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marketplace: this.config.sellerSprite.marketplace, asins: requested }),
    }), "lookup body");
    if (!text(root.request_id, "request_id") || text(root.marketplace, "marketplace").toUpperCase() !== this.config.sellerSprite.marketplace) throw new McpClientError("MCP lookup request ID or marketplace is invalid");
    if (!Array.isArray(root.items) || root.items.length !== requested.length) throw new McpClientError("MCP lookup does not account for every ASIN");
    const items: CompetitorLookupItem[] = root.items.map((value, index) => {
      const item = object(value, `items[${index}]`);
      const asin = text(item.asin, `items[${index}].asin`).toUpperCase();
      if (asin !== requested[index]) throw new McpClientError("MCP response ASIN order or value changed");
      if (item.status !== "ok" && item.status !== "not_found" && item.status !== "upstream_error") throw new McpClientError(`MCP response schema changed: items[${index}].status`);
      const fulfillment = text(item.fulfillment, `items[${index}].fulfillment`, true).toUpperCase();
      if (fulfillment && fulfillment !== "FBA" && fulfillment !== "FBM") throw new McpClientError(`MCP response schema changed: items[${index}].fulfillment`);
      return {
        asin,
        status: item.status,
        title: nullableText(item.title, `items[${index}].title`),
        nodeLabelPath: nullableText(item.nodeLabelPath, `items[${index}].nodeLabelPath`),
        brand: nullableText(item.brand, `items[${index}].brand`),
        brandUrl: nullableUrl(item.brandUrl, `items[${index}].brandUrl`, this.config.amazon.marketplace),
        imageUrl: url(item.image_url, `items[${index}].image_url`),
        bsrRank: integer(item.bsr_rank, `items[${index}].bsr_rank`, true),
        childSales30d: integer(item.child_sales_30d, `items[${index}].child_sales_30d`, true),
        availableDate: isoDate(item.available_date, `items[${index}].available_date`, true),
        fulfillment,
        variationCount: integer(item.variation_count, `items[${index}].variation_count`, true),
        buyboxSellerId: text(item.buybox_seller_id, `items[${index}].buybox_seller_id`, true),
        buyboxSellerName: text(item.buybox_seller_name, `items[${index}].buybox_seller_name`, true),
        errorCode: text(item.error_code, `items[${index}].error_code`, true),
        errorMessage: text(item.error_message, `items[${index}].error_message`, true),
      };
    });
    const success = items.filter((item) => item.status === "ok").length;
    const missing = items.filter((item) => item.status === "not_found").length;
    const errors = items.filter((item) => item.status === "upstream_error").length;
    const counts = { requested: integer(root.request_count, "request_count")!, success: integer(root.success_count, "success_count")!, missing: integer(root.not_found_count, "not_found_count")!, errors: integer(root.error_count, "error_count")! };
    if (counts.requested !== requested.length || counts.success !== success || counts.missing !== missing || counts.errors !== errors || typeof root.partial !== "boolean" || root.partial !== (success !== requested.length)) throw new McpClientError("MCP lookup counters do not match items");
    return { marketplace: this.config.sellerSprite.marketplace, requested: counts.requested, succeeded: success, missing, errors, partial: root.partial, items };
  }

  async sales7d(asin: string, asOfDate: string, dailySalesMinimum: number): Promise<Sales7dResult> {
    if (!Number.isSafeInteger(dailySalesMinimum) || dailySalesMinimum < 1) throw new Error("dailySalesMinimum must be an integer >= 1");
    const window = fixedSales7dWindow(asOfDate);
    const root = object(await requestJson(this.config, "/v1/asin-sales/last-7-days", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marketplace: this.config.sellerSprite.marketplace, asin, as_of_date: asOfDate, daily_sales_minimum: dailySalesMinimum }),
    }), "sales-7d body");
    if (!text(root.request_id, "request_id") || text(root.marketplace, "marketplace").toUpperCase() !== this.config.sellerSprite.marketplace || text(root.asin, "asin").toUpperCase() !== asin || root.data_type !== "prediction") throw new McpClientError("MCP sales-7d identity or data type is invalid");
    if (root.window_start !== window.windowStart || root.window_end !== window.windowEnd) throw new McpClientError("MCP sales-7d window does not match fixed run window");
    if (integer(root.daily_sales_minimum, "daily_sales_minimum") !== dailySalesMinimum) throw new McpClientError("MCP sales-7d daily minimum does not match the request");
    if (!Array.isArray(root.dailyItemList) || root.dailyItemList.length !== 7 || typeof root.complete !== "boolean") throw new McpClientError("MCP sales-7d must contain complete and exactly seven days");
    const days = root.dailyItemList.map((value, index) => {
      const item = object(value, `dailyItemList[${index}]`);
      const date = isoDate(item.date, `dailyItemList[${index}].date`);
      if (date !== addUtcDays(window.windowStart, index)) throw new McpClientError("MCP sales-7d dates do not match the fixed window");
      const sales = integer(item.sales, `dailyItemList[${index}].sales`, true);
      return { date, sales };
    });
    if (root.result !== "yes" && root.result !== "No") throw new McpClientError("MCP sales-7d result must be exact yes or No");
    return { marketplace: this.config.sellerSprite.marketplace, asin, dataType: "prediction", ...window, dailySalesMinimum, complete: root.complete, result: root.result, days };
  }

  async asinDetail(asin: string): Promise<AsinDetailResult> {
    const requested = asin.trim().toUpperCase();
    const root = object(await requestJson(this.config, "/v1/asin-detail", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marketplace: this.config.sellerSprite.marketplace, asin: requested }),
    }), "asin-detail body");
    if (!text(root.request_id, "request_id") || text(root.marketplace, "marketplace").toUpperCase() !== this.config.sellerSprite.marketplace || text(root.asin, "asin").toUpperCase() !== requested) {
      throw new McpClientError("MCP asin-detail identity is invalid");
    }
    return {
      marketplace: this.config.sellerSprite.marketplace,
      asin: requested,
      features: stringArrayOrNull(root.features, "features"),
      overviews: rawTextOrNull(root.overviews, "overviews"),
    };
  }
}
