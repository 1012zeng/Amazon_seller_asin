import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { AppConfig } from "./types.js";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid config section: ${label}`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`Invalid config value: ${label}`);
  return value.trim();
}

function number(value: unknown, label: string, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw new Error(`Invalid numeric config value: ${label}`);
  return value;
}

function integer(value: unknown, label: string, min = 0): number {
  const result = number(value, label, min);
  if (!Number.isInteger(result)) throw new Error(`Config value must be an integer: ${label}`);
  return result;
}

function ports(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item) || item < 1 || item > 65_535)) throw new Error(`Invalid proxy ports: ${label}`);
  return value as number[];
}

function resolveProjectPath(value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(projectRoot, value);
}

export interface ConfigOverrides { inputPath?: string; limit?: number }

export function loadConfig(configFile = existsSync(path.join(projectRoot, "config/local.yaml")) ? "config/local.yaml" : "config/amazon-de.yaml", overrides: ConfigOverrides = {}): AppConfig {
  const configPath = resolveProjectPath(configFile);
  const sourceText = readFileSync(configPath, "utf8");
  const raw = object(YAML.parse(sourceText), "root");
  const source = object(raw.source, "source");
  const amazon = object(raw.amazon, "amazon");
  const browser = object(raw.browser, "browser");
  const stores = object(raw.stores, "stores");
  const storeConcurrency = object(stores.concurrency, "stores.concurrency");
  const sellerSprite = object(raw.sellerSprite, "sellerSprite");
  const filters = object(raw.filters, "filters");
  const output = object(raw.output, "output");
  if (Object.hasOwn(filters, "minPredictedSales7dExclusive")) throw new Error("filters.minPredictedSales7dExclusive was removed; sales-7d filtering uses exact result=yes or No");
  if (Object.hasOwn(filters, "minRatingExclusive")) throw new Error("filters.minRatingExclusive was replaced by minRatingInclusive");
  for (const removed of ["priceTierBoundaryCents", "minChildSales30d", "highTierMinChildSales30d", "lowTierDailySalesMinimum", "highTierDailySalesMinimum", "maxNewAgeDays", "firstSalesBandMaxAgeDays", "secondSalesBandMaxAgeDays", "firstSalesBandMinChildSales30d", "secondSalesBandMinChildSales30d", "thirdSalesBandMinChildSales30d", "newListingDailySalesMinimum"]) {
    if (Object.hasOwn(filters, removed)) throw new Error(`filters.${removed} was removed; all eligible listings now require the sales-7d gate`);
  }

  const config: AppConfig = {
    projectRoot,
    configPath,
    configHash: createHash("sha256").update(sourceText).digest("hex"),
    source: {
      path: resolveProjectPath(string(overrides.inputPath ?? source.path, "source.path")),
      sheet: string(source.sheet, "source.sheet"),
      limit: integer(overrides.limit ?? source.limit, "source.limit"),
    },
    amazon: {
      marketplace: string(amazon.marketplace, "amazon.marketplace").replace(/\/$/, ""),
      site: string(amazon.site, "amazon.site"),
      marketplaceId: string(amazon.marketplaceId, "amazon.marketplaceId"),
      postcode: string(amazon.postcode, "amazon.postcode"),
      currency: string(amazon.currency, "amazon.currency").toUpperCase() as "EUR",
    },
    browser: {
      headed: browser.headed !== false,
      executablePath: string(browser.executablePath ?? "", "browser.executablePath", true),
      controlPath: string(browser.controlPath, "browser.controlPath"),
      navigationTimeoutMs: integer(browser.navigationTimeoutMs, "browser.navigationTimeoutMs", 1_000),
      requestTimeoutMs: integer(browser.requestTimeoutMs, "browser.requestTimeoutMs", 1_000),
      wafWaitSeconds: integer(browser.wafWaitSeconds, "browser.wafWaitSeconds"),
      pageRefreshAttempts: integer(browser.pageRefreshAttempts ?? 1, "browser.pageRefreshAttempts", 1),
      browserRestartAttempts: integer(browser.browserRestartAttempts ?? 2, "browser.browserRestartAttempts", 1),
      noResponseTimeoutMs: integer(browser.noResponseTimeoutMs ?? 60_000, "browser.noResponseTimeoutMs", 1_000),
      recoveryDelayMs: integer(browser.recoveryDelayMs ?? 5_000, "browser.recoveryDelayMs"),
    },
    stores: {
      concurrency: {
        initial: integer(storeConcurrency.initial, "stores.concurrency.initial", 1),
        min: integer(storeConcurrency.min, "stores.concurrency.min", 1),
        max: integer(storeConcurrency.max, "stores.concurrency.max", 1),
        successWindowPages: integer(storeConcurrency.successWindowPages, "stores.concurrency.successWindowPages", 1),
        cooldownMs: integer(storeConcurrency.cooldownMs, "stores.concurrency.cooldownMs"),
      },
      requestsPerSecond: number(stores.requestsPerSecond, "stores.requestsPerSecond", 0.1),
      maxResponseBytes: integer(stores.maxResponseBytes, "stores.maxResponseBytes", 1),
      maxRetries: integer(stores.maxRetries, "stores.maxRetries", 1),
      maxBlockedAttempts: integer(stores.maxBlockedAttempts, "stores.maxBlockedAttempts", 1),
      blockedDelayMs: integer(stores.blockedDelayMs, "stores.blockedDelayMs"),
      maxPagesPerStore: integer(stores.maxPagesPerStore, "stores.maxPagesPerStore"),
      fallbackMaxPagesPerStore: integer(stores.fallbackMaxPagesPerStore ?? 400, "stores.fallbackMaxPagesPerStore", 1),
      proxyPorts: ports(stores.proxyPorts, "stores.proxyPorts"),
    },
    sellerSprite: {
      serviceUrl: string(sellerSprite.serviceUrl, "sellerSprite.serviceUrl").replace(/\/$/, ""),
      marketplace: string(sellerSprite.marketplace, "sellerSprite.marketplace").toUpperCase(),
      batchSize: integer(sellerSprite.batchSize, "sellerSprite.batchSize", 1),
      requestTimeoutMs: integer(sellerSprite.requestTimeoutMs, "sellerSprite.requestTimeoutMs", 1_000),
    },
    filters: {
      maxReviewCountExclusive: integer(filters.maxReviewCountExclusive, "filters.maxReviewCountExclusive"),
      minRatingInclusive: number(filters.minRatingInclusive, "filters.minRatingInclusive"),
      minPriceCentsInclusive: integer(filters.minPriceCentsInclusive, "filters.minPriceCentsInclusive"),
      maxPriceCentsInclusive: integer(filters.maxPriceCentsInclusive, "filters.maxPriceCentsInclusive"),
      maxVariations: integer(filters.maxVariations, "filters.maxVariations"),
      maxAgeDays: integer(filters.maxAgeDays, "filters.maxAgeDays"),
      sales7dDailySalesMinimum: integer(filters.sales7dDailySalesMinimum, "filters.sales7dDailySalesMinimum", 1),
    },
    output: { root: resolveProjectPath(string(output.root, "output.root")) },
  };

  if (config.amazon.marketplace !== "https://www.amazon.de" || config.amazon.site !== "amazon.de" || config.amazon.marketplaceId !== "A1PA6795UKMFR9") throw new Error("Amazon DE marketplace contract cannot be changed");
  if (config.amazon.postcode !== "10115") throw new Error("amazon.postcode must remain 10115");
  if (config.amazon.currency !== "EUR") throw new Error("amazon.currency must remain EUR");
  if (!config.source.sheet) throw new Error("source.sheet must not be empty");
  if (!path.isAbsolute(config.source.path) || !existsSync(config.source.path)) throw new Error(`Source Excel does not exist: ${config.source.path}`);
  const concurrency = config.stores.concurrency;
  if (concurrency.min > concurrency.initial || concurrency.initial > concurrency.max || concurrency.max !== 3) throw new Error("stores.concurrency must satisfy min <= initial <= max, with max fixed at 3");
  if (config.stores.proxyPorts.length !== 4) throw new Error("stores.proxyPorts must contain the four ordered failover ports");
  if (![2, 3].includes(config.stores.requestsPerSecond) || config.stores.maxResponseBytes !== 5_242_880) throw new Error("Store request contract allows 2 requests/second (or rollout fallback 3) with a 5 MiB response limit");
  if (config.sellerSprite.serviceUrl !== "http://127.0.0.1:8012" || config.sellerSprite.marketplace !== "DE" || config.sellerSprite.batchSize !== 40) throw new Error("SellerSprite contract must remain DE, http://127.0.0.1:8012, batch size 40");
  const expected = config.filters;
  if (expected.maxReviewCountExclusive !== 300 || expected.minRatingInclusive !== 3.5 || expected.minPriceCentsInclusive !== 799 || expected.maxPriceCentsInclusive !== 6000 || expected.maxVariations !== 3 || expected.maxAgeDays !== 180 || expected.sales7dDailySalesMinimum !== 3) {
    throw new Error("Filtering rules are part of the run contract and cannot be changed");
  }
  return config;
}
