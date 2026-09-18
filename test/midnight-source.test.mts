import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Transaction } from '@midnightntwrk/ledger-v9';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  deriveAccountKeys,
  ensureFeeReady,
  type WalletFacade,
  type FacadeState,
} from '@sig-net/midnight-contract-deploy';
import { MidnightNetwork } from '@sig-net/midnight';
import { createPublicClient, http } from 'viem';
import {
  createUnprovenCallTx,
  verifyContractState,
} from '@midnight-ntwrk/midnight-js/contracts';
import {
  pollVerified,
  createWalletLane,
  createMidnightSource,
} from '../src/midnight/source.mjs';
import { withinDeadline } from '../src/midnight/deadline.mjs';
import * as providers from '../src/midnight/provider.mjs';
import * as configuration from '../src/midnight/config.mjs';
import * as indexer from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type { BuiltTransaction } from '../src/utils/bidirectionalTx.js';

/** Every unconfigured SDK access fails, keeping boundary mocks explicit. */
function boundary<T extends object>(properties: Partial<NoInfer<T>>): T {
  return new Proxy(properties, {
    get(target, key) {
      if (key in target || typeof key === 'symbol' || key === 'then')
        return Reflect.get(target, key);
      throw new Error(`Unconfigured SDK boundary: ${String(key)}`);
    },
  }) as T;
}

vi.mock('node:timers/promises', () => ({
  setTimeout: (
    ms: number,
    value: undefined,
    options?: { signal?: AbortSignal }
  ) =>
    new Promise<void>((resolve, reject) => {
      const signal = options?.signal;
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      }, ms);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    }),
}));
vi.mock('@sig-net/midnight-contract-deploy', async importOriginal => ({
  ...(await importOriginal<
    typeof import('@sig-net/midnight-contract-deploy')
  >()),
  ensureFeeReady: vi.fn().mockResolvedValue(100n),
}));
vi.mock(
  '@midnight-ntwrk/midnight-js-indexer-public-data-provider',
  async importOriginal => {
    const original =
      await importOriginal<
        typeof import('@midnight-ntwrk/midnight-js-indexer-public-data-provider')
      >();
    return {
      ...original,
      indexerPublicDataProvider: vi.fn(original.indexerPublicDataProvider),
    };
  }
);
vi.mock('@midnight-ntwrk/midnight-js/contracts', async importOriginal => ({
  ...(await importOriginal<
    typeof import('@midnight-ntwrk/midnight-js/contracts')
  >()),
  createUnprovenCallTx: vi.fn(),
  verifyContractState: vi.fn(),
}));

beforeEach(async () => {
  const tests = resolve('.midnight/tests');
  await mkdir(tests, { recursive: true });
  sourceConfig.stateDirectory = await mkdtemp(resolve(tests, 'source-'));
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const root =
  '04' +
  '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' +
  '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8';
const sourceConfig: configuration.MidnightConfig = {
  node: {
    networkId: MidnightNetwork.Stagenet,
    nodeUrl: 'http://unused.invalid',
    indexerUrl: 'http://unused.invalid',
    indexerWsUrl: 'ws://unused.invalid',
    proofServerUrl: 'http://unused.invalid',
  },
  seed: '07'.repeat(32),
  operatorSecret: new Uint8Array(32),
  callerAddress: 'a'.repeat(64),
  centralAddress: 'b'.repeat(64),
  rootPublicKey: root,
  stateDirectory: '/unused',
};

describe('Midnight deadlines and wallet ownership', () => {
  it('rejects a permanently pending read at the timeout and forwards cancellation', async () => {
    let active: AbortSignal | undefined;
    const pending = pollVerified(
      signal => {
        active = signal;
        return new Promise(() => {});
      },
      10,
      new AbortController().signal
    );
    const result = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(active?.aborted).toBe(true);
  });

  it('rejects promptly when shutdown aborts a pending read', async () => {
    const shutdown = new AbortController();
    const pending = pollVerified(
      () => new Promise(() => {}),
      100,
      shutdown.signal
    );
    const result = expect(pending).rejects.toThrow('shutdown');
    shutdown.abort(new Error('shutdown'));
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cannot accept a late successful read after the deadline', async () => {
    let resolveRead!: (value: string) => void;
    const pending = pollVerified(
      () =>
        new Promise<string>(resolve => {
          resolveRead = resolve;
        }),
      10,
      new AbortController().signal
    );
    const result = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10);
    resolveRead('late');
    await result;
  });

  it('keeps timed-out wallet work exclusive, then skips expired queued work', async () => {
    const lane = createWalletLane();
    let finish!: () => void;
    const first = withinDeadline(
      () =>
        lane.run(
          () =>
            new Promise<void>(resolve => {
              finish = resolve;
            })
        ),
      10,
      new AbortController().signal,
      'submit'
    );
    const firstResult = expect(first).rejects.toThrow('timed out');
    const queuedWork = vi.fn();
    const queued = withinDeadline(
      signal =>
        lane.run(async () => {
          signal.throwIfAborted();
          queuedWork();
        }),
      15,
      new AbortController().signal,
      'queued'
    );
    const queuedResult = expect(queued).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20);
    await firstResult;
    await queuedResult;
    expect(queuedWork).not.toHaveBeenCalled();
    let idle = false;
    void lane.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    finish();
    await lane.idle();
    expect(queuedWork).not.toHaveBeenCalled();
  });

  it('bounds readiness when the indexer never resolves', async () => {
    vi.spyOn(configuration, 'resolveMidnightConfig').mockReturnValue(
      sourceConfig
    );
    vi.mocked(indexer.indexerPublicDataProvider).mockReturnValueOnce(
      boundary<ReturnType<typeof indexer.indexerPublicDataProvider>>({
        queryContractState: vi.fn().mockReturnValue(new Promise(() => {})),
        dispose: vi.fn().mockResolvedValue(undefined),
      })
    );
    const client = createPublicClient({
      transport: http('http://unused.invalid'),
    });
    const source = await createMidnightSource('stagenet', client);
    const pending = source.deriveWorkers(client, ['load-0']);
    const result = expect(pending).rejects.toThrow(
      'Midnight caller readiness timed out'
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    await source.close?.();
  });

  it('keeps caller preparation serialized and skips cancelled queued work', async () => {
    vi.spyOn(configuration, 'resolveMidnightConfig').mockReturnValue(
      sourceConfig
    );
    vi.mocked(indexer.indexerPublicDataProvider).mockReturnValueOnce(
      boundary<ReturnType<typeof indexer.indexerPublicDataProvider>>({
        dispose: vi.fn().mockResolvedValue(undefined),
      })
    );
    const close = vi.fn().mockResolvedValue(undefined);
    const provider = boundary<
      Awaited<ReturnType<typeof providers.openMidnightSession>>['providers']
    >({
      publicDataProvider: boundary({
        queryContractState: vi.fn().mockResolvedValue({}),
      }),
      zkConfigProvider: boundary({
        getVerifierKeys: vi.fn().mockResolvedValue([]),
      }),
      privateStateProvider: boundary({
        setContractAddress: vi.fn(),
        set: vi.fn().mockResolvedValue(undefined),
      }),
    });
    const open = vi.spyOn(providers, 'openMidnightSession').mockResolvedValue(
      boundary<Awaited<ReturnType<typeof providers.openMidnightSession>>>({
        providers: provider,
        close,
      })
    );
    let finishFirst!: (
      value: Awaited<ReturnType<typeof createUnprovenCallTx>>
    ) => void;
    vi.mocked(createUnprovenCallTx).mockReturnValueOnce(
      new Promise(resolve => {
        finishFirst = resolve;
      })
    );
    const source = await createMidnightSource(
      'stagenet',
      createPublicClient({ transport: http('http://unused.invalid') })
    );
    const built: BuiltTransaction = {
      unsigned: {
        type: 'eip1559',
        chainId: 11155111,
        nonce: 0,
        gas: 21000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        to: '0x3333333333333333333333333333333333333333',
        value: 0n,
      },
      rlpEncoded: '0x02',
      nonce: 0,
      gasCostWei: 42000n,
      outputDeserializationSchema: Buffer.alloc(0),
      respondSerializationSchema: Buffer.from('"bool"'),
    };
    const signal = new AbortController();
    const args = {
      built,
      worker: {
        path: 'one',
        address: '0x3333333333333333333333333333333333333333' as const,
        busy: false,
        underfunded: false,
        balanceWei: 1n,
        leases: 0,
      },
      signal: signal.signal,
      signatureTimeoutMs: 100,
      responseTimeoutMs: 100,
    };
    const first = source.submit(args);
    const firstResult = expect(first).rejects.toThrow('cancel preparation');
    const second = source.submit(args);
    const secondResult = expect(second).rejects.toThrow('cancel preparation');
    await vi.waitFor(() =>
      expect(createUnprovenCallTx).toHaveBeenCalledTimes(1)
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(verifyContractState).toHaveBeenCalledTimes(1);
    signal.abort(new Error('cancel preparation'));
    finishFirst(boundary({}));
    await firstResult;
    await secondResult;
    await source.close?.();
    expect(createUnprovenCallTx).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledOnce();
  });
});

const keys = deriveAccountKeys('07'.repeat(32), MidnightNetwork.Stagenet);
const transaction = Transaction.fromParts(MidnightNetwork.Stagenet);
const fundedState = boundary<FacadeState>({
  unshielded: boundary<FacadeState['unshielded']>({ balances: { night: 1n } }),
  dust: boundary<FacadeState['dust']>({ balance: () => 100n }),
});

describe('Midnight estimated fee readiness', () => {
  it('retries the pinned SDK insufficient-funds tag while NIGHT generates', async () => {
    const insufficient = Object.assign(
      new Error('spendable coins cannot cover balancing'),
      { _tag: 'Wallet.InsufficientFunds' }
    );
    const estimate = vi
      .fn()
      .mockRejectedValueOnce(insufficient)
      .mockResolvedValue(20n);
    const wallet = boundary<WalletFacade>({
      calculateTransactionFee: vi.fn().mockResolvedValue(10n),
      estimateTransactionFee: estimate,
      waitForSyncedState: vi.fn().mockResolvedValue(fundedState),
    });
    const pending = providers.ensureTransactionFee(
      wallet,
      keys,
      MidnightNetwork.Stagenet,
      transaction,
      70_000
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;
    expect(estimate).toHaveBeenCalledTimes(2);
    expect(ensureFeeReady).toHaveBeenCalledTimes(2);
  });

  it('stops retrying at the transaction preparation deadline', async () => {
    const wallet = boundary<WalletFacade>({
      calculateTransactionFee: vi.fn().mockResolvedValue(10n),
      estimateTransactionFee: vi
        .fn()
        .mockRejectedValue(
          new Error('Insufficient Funds: could not balance dust')
        ),
      waitForSyncedState: vi.fn().mockResolvedValue(fundedState),
    });
    const pending = providers.ensureTransactionFee(
      wallet,
      keys,
      MidnightNetwork.Stagenet,
      transaction,
      65_000
    );
    const result = expect(pending).rejects.toThrow(
      'expired during fee preparation'
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await result;
  });

  it('preserves non-funding errors without retry', async () => {
    const original = new Error('invalid transaction');
    const estimate = vi.fn().mockRejectedValue(original);
    const wallet = boundary<WalletFacade>({
      calculateTransactionFee: vi.fn().mockResolvedValue(10n),
      estimateTransactionFee: estimate,
      waitForSyncedState: vi.fn().mockResolvedValue(fundedState),
    });
    await expect(
      providers.ensureTransactionFee(
        wallet,
        keys,
        MidnightNetwork.Stagenet,
        transaction,
        70_000
      )
    ).rejects.toBe(original);
    expect(estimate).toHaveBeenCalledOnce();
  });
});
