import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js/types';
import {
  decodeRespondBidirectionalEventPayload,
  decodeSignatureRespondedEventPayload,
  decodeSignetEventName,
  requestIdHex,
  SIGNET_EVENT_NAME_LENGTH,
  SIGNET_EVENT_PAYLOAD_LENGTH,
  SignetEventName,
  type SignetEventSource,
  type SignetMiscEvent,
} from '@sig-net/midnight';

// Fail closed on an excessive stream instead of growing memory or silently
// dropping possible responses. These bounds include unverified public posts.
export const MAX_REQUEST_EVENTS = 64;
export const MAX_RECEIVED_EVENTS = 4096;

/**
 * One replay/live stream from the submitted transaction's block; reads use the
 * cache. The pinned indexer cannot prefix-filter Misc payloads, so other central
 * Misc events after that block are received and scoped locally by SDK decoders.
 * Cached request IDs are routing data; the reader still authenticates signatures.
 */
export function createRequestEventSource(
  provider: Pick<PublicDataProvider, 'contractEventsObservable'>,
  centralAddress: string,
  requestId: string,
  startBlockHeight: number,
  signal: AbortSignal
): SignetEventSource & { close(): void } {
  if (!Number.isSafeInteger(startBlockHeight) || startBlockHeight < 0) {
    throw new Error(
      'A valid submission block height is required for Midnight events'
    );
  }
  if (!/^[0-9a-f]{64}$/.test(requestId)) {
    throw new Error('A canonical request ID is required for Midnight events');
  }
  const records = new Map<number, SignetMiscEvent>();
  let received = 0;
  let lastId = -1;
  let failure: Error | undefined;
  let closed = false;
  let subscription: { unsubscribe(): void } | undefined;
  const stop = () => {
    closed = true;
    signal.removeEventListener('abort', abort);
    subscription?.unsubscribe();
  };
  const fail = (error: Error) => {
    failure ??= error;
    stop();
  };
  const abort = () =>
    fail(new Error('Midnight event stream aborted', { cause: signal.reason }));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  if (!closed) {
    try {
      subscription = provider
        .contractEventsObservable(
          { contractAddress: centralAddress, types: ['Misc'] },
          { startAt: { fromBlock: startBlockHeight } }
        )
        .subscribe({
          next(event) {
            if (closed) return;
            try {
              if (++received > MAX_RECEIVED_EVENTS)
                throw new Error('Midnight event receive budget exceeded');
              if (!Number.isSafeInteger(event.id) || event.id < 0)
                throw new Error('Invalid Midnight event cursor');
              // The SDK guarantees monotonic IDs and at-least-once reconnect
              // delivery. A high-water mark drops replay without an unbounded set.
              if (event.id <= lastId) return;
              lastId = event.id;
              if (
                event.eventType !== 'Misc' ||
                event.contractAddress !== centralAddress
              )
                throw new Error(
                  'Midnight event escaped its contract/type filter'
                );
              if (event.version !== 1)
                throw new Error('Unsupported Midnight event schema version');
              if (
                !/^(?:[0-9a-fA-F]{2})*$/.test(event.name) ||
                event.name.length > SIGNET_EVENT_NAME_LENGTH * 2
              )
                throw new Error('Invalid Midnight event name encoding');
              const name = decodeSignetEventName(
                Buffer.from(event.name, 'hex')
              );
              if (
                name !== SignetEventName.SignatureRespondedEvent &&
                name !== SignetEventName.RespondBidirectionalEvent
              )
                return;
              if (
                !/^(?:[0-9a-fA-F]{2})*$/.test(event.payload) ||
                event.payload.length > SIGNET_EVENT_PAYLOAD_LENGTH * 2
              )
                throw new Error('Invalid Midnight event payload encoding');
              const payload = new Uint8Array(SIGNET_EVENT_PAYLOAD_LENGTH);
              payload.set(Buffer.from(event.payload, 'hex'));
              const post =
                name === SignetEventName.SignatureRespondedEvent
                  ? decodeSignatureRespondedEventPayload(payload)
                  : decodeRespondBidirectionalEventPayload(payload);
              if (requestIdHex(post.requestId) !== requestId) return;
              if (records.size >= MAX_REQUEST_EVENTS)
                throw new Error('Midnight request event cache limit exceeded');
              records.set(event.id, { name, payload });
            } catch (error) {
              fail(
                error instanceof Error
                  ? error
                  : new Error('Midnight event processing failed')
              );
            }
          },
          error: error =>
            fail(new Error('Midnight event stream failed', { cause: error })),
          complete: () =>
            fail(new Error('Midnight event stream ended before closure')),
        });
      // A provider may emit synchronously before subscribe() returns its handle.
      if (closed) subscription.unsubscribe();
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new Error('Midnight event subscription failed')
      );
    }
  }
  return {
    async querySignetEvents(address) {
      if (failure) throw failure;
      if (closed) throw new Error('Midnight event stream is closed');
      if (address !== centralAddress)
        throw new Error('Midnight event source belongs to another contract');
      return [...records.values()].map(event => ({
        name: event.name,
        payload: event.payload.slice(),
      }));
    },
    close: stop,
  };
}
