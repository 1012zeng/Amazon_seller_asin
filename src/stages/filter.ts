import type { RunStore } from "../database/run-store.js";
import type { FilterCandidateRow } from "../database/repositories/candidate-repository.js";
import { appendEvent, truncateError, writeSummary } from "../shared/utils.js";

export function listingAgeDays(availableDate: string, asOfDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(availableDate)) return null;
  const available = new Date(`${availableDate}T00:00:00.000Z`);
  const asOf = new Date(`${asOfDate}T00:00:00.000Z`);
  if (!Number.isFinite(available.getTime()) || available.toISOString().slice(0, 10) !== availableDate) return null;
  return Math.floor((asOf.getTime() - available.getTime()) / 86_400_000);
}

function rejection(row: FilterCandidateRow, asOfDate: string, config: ReturnType<RunStore["getRunConfig"]>): { reason: string; age: number | null } | null {
  const age = listingAgeDays(row.available_date, asOfDate);
  if (age === null) return { reason: "invalid_available_date", age };
  if (age < 0) return { reason: "future_available_date", age };
  if (age > config.filters.maxAgeDays) return { reason: `age_gt_${config.filters.maxAgeDays}`, age };
  if (row.fulfillment !== "FBA") return { reason: "fulfillment_not_fba", age };
  if (row.variation_count === null) return { reason: "variation_count_missing", age };
  if (row.variation_count > config.filters.maxVariations) return { reason: `variation_count_gt_${config.filters.maxVariations}`, age };
  return null;
}

export async function runFilterStage(store: RunStore): Promise<number> {
  try {
    if (store.source.stageStatus("enrich") !== "completed") throw new Error("Filter requires completed enrichment stage");
    store.setStage("filter", "running");
    const config = store.getRunConfig();
    const asOfDate = store.getAsOfDate();
    const rows = store.candidates.filterRows();
    store.db.transaction(() => {
      for (const row of rows) {
        const excluded = rejection(row, asOfDate, config);
        if (excluded) {
          store.candidates.setState(row.asin, "filtered_non_sales", "filter", excluded.reason, excluded.age);
          store.exports.remove(row.asin);
          continue;
        }
        const age = listingAgeDays(row.available_date, asOfDate)!;
        store.candidates.setState(row.asin, "sales_pending", "", "", age);
      }
    })();
    store.setStage("filter", "completed");
    appendEvent(store.runDir, "filter_completed", { candidates: store.candidates.counts(), cleanedProducts: store.exports.count() });
    writeSummary(store);
    return 0;
  } catch (error) {
    store.setStage("filter", "failed", truncateError(error));
    appendEvent(store.runDir, "filter_failed", { error: truncateError(error) });
    writeSummary(store);
    return 1;
  }
}
