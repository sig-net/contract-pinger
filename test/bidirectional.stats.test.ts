import { expect, it } from 'vitest';
import { BidirectionalService } from '../src/handlers/signBidirectional';
import { buildStats } from '../src/jobs/stats';

const summary = (values: number[]) => ({
  count: values.length,
  min: values[0] ?? null,
  p05: values[0] ?? null,
  p50: values.at(-1) ?? null,
  p95: values.at(-1) ?? null,
  max: values.at(-1) ?? null,
});

it('reports stage durations across outcomes, but total latency only for success', () => {
  const service = new BidirectionalService('dev', 'http://unused.invalid');
  const success = service.jobs.create('dev', 'eth_self_transfer');
  service.jobs.update(success.id, {
    state: 'responded',
    timings: {
      acceptedAt: 0,
      leaseAcquiredAt: 0,
      signSentAt: 10,
      signatureAt: 20,
      broadcastAt: 20,
      confirmedAt: 40,
      respondedAt: 60,
      finishedAt: 60,
    },
  });
  const failed = service.jobs.create('dev', 'eth_self_transfer');
  service.jobs.update(failed.id, {
    state: 'failed',
    failureReason: 'respond_timeout',
    timings: {
      acceptedAt: 200,
      leaseAcquiredAt: 202,
      signSentAt: 203,
      signatureAt: 213,
      broadcastAt: 215,
      confirmedAt: 230,
      finishedAt: 250,
    },
  });
  const early = service.jobs.create('dev', 'eth_self_transfer');
  service.jobs.update(early.id, {
    state: 'failed',
    failureReason: 'all_workers_busy',
    timings: { acceptedAt: 100, finishedAt: 101 },
  });
  service.jobs.create('dev', 'eth_self_transfer');
  const token = service.jobs.create('dev', 'erc20_zero_transfer');
  service.jobs.update(token.id, {
    state: 'responded',
    timings: {
      acceptedAt: 300,
      leaseAcquiredAt: 304,
      signSentAt: 305,
      signatureAt: 335,
      broadcastAt: 336,
      confirmedAt: 346,
      respondedAt: 366,
      finishedAt: 366,
    },
  });
  const before = structuredClone(service.jobs.all());
  expect(buildStats(service).byMode).toEqual({
    eth_self_transfer: {
      total: 4,
      succeeded: 1,
      failed: 2,
      latencies: {
        leaseWaitMs: summary([0, 2]),
        signatureMs: summary([10, 10]),
        confirmationMs: summary([15, 20]),
        respondMs: summary([20]),
        totalMs: summary([60]),
      },
    },
    erc20_zero_transfer: {
      total: 1,
      succeeded: 1,
      failed: 0,
      latencies: {
        leaseWaitMs: summary([4]),
        signatureMs: summary([30]),
        confirmationMs: summary([10]),
        respondMs: summary([20]),
        totalMs: summary([66]),
      },
    },
  });
  expect(service.jobs.view(success.id)?.durations).toEqual({
    leaseWaitMs: 0,
    signatureMs: 10,
    confirmationMs: 20,
    respondMs: 20,
    totalMs: 60,
  });
  expect(service.jobs.view(failed.id)?.durations).toEqual({
    leaseWaitMs: 2,
    signatureMs: 10,
    confirmationMs: 15,
    totalMs: 50,
  });
  expect(service.jobs.all()).toEqual(before);
});

it('keeps empty duration summaries for modes without completed stages', () => {
  const service = new BidirectionalService('dev', 'http://unused.invalid');
  service.jobs.create('dev', 'eth_self_transfer');
  expect(buildStats(service).byMode).toEqual({
    eth_self_transfer: {
      total: 1,
      succeeded: 0,
      failed: 0,
      latencies: {
        leaseWaitMs: summary([]),
        signatureMs: summary([]),
        confirmationMs: summary([]),
        respondMs: summary([]),
        totalMs: summary([]),
      },
    },
  });
});
