import { normalizeStoreSnapshot } from "../amazon/parsing.js";
import { fetchStoreSnapshot } from "../browser/fetch.js";
import { StoreBrowserRuntime } from "../browser/store-runtime.js";
import { AdaptiveConcurrencyController, isPeerRecoveryInterruption, selectDispatchableTasks, StartRateLimiter } from "../browser/store-scheduler.js";
import type { RunStore } from "../database/run-store.js";
import { appendEvent, sleep, truncateError, writeSummary } from "../shared/utils.js";

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

export async function runStoreStage(store: RunStore): Promise<number> {
  const config = store.getRunConfig();
  if (!["skipped"].includes(store.source.stageStatus("seller_discovery"))) throw new Error("Store crawl requires terminal seller discovery");
  if (store.storeStageIsTerminal()) {
    const counts = store.storePageCounts();
    const partial = store.stores.failedStores().length > 0;
    store.setStage("stores", partial ? "partial" : "completed");
    appendEvent(store.runDir, "stores_completed", { counts, partial, resumed: true });
    writeSummary(store);
    return partial ? 2 : 0;
  }
  if (store.source.isStoreSnapshotSealed()) throw new Error("Store snapshot is sealed; failed stores require a new run");

  store.setStage("stores", "running");
  const controller = new AdaptiveConcurrencyController(config.stores.concurrency);
  const limiter = new StartRateLimiter(config.stores.requestsPerSecond);
  const runtime = new StoreBrowserRuntime(config, (event, payload) => appendEvent(store.runDir, event, payload));
  const active = new Map<string, Promise<void>>();
  const activeSellers = new Set<string>();
  const fetchDurations: number[] = [];
  let httpInFlight = 0;
  let interrupted = false;
  let fatal: Error | undefined;
  const onInterrupt = (): void => { interrupted = true; };
  process.once("SIGINT", onInterrupt);

  const persistRuntime = (): void => {
    runtime.setP95FetchMs(percentile95(fetchDurations));
    store.source.setStoreRuntimeMetrics(runtime.metrics());
  };

  const recoverSession = async (cause: unknown): Promise<void> => {
    const before = runtime.metrics();
    await runtime.recover(cause);
    const after = runtime.metrics();
    if (after.restartCount > before.restartCount || after.proxySwitchCount > before.proxySwitchCount) {
      const concurrency = controller.onHardFailure();
      appendEvent(store.runDir, "store_concurrency_reduced", { reason: "browser_restart_or_proxy_switch", concurrency });
    }
  };

  async function execute(task: { sellerId: string; crawlRound: 1 | 2; page: number; url: string }): Promise<void> {
    await limiter.acquire();
    const generation = runtime.generation;
    const endpointPort = runtime.endpointPort;
    try {
      httpInFlight += 1;
      runtime.observeConcurrency(httpInFlight);
      let snapshot: Awaited<ReturnType<typeof fetchStoreSnapshot>>;
      try {
        snapshot = await runtime.withNoResponseTimeout(() => fetchStoreSnapshot(
          runtime.amazon.page, task.url, config.browser.requestTimeoutMs, config.stores.maxResponseBytes,
        ));
      } finally {
        httpInFlight -= 1;
      }
      fetchDurations.push(snapshot.fetchMs);
      const parsed = {
        ...normalizeStoreSnapshot(snapshot, task.sellerId, task.page, config.amazon.marketplace, config.amazon.marketplaceId),
        endpointPort,
      };
      if (parsed.kind === "success") {
        const applied = store.applyStorePageSuccess(task.sellerId, task.crawlRound, task.page, parsed);
        if (applied.boundary) {
          appendEvent(store.runDir, "store_pagination_boundary_detected", {
            sellerId: task.sellerId,
            mode: applied.boundary.mode,
            expectedLastPage: applied.boundary.expectedLastPage,
          });
        }
        if (applied.applied && applied.warnings.length > 0) {
          appendEvent(store.runDir, "store_page_warning", {
            sellerId: task.sellerId,
            crawlRound: task.crawlRound,
            page: task.page,
            warnings: applied.warnings,
          });
        }
        if (applied.status === "retry" || applied.status === "incomplete") {
          const concurrency = controller.onSoftFailure();
          const event = applied.status === "retry" ? "store_page_completeness_retry" : "store_page_incomplete";
          appendEvent(store.runDir, event, { sellerId: task.sellerId, crawlRound: task.crawlRound, page: task.page, reason: applied.reason, resultSummaryText: snapshot.resultSummaryText.slice(0, 500), concurrency });
        } else {
          const concurrency = controller.onSuccess();
          appendEvent(store.runDir, applied.applied ? "store_page_success" : "duplicate_store_page_result", {
            sellerId: task.sellerId, crawlRound: task.crawlRound, page: task.page, results: parsed.occurrences.length, reportedTotal: parsed.reportedTotal,
            visibleLastPage: parsed.visibleLastPage, nextUrl: parsed.nextUrl, status: applied.status, endpointPort, fetchMs: parsed.fetchMs, concurrency,
          });
        }
        return;
      }

      const applied = store.applyStorePageFailure(task.sellerId, task.crawlRound, task.page, parsed.kind, parsed.error, parsed);
      appendEvent(store.runDir, "store_page_failure", { sellerId: task.sellerId, crawlRound: task.crawlRound, page: task.page, kind: parsed.kind, outcome: applied.status, error: parsed.error, endpointPort });
      if (parsed.kind === "blocked") {
        const concurrency = controller.onHardFailure();
        appendEvent(store.runDir, "store_concurrency_reduced", { reason: parsed.kind, concurrency });
        await recoverSession(parsed.error);
      }
    } catch (error) {
      if (isPeerRecoveryInterruption(generation, runtime.generation)) {
        appendEvent(store.runDir, "store_page_peer_requeued", { sellerId: task.sellerId, crawlRound: task.crawlRound, page: task.page, generation, currentGeneration: runtime.generation, error: truncateError(error) });
        return;
      }
      const applied = store.applyStorePageFailure(task.sellerId, task.crawlRound, task.page, "error", error);
      const hard = /HTTP\s+(?:429|503)|captcha|waf|browser.*closed|target page|context.*closed/i.test(String(error));
      const concurrency = hard ? controller.onHardFailure() : controller.onSoftFailure();
      appendEvent(store.runDir, "store_page_failure", { sellerId: task.sellerId, crawlRound: task.crawlRound, page: task.page, kind: "error", outcome: applied.status, error: truncateError(error), endpointPort, concurrency });
      await recoverSession(error);
    }
  }

  try {
    await runtime.start();
    while (!interrupted && !fatal && !store.storeStageIsTerminal()) {
      const capacity = Math.max(0, controller.current - active.size);
      if (capacity > 0) {
        const tasks = selectDispatchableTasks(store.pendingStorePages(100), activeSellers, new Set(active.keys()), capacity);
        for (const task of tasks) {
          const key = `${task.sellerId}:${task.crawlRound}:${task.page}`;
          activeSellers.add(task.sellerId);
          const promise = execute(task)
            .catch((error) => { fatal = error instanceof Error ? error : new Error(String(error)); })
            .finally(() => { active.delete(key); activeSellers.delete(task.sellerId); });
          active.set(key, promise);
        }
      }
      if (active.size > 0) await Promise.race([...active.values(), sleep(100)]);
      else await sleep(100);
    }
    await Promise.allSettled(active.values());
    persistRuntime();
    if (fatal) throw fatal;
    if (interrupted) {
      store.setStage("stores", "paused", "Interrupted by Ctrl+C");
      appendEvent(store.runDir, "stores_paused", { reason: "SIGINT" });
      writeSummary(store);
      return 130;
    }
    const counts = store.storePageCounts();
    const partial = store.stores.failedStores().length > 0;
    store.setStage("stores", partial ? "partial" : "completed");
    appendEvent(store.runDir, "stores_completed", { counts, partial, completeness: store.stores.completenessSummary(), runtime: runtime.metrics() });
    writeSummary(store);
    return partial ? 2 : 0;
  } catch (error) {
    persistRuntime();
    const failure = error instanceof Error ? error : new Error(String(error));
    store.setStage("stores", "failed", truncateError(failure));
    appendEvent(store.runDir, "stores_failed", { error: truncateError(failure) });
    writeSummary(store);
    return 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    await runtime.close().catch(() => undefined);
  }
}
