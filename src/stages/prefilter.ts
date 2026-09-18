import type { RunStore } from "../database/run-store.js";
import { appendEvent, truncateError, writeSummary } from "../shared/utils.js";

export async function runPrefilterStage(store: RunStore): Promise<number> {
  try {
    if (!store.storeStageIsTerminal()) throw new Error("Prefilter requires every store page to be terminal");
    store.setStage("prefilter", "running");
    store.source.sealStoreSnapshot();
    const failedStores = store.stores.failedStores();
    store.source.setPartial(failedStores.length > 0);
    const counts = store.candidates.prefilter();
    store.setStage("prefilter", "completed");
    appendEvent(store.runDir, "prefilter_completed", { ...counts, reasons: store.candidates.prefilterReasonCounts(), partial: failedStores.length > 0 });
    writeSummary(store);
    return 0;
  } catch (error) {
    store.setStage("prefilter", "failed", truncateError(error));
    appendEvent(store.runDir, "prefilter_failed", { error: truncateError(error) });
    writeSummary(store);
    return 1;
  }
}
