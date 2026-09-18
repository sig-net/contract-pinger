import type { BidirectionalService } from '../handlers/signBidirectional';
import { durationsFor, type JobRecord } from './store';

const percentile = (sorted: number[], p: number): number | null => {
  if (sorted.length === 0) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length)
  );
  return sorted[index];
};

const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted.length > 0 ? sorted[0] : null,
    p05: percentile(sorted, 5),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
  };
};

const latenciesFor = (jobs: readonly JobRecord[]) => {
  const durations = jobs.map(job => {
    const result = durationsFor(job.timings);
    // Early failures must not lower the reported full-round-trip latency.
    if (job.state !== 'responded') delete result.totalMs;
    return result;
  });
  const metric = (name: string) =>
    summarize(
      durations.map(values => values[name]).filter(value => value !== undefined)
    );
  return {
    leaseWaitMs: metric('leaseWaitMs'),
    signatureMs: metric('signatureMs'),
    confirmationMs: metric('confirmationMs'),
    respondMs: metric('respondMs'),
    totalMs: metric('totalMs'),
  };
};

const countBy = <T extends string>(values: T[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
};

export const buildStats = (service: BidirectionalService) => {
  const jobs = service.jobs.all();
  const byMode: Record<string, unknown> = {};

  for (const mode of new Set(jobs.map(j => j.mode))) {
    const modeJobs = jobs.filter(j => j.mode === mode);
    byMode[mode] = {
      total: modeJobs.length,
      succeeded: modeJobs.filter(j => j.state === 'responded').length,
      failed: modeJobs.filter(j => j.state === 'failed').length,
      latencies: latenciesFor(modeJobs),
    };
  }

  return {
    environment: service.environment,
    sourceChain: service.sourceChain,
    jobs: {
      total: jobs.length,
      active: service.jobs.activeCount,
      awaitingRespond: service.jobs.awaitingRespondCount,
      live: service.jobs.liveCount,
      states: countBy(jobs.map(j => j.state)),
      failures: countBy(
        jobs
          .map(j => j.failureReason)
          .filter((r): r is NonNullable<typeof r> => r !== undefined)
      ),
    },
    rate: {
      usedInWindow: service.limiter.used(),
      retryAfterMs: service.limiter.retryAfterMs(),
    },
    pool: {
      size: service.pool.size,
      busy: service.pool.all().filter(w => w.busy).length,
      // Jobs parked for an address. Rising here means the pool is the
      // bottleneck, which lease-wait latency then quantifies.
      waiting: service.pool.waiting,
      underfunded: service.pool.all().filter(w => w.underfunded).length,
    },
    byMode,
  };
};
