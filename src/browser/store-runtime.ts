import { chromium, type Browser } from "playwright";
import type { AppConfig, StoreRuntimeMetrics } from "../shared/types.js";
import { sleep, truncateError } from "../shared/utils.js";
import { createAmazonContext, refreshAmazonSession, type AmazonContext } from "./context.js";
import { recoveryPlan, SingleFlight } from "./store-scheduler.js";

type EventWriter = (event: string, payload: Record<string, unknown>) => void;

export class StoreBrowserRuntime {
  private browser: Browser | null = null;
  private session: AmazonContext | null = null;
  private proxyIndex = 0;
  private generationValue = 0;
  private readonly recoverySingleFlight = new SingleFlight();
  private readonly counters: StoreRuntimeMetrics = {
    browserContexts: 0, browserPages: 0, maxObservedConcurrency: 0, p95FetchMs: 0,
    refreshCount: 0, restartCount: 0, proxySwitchCount: 0,
  };

  constructor(private readonly config: AppConfig, private readonly writeEvent: EventWriter) {}

  get amazon(): AmazonContext {
    if (!this.session) throw new Error("Amazon browser session is unavailable");
    return this.session;
  }

  get generation(): number { return this.generationValue; }
  get endpointPort(): number { return this.amazon.proxyPort; }
  metrics(): StoreRuntimeMetrics { return { ...this.counters }; }

  observeConcurrency(inFlight: number): void {
    this.counters.maxObservedConcurrency = Math.max(this.counters.maxObservedConcurrency, inFlight);
  }

  setP95FetchMs(value: number): void { this.counters.p95FetchMs = value; }

  private async closeCurrent(): Promise<void> {
    const session = this.session;
    const browser = this.browser;
    this.session = null;
    this.browser = null;
    if (session) await Promise.race([session.context.close().catch(() => undefined), sleep(5_000)]);
    if (browser) await Promise.race([browser.close().catch(() => undefined), sleep(5_000)]);
  }

  private async launchAt(index: number): Promise<void> {
    await this.closeCurrent();
    const port = this.config.stores.proxyPorts[index];
    if (!port) throw new Error(`Missing proxy port at failover index ${index}`);
    const browser = await chromium.launch({
      headless: !this.config.browser.headed,
      ...(this.config.browser.executablePath ? { executablePath: this.config.browser.executablePath } : {}),
    });
    this.browser = browser;
    try {
      this.session = await createAmazonContext(browser, this.config, port);
      this.proxyIndex = index;
      this.counters.browserContexts = Math.max(this.counters.browserContexts, 1);
      this.counters.browserPages = Math.max(this.counters.browserPages, 1);
      this.writeEvent("store_context_ready", { proxyPort: port, failoverIndex: index });
    } catch (error) {
      await this.closeCurrent();
      throw error;
    }
  }

  async start(): Promise<void> {
    let lastError: unknown = new Error("No proxy ports configured");
    for (let index = 0; index < this.config.stores.proxyPorts.length; index += 1) {
      if (index > 0) this.counters.proxySwitchCount += 1;
      try {
        await this.launchAt(index);
        return;
      } catch (error) {
        lastError = error;
        this.writeEvent("store_context_unavailable", { proxyPort: this.config.stores.proxyPorts[index], error: truncateError(error), initial: true });
      }
    }
    throw new Error(`All store proxy endpoints are unavailable: ${truncateError(lastError)}`);
  }

  async withNoResponseTimeout<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Browser request produced no response within ${this.config.browser.noResponseTimeoutMs} ms`)), this.config.browser.noResponseTimeoutMs);
    });
    try { return await Promise.race([operation(), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }

  recover(cause: unknown): Promise<void> {
    return this.recoverySingleFlight.run(async () => {
      this.generationValue += 1;
      await this.performRecovery(cause);
    });
  }

  private async performRecovery(cause: unknown): Promise<void> {
    this.writeEvent("store_recovery_started", { proxyPort: this.config.stores.proxyPorts[this.proxyIndex], cause: truncateError(cause) });
    const actions = recoveryPlan(this.proxyIndex, this.config.stores.proxyPorts.length, this.config.browser.pageRefreshAttempts, this.config.browser.browserRestartAttempts);
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const action = actions[actionIndex]!;
      try {
        if (action.kind === "refresh") {
          this.counters.refreshCount += 1;
          await refreshAmazonSession(this.amazon, this.config);
          this.writeEvent("store_session_refreshed", { proxyPort: this.endpointPort, attempt: actionIndex + 1 });
        } else {
          if (action.kind === "restart") this.counters.restartCount += 1;
          else this.counters.proxySwitchCount += 1;
          await this.launchAt(action.proxyIndex);
          this.writeEvent(action.kind === "restart" ? "store_browser_restarted" : "store_proxy_switched", { proxyPort: this.endpointPort, failoverIndex: action.proxyIndex });
        }
        return;
      } catch (error) {
        this.writeEvent(`store_${action.kind}_failed`, { proxyPort: this.config.stores.proxyPorts[action.proxyIndex], error: truncateError(error) });
        if (action.kind === "restart" && this.config.browser.recoveryDelayMs > 0) await sleep(this.config.browser.recoveryDelayMs);
      }
    }
    throw new Error("Store browser recovery exhausted every proxy endpoint");
  }

  async close(): Promise<void> {
    this.generationValue += 1;
    await this.closeCurrent();
  }
}
