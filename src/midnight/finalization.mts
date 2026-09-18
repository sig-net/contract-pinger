import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type { FinalizedTxData } from '@midnight-ntwrk/midnight-js/types';
import type { MidnightNodeConfig } from '@sig-net/midnight-contract-deploy';
import { withinDeadline } from './deadline.mjs';

/** Own the indexer watch so an outward deadline also stops its polling. */
export async function waitForMidnightTransaction(
  nodeConfig: MidnightNodeConfig,
  txId: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<FinalizedTxData> {
  signal.throwIfAborted();
  const timeoutError = () =>
    new Error(
      `Midnight transaction ${txId} finalization timed out after ${timeoutMs}ms`
    );
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw timeoutError();
  let provider: ReturnType<typeof indexerPublicDataProvider> | undefined;
  try {
    return await withinDeadline(
      () => {
        provider = indexerPublicDataProvider({
          queryURL: nodeConfig.indexerUrl,
          subscriptionURL: nodeConfig.indexerWsUrl,
          pollInterval: 5000,
        });
        return provider.watchForTxData(txId);
      },
      timeoutMs,
      signal,
      `Midnight transaction ${txId} finalization`
    );
  } finally {
    // The SDK stops Apollo synchronously, then awaits WebSocket teardown.
    // Observe teardown errors without letting a stalled socket extend this wait.
    void provider?.dispose().catch(error => {
      console.error('Midnight finalization provider disposal failed', error);
    });
  }
}
