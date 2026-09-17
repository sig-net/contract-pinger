import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';

const mock = vi.hoisted(() => {
  const address = '0x1111111111111111111111111111111111111111';
  const source = () => ({
    deriveWorkers: vi.fn(async (_client: unknown, paths: readonly string[]) =>
      paths.map(path => ({ path, address }))
    ),
    submit: vi.fn(),
    assertReady: vi.fn(async () => {}),
  });
  return {
    address,
    solana: source(),
    midnight: source(),
    client: {
      getBalance: vi.fn(async () => 10n ** 18n),
      getTransactionCount: vi.fn(async () => 0),
      sendRawTransaction: vi.fn(async () => '0x1234'),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    },
  };
});

vi.mock('../src/utils/solanaSource', () => ({
  createSolanaSource: () => mock.solana,
}));
vi.mock('../src/midnight/source.mjs', () => ({
  createMidnightSource: () => mock.midnight,
}));
vi.mock('../src/utils/bidirectionalTx', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/utils/bidirectionalTx')>()),
  createEthereumClient: () => mock.client,
  buildTransaction: async () => ({
    nonce: 0,
    gasCostWei: 1n,
    unsigned: {},
    rlpEncoded: '0x01',
  }),
  attachSignature: async () => ({
    serialized: '0x01',
    recoveredFrom: mock.address,
  }),
}));

import {
  abortActiveJobs,
  BidirectionalService,
  getService,
} from '../src/handlers/signBidirectional';
import { env } from '../src/utils/env';
import { JobStore } from '../src/jobs/store';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
};
let response = deferred<Hex>();
let submittedSignal: AbortSignal | undefined;
const submit =
  (sourceTx: string) =>
  async ({ signal }: { signal: AbortSignal }) => {
    submittedSignal = signal;
    return {
      requestId: 'request-1',
      sourceTx,
      signature: Promise.resolve({ r: '01', s: '02', v: 27 }),
      response: new Promise<Hex>((resolve, reject) => {
        response.promise.then(resolve);
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
    };
  };

beforeEach(() => {
  vi.clearAllMocks();
  response = deferred<Hex>();
  submittedSignal = undefined;
  mock.solana.assertReady.mockResolvedValue(undefined);
  mock.midnight.assertReady.mockResolvedValue(undefined);
  mock.client.sendRawTransaction.mockResolvedValue('0x1234');
  mock.client.waitForTransactionReceipt.mockResolvedValue({
    status: 'success',
  });
  mock.solana.submit.mockImplementation(submit('solana-tx'));
  mock.midnight.submit.mockImplementation(submit('midnight-tx'));
});
afterEach(async () => {
  abortActiveJobs();
  await Promise.resolve();
  vi.useRealTimers();
});

describe('bidirectional source dispatch', () => {
  it('defaults to Solana and isolates its cache, pools and jobs from Midnight', async () => {
    const solana = getService('dev', 'http://localhost:8545');
    const midnight = getService(
      'stagenet',
      'http://localhost:8545',
      'midnight'
    );
    expect(getService('dev', 'http://localhost:8545', 'solana')).toBe(solana);
    expect(getService('stagenet', 'http://localhost:8545', 'midnight')).toBe(
      midnight
    );
    expect(() =>
      getService('dev', 'http://localhost:8545', 'midnight')
    ).toThrow('Unsupported source/environment');
    expect(solana.jobs).not.toBe(midnight.jobs);
    expect(solana.pool).not.toBe(midnight.pool);
    await Promise.all([solana.ensureAddresses(), midnight.ensureAddresses()]);
    expect(mock.solana.deriveWorkers).toHaveBeenCalledOnce();
    expect(mock.midnight.deriveWorkers).toHaveBeenCalledOnce();
    expect(midnight.pool.size).toBe(1);
    expect(midnight.maxActiveJobs).toBe(1);
    expect(midnight.maxRequestsPerMinute).toBe(1);
  });

  it.each([
    ['solana', 'stagenet'],
    ['midnight', 'dev'],
    ['midnight', 'testnet'],
    ['midnight', 'mainnet'],
  ] as const)(
    'rejects %s/%s before initializing a source',
    (source, network) => {
      expect(
        () => new BidirectionalService(network, 'http://localhost:8545', source)
      ).toThrow('Unsupported source/environment');
      expect(mock.solana.deriveWorkers).not.toHaveBeenCalled();
      expect(mock.midnight.deriveWorkers).not.toHaveBeenCalled();
    }
  );

  it.each(['solana', 'midnight'] as const)(
    'records source identity and retains only the Midnight lease while confirmed (%s)',
    async source => {
      const service = new BidirectionalService(
        source === 'solana' ? 'dev' : 'stagenet',
        'http://localhost:8545',
        source
      );
      const job = service.start('eth_self_transfer');
      await vi.waitFor(() => expect(job.state).toBe('confirmed'));
      expect(job.sourceChain).toBe(source);
      expect(job.sourceTx).toBe(`${source}-tx`);
      expect(job.solanaTx).toBe(source === 'solana' ? 'solana-tx' : undefined);
      expect(service.pool.all().filter(worker => worker.busy).length).toBe(
        source === 'midnight' ? 1 : 0
      );
      expect(service.jobs.activeCount).toBe(source === 'midnight' ? 1 : 0);
      expect(service.jobs.awaitingRespondCount).toBe(1);
      expect(service.jobs.liveCount).toBe(1);
      expect(service.jobs.atCapacity()).toBe(
        source === 'midnight' ? 'active' : null
      );
      abortActiveJobs();
      await vi.waitFor(() => expect(job.failureReason).toBe('shutdown'));
      expect(service.pool.all().every(worker => !worker.busy)).toBe(true);
    }
  );

  it('starts the respond deadline at Ethereum confirmation', async () => {
    vi.useFakeTimers();
    const confirmed = deferred<{ status: string }>();
    mock.client.waitForTransactionReceipt.mockReturnValueOnce(
      confirmed.promise
    );
    const service = new BidirectionalService(
      'stagenet',
      'http://localhost:8545',
      'midnight'
    );
    const job = service.start('eth_self_transfer');
    await vi.advanceTimersByTimeAsync(0);
    expect(job.state).toBe('broadcast');
    await vi.advanceTimersByTimeAsync(env.bidirectional.respondTimeoutMs);
    expect(job.state).toBe('broadcast');
    confirmed.resolve({ status: 'success' });
    await vi.advanceTimersByTimeAsync(0);
    expect(job.state).toBe('confirmed');
    await vi.advanceTimersByTimeAsync(env.bidirectional.respondTimeoutMs - 1);
    expect(job.state).toBe('confirmed');
    await vi.advanceTimersByTimeAsync(1);
    expect(job.failureReason).toBe('respond_timeout');
    expect(service.pool.all().every(worker => !worker.busy)).toBe(true);
  });

  it('quarantines an address after an ambiguous Ethereum broadcast failure', async () => {
    mock.client.sendRawTransaction.mockRejectedValueOnce(
      new Error('connection lost')
    );
    const service = new BidirectionalService(
      'stagenet',
      'http://localhost:8545',
      'midnight'
    );
    const job = service.start('eth_self_transfer');
    await vi.waitFor(() => expect(job.failureReason).toBe('broadcast_failed'));
    expect(service.pool.quarantined()).toHaveLength(1);
    expect(service.pool.quarantined()[0].pendingNonce).toBe(0);
    expect(submittedSignal?.aborted).toBe(true);
  });

  it('aborts the response watcher when signature waiting fails', async () => {
    mock.midnight.submit.mockImplementationOnce(
      async (args: { signal: AbortSignal }) => ({
        ...(await submit('midnight-tx')(args)),
        signature: Promise.reject(new Error('signature expired')),
      })
    );
    const service = new BidirectionalService(
      'stagenet',
      'http://localhost:8545',
      'midnight'
    );
    const job = service.start('eth_self_transfer');
    await vi.waitFor(() => expect(job.failureReason).toBe('signature_timeout'));
    expect(submittedSignal?.aborted).toBe(true);
    expect(mock.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(service.pool.all().every(worker => !worker.busy)).toBe(true);
  });

  it('observes a response rejection before Ethereum confirmation', async () => {
    mock.midnight.submit.mockImplementationOnce(
      async ({ signal }: { signal: AbortSignal }) => {
        submittedSignal = signal;
        return {
          requestId: 'request-1',
          sourceTx: 'midnight-tx',
          signature: Promise.resolve({ r: '01', s: '02', v: 27 }),
          response: Promise.reject(new Error('response expired')),
        };
      }
    );
    const service = new BidirectionalService(
      'stagenet',
      'http://localhost:8545',
      'midnight'
    );
    const job = service.start('eth_self_transfer');
    await vi.waitFor(() => expect(job.failureReason).toBe('respond_timeout'));
    expect(job.error).toBe('response expired');
    expect(submittedSignal?.aborted).toBe(true);
  });

  it('keeps preparation failure diagnostic and releases the acquired lease', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    mock.midnight.submit.mockRejectedValueOnce(new Error('caller unavailable'));
    const service = new BidirectionalService(
      'stagenet',
      'http://localhost:8545',
      'midnight'
    );
    const job = service.start('eth_self_transfer');
    await vi.waitFor(() => expect(job.failureReason).toBe('internal_error'));
    expect(job.error).toBe('caller unavailable');
    expect(service.pool.all().every(worker => !worker.busy)).toBe(true);
    diagnostic.mockRestore();
  });

  it.each(['solana', 'midnight'] as const)(
    'completes a verified response and releases the lease (%s)',
    async source => {
      const service = new BidirectionalService(
        source === 'solana' ? 'dev' : 'stagenet',
        'http://localhost:8545',
        source
      );
      const job = service.start('eth_self_transfer');
      await vi.waitFor(() => expect(job.state).toBe('confirmed'));
      response.resolve('0x01');
      await vi.waitFor(() => expect(job.state).toBe('responded'));
      expect(job.serializedOutput).toBe('0x01');
      expect(service.jobs.liveCount).toBe(0);
      expect(service.pool.all().every(worker => !worker.busy)).toBe(true);
    }
  );

  it('rejects an unexpected authenticated response output', async () => {
    const service = new BidirectionalService(
      'stagenet',
      'http://localhost:8545',
      'midnight'
    );
    const job = service.start('eth_self_transfer');
    await vi.waitFor(() => expect(job.state).toBe('confirmed'));
    response.resolve('0x00');
    await vi.waitFor(() => expect(job.failureReason).toBe('respond_mismatch'));
    expect(service.pool.all().every(worker => !worker.busy)).toBe(true);
  });

  it('abandons shutdown during preparation before any submission', async () => {
    const derived = deferred<{ path: string; address: string }[]>();
    mock.midnight.deriveWorkers.mockReturnValueOnce(derived.promise);
    const service = new BidirectionalService(
      'stagenet',
      'http://localhost:8545',
      'midnight'
    );
    const job = service.start('eth_self_transfer');
    await vi.waitFor(() =>
      expect(mock.midnight.deriveWorkers).toHaveBeenCalledOnce()
    );
    abortActiveJobs();
    derived.resolve(
      service.pool
        .all()
        .map(worker => ({ path: worker.path, address: mock.address }))
    );
    await vi.waitFor(() => expect(job.failureReason).toBe('shutdown'));
    expect(mock.midnight.submit).not.toHaveBeenCalled();
  });

  it('retains early and late submission progress without reviving a failed job', async () => {
    type Progress = { requestId?: string; sourceTx?: string; nonce?: number };
    let progress: ((value: Progress) => void) | undefined;
    let nonceAtSubmission: number | undefined;
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new BidirectionalService(
      'stagenet',
      'http://localhost:8545',
      'midnight'
    );
    mock.midnight.submit.mockImplementationOnce(
      async (args: { onProgress?: (value: Progress) => void }) => {
        nonceAtSubmission = job.nonce;
        progress = args.onProgress;
        progress?.({ requestId: 'prepared-request' });
        throw new Error('Midnight request submission timed out');
      }
    );
    const job = service.start('eth_self_transfer');
    await vi.waitFor(() => expect(job.state).toBe('failed'));
    expect(nonceAtSubmission).toBe(0);
    expect(job.requestId).toBe('prepared-request');
    expect(job.nonce).toBe(0);
    const finishedAt = job.timings.finishedAt;
    progress?.({ sourceTx: 'late-accepted-transaction' });
    progress?.({ requestId: undefined, sourceTx: undefined, nonce: undefined });
    expect(job.sourceTx).toBe('late-accepted-transaction');
    expect(job.requestId).toBe('prepared-request');
    expect(job.nonce).toBe(0);
    expect(job.state).toBe('failed');
    expect(job.failureReason).toBe('internal_error');
    expect(job.timings.finishedAt).toBe(finishedAt);
    diagnostic.mockRestore();
  });

  it('rechecks source recovery readiness even with cached worker addresses', async () => {
    const service = new BidirectionalService(
      'stagenet',
      'http://localhost:8545',
      'midnight'
    );
    await service.ensureAddresses();
    mock.midnight.assertReady.mockRejectedValue(
      new Error('Pending request requires reconciliation: request-1')
    );
    await expect(service.ensureAddresses()).rejects.toThrow(
      'requires reconciliation'
    );
    expect(mock.midnight.deriveWorkers).toHaveBeenCalledOnce();
    expect(mock.client.getBalance).not.toHaveBeenCalled();
    expect(mock.midnight.submit).not.toHaveBeenCalled();
    expect(service.pool.all().every(worker => !worker.busy)).toBe(true);
  });

  it('keeps existing JobStore callers on Solana capacity behavior', () => {
    const store = new JobStore(10, 100, 1);
    const job = store.create('dev', 'eth_self_transfer');
    store.update(job.id, { state: 'confirmed' });
    expect(job.sourceChain).toBe('solana');
    expect(store.activeCount).toBe(0);
    expect(store.liveCount).toBe(1);
    expect(store.atCapacity()).toBeNull();
  });
});
