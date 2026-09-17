import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type { FinalizedTxData } from '@midnight-ntwrk/midnight-js/types';
import type { MidnightNodeConfig } from '@sig-net/midnight-contract-deploy';

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
  const deadline = Date.now() + timeoutMs;
  const provider = indexerPublicDataProvider({
    queryURL: nodeConfig.indexerUrl,
    subscriptionURL: nodeConfig.indexerWsUrl,
    pollInterval: 5000,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<FinalizedTxData>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(timeoutError()), timeoutMs);
      provider
        .watchForTxData(txId)
        .then(
          result =>
            Date.now() >= deadline ? reject(timeoutError()) : resolve(result),
          reject
        );
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    // The SDK stops Apollo synchronously, then awaits WebSocket teardown.
    // Observe teardown errors without letting a stalled socket extend this wait.
    void provider.dispose().catch(error => {
      console.error('Midnight finalization provider disposal failed', error);
    });
  }
}
