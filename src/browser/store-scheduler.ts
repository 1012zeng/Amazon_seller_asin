import { sleep } from "../shared/utils.js";

export interface StoreTask { sellerId: string; crawlRound: 1 | 2; page: number; url: string }

export function isPeerRecoveryInterruption(taskGeneration: number, currentGeneration: number): boolean {
  return taskGeneration !== currentGeneration;
}

export function selectDispatchableTasks(tasks: StoreTask[], activeSellers: ReadonlySet<string>, activeKeys: ReadonlySet<string>, capacity: number): StoreTask[] {
  const selected: StoreTask[] = [];
  const sellers = new Set(activeSellers);
  for (const task of tasks) {
    if (selected.length >= capacity) break;
    const key = `${task.sellerId}:${task.crawlRound}:${task.page}`;
    if (sellers.has(task.sellerId) || activeKeys.has(key)) continue;
    selected.push(task);
    sellers.add(task.sellerId);
  }
  return selected;
}

export class SingleFlight {
  private flight: Promise<void> | null = null;

  run(operation: () => Promise<void>): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = operation().finally(() => { this.flight = null; });
    return this.flight;
  }
}

export function recoveryPlan(currentProxyIndex: number, proxyCount: number, refreshAttempts: number, restartAttempts: number): Array<{ kind: "refresh" | "restart" | "switch"; proxyIndex: number }> {
  const plan: Array<{ kind: "refresh" | "restart" | "switch"; proxyIndex: number }> = [];
  for (let attempt = 0; attempt < refreshAttempts; attempt += 1) plan.push({ kind: "refresh", proxyIndex: currentProxyIndex });
  for (let attempt = 0; attempt < restartAttempts; attempt += 1) plan.push({ kind: "restart", proxyIndex: currentProxyIndex });
  for (let offset = 1; offset < proxyCount; offset += 1) plan.push({ kind: "switch", proxyIndex: (currentProxyIndex + offset) % proxyCount });
  return plan;
}

export class StartRateLimiter {
  private readonly intervalMs: number;
  private nextStartAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(requestsPerSecond: number) {
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) throw new Error("requestsPerSecond must be positive");
    this.intervalMs = Math.ceil(1_000 / requestsPerSecond);
  }

  acquire(): Promise<void> {
    const turn = this.queue.then(async () => {
      const waitMs = Math.max(0, this.nextStartAt - Date.now());
      if (waitMs > 0) await sleep(waitMs);
      this.nextStartAt = Date.now() + this.intervalMs;
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }
}

export class AdaptiveConcurrencyController {
  private value: number;
  private successfulPages = 0;
  private cooldownUntil = 0;

  constructor(private readonly options: { initial: number; min: number; max: number; successWindowPages: number; cooldownMs: number }) {
    this.value = options.initial;
  }

  get current(): number { return this.value; }

  onSoftFailure(now = Date.now()): number {
    this.value = Math.max(this.options.min, this.value - 1);
    this.successfulPages = 0;
    this.cooldownUntil = now + this.options.cooldownMs;
    return this.value;
  }

  onHardFailure(now = Date.now()): number {
    this.value = this.options.min;
    this.successfulPages = 0;
    this.cooldownUntil = now + this.options.cooldownMs;
    return this.value;
  }

  onSuccess(now = Date.now()): number {
    if (now < this.cooldownUntil || this.value >= this.options.max) return this.value;
    this.successfulPages += 1;
    if (this.successfulPages >= this.options.successWindowPages) {
      this.value = Math.min(this.options.max, this.value + 1);
      this.successfulPages = 0;
    }
    return this.value;
  }
}
