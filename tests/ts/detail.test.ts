import { fixedSales7dWindow } from "../../src/mcp/client.js";
import { describe, expect, it } from "vitest";
import type { RunStore } from "../../src/database/run-store.js";
import { runDetailStage } from "../../src/stages/detail.js";
import { runFilterStage } from "../../src/stages/filter.js";
import { runSales7dStage } from "../../src/stages/sales-7d.js";
import { runFixture, seedCandidates } from "./helpers.js";

async function seedFinalProducts(store: RunStore, count: number): Promise<string[]> {
  const asins = seedCandidates(store, count);
  const insert = store.db.prepare("INSERT INTO enrichments(asin,title,node_label_path,image_url,child_sales_30d,available_date,fulfillment,variation_count,enriched_at) VALUES(?,?,?,'',200,'2026-07-13','FBA',1,'x')");
  store.db.transaction(() => {
    for (const asin of asins) {
      insert.run(asin, `Title ${asin}`, "Home & Kitchen:Storage");
      store.db.prepare("UPDATE asin_candidates SET state='mcp_ok' WHERE asin=?").run(asin);
    }
  })();
  store.setStage("enrich", "completed");
  expect(await runFilterStage(store)).toBe(0);
  expect(await runSales7dStage(store, { health: async () => undefined, sales7d: async (asin, asOfDate, dailySalesMinimum) => ({ marketplace: "DE", asin, dataType: "prediction", ...fixedSales7dWindow(asOfDate), dailySalesMinimum, complete: true, result: "yes", days: [] }) })).toBe(0);
  return asins;
}

describe("ASIN detail stage", () => {
  it("persists detail fields and resumes only the failed task", async () => {
    const { store } = runFixture();
    const [asin] = await seedFinalProducts(store, 1);
    let attempts = 0;
    const client = {
      health: async () => undefined,
      asinDetail: async (requested: string) => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary");
        return { marketplace: "DE" as const, asin: requested, features: ["First", "Second"], overviews: '{"Brand":"Example"}' };
      },
    };
    expect(await runDetailStage(store, client)).toBe(2);
    expect(store.exports.count()).toBe(1);
    expect(store.details.counts()).toEqual({ failed: 1 });
    expect(await runDetailStage(store, client)).toBe(0);
    expect(store.details.counts()).toEqual({ completed: 1 });
    expect(store.db.prepare("SELECT attempt_count FROM asin_detail_tasks WHERE asin=?").get(asin)).toEqual({ attempt_count: 2 });
    expect(store.exports.rows()[0]).toMatchObject({
      asin, title: `Title ${asin}`, category: "Home & Kitchen:Storage",
      features_json: '["First","Second"]', overviews: '{"Brand":"Example"}',
    });
    expect(store.db.prepare("SELECT detail_state,features_json,overviews FROM asin_candidates WHERE asin=?").get(asin)).toEqual({
      detail_state: "completed", features_json: '["First","Second"]', overviews: '{"Brand":"Example"}',
    });
    store.close();
  });

  it("completes valid null detail fields and leaves them blank", async () => {
    const { store } = runFixture();
    const [asin] = await seedFinalProducts(store, 1);
    expect(await runDetailStage(store, { health: async () => undefined, asinDetail: async () => ({ marketplace: "DE", asin: asin!, features: null, overviews: null }) })).toBe(0);
    expect(store.exports.rows()[0]).toMatchObject({ features_json: null, overviews: null });
    expect(store.summary()).toMatchObject({ asinDetailTaskStates: { completed: 1 } });
    store.close();
  });

  it("rejects a mismatched ASIN without writing another product", async () => {
    const { store } = runFixture();
    await seedFinalProducts(store, 1);
    expect(await runDetailStage(store, { health: async () => undefined, asinDetail: async () => ({ marketplace: "DE", asin: "B999999999", features: [], overviews: null }) })).toBe(2);
    expect(store.details.counts()).toEqual({ failed: 1 });
    expect(store.exports.rows()[0]).toMatchObject({ features_json: null, overviews: null });
    store.close();
  });
});
