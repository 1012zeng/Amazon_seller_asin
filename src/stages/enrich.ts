import type { RunStore } from "../database/run-store.js";
import { SellerSpriteClient } from "../mcp/client.js";
import { appendEvent, truncateError, writeSummary } from "../shared/utils.js";

export async function runEnrichmentStage(store: RunStore, client: Pick<SellerSpriteClient, "health" | "competitorLookup"> = new SellerSpriteClient(store.getRunConfig())): Promise<number> {
  try {
    if (store.source.stageStatus("prefilter") !== "completed" || store.source.stageStatus("history_filter") !== "skipped") throw new Error("Enrichment requires completed prefilter and explicitly skipped history filter");
    store.setStage("enrich", "running");
    await client.health();
    const config = store.getRunConfig();
    if (!store.enrichments.hasRound(1)) store.enrichments.materialize(1, store.candidates.listAsinsByState("mcp_pending"), config.sellerSprite.batchSize);
    for (const round of [1, 2] as const) {
      if (round === 2 && !store.enrichments.hasRound(2)) store.enrichments.materialize(2, store.candidates.listAsinsByState("round1_not_found"), config.sellerSprite.batchSize);
      for (;;) {
        if (round === 2 && store.enrichments.consecutiveEmptyRound2() >= 2) {
          const skipped = store.enrichments.stopRemainingRound2("two_consecutive_empty_batches");
          appendEvent(store.runDir, "mcp_round2_stopped", { reason: "two_consecutive_empty_batches", skipped, resumed: true });
          break;
        }
        const batch = store.enrichments.nextBatch(round);
        if (!batch) break;
        store.enrichments.beginBatch(batch);
        appendEvent(store.runDir, "mcp_batch_started", { round, batchOrdinal: batch.ordinal, count: batch.asins.length });
        try {
          const result = await client.competitorLookup(batch.asins);
          if (result.errors > 0) throw new Error(`MCP batch contains ${result.errors} upstream_error item(s)`);
          const successes = store.enrichments.commitBatch(batch, result);
          appendEvent(store.runDir, "mcp_batch_completed", { round, batchOrdinal: batch.ordinal, count: batch.asins.length, successes, notFound: result.missing });
          if (round === 2 && store.enrichments.consecutiveEmptyRound2() >= 2) {
            const skipped = store.enrichments.stopRemainingRound2("two_consecutive_empty_batches");
            appendEvent(store.runDir, "mcp_round2_stopped", { reason: "two_consecutive_empty_batches", skipped });
            break;
          }
        } catch (error) {
          store.enrichments.failBatch(batch, error);
          throw error;
        }
      }
    }
    if (!store.enrichments.isTerminal()) throw new Error("MCP batch ledger is not terminal");
    store.setStage("enrich", "completed");
    appendEvent(store.runDir, "enrichment_completed", { batches: store.enrichments.counts(), candidates: store.candidates.counts() });
    writeSummary(store);
    return 0;
  } catch (error) {
    store.setStage("enrich", "paused", truncateError(error));
    appendEvent(store.runDir, "enrichment_paused", { error: truncateError(error) });
    writeSummary(store);
    return 2;
  }
}
