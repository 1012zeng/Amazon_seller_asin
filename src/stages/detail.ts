import type { RunStore } from "../database/run-store.js";
import { SellerSpriteClient } from "../mcp/client.js";
import { appendEvent, truncateError, writeSummary } from "../shared/utils.js";

export async function runDetailStage(store: RunStore, client: Pick<SellerSpriteClient, "health" | "asinDetail"> = new SellerSpriteClient(store.getRunConfig())): Promise<number> {
  try {
    if (store.source.stageStatus("sales_7d") !== "completed") throw new Error("ASIN detail requires completed sales-7d stage");
    store.setStage("detail", "running");
    await client.health();
    store.details.materialize();
    for (;;) {
      const asin = store.details.next();
      if (!asin) break;
      try {
        const result = await client.asinDetail(asin);
        if (result.asin !== asin) throw new Error("ASIN detail response does not match the pending task");
        store.details.complete(result);
        appendEvent(store.runDir, "asin_detail_completed", { hasFeatures: result.features !== null, hasOverviews: result.overviews !== null });
      } catch (error) {
        store.details.fail(asin, error);
        throw error;
      }
    }
    if (!store.details.isTerminal()) throw new Error("ASIN detail tasks are not terminal");
    store.setStage("detail", "completed");
    appendEvent(store.runDir, "asin_detail_stage_completed", { counts: store.details.counts(), cleanedProducts: store.exports.count() });
    writeSummary(store);
    return 0;
  } catch (error) {
    store.setStage("detail", "paused", truncateError(error));
    appendEvent(store.runDir, "asin_detail_paused", { error: truncateError(error) });
    writeSummary(store);
    return 2;
  }
}
