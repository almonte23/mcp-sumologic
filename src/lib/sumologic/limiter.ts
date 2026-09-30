// Sumo Logic rejects more than 4 API requests/second or 10 in flight per access
// key with `429 rate.limit.exceeded`. Skills fan out several searches in
// parallel (each polling once a second), so pace every call through one
// process-wide limiter instead of relying on retries after the fact.

export interface LimiterOptions {
  maxPerSecond: number;
  maxInFlight: number;
}

export class RateLimiter {
  private readonly minSpacingMs: number;
  private readonly maxInFlight: number;
  private inFlight = 0;
  private nextSlotAt = 0;
  private queue: Array<() => void> = [];

  constructor({ maxPerSecond, maxInFlight }: LimiterOptions) {
    this.minSpacingMs = maxPerSecond > 0 ? 1000 / maxPerSecond : 0;
    this.maxInFlight = Math.max(1, maxInFlight);
  }

  async run<T>(fn: () => PromiseLike<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      this.drain();
    }
  }

  private acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  private drain(): void {
    while (this.queue.length && this.inFlight < this.maxInFlight) {
      const now = Date.now();
      const startAt = Math.max(now, this.nextSlotAt);
      this.nextSlotAt = startAt + this.minSpacingMs;
      this.inFlight += 1;
      const resolve = this.queue.shift()!;
      const wait = startAt - now;
      if (wait > 0) {
        setTimeout(resolve, wait);
      } else {
        resolve();
      }
    }
  }
}
