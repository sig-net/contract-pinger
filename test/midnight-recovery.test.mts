import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Transaction as EvmTransaction, SigningKey } from 'ethers';
import { createPublicClient, http, serializeTransaction } from 'viem';
import { createUnprovenCallTx } from '@midnight-ntwrk/midnight-js/contracts';
import {
  SucceedEntirely,
  type MidnightProvider,
  type FinalizedTxData,
  type ProofProvider,
  type PrivateStateProvider,
} from '@midnight-ntwrk/midnight-js/types';
import {
  MidnightNetwork,
  SignetRequestResponseReader,
} from '@sig-net/midnight';
import { ecdsaSignatureToMpcSignature } from '@sig-net/midnight/testing';
import type {
  BidirectionalSource,
  SourceProgress,
} from '../src/utils/bidirectionalSource.js';
import type { BuiltTransaction } from '../src/utils/bidirectionalTx.js';
import { createMidnightSource } from '../src/midnight/source.mjs';
import { pendingRequestStore } from '../src/midnight/pending.mjs';
import {
  PRIVATE_STATE_ID,
  type CallerPrivateState,
} from '../src/midnight/caller.mjs';
import * as configuration from '../src/midnight/config.mjs';
import * as sessions from '../src/midnight/provider.mjs';
import * as finalization from '../src/midnight/finalization.mjs';
import * as events from '../src/midnight/events.mjs';
import * as indexer from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

// Keep the SDK's submitTxAsync producer intact: it proves, balances, then
// invokes the wrapped midnightProvider. Unconfigured boundary access fails.
function boundary<T extends object>(properties: Partial<NoInfer<T>>): T {
  return new Proxy(properties, {
    get(target, key) {
      if (key in target || typeof key === 'symbol' || key === 'then')
        return Reflect.get(target, key);
      throw new Error(`Unconfigured SDK boundary: ${String(key)}`);
    },
  }) as T;
}
vi.mock('@midnight-ntwrk/midnight-js/contracts', async original => ({
  ...(await original<typeof import('@midnight-ntwrk/midnight-js/contracts')>()),
  createUnprovenCallTx: vi.fn(),
  verifyContractState: vi.fn(),
}));
vi.mock(
  '@midnight-ntwrk/midnight-js-indexer-public-data-provider',
  async original => ({
    ...(await original<
      typeof import('@midnight-ntwrk/midnight-js-indexer-public-data-provider')
    >()),
    indexerPublicDataProvider: vi.fn(),
  })
);

const requestId = '01'.repeat(32);
const sourceTx = '02'.repeat(32);
const settlementTx = '03'.repeat(32);
const node = {
  networkId: MidnightNetwork.Stagenet,
  nodeUrl: 'http://unused.invalid',
  indexerUrl: 'http://unused.invalid',
  indexerWsUrl: 'ws://unused.invalid',
  proofServerUrl: 'http://unused.invalid',
};
const unsigned = {
  type: 'eip1559',
  chainId: 11155111,
  nonce: 9,
  gas: 21000n,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
  to: '0x3333333333333333333333333333333333333333',
  value: 0n,
} as const;
const built: BuiltTransaction = {
  unsigned,
  rlpEncoded: serializeTransaction(unsigned),
  nonce: 9,
  gasCostWei: 42000n,
  outputDeserializationSchema: Buffer.from('[]'),
  respondSerializationSchema: Buffer.from('"bool"'),
};
const worker = {
  path: 'load-0',
  address: unsigned.to,
  busy: true,
  underfunded: false,
  balanceWei: 10n ** 18n,
  leases: 1,
};
const signature = new SigningKey('0x' + '07'.repeat(32)).sign(
  EvmTransaction.from(built.rlpEncoded).unsignedHash
);
const event = {
  signature: ecdsaSignatureToMpcSignature({
    r: BigInt(signature.r),
    s: BigInt(signature.s),
    recoveryId: signature.yParity,
  }),
};
const transaction = (identifier: string) =>
  boundary<Parameters<MidnightProvider['submitTx']>[0]>({
    identifiers: () => [identifier],
  });
const initialTx = transaction(sourceTx);
const completeTx = transaction(settlementTx);
const finalized = (txId: string, status = SucceedEntirely) =>
  boundary<FinalizedTxData>({ txId, status, blockHeight: 10 });

let config: configuration.MidnightConfig;
let sources: BidirectionalSource[];
let controllers: AbortController[];
let releasePending: (() => void)[];
let prove: ReturnType<typeof vi.fn<ProofProvider['proveTx']>>;
let networkSubmit: ReturnType<typeof vi.fn<MidnightProvider['submitTx']>>;
let privateSet: ReturnType<
  typeof vi.fn<
    PrivateStateProvider<typeof PRIVATE_STATE_ID, CallerPrivateState>['set']
  >
>;
let close: ReturnType<typeof vi.fn<() => Promise<void>>>;
let eventClose: ReturnType<typeof vi.fn<() => void>>;
let progress: SourceProgress[];

function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  releasePending.push(() => resolve(fallback));
  return { promise, resolve };
}
async function source() {
  const value = await createMidnightSource(
    'stagenet',
    createPublicClient({ transport: http('http://unused.invalid') })
  );
  sources.push(value);
  return value;
}
function args() {
  const controller = new AbortController();
  controllers.push(controller);
  return {
    built,
    worker,
    signal: controller.signal,
    signatureTimeoutMs: 1000,
    responseTimeoutMs: 1000,
    onProgress: (value: SourceProgress) => progress.push(value),
  };
}
const record = () => pendingRequestStore(config.stateDirectory).read();

beforeEach(async () => {
  await mkdir(resolve('.midnight/tests'), { recursive: true });
  config = {
    node,
    callerAddress: 'a'.repeat(64),
    centralAddress: 'b'.repeat(64),
    seed: '07'.repeat(32),
    operatorSecret: new Uint8Array(32),
    rootPublicKey:
      '04' +
      '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' +
      '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8',
    stateDirectory: await mkdtemp(resolve('.midnight/tests/recovery-')),
  };
  sources = [];
  controllers = [];
  releasePending = [];
  progress = [];
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(configuration, 'resolveMidnightConfig').mockReturnValue(config);
  vi.mocked(indexer.indexerPublicDataProvider).mockReturnValue(
    boundary({ dispose: vi.fn().mockResolvedValue(undefined) })
  );
  prove = vi.fn(
    async tx => tx as unknown as Awaited<ReturnType<ProofProvider['proveTx']>>
  );
  networkSubmit = vi.fn(
    async (tx: Parameters<MidnightProvider['submitTx']>[0]) =>
      tx.identifiers().at(-1)!
  );
  privateSet = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  eventClose = vi.fn();
  const provider = boundary<
    Awaited<ReturnType<typeof sessions.openMidnightSession>>['providers']
  >({
    publicDataProvider: boundary({
      queryContractState: vi.fn().mockResolvedValue({}),
    }),
    zkConfigProvider: boundary({
      getVerifierKeys: vi.fn().mockResolvedValue([]),
    }),
    privateStateProvider: boundary({
      setContractAddress: vi.fn(),
      set: privateSet,
    }),
    proofProvider: boundary({ proveTx: prove }),
    walletProvider: boundary({
      balanceTx: vi.fn(
        async tx => tx as unknown as Parameters<MidnightProvider['submitTx']>[0]
      ),
    }),
    midnightProvider: boundary({ submitTx: networkSubmit }),
  });
  vi.spyOn(sessions, 'openMidnightSession').mockResolvedValue(
    boundary({ providers: provider, close })
  );
  vi.mocked(createUnprovenCallTx).mockImplementation(
    async (_providers, options) =>
      boundary({
        private: boundary({
          result: new Uint8Array(32).fill(1),
          unprovenTx: (options.circuitId === 'submitNative'
            ? initialTx
            : completeTx) as never,
          nextPrivateState: { secretKey: config.operatorSecret },
        }),
      })
  );
  vi.spyOn(finalization, 'waitForMidnightTransaction').mockImplementation(
    async (_node, txId, signal) => {
      signal.throwIfAborted();
      return finalized(txId);
    }
  );
  vi.spyOn(events, 'createRequestEventSource').mockReturnValue(
    boundary({ close: eventClose })
  );
  vi.spyOn(
    SignetRequestResponseReader.prototype,
    'getUnsignedEvmTransaction'
  ).mockResolvedValue(EvmTransaction.from(built.rlpEncoded));
  vi.spyOn(
    SignetRequestResponseReader.prototype,
    'getVerifiedSignatureRespondedEvent'
  ).mockResolvedValue(boundary({ verified: event }));
  vi.spyOn(
    SignetRequestResponseReader.prototype,
    'getVerifiedRespondBidirectionalEvent'
  ).mockResolvedValue(event);
});
afterEach(async () => {
  for (const controller of controllers)
    controller.abort(new Error('test cleanup'));
  for (const release of releasePending) release();
  await Promise.all(sources.map(value => value.close?.()));
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('Midnight request recovery journal', () => {
  it('retains accepted-late request identity and blocks another submission, including after restart', async () => {
    const accepted = deferred(sourceTx);
    networkSubmit.mockReturnValueOnce(accepted.promise);
    const original = await source();
    const submitted = original.submit(args());
    const rejected = expect(submitted).rejects.toThrow(
      'Midnight request submission timed out'
    );
    await vi.waitFor(() => expect(networkSubmit).toHaveBeenCalledOnce());
    expect(await record()).toMatchObject({
      requestId,
      sourceTx,
      nonce: 9,
      path: worker.path,
    });
    expect(progress).toContainEqual({ requestId, sourceTx, nonce: 9 });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await rejected;
    await expect(original.assertReady?.()).rejects.toThrow(requestId);
    accepted.resolve(sourceTx);
    await original.close?.();
    expect(await record()).toMatchObject({ requestId, sourceTx, nonce: 9 });
    await expect(original.submit(args())).rejects.toThrow(
      'requires reconciliation'
    );
    const restarted = await source();
    await expect(restarted.assertReady?.()).rejects.toThrow(sourceTx);
    await expect(restarted.submit(args())).rejects.toThrow(
      'requires reconciliation'
    );
    expect(networkSubmit).toHaveBeenCalledOnce();
    expect(createUnprovenCallTx).toHaveBeenCalledOnce();
    expect(finalization.waitForMidnightTransaction).not.toHaveBeenCalled();
    expect(privateSet).toHaveBeenCalledTimes(1); // session witness only
    const persisted = JSON.parse(
      await readFile(
        pendingRequestStore(config.stateDirectory).filename,
        'utf8'
      )
    );
    expect(Object.keys(persisted).sort()).toEqual([
      'callerAddress',
      'centralAddress',
      'createdAt',
      'nonce',
      'path',
      'requestId',
      'sourceTx',
    ]);
  });

  it('keeps the journal while abandoned proving runs and clears it only after no attempt remains', async () => {
    const proving = deferred(
      initialTx as unknown as Awaited<ReturnType<ProofProvider['proveTx']>>
    );
    prove.mockReturnValueOnce(proving.promise);
    const original = await source();
    const options = args();
    const submitted = original.submit(options);
    const rejected = expect(submitted).rejects.toThrow('test cancellation');
    await vi.waitFor(() => expect(prove).toHaveBeenCalledOnce());
    controllers[0].abort(new Error('test cancellation'));
    await rejected;
    expect(await record()).toMatchObject({ requestId, nonce: 9 });
    await expect(original.assertReady?.()).rejects.toThrow(requestId);
    expect(networkSubmit).not.toHaveBeenCalled();
    proving.resolve(
      initialTx as unknown as Awaited<ReturnType<ProofProvider['proveTx']>>
    );
    await original.close?.();
    expect(networkSubmit).not.toHaveBeenCalled();
    expect(await record()).toBeUndefined();
    await expect(original.assertReady?.()).resolves.toBeUndefined();
  });

  it('clears the pending request only after authenticated settlement finalizes', async () => {
    const settled = deferred(finalized(settlementTx));
    vi.mocked(finalization.waitForMidnightTransaction).mockImplementation(
      async (_node, txId) =>
        txId === settlementTx ? settled.promise : finalized(txId)
    );
    const original = await source();
    const submitted = await original.submit(args());
    await vi.waitFor(() => expect(networkSubmit).toHaveBeenCalledTimes(2));
    expect(await record()).toMatchObject({
      requestId,
      sourceTx,
      settlementTx,
      nonce: 9,
    });
    expect(privateSet).toHaveBeenCalledTimes(2); // witness + confirmed request
    settled.resolve(finalized(settlementTx));
    await expect(submitted.signature).resolves.toMatchObject({
      v: signature.v,
    });
    await expect(submitted.response).resolves.toBe('0x01');
    expect(await record()).toBeUndefined();
    expect(privateSet).toHaveBeenCalledTimes(3);
    expect(eventClose).toHaveBeenCalledOnce();
    await expect(original.assertReady?.()).resolves.toBeUndefined();
  });

  it('retains both identifiers when settlement exceeds its response deadline', async () => {
    const settled = deferred(finalized(settlementTx));
    vi.mocked(finalization.waitForMidnightTransaction).mockImplementation(
      async (_node, txId, signal) => {
        if (txId !== settlementTx) return finalized(txId);
        return new Promise<FinalizedTxData>((resolve, reject) => {
          settled.promise.then(resolve);
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      }
    );
    const original = await source();
    const submitted = await original.submit(args());
    const rejected = expect(submitted.response).rejects.toThrow('timed out');
    await vi.waitFor(() => expect(networkSubmit).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(await record()).toMatchObject({
      requestId,
      sourceTx,
      settlementTx,
      nonce: 9,
    });
    expect(privateSet).toHaveBeenCalledTimes(2);
    await expect(original.assertReady?.()).rejects.toThrow(
      'requires reconciliation'
    );
    await expect(original.submit(args())).rejects.toThrow(
      'requires reconciliation'
    );
    expect(networkSubmit).toHaveBeenCalledTimes(2);
  });

  it('does not commit next private state when request finalization fails', async () => {
    vi.mocked(finalization.waitForMidnightTransaction).mockRejectedValueOnce(
      new Error('request finalization failed')
    );
    const original = await source();
    await expect(original.submit(args())).rejects.toThrow(
      'request finalization failed'
    );
    expect(privateSet).toHaveBeenCalledTimes(1);
    expect(privateSet).toHaveBeenCalledWith(PRIVATE_STATE_ID, {
      secretKey: config.operatorSecret,
    });
    expect(await record()).toMatchObject({ requestId, sourceTx, nonce: 9 });
    await expect(original.assertReady?.()).rejects.toThrow(
      'requires reconciliation'
    );
  });
});
