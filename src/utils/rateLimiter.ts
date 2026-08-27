/**
 * Sliding-window request limiter.
 *
 * Bounds how fast jobs are *started*, which is a different constraint from
 * how many run at once: a job holds its address for about a minute but stays
 * alive for up to thirty-five, so an unbounded arrival rate would pile up
 * respond waits long after the address pool stopped being the bottleneck.
 */
export class RateLimiter {
  private readonly hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.hits.length > 0 && this.hits[0] <= cutoff) this.hits.shift();
  }

  /** Records a hit and reports whether it was allowed. */
  tryAcquire(now = Date.now()): boolean {
    this.prune(now);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }

  /** Milliseconds until the next slot frees up, or 0 if one is free now. */
  retryAfterMs(now = Date.now()): number {
    this.prune(now);
    // A zero limit is a supported way to freeze intake. No slot will ever
    // free, and `hits[0]` is undefined, so the arithmetic below would hand the
    // caller a NaN to put in a Retry-After header. A full window is the
    // honest answer: no wait is more correct than any other.
    if (this.limit <= 0) return this.windowMs;
    if (this.hits.length < this.limit) return 0;
    return Math.max(0, this.hits[0] + this.windowMs - now);
  }

  used(now = Date.now()): number {
    this.prune(now);
    return this.hits.length;
  }
}
