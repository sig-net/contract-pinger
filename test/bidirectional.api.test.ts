import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';

import { app } from '../src/index';

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

  it('reports a bad mode even when no RPC URL is configured', async () => {
    // Mode validation runs before service resolution, so a mode error is
    // never masked by a missing SIG_ETH_RPC_URL_SEPOLIA.
    const res = await post({ env: 'mainnet', mode: 'nonsense' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid mode/);
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
