import { setTimeout as delay } from 'node:timers/promises';
import {
  createUnprovenCallTx,
  submitTxAsync,
  verifyContractState,
} from '@midnight-ntwrk/midnight-js/contracts';
import { SucceedEntirely } from '@midnight-ntwrk/midnight-js/types';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {
  deriveMidnightResponseKey,
  requestIdHex,
  requestIdBytes,
  respondBidirectionalEventToCircuitInput,
  signatureRespondedEventToSignature,
  SignetRequestResponseReader,
} from '@sig-net/midnight';
import type { Hex, PublicClient } from 'viem';
import type { BidirectionalEnvironment } from '../utils/bidirectionalTx.js';
import type { BidirectionalSource } from '../utils/bidirectionalSource.js';
import {
  Contract,
  witnesses,
  compiledContract,
  ledger,
  PRIVATE_STATE_ID,
  NATIVE_REQUESTS_PATH,
  ERC20_REQUESTS_PATH,
  type CallerCircuitId,
} from './caller.mjs';
import { resolveMidnightConfig } from './config.mjs';
import { openMidnightSession } from './provider.mjs';
import { midnightPath, toCallerTransaction } from './transaction.mjs';
import { deriveMidnightWorkers } from './derivation.mjs';
import { pendingRequestStore } from './pending.mjs';
import { waitForMidnightTransaction } from './finalization.mjs';
import { createRequestEventSource } from './events.mjs';

/** Bound the caller's wait without releasing ownership of unfinished work. */
export function withinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  label: string
): Promise<T> {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  return new Promise<T>((resolve, reject) => {
    const abort = () => controller.abort(signal.reason);
    const timeout = () =>
      controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
    const timer = setTimeout(timeout, Math.max(0, timeoutMs));
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    controller.signal.addEventListener(
      'abort',
      () => {
        cleanup();
        reject(controller.signal.reason);
      },
      { once: true }
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    if (timeoutMs <= 0) timeout();
    if (controller.signal.aborted) return;
    Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      })
      .then(
        value => {
          if (Date.now() >= deadline) timeout();
          cleanup();
          if (!controller.signal.aborted) resolve(value);
        },
        error => {
          cleanup();
          reject(error);
        }
      );
  });
}

/** Poll authenticated reads under one deadline, including stalled reads and settlement. */
export function pollVerified<T>(
  read: (signal: AbortSignal) => Promise<T | undefined>,
  timeoutMs: number,
  signal: AbortSignal
): Promise<T> {
  return withinDeadline(
    async active => {
      for (;;) {
        active.throwIfAborted();
        const value = await read(active);
        active.throwIfAborted();
        if (value !== undefined) return value;
        await delay(5_000, undefined, { signal: active });
      }
    },
    timeoutMs,
    signal,
    'Verified Midnight response'
  );
}

/** The raw operation holds the queue until it settles, even if its outward wait expires. */
export function createWalletLane() {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation);
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
    idle: () => tail,
  };
}

const SOURCE_TRANSACTION_TIMEOUT_MS = 30 * 60_000;

/** A pending on-chain request blocks fresh work until its authenticated settlement is confirmed. */
export async function createMidnightSource(
  environment: BidirectionalEnvironment,
  _client: PublicClient
): Promise<BidirectionalSource> {
  if (environment !== 'stagenet')
    throw new Error('Midnight pinger only supports stagenet');
  const config = resolveMidnightConfig();
  const callerAddress = config.callerAddress!;
  const pending = pendingRequestStore(config.stateDirectory);
  const publicDataProvider = indexerPublicDataProvider({
    queryURL: config.node.indexerUrl,
    subscriptionURL: config.node.indexerWsUrl,
  });
  const responseKey = deriveMidnightResponseKey(
    config.rootPublicKey,
    callerAddress
  );
  const lane = createWalletLane();
  let sessionPromise: ReturnType<typeof openMidnightSession> | undefined;
  const session = () =>
    (sessionPromise ??= (async () => {
      const ready = await openMidnightSession(config);
      try {
        // Joining through findDeployedContract starts an indefinite deployment watcher.
        // Calls need only verified current code and the operator's private witness.
        const state =
          await ready.providers.publicDataProvider.queryContractState(
            callerAddress
          );
        if (!state) throw new Error('Midnight caller is not indexed');
        const ids = Object.keys(
          new Contract(witnesses).provableCircuits
        ) as CallerCircuitId[];
        verifyContractState(
          await ready.providers.zkConfigProvider.getVerifierKeys(ids),
          state
        );
        ready.providers.privateStateProvider.setContractAddress(callerAddress);
        await ready.providers.privateStateProvider.set(PRIVATE_STATE_ID, {
          secretKey: config.operatorSecret,
        });
        return ready;
      } catch (error) {
        await ready.close();
        throw error;
      }
    })().catch(error => {
      sessionPromise = undefined;
      throw error;
    }));

  const submitPrepared = async (
    ready: Awaited<ReturnType<typeof openMidnightSession>>,
    circuitId: CallerCircuitId,
    unprovenTx: Parameters<typeof submitTxAsync>[1]['unprovenTx'],
    signal: AbortSignal,
    recordTransaction: (txId: string) => Promise<void>
  ) => {
    signal.throwIfAborted();
    const txId = await submitTxAsync(
      {
        ...ready.providers,
        midnightProvider: {
          async submitTx(tx) {
            signal.throwIfAborted();
            // WalletFacade.submitTransaction returns the last intent identifier.
            const identifier = tx.identifiers().at(-1);
            if (!identifier)
              throw new Error('Midnight transaction has no identifier');
            await recordTransaction(identifier);
            signal.throwIfAborted();
            return ready.providers.midnightProvider.submitTx(tx);
          },
        },
      },
      { unprovenTx, circuitId }
    );
    signal.throwIfAborted();
    const finalized = await waitForMidnightTransaction(
      config.node,
      txId,
      signal,
      SOURCE_TRANSACTION_TIMEOUT_MS
    );
    if (finalized.status !== SucceedEntirely)
      throw new Error(`Midnight transaction ${txId} did not succeed entirely`);
    return finalized;
  };

  return {
    assertReady: () => pending.assertEmpty(),
    async deriveWorkers(_client, paths) {
      const state = await withinDeadline(
        () => publicDataProvider.queryContractState(callerAddress),
        30_000,
        new AbortController().signal,
        'Midnight caller readiness'
      );
      if (!state) throw new Error('Midnight pinger caller is not indexed');
      const current = ledger(state.data);
      if (
        current.initialised === 0n ||
        current.destinationChainId !== 11155111n ||
        current.mpcResponseKey.x !== responseKey.x ||
        current.mpcResponseKey.y !== responseKey.y ||
        current.mpcResponseKey.identity !== responseKey.identity
      )
        throw new Error(
          'Midnight caller must be initialised for the configured MPC root and Sepolia'
        );
      return deriveMidnightWorkers(paths, {
        MPC_MIDNIGHT_CALLER_ADDRESS: callerAddress,
        MPC_MIDNIGHT_ROOT_PUBLIC_KEY: config.rootPublicKey,
        MPC_MIDNIGHT_CENTRAL_ADDRESS: config.centralAddress,
        MPC_MIDNIGHT_STATE_DIR: config.stateDirectory,
      });
    },
    async submit({
      built,
      worker,
      signal,
      signatureTimeoutMs,
      responseTimeoutMs,
      onProgress,
    }) {
      const tx = toCallerTransaction(built.unsigned);
      const native = !tx.calldata.is_some;
      const submitted = await withinDeadline(
        active =>
          lane.run(async () => {
            active.throwIfAborted();
            await pending.assertEmpty();
            const ready = await session();
            active.throwIfAborted();
            const circuitId = native ? 'submitNative' : 'submitErc20';
            const prepared = await createUnprovenCallTx(ready.providers, {
              contractAddress: callerAddress,
              compiledContract,
              privateStateId: PRIVATE_STATE_ID,
              circuitId,
              args: [tx, midnightPath(worker.path)],
            });
            active.throwIfAborted();
            const requestId = requestIdHex(prepared.private.result);
            await pending.create({
              callerAddress,
              centralAddress: config.centralAddress,
              requestId,
              path: worker.path,
              nonce: built.nonce,
              createdAt: new Date().toISOString(),
            });
            onProgress?.({ requestId, nonce: built.nonce });
            try {
              const finalized = await submitPrepared(
                ready,
                circuitId,
                prepared.private.unprovenTx,
                active,
                async sourceTx => {
                  await pending.update(requestId, { sourceTx });
                  onProgress?.({ requestId, sourceTx, nonce: built.nonce });
                }
              );
              await ready.providers.privateStateProvider.set(
                PRIVATE_STATE_ID,
                prepared.private.nextPrivateState
              );
              return { requestId, finalized };
            } catch (error) {
              // No contract transaction was attempted. Wait for raw preparation to
              // stop before permitting another request; an outward timeout alone is insufficient.
              const record = await pending.read();
              if (record?.requestId === requestId && !record.sourceTx)
                await pending.clear(requestId);
              throw error;
            }
          }),
        SOURCE_TRANSACTION_TIMEOUT_MS,
        signal,
        'Midnight request submission'
      );
      const { requestId, finalized } = submitted;
      const events = createRequestEventSource(
        publicDataProvider,
        config.centralAddress,
        requestId,
        finalized.blockHeight,
        signal
      );
      const reader = new SignetRequestResponseReader({
        requesterContractAddress: callerAddress,
        requesterRequestsPath: native
          ? NATIVE_REQUESTS_PATH
          : ERC20_REQUESTS_PATH,
        signetContractAddress: config.centralAddress,
        publicDataProvider,
        eventSource: events,
      });
      const signature = pollVerified(
        async () => {
          const unsigned = await reader.getUnsignedEvmTransaction(requestId);
          if (
            unsigned.unsignedSerialized.toLowerCase() !==
            built.rlpEncoded.toLowerCase()
          )
            throw new Error(
              'Midnight caller changed the Ethereum signing payload'
            );
          const result = await reader.getVerifiedSignatureRespondedEvent(
            requestId,
            worker.address
          );
          if (!result.verified) return undefined;
          const signed = signatureRespondedEventToSignature(result.verified);
          return { r: signed.r, s: signed.s, v: signed.v };
        },
        signatureTimeoutMs,
        signal
      );
      const response = pollVerified(
        async active => {
          const output = Uint8Array.of(1);
          const attestation = await reader.getVerifiedRespondBidirectionalEvent(
            requestId,
            output,
            responseKey
          );
          if (!attestation) return undefined;
          await lane.run(async () => {
            active.throwIfAborted();
            const ready = await session();
            const circuitId = native ? 'completeNative' : 'completeErc20';
            const prepared = await createUnprovenCallTx(ready.providers, {
              contractAddress: callerAddress,
              compiledContract,
              privateStateId: PRIVATE_STATE_ID,
              circuitId,
              args: [
                requestIdBytes(requestId),
                respondBidirectionalEventToCircuitInput(attestation),
                output,
              ],
            });
            await submitPrepared(
              ready,
              circuitId,
              prepared.private.unprovenTx,
              active,
              settlementTx => pending.update(requestId, { settlementTx })
            );
            await ready.providers.privateStateProvider.set(
              PRIVATE_STATE_ID,
              prepared.private.nextPrivateState
            );
            await pending.clear(requestId);
          });
          return '0x01' as Hex;
        },
        responseTimeoutMs,
        signal
      ).finally(() => events.close());
      signature.catch(() => undefined);
      response.catch(() => undefined);
      return { requestId, sourceTx: finalized.txId, signature, response };
    },
    async close() {
      const cleanup = Promise.all([
        publicDataProvider.dispose(),
        lane.idle().then(async () => {
          if (sessionPromise) await (await sessionPromise).close();
        }),
      ]);
      await withinDeadline(
        () => cleanup,
        30_000,
        new AbortController().signal,
        'Midnight shutdown'
      );
    },
  };
}
