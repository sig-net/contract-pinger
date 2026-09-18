import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'http';

const midnight = vi.hoisted(() => ({
  assertReady: vi.fn(async () => {}),
  deriveWorkers: vi.fn(async (_client: unknown, paths: readonly string[]) =>
    paths.map(path => ({
      path,
      address: '0x1111111111111111111111111111111111111111',
    }))
  ),
}));
vi.mock('../src/midnight/source.mjs', () => ({
  createMidnightSource: () => midnight,
}));

import { app } from '../src/index';
import {
  BidirectionalService,
  getService,
} from '../src/handlers/signBidirectional';
import { ETHEREUM_TARGETS } from '../src/utils/bidirectionalTx';

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

const post = (body: unknown) =>
  request(app)
    .post('/sign_bidirectional')
    .set('x-api-secret', API_SECRET)
    .send(body as object);

describe('POST /sign_bidirectional validation', () => {
  it('requires the API secret', async () => {
    const res = await request(app)
      .post('/sign_bidirectional')
      .send({ env: 'dev' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('rejects a missing environment', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or missing environment parameter');
  });

  it('rejects an unknown environment', async () => {
    const res = await post({ env: 'staging' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or missing environment parameter');
    expect(res.body.validEnvironments).toContain('dev');
  });

  it('rejects a mode that is not one of the two supported ones', async () => {
    const res = await post({ env: 'dev', mode: 'erc20_transfer' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid mode/);
    expect(res.body.validModes).toEqual([
      'eth_self_transfer',
      'erc20_zero_transfer',
    ]);
  });

  it('reports a bad mode before it looks at the environment', async () => {
    // Mode validation runs first, so a mode error is never masked by an
    // unusable environment or a missing SIG_ETH_RPC_URL_SEPOLIA.
    const res = await post({ env: 'mainnet', mode: 'nonsense' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid mode/);
  });

  it('accepts mainnet as an environment, but needs its own RPC', async () => {
    // Mainnet settles on real Ethereum, so it reads SIG_ETH_RPC_URL_MAINNET
    // rather than the Sepolia endpoint the other two share.
    const res = await post({ env: 'mainnet' });
    expect(res.status).toBe(400);
    expect(res.body.error).not.toBe('Invalid or missing environment parameter');
    expect(res.body.error).toMatch(/RPC URL/);
  });
});

describe('GET /sign_bidirectional/:jobId', () => {
  it('requires the API secret', async () => {
    const res = await request(app).get('/sign_bidirectional/does-not-exist');
    expect(res.status).toBe(401);
  });

  it('404s an unknown job id', async () => {
    const res = await request(app)
      .get('/sign_bidirectional/does-not-exist')
      .set('x-api-secret', API_SECRET);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Unknown jobId');
  });

  it('does not shadow the workers and stats routes', async () => {
    // These are registered before the :jobId route; if ordering regressed they
    // would 404 as unknown job ids instead.
    for (const path of ['workers', 'stats']) {
      const res = await request(app)
        .get(`/sign_bidirectional/${path}?env=dev`)
        .set('x-api-secret', API_SECRET);
      expect(res.body.error).not.toBe('Unknown jobId');
    }
  });
});

describe('GET /sign_bidirectional/stats', () => {
  it('reports pool, rate and job structure without touching the network', async () => {
    const res = await request(app)
      .get('/sign_bidirectional/stats?env=dev')
      .set('x-api-secret', API_SECRET);

    if (res.status === 400) {
      // No Sepolia RPC configured locally; nothing further to assert.
      expect(res.body.error).toMatch(/RPC URL/);
      return;
    }

    expect(res.status).toBe(200);
    expect(res.body.environment).toBe('dev');
    expect(res.body.pool.size).toBeGreaterThan(0);
    expect(res.body.rate).toHaveProperty('usedInWindow');
    expect(res.body.jobs).toHaveProperty('states');
  });
});

describe('bidirectional source/environment validation', () => {
  it.each(['unknown', '', null, 3])(
    'rejects invalid sourceChain %s',
    async sourceChain => {
      const res = await post({ env: 'dev', sourceChain });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid sourceChain parameter');
      expect(res.body.validSourceChains).toEqual(['solana', 'midnight']);
    }
  );

  it.each([
    ['solana', 'stagenet', ['dev', 'testnet', 'mainnet']],
    ['midnight', 'dev', ['stagenet']],
    ['midnight', 'testnet', ['stagenet']],
    ['midnight', 'mainnet', ['stagenet']],
  ])(
    'rejects unsupported %s/%s',
    async (sourceChain, network, validEnvironments) => {
      const res = await post({ env: network, sourceChain });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid or missing environment parameter');
      expect(res.body.validEnvironments).toEqual(validEnvironments);
    }
  );

  it.each(['workers', 'stats'])(
    'validates source selection on %s',
    async endpoint => {
      const res = await request(app)
        .get(`/sign_bidirectional/${endpoint}?env=mainnet&sourceChain=midnight`)
        .set('x-api-secret', API_SECRET);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid or missing environment parameter');
    }
  );
});

describe('Midnight job API dispatch', () => {
  it('accepts a Midnight job, exposes it by ID, and reports effective serialized capacity', async () => {
    midnight.assertReady.mockResolvedValue(undefined);
    const rpc = vi
      .spyOn(ETHEREUM_TARGETS.stagenet, 'rpcUrl')
      .mockReturnValue('http://localhost:8545');
    // Exercise HTTP dispatch and real stores without submitting chain transactions.
    const start = vi
      .spyOn(BidirectionalService.prototype, 'start')
      .mockImplementation(function (this: BidirectionalService, mode) {
        return this.jobs.create(this.environment, mode, this.sourceChain);
      });
    try {
      const accepted = await post({ sourceChain: 'midnight', env: 'stagenet' });
      expect(accepted.status).toBe(202);
      expect(accepted.body.sourceChain).toBe('midnight');
      const job = await request(app)
        .get(`/sign_bidirectional/${accepted.body.jobId}`)
        .set('x-api-secret', API_SECRET);
      expect(job.status).toBe(200);
      expect(job.body.sourceChain).toBe('midnight');
      expect(job.body.environment).toBe('stagenet');
      midnight.assertReady.mockRejectedValue(
        new Error('Active request requires reconciliation')
      );
      const service = getService(
        'stagenet',
        'http://localhost:8545',
        'midnight'
      );
      const balances = vi
        .spyOn(service, 'refreshBalances')
        .mockResolvedValue(undefined);
      try {
        const workers = await request(app)
          .get('/sign_bidirectional/workers?sourceChain=midnight&env=stagenet')
          .set('x-api-secret', API_SECRET);
        expect(workers.status).toBe(200);
        expect(workers.body.workers).toHaveLength(1);
      } finally {
        balances.mockRestore();
      }
      const full = await post({ sourceChain: 'midnight', env: 'stagenet' });
      expect(full.status).toBe(429);
      expect(full.body.limit).toBe('active');
      expect(full.body.maxActiveJobs).toBe(1);
      expect(start).toHaveBeenCalledOnce();
      const stats = await request(app)
        .get('/sign_bidirectional/stats?sourceChain=midnight')
        .set('x-api-secret', API_SECRET);
      expect(stats.status).toBe(200);
      expect(stats.body.environment).toBe('stagenet');
      expect(stats.body.sourceChain).toBe('midnight');
      expect(stats.body.pool.size).toBe(1);
      expect(stats.body.jobs.active).toBe(1);
    } finally {
      const service = getService(
        'stagenet',
        'http://localhost:8545',
        'midnight'
      );
      for (const job of service.jobs.all()) {
        service.jobs.update(job.id, { state: 'failed' });
      }
      start.mockRestore();
      midnight.assertReady.mockResolvedValue(undefined);
      rpc.mockRestore();
    }
  });
});

it('refuses unreconciled Midnight submissions before creating a job or charging the limiter', async () => {
  const rpc = vi
    .spyOn(ETHEREUM_TARGETS.stagenet, 'rpcUrl')
    .mockReturnValue('http://localhost:8545');
  const service = getService('stagenet', 'http://localhost:8545', 'midnight');
  expect(service.jobs.activeCount).toBe(0);
  midnight.assertReady.mockRejectedValue(
    new Error('Pending request request-42 / tx-42 requires reconciliation')
  );
  const create = vi.spyOn(service.jobs, 'create');
  const limiter = vi.spyOn(service.limiter, 'tryAcquire');
  try {
    const res = await post({ sourceChain: 'midnight', env: 'stagenet' });
    expect(res.status).toBe(503);
    expect(res.body.details).toContain(
      'request-42 / tx-42 requires reconciliation'
    );
    expect(create).not.toHaveBeenCalled();
    expect(limiter).not.toHaveBeenCalled();
  } finally {
    midnight.assertReady.mockResolvedValue(undefined);
    create.mockRestore();
    limiter.mockRestore();
    rpc.mockRestore();
  }
});
