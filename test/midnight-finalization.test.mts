import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Transaction } from '@midnightntwrk/ledger-v9';
import type { MidnightNodeConfig } from '@sig-net/midnight-contract-deploy';
import { waitForMidnightTransaction } from '../src/midnight/finalization.mjs';
import {
  IndexerPublicDataProvider,
  indexerPublicDataProvider,
} from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

// Exercise the pinned provider's actual Apollo polling without network transport.
const sdkRequire = createRequire(
  import.meta
    .resolve('@midnight-ntwrk/midnight-js-indexer-public-data-provider')
);
const { ApolloClient, ApolloLink, InMemoryCache, Observable } = sdkRequire(
  '@apollo/client/core'
);

vi.mock(
  '@midnight-ntwrk/midnight-js-indexer-public-data-provider',
  async original => ({
    ...(await original<
      typeof import('@midnight-ntwrk/midnight-js-indexer-public-data-provider')
    >()),
    indexerPublicDataProvider: vi.fn(),
  })
);

const providers: IndexerPublicDataProvider[] = [];
const node: MidnightNodeConfig = {
  networkId: 'stagenet',
  nodeUrl: 'http://unused.invalid',
  indexerUrl: 'http://unused.invalid/graphql',
  indexerWsUrl: 'ws://unused.invalid/graphql',
  proofServerUrl: 'http://unused.invalid',
};
const txId = '11'.repeat(32);
function fixture(
  options: {
    pending?: boolean;
    data?: object;
    error?: Error;
    disposeError?: Error;
    hangingDispose?: boolean;
    constructionMs?: number;
  } = {}
) {
  let requests = 0;
  let active = 0;
  const client = new ApolloClient({
    cache: new InMemoryCache(),
    link: new ApolloLink(
      () =>
        new Observable(
          (sink: {
            next(value: object): void;
            error(error: Error): void;
            complete(): void;
          }) => {
            requests++;
            active++;
            if (options.error) sink.error(options.error);
            else if (!options.pending) {
              sink.next({ data: options.data ?? { transactions: [] } });
              sink.complete();
            }
            return () => {
              active--;
            };
          }
        )
    ),
  });
  const dispose = vi.fn(async () => {
    client.stop();
    if (options.disposeError) throw options.disposeError;
    if (options.hangingDispose) await new Promise(() => {});
  });
  const provider = new IndexerPublicDataProvider({ client, dispose }, 5000);
  providers.push(provider);
  vi.mocked(indexerPublicDataProvider).mockImplementationOnce(() => {
    vi.setSystemTime(Date.now() + (options.constructionMs ?? 0));
    return provider;
  });
  return {
    provider,
    dispose,
    requests: () => requests,
    active: () => active,
    queries: () => client.getObservableQueries().size,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(async () => {
  for (const provider of providers.splice(0))
    void provider.dispose().catch(() => {});
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('reproduces continued SDK polling when only the outward wait times out', async () => {
  const f = fixture();
  const watch = f.provider.watchForTxData('11'.repeat(32));
  watch.catch(() => {});
  const timedOut = Promise.race([
    watch,
    new Promise(resolve => setTimeout(() => resolve('timed out'), 1000)),
  ]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await timedOut).toBe('timed out');
  const atTimeout = f.requests();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.requests()).toBeGreaterThan(atTimeout);
  expect(f.queries()).toBe(1);
  await f.provider.dispose();
  expect(f.queries()).toBe(0);
});

it.each(['timeout', 'abort'] as const)(
  'stops subsequent polls after %s',
  async reason => {
    const f = fixture();
    const controller = new AbortController();
    const failure = new Error('shutdown');
    const wait = waitForMidnightTransaction(
      node,
      txId,
      controller.signal,
      6000
    );
    const rejected = expect(wait).rejects.toThrow(
      reason === 'timeout' ? /finalization timed out/ : failure
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.requests()).toBeGreaterThan(1);
    if (reason === 'abort') controller.abort(failure);
    else await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(f.queries()).toBe(0);
    expect(f.dispose).toHaveBeenCalledOnce();
    const stoppedAt = f.requests();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.requests()).toBe(stoppedAt);
    expect(indexerPublicDataProvider).toHaveBeenCalledWith({
      queryURL: node.indexerUrl,
      subscriptionURL: node.indexerWsUrl,
      pollInterval: 5000,
    });
  }
);

it.each(['timeout', 'abort'] as const)(
  'unsubscribes an in-flight transport on %s',
  async reason => {
    const f = fixture({ pending: true });
    const controller = new AbortController();
    const wait = waitForMidnightTransaction(
      node,
      txId,
      controller.signal,
      1000
    );
    const rejected = expect(wait).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.active()).toBe(1);
    if (reason === 'abort') controller.abort(new Error('shutdown'));
    else await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(f.active()).toBe(0);
    expect(f.queries()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.requests()).toBe(1);
  }
);

it.each(['on-time', 'late-result', 'slow-construction'] as const)(
  'checks the finalization deadline before returning data (%s)',
  async scenario => {
    // The actual ledger serializer supplies the provider's required proof/binding format.
    // This empty simulator transaction is never sent to a network.
    const tx = Transaction.fromParts('stagenet').mockProve();
    const raw = Buffer.from(tx.serialize()).toString('hex');
    const f = fixture({
      constructionMs: scenario === 'slow-construction' ? 1001 : 0,
      data: {
        transactions: [
          {
            __typename: 'RegularTransaction',
            id: 7,
            protocolVersion: 9,
            raw,
            hash: '22'.repeat(32),
            identifiers: [txId],
            transactionResult: { status: 'SUCCESS', segments: null },
            unshieldedCreatedOutputs: [],
            unshieldedSpentOutputs: [],
            block: {
              height: 3,
              hash: '33'.repeat(32),
              author: 'author',
              timestamp: 1234,
            },
            fees: { paidFees: '10', estimatedFees: '9' },
          },
        ],
      },
    });
    const pending = waitForMidnightTransaction(
      node,
      txId,
      new AbortController().signal,
      1000
    );
    if (scenario !== 'on-time') {
      if (scenario === 'late-result') vi.setSystemTime(1001);
      await expect(pending).rejects.toThrow(
        `Midnight transaction ${txId} finalization timed out after 1000ms`
      );
      expect(f.queries()).toBe(0);
      expect(f.dispose).toHaveBeenCalledOnce();
      return;
    }
    const result = await pending;
    expect(result.txId).toBe(txId);
    expect(result.status).toBe('SucceedEntirely');
    expect(Buffer.from(result.tx.serialize()).toString('hex')).toBe(raw);
    expect(result.blockHeight).toBe(3);
    expect(result.fees).toEqual({ paidFees: '10', estimatedFees: '9' });
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.queries()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.requests()).toBe(1);
  }
);

it('preserves an indexer error and disposes its watch', async () => {
  const original = new Error('indexer unavailable');
  const f = fixture({ error: original });
  await expect(
    waitForMidnightTransaction(node, txId, new AbortController().signal, 1000)
  ).rejects.toMatchObject({
    name: 'IndexerQueryError',
    message: original.message,
  });
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(f.queries()).toBe(0);
});

it.each(['construction', 'watch'] as const)(
  'preserves a synchronous %s error and disposes any owned provider',
  async phase => {
    const f = fixture();
    const failure = new Error(`${phase} failed`);
    if (phase === 'construction') {
      vi.mocked(indexerPublicDataProvider)
        .mockReset()
        .mockImplementationOnce(() => {
          throw failure;
        });
    } else {
      vi.spyOn(f.provider, 'watchForTxData').mockImplementationOnce(() => {
        throw failure;
      });
    }
    await expect(
      waitForMidnightTransaction(node, txId, new AbortController().signal, 1000)
    ).rejects.toBe(failure);
    expect(f.dispose).toHaveBeenCalledTimes(phase === 'construction' ? 0 : 1);
    expect(f.queries()).toBe(0);
  }
);

it('observes disposal failures without replacing the deadline error', async () => {
  const disposeError = new Error('socket teardown failed');
  fixture({ pending: true, disposeError });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const rejected = expect(
    waitForMidnightTransaction(node, txId, new AbortController().signal, 1000)
  ).rejects.toThrow(/finalization timed out/);
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(log).toHaveBeenCalledWith(
    'Midnight finalization provider disposal failed',
    disposeError
  );
});

it('does not let asynchronous socket teardown extend the deadline', async () => {
  const f = fixture({ pending: true, hangingDispose: true });
  const rejected = expect(
    waitForMidnightTransaction(node, txId, new AbortController().signal, 1000)
  ).rejects.toThrow(/finalization timed out/);
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(f.active()).toBe(0);
  expect(f.dispose).toHaveBeenCalledOnce();
});

it('does not allocate a provider for an already cancelled or expired wait', async () => {
  const controller = new AbortController();
  controller.abort(new Error('shutdown'));
  await expect(
    waitForMidnightTransaction(node, txId, controller.signal, 1000)
  ).rejects.toThrow('shutdown');
  for (const timeout of [0, -1, NaN, Infinity]) {
    await expect(
      waitForMidnightTransaction(
        node,
        txId,
        new AbortController().signal,
        timeout
      )
    ).rejects.toThrow(
      `Midnight transaction ${txId} finalization timed out after ${timeout}ms`
    );
  }
  expect(indexerPublicDataProvider).not.toHaveBeenCalled();
});

it('cancels only the provider owned by that wait', async () => {
  const first = fixture({ pending: true });
  const second = fixture({ pending: true });
  const a = new AbortController();
  const b = new AbortController();
  const one = expect(
    waitForMidnightTransaction(node, txId, a.signal, 1000)
  ).rejects.toThrow('first cancelled');
  const two = expect(
    waitForMidnightTransaction(node, txId, b.signal, 1000)
  ).rejects.toThrow('second cancelled');
  await vi.advanceTimersByTimeAsync(0);
  a.abort(new Error('first cancelled'));
  await one;
  expect(first.active()).toBe(0);
  expect(second.active()).toBe(1);
  expect(second.dispose).not.toHaveBeenCalled();
  b.abort(new Error('second cancelled'));
  await two;
  expect(second.active()).toBe(0);
});
