import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';

import { app } from '../src/index';
import { useEnv } from '../src/utils/useEnv';

/**
 * The real round trip: Solana request, MPC signature, Sepolia broadcast, MPC
 * respond. Excluded from `pnpm test` because the respond leg waits for
 * Ethereum finality — up to thirty-five minutes — and a normal CI run should
 * not be hostage to that. Run with `pnpm test:e2e`.
 */

const REQUIRED = [
  'SIG_SOL_RPC_URL_DEV',
  'SIG_SOL_SK',
  'SIG_ETH_RPC_URL_SEPOLIA',
];
const missing = REQUIRED.filter(name => !process.env[name]);

const ENV = process.env.SIG_BIDIRECTIONAL_E2E_ENV || 'dev';
const MODE = process.env.SIG_BIDIRECTIONAL_E2E_MODE || 'eth_self_transfer';
const POLL_INTERVAL_MS = 10_000;

// Derived from the job's own timeouts rather than hardcoded: a job may
// legitimately spend the full signature, confirmation and respond budgets in
// sequence, and a shorter deadline here would report a healthy job as a
// failure. Slack covers polling granularity and startup.
const { bidirectional } = useEnv();
const DEADLINE_MS =
  bidirectional.signatureTimeoutMs +
  bidirectional.ethConfirmTimeoutMs +
  bidirectional.respondTimeoutMs +
  120_000;

let server: Server;
const API_SECRET = process.env.API_SECRET!;

beforeAll(() => {
  return new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
});

afterAll(() => {
  return new Promise<void>(resolve => {
    server?.close(() => resolve());
  });
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(missing.length > 0)('sign_bidirectional end to end', () => {
  it('reports the derived addresses and their gas balances', async () => {
    const res = await request(app)
      .get(`/sign_bidirectional/workers?env=${ENV}`)
      .set('x-api-secret', API_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.workers.length).toBeGreaterThan(0);

    for (const worker of res.body.workers) {
      expect(worker.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      console.log(
        `  ${worker.path}  ${worker.address}  ${worker.balanceWei} wei` +
          (worker.underfunded ? '  UNDERFUNDED' : '')
      );
    }

    const funded = res.body.workers.filter((w: any) => !w.underfunded);
    expect(
      funded.length,
      'No derived address holds enough gas. Fund the addresses listed above, ' +
        `or run: pnpm fund --env ${ENV}`
    ).toBeGreaterThan(0);
  }, 120_000);

  it(
    `completes a ${MODE} round trip`,
    async () => {
      const started = await request(app)
        .post('/sign_bidirectional')
        .set('x-api-secret', API_SECRET)
        .send({ env: ENV, mode: MODE });

      expect(started.status).toBe(202);
      const { jobId } = started.body;
      console.log(`  job ${jobId} accepted`);

      const deadline = Date.now() + DEADLINE_MS;
      let last = '';

      while (Date.now() < deadline) {
        const res = await request(app)
          .get(`/sign_bidirectional/${jobId}`)
          .set('x-api-secret', API_SECRET);
        expect(res.status).toBe(200);

        const job = res.body;
        if (job.state !== last) {
          console.log(`  → ${job.state}`, {
            solanaTx: job.solanaTx,
            ethTxHash: job.ethTxHash,
            derivedAddress: job.derivedAddress,
          });
          last = job.state;
        }

        if (job.state === 'responded') {
          expect(job.serializedOutput).toBe('0x01');
          console.log('  durations:', job.durations);
          return;
        }

        if (job.state === 'failed') {
          throw new Error(`Job failed (${job.failureReason}): ${job.error}`);
        }

        await sleep(POLL_INTERVAL_MS);
      }

      throw new Error(`Job ${jobId} did not settle within ${DEADLINE_MS}ms`);
    },
    DEADLINE_MS + 60_000
  );
});

describe.skipIf(missing.length === 0)('sign_bidirectional end to end', () => {
  it('is skipped without credentials', () => {
    console.log(`Skipped: missing ${missing.join(', ')}`);
    expect(missing.length).toBeGreaterThan(0);
  });
});
