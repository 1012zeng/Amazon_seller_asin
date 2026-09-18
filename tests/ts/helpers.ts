import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { RunStore } from "../../src/database/run-store.js";
import { loadConfig, projectRoot } from "../../src/shared/config.js";
import type { AppConfig, StoreAsinOccurrence, StorePageParseResult } from "../../src/shared/types.js";
export function runFixture(): { store: RunStore; config: AppConfig; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "de-seller-v18-"));
  const source = path.join(root, "source.xlsx");
  const configPath = path.join(root, "config.yaml");
  writeFileSync(source, "fixture");
  const raw = YAML.parse(readFileSync(path.join(projectRoot, "config/amazon-de.yaml"), "utf8"));
  raw.source = { path: source, sheet: "卖家数据", limit: 0 };
  raw.browser.headed = false;
  raw.browser.navigationTimeoutMs = 1000; raw.browser.requestTimeoutMs = 1000;
  raw.browser.wafWaitSeconds = 0; raw.browser.noResponseTimeoutMs = 2000; raw.browser.recoveryDelayMs = 0;
  raw.stores.maxRetries = 2; raw.stores.maxBlockedAttempts = 2; raw.stores.blockedDelayMs = 0;
  raw.stores.proxyPorts = [1, 2, 3, 4]; raw.sellerSprite.requestTimeoutMs = 1000;
  raw.output.root = root;
  writeFileSync(configPath, YAML.stringify(raw));
  const config = loadConfig(configPath);
  const store = new RunStore(path.join(root, "run"));
  const sellers = ["A123456789", "B123456789"].map((sellerId, i) => ({
    sellerId, sourceRow: i + 2, sourceName: i === 0 ? "First" : "Second",
    sourceUrl: `https://www.amazon.de/s?me=${sellerId}`,
    profileUrl: `https://www.amazon.de/sp?marketplaceID=A1PA6795UKMFR9&seller=${sellerId}`,
    storeUrl: `https://www.amazon.de/s?me=${sellerId}&marketplaceID=A1PA6795UKMFR9`,
  }));
  store.source.initializeSellers("run", config, { sellers, rows: [], sourceHash: createHash("sha256").update("fixture").digest("hex"), stats: {
    format: "seller_library", sourceRows: 2, duplicateRows: 0, duplicateAsins: 0, duplicateSellers: 0,
    uniqueProducts: 0, uniqueStores: 2, selectedStores: 2, blankRows: 0, appliedLimit: 0,
  } }, "2026-08-13T01:02:03.000Z");
  return { store, config, root };
}

export function occurrence(sellerId: string, asin: string, patch: Partial<StoreAsinOccurrence> = {}): StoreAsinOccurrence {
  return { sellerId, asin, page: 1, position: 1, title: asin, listingProductUrl: "", productUrl: `https://www.amazon.de/dp/${asin}`, imageUrl: "https://example.invalid/amazon.jpg", reviewCount: 100, rating: 4, priceText: "10,00 €", priceCents: 1000, ...patch };
}

export function pageResult(patch: Partial<StorePageParseResult> & Pick<StorePageParseResult, "occurrences">): StorePageParseResult {
  return {
    kind: "success", error: "", displayedName: "", nextUrl: "", signature: "page", zeroResults: false,
    httpStatus: 200, responseBytes: 1_000, fetchMs: 100, reportedTotal: patch.occurrences.length,
    visibleLastPage: null, endpointPort: 7901, completenessError: "", ...patch,
  };
}

export function seedCandidates(store: RunStore, count: number, historyCompleted = true): string[] {
  const asins = Array.from({ length: count }, (_, index) => `B${String(index).padStart(9, "0")}`);
  const now = "2026-08-13T01:02:03.000Z";
  const insertOccurrence = store.db.prepare(`INSERT INTO store_asin_occurrences(seller_id,asin,crawl_round,page,position,title,product_url,review_count,rating,price_text,price_cents,captured_at) VALUES('A123456789',?,1,1,?,?,?,100,4,'10,00 €',1000,?)`);
  const insertCandidate = store.db.prepare("INSERT INTO asin_candidates(asin,seller_id,occurrence_id,state,price_cents,created_at,updated_at) VALUES(?,'A123456789',?,'mcp_pending',1000,?,?)");
  store.db.transaction(() => asins.forEach((asin, index) => {
    const result = insertOccurrence.run(asin, index + 1, asin, `https://www.amazon.de/dp/${asin}`, now);
    insertCandidate.run(asin, Number(result.lastInsertRowid), now, now);
  }))();
  store.setStage("prefilter", "completed");
  if (historyCompleted) store.setStage("history_filter", "skipped");
  else store.setStage("history_filter", "pending");
  return asins;
}
