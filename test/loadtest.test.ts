import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ModuleKind, transpile } from 'typescript';
import { expect, it } from 'vitest';
import { JobStore } from '../src/jobs/store';

const source = readFileSync(resolve('scripts/loadtest.ts'), 'utf8');
const entry = source.lastIndexOf('\nmain().catch(');
if (entry < 0) throw new Error('CLI entrypoint missing');
// Run the real orchestration without terminating the test process.
const script = transpile(source.slice(0, entry) + '\nglobalThis.run = main;', {
  module: ModuleKind.CommonJS,
});
class Exit extends Error {
  constructor(readonly code: number) {
    super('CLI exited');
  }
}
type Reply = [number, unknown];
async function drive(args: string[], replies: Reply[], secret = 'test-secret') {
  const requests: {
    url: string;
    method: string;
    body?: unknown;
    headers: unknown;
  }[] = [];
  const output: string[] = [];
  const errors: unknown[][] = [];
  const sleeps: number[] = [];
  let now = 0;
  const context = {
    exports: {},
    require: (name: string) => {
      if (name === 'dotenv/config') return {};
      if (name === '../src/utils/env')
        return {
          env: {
            port: 3001,
            apiSecret: secret,
            bidirectional: { e2eEnv: 'testnet', txMode: 'eth_self_transfer' },
          },
        };
      throw new Error(`Unexpected runtime import: ${name}`);
    },
    console: {
      log: (message: string) => output.push(message),
      error: (...values: unknown[]) => errors.push(values),
    },
    process: {
      argv: ['node', 'loadtest.ts', ...args],
      stdout: { write: (value: string) => output.push(value) },
      exit: (code: number) => {
        throw new Exit(code);
      },
    },
    Date: { now: () => now },
    setTimeout: (callback: () => void, delay: number) => {
      sleeps.push(delay);
      now += delay;
      callback();
    },
    fetch: async (url: string, init: RequestInit = {}) => {
      requests.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        headers: init.headers,
      });
      const reply = replies.shift();
      if (!reply) throw new Error(`Unexpected request: ${url}`);
      return new Response(JSON.stringify(reply[1]), { status: reply[0] });
    },
    run: async () => {},
  };
  runInNewContext(script, context);
  let code: number | undefined;
  try {
    await context.run();
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    code = error.code;
  }
  expect(replies).toHaveLength(0);
  return { code, requests, output, errors, sleeps };
}

function job(state: 'responded' | 'failed' | 'confirmed') {
  const store = new JobStore(10);
  const record = store.create('testnet', 'eth_self_transfer');
  store.update(record.id, {
    state,
    timings: {
      acceptedAt: 0,
      leaseAcquiredAt: 1000,
      signSentAt: 2000,
      signatureAt: 4000,
      broadcastAt: 5000,
      confirmedAt: 8000,
      respondedAt: 12000,
      finishedAt: 14000,
    },
    ...(state === 'failed'
      ? { failureReason: 'respond_timeout', error: 'not returned' }
      : {}),
  });
  return store.view(record.id)!;
}

it('submits all jobs before polling and preserves output, defaults, timings and stats', async () => {
  const run = await drive(
    ['--jobs', '2'],
    [
      [202, { jobId: 'a' }],
      [202, { jobId: 'b' }],
      [200, job('responded')],
      [200, job('responded')],
      [200, { pool: { busy: 1, size: 2, underfunded: 0 } }],
    ]
  );
  expect(run.code).toBe(0);
  expect(run.requests.map(r => [r.method, r.url])).toEqual([
    ['POST', 'http://localhost:3001/sign_bidirectional'],
    ['POST', 'http://localhost:3001/sign_bidirectional'],
    ['GET', 'http://localhost:3001/sign_bidirectional/a'],
    ['GET', 'http://localhost:3001/sign_bidirectional/b'],
    [
      'GET',
      'http://localhost:3001/sign_bidirectional/stats?env=testnet&sourceChain=solana',
    ],
  ]);
  expect(run.requests[0].body).toEqual({
    env: 'testnet',
    mode: 'eth_self_transfer',
    sourceChain: 'solana',
  });
  expect(run.requests[0].headers).toEqual({
    'content-type': 'application/json',
    'x-api-secret': 'test-secret',
  });
  expect(run.sleeps).toEqual([15000]);
  expect(run.output).toEqual([
    'Driving 2 × eth_self_transfer against http://localhost:3001 (solana/testnet)\n',
    '\r[00:00] submitted 1/2            ',
    '\r[00:00] submitted 2/2            ',
    '\n\nAll 2 submitted in 00:00\nPolling to completion — the respond leg waits for Ethereum finality.\n',
    '[00:15] responded=2',
    '\n' + '='.repeat(60),
    'Completed in 00:15',
    '  succeeded  2/2',
    '  failed     0/2',
    '\nLatency (succeeded jobs):',
    '  stage             min       p50       p95       max',
    '  lease wait         1.0s      1.0s      1.0s      1.0s',
    '  signature          2.0s      2.0s      2.0s      2.0s',
    '  confirmation       3.0s      3.0s      3.0s      3.0s',
    '  respond            4.0s      4.0s      4.0s      4.0s',
    '  total             14.0s     14.0s     14.0s     14.0s',
    '\nPool: 1/2 busy, 0 underfunded',
  ]);
});

it('keeps Midnight defaults, explicit overrides and both rate-limit waits', async () => {
  const run = await drive(
    [
      '--source-chain',
      'midnight',
      '--jobs',
      '1',
      '--poll',
      '1000',
      '--url',
      'https://pinger.invalid',
      '--mode',
      'erc20_zero_transfer',
    ],
    [
      [429, { retryAfterMs: 750 }],
      [429, {}],
      [202, { jobId: 'a' }],
      [200, job('responded')],
      [503, {}],
    ]
  );
  expect(run.code).toBe(0);
  expect(run.requests[0].body).toEqual({
    env: 'stagenet',
    sourceChain: 'midnight',
    mode: 'erc20_zero_transfer',
  });
  expect(run.requests.at(-1)?.url).toBe(
    'https://pinger.invalid/sign_bidirectional/stats?env=stagenet&sourceChain=midnight'
  );
  expect(run.sleeps).toEqual([1000, 5250, 1000]);
  expect(run.output).toContain(
    '\n\nAll 1 submitted in 00:06 (2 rate-limit waits)\nPolling to completion — the respond leg waits for Ethereum finality.\n'
  );
});

it('resets consecutive poll misses, skips finished jobs and reports server failures', async () => {
  const run = await drive(
    ['--jobs', '2', '--poll', '0'],
    [
      [202, { jobId: 'a' }],
      [202, { jobId: 'b' }],
      [200, job('responded')],
      [404, {}],
      [404, {}],
      [404, {}],
      [404, {}],
      [200, job('confirmed')],
      [404, {}],
      [404, {}],
      [404, {}],
      [404, {}],
      [200, job('failed')],
      [503, {}],
    ]
  );
  expect(run.code).toBe(1);
  expect(run.requests.filter(r => r.url.endsWith('/a'))).toHaveLength(1);
  expect(run.output).toContain('[00:00] confirmed=1  responded=1');
  expect(run.output).toContain('[00:00] failed=1  responded=1');
  expect(run.output).toContain('     1  respond_timeout');
  expect(run.output).toContain('        e.g. not returned');
});

it('marks a job lost after five unsuccessful polls and emits empty latency cells', async () => {
  const run = await drive(
    ['--jobs', '1', '--poll', '0'],
    [
      [202, { jobId: 'a' }],
      ...Array.from({ length: 5 }, (): Reply => [404, {}]),
      [503, {}],
    ]
  );
  expect(run.code).toBe(1);
  expect(run.output).toContain('     1  lost_by_server');
  expect(run.output).toContain(
    '        e.g. Job not found after 5 polls (server restarted, or the record was pruned)'
  );
  expect(run.output).toContain(
    '  total                 —         —         —         —'
  );
});

it('rejects missing credentials before requests and unsuccessful submissions before polling', async () => {
  const missing = await drive([], [], '');
  expect(missing.code).toBe(1);
  expect(missing.requests).toHaveLength(0);
  expect(missing.errors).toEqual([['Set API_SECRET in the environment']]);
  const rejected = await drive(
    ['--jobs', '1'],
    [[400, { error: 'invalid mode' }]]
  );
  expect(rejected.code).toBe(1);
  expect(rejected.requests).toHaveLength(1);
  expect(rejected.sleeps).toHaveLength(0);
  expect(rejected.errors).toEqual([
    ['\nSubmit failed (400):', '{"error":"invalid mode"}'],
  ]);
});
