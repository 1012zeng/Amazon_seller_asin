import { describe, expect, it } from "vitest";
import type { CompetitorLookupResult } from "../../src/shared/types.js";
import { runEnrichmentStage } from "../../src/stages/enrich.js";
import { runFixture, seedCandidates } from "./helpers.js";

function response(asins: string[], successCount = 0): CompetitorLookupResult {
  return { marketplace: "DE", requested: asins.length, succeeded: successCount, missing: asins.length - successCount, errors: 0, partial: successCount !== asins.length, items: asins.map((asin, index) => ({ asin, status: index < successCount ? "ok" : "not_found", title: index < successCount ? `Title ${asin}` : "", nodeLabelPath: index < successCount ? "Home & Kitchen:Storage" : "", brand: index < successCount ? `Brand ${asin}` : "", brandUrl: index < successCount ? `https://www.amazon.de/stores/${asin}` : "", imageUrl: "", bsrRank: null, childSales30d: index < successCount ? 100 : null, availableDate: index < successCount ? "2026-08-01" : "", fulfillment: index < successCount ? "FBA" : "", variationCount: index < successCount ? 1 : null, buyboxSellerId: "", buyboxSellerName: "", errorCode: "", errorMessage: "" })) };
}

describe("two-round MCP batching", () => {
  it("materializes 40/tail batches and stops after two empty round-2 batches", async () => {
    const { store } = runFixture();
    seedCandidates(store, 85);
    const calls: Array<{ roundLike: number; size: number }> = [];
    const code = await runEnrichmentStage(store, { health: async () => undefined, competitorLookup: async (asins) => {
      calls.push({ roundLike: calls.length, size: asins.length });
      return response(asins, calls.length <= 3 ? 0 : 0);
    } });
    expect(code).toBe(0);
    expect(calls.map((call) => call.size)).toEqual([40, 40, 5, 40, 40]);
    expect(store.candidates.counts()).toEqual({ mcp_unavailable: 85 });
    const skipped = store.db.prepare("SELECT COUNT(*) count FROM mcp_batches WHERE round=2 AND state='skipped'").get() as { count: number };
    expect(skipped.count).toBe(1);
    store.close();
  });

  it("resumes the same deterministic batch after a temporary failure", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 45);
    let attempt = 0;
    const client = { health: async () => undefined, competitorLookup: async (asins: string[]) => {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary");
      return response(asins, asins.length);
    } };
    expect(await runEnrichmentStage(store, client)).toBe(2);
    const failedItems = store.db.prepare("SELECT asin FROM mcp_batch_items WHERE round=1 AND batch_ordinal=1 ORDER BY item_ordinal").all() as Array<{ asin: string }>;
    expect(failedItems).toHaveLength(40);
    expect(await runEnrichmentStage(store, client)).toBe(0);
    expect(store.candidates.counts()).toEqual({ mcp_ok: 45 });
    expect(store.db.prepare("SELECT title,node_label_path,brand,brand_url FROM enrichments WHERE asin=?").get(asins[0])).toEqual({
      title: `Title ${asins[0]}`, node_label_path: "Home & Kitchen:Storage", brand: `Brand ${asins[0]}`, brand_url: `https://www.amazon.de/stores/${asins[0]}`,
    });
    expect(store.db.prepare("SELECT title,category,brand,brand_url,child_sales_30d,available_date,fulfillment,variation_count FROM asin_candidates WHERE asin=?").get(asins[0])).toEqual({
      title: `Title ${asins[0]}`, category: "Home & Kitchen:Storage", brand: `Brand ${asins[0]}`, brand_url: `https://www.amazon.de/stores/${asins[0]}`, child_sales_30d: 100, available_date: "2026-08-01", fulfillment: "FBA", variation_count: 1,
    });
    expect((store.db.prepare("SELECT attempt_count FROM mcp_batches WHERE round=1 AND batch_ordinal=1").get() as { attempt_count: number }).attempt_count).toBe(2);
    store.close();
  });

  it("does not business-commit responses containing upstream_error", async () => {
    const { store } = runFixture();
    const [asin] = seedCandidates(store, 1);
    const code = await runEnrichmentStage(store, { health: async () => undefined, competitorLookup: async () => ({ ...response([asin!], 0), missing: 0, errors: 1, items: [{ ...response([asin!]).items[0]!, status: "upstream_error" }] }) });
    expect(code).toBe(2);
    expect(store.candidates.counts()).toEqual({ mcp_pending: 1 });
    expect(store.exports.count()).toBe(0);
    store.close();
  });

  it("recovers an empty round-2 streak from the persisted ledger", async () => {
    const { store } = runFixture();
    const asins = seedCandidates(store, 85);
    store.enrichments.materialize(1, asins, 40);
    for (;;) {
      const batch = store.enrichments.nextBatch(1);
      if (!batch) break;
      store.enrichments.beginBatch(batch);
      store.enrichments.commitBatch(batch, response(batch.asins));
    }
    store.enrichments.materialize(2, store.candidates.listAsinsByState("round1_not_found"), 40);
    const first = store.enrichments.nextBatch(2)!;
    store.enrichments.beginBatch(first);
    store.enrichments.commitBatch(first, response(first.asins));
    expect(store.enrichments.consecutiveEmptyRound2()).toBe(1);
    let calls = 0;
    expect(await runEnrichmentStage(store, { health: async () => undefined, competitorLookup: async (batch) => { calls += 1; return response(batch); } })).toBe(0);
    expect(calls).toBe(1);
    expect(store.candidates.counts()).toEqual({ mcp_unavailable: 85 });
    store.close();
  });
});
