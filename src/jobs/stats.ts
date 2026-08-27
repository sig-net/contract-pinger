import type { BidirectionalService } from '../handlers/signBidirectional';
import type { JobRecord, JobState } from './store';

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
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
  };
};

const span = (from?: number, to?: number) =>
  from !== undefined && to !== undefined ? to - from : undefined;

const collect = (
  jobs: readonly JobRecord[],
  pick: (j: JobRecord) => number | undefined
) => jobs.map(pick).filter((v): v is number => v !== undefined);

/**
 * Signature latency and respond latency are reported separately because they
 * measure different things: one is the MPC signing, the other is the MPC
 * watching Ethereum reach finality. Lease-wait time is reported alongside so
 * that a saturated address pool reads as queueing rather than hiding inside
 * the end-to-end number.
 */
const latenciesFor = (jobs: readonly JobRecord[]) => ({
  leaseWaitMs: summarize(
    collect(jobs, j => span(j.timings.acceptedAt, j.timings.leaseAcquiredAt))
  ),
  signatureMs: summarize(
    collect(jobs, j => span(j.timings.signSentAt, j.timings.signatureAt))
  ),
  confirmationMs: summarize(
    collect(jobs, j => span(j.timings.broadcastAt, j.timings.confirmedAt))
  ),
  respondMs: summarize(
    collect(jobs, j => span(j.timings.confirmedAt, j.timings.respondedAt))
  ),
  // Successes only. A failure also sets `finishedAt`, and pool-exhaustion
  // failures finish in milliseconds, so including them drags the reported
  // median of a tens-of-minutes round trip toward zero. The per-stage figures
  // self-filter, since a failed job never reaches their closing timestamp.
  totalMs: summarize(
    collect(
      jobs.filter(j => j.state === 'responded'),
      j => span(j.timings.acceptedAt, j.timings.finishedAt)
    )
  ),
});

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
    jobs: {
      total: jobs.length,
      active: service.jobs.activeCount,
      awaitingRespond: service.jobs.awaitingRespondCount,
      live: service.jobs.liveCount,
      states: countBy(jobs.map(j => j.state as JobState)),
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
