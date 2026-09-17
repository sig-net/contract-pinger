import { createRequire } from 'node:module';
import {
  createCircuitContext,
  createConstructorContext,
} from '@midnight-ntwrk/compact-runtime';
import { IndexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { Contract } from '@sig-net/midnight-contract';
import {
  decodeSignetLogEvents,
  requestIdBytes,
  requestIdHex,
  SIGNET_EVENT_NAME_LENGTH,
} from '@sig-net/midnight';
import {
  calculateSignetAttestationDigest,
  ecdsaSignatureToMpcSignature,
  signAttestationDigest,
} from '@sig-net/midnight/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createRequestEventSource,
  MAX_RECEIVED_EVENTS,
  MAX_REQUEST_EVENTS,
} from '../src/midnight/events.mjs';

const require = createRequire(
  import.meta
    .resolve('@midnight-ntwrk/midnight-js-indexer-public-data-provider')
);
const { Observable } = require('rxjs');
const central = 'ab'.repeat(32);
const request = requestIdHex(new Uint8Array(32).fill(3));
const otherRequest = requestIdHex(new Uint8Array(32).fill(4));
type WireEvent = {
  __typename: string;
  id: number;
  maxId: number;
  version: number;
  contractAddress: string;
  transactionId: number;
  raw: string;
  name: string;
  payload: string;
};
const fixtures: WireEvent[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

beforeAll(async () => {
  // Use the published contract's actual emit path, not a hand-packed payload.
  for (const [circuit, id] of [
    ['respond', request],
    ['respondBidirectional', request],
    ['respondBidirectional', otherRequest],
  ] as const) {
    const contract = new Contract({});
    const initial = await contract.initialState(
      createConstructorContext(undefined, '00'.repeat(32))
    );
    const context = createCircuitContext(
      circuit,
      central,
      '00'.repeat(32),
      initial.currentContractState,
      initial.currentPrivateState
    );
    const signature = ecdsaSignatureToMpcSignature(
      signAttestationDigest(
        calculateSignetAttestationDigest(requestIdBytes(id), Uint8Array.of(1)),
        new Uint8Array(32).fill(42)
      )
    );
    const result = await contract.circuits[circuit](
      context,
      requestIdBytes(id),
      { signature }
    );
    const event = decodeSignetLogEvents(result.context.events, central)[0];
    if (!event) throw new Error('Published circuit emitted no event');
    const name = Buffer.alloc(SIGNET_EVENT_NAME_LENGTH);
    name.write(event.name);
    fixtures.push({
      __typename: 'MiscContractEvent',
      id: fixtures.length + 1,
      maxId: 3,
      version: 1,
      contractAddress: central,
      transactionId: 1,
      raw: '',
      name: name.toString('hex'),
      payload: Buffer.from(event.payload).toString('hex'),
    });
  }
});

function transport(synchronous?: WireEvent[]) {
  let observer:
    | {
        next(value: unknown): void;
        error(error: unknown): void;
        complete(): void;
      }
    | undefined;
  let stopped = false;
  const requests: { variables: unknown }[] = [];
  const client = {
    subscribe(operation: { variables: unknown }) {
      requests.push(operation);
      return new Observable((subscriber: NonNullable<typeof observer>) => {
        observer = subscriber;
        for (const event of synchronous ?? [])
          subscriber.next({ data: { contractEvents: event } });
        return () => {
          stopped = true;
        };
      });
    },
  };
  // Only transport is replaced. The pinned SDK validates filters, constructs
  // GraphQL variables, and maps actual indexer envelopes before our helper.
  const provider = new IndexerPublicDataProvider(
    {
      client: client as unknown as ConstructorParameters<
        typeof IndexerPublicDataProvider
      >[0]['client'],
      dispose: async () => {},
    },
    1000
  );
  const controller = new AbortController();
  const source = createRequestEventSource(
    provider,
    central,
    request,
    123,
    controller.signal
  );
  cleanups.push(source.close);
  return {
    provider,
    source,
    controller,
    requests,
    emit: (event: WireEvent) =>
      observer!.next({ data: { contractEvents: event } }),
    error: () => observer!.error(new Error('transport unavailable')),
    complete: () => observer!.complete(),
    stopped: () => stopped,
  };
}

describe('request-scoped Midnight events', () => {
  it('sends the actual SDK contract/type filter and submission-block cursor once', async () => {
    const run = transport();
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0].variables).toEqual({
      filter: {
        contractAddress: central,
        types: ['MISC'],
        fieldPrefixes: null,
        fromBlock: 123,
        toBlock: null,
        transactionHash: null,
      },
      id: null,
    });
    expect(() =>
      run.provider.contractEventsObservable({
        contractAddress: central,
        types: ['Misc'],
        fieldPrefixes: [{ fieldName: 'payload', prefix: request }],
      })
    ).toThrow(/Misc has no indexed fields/);
    await run.source.querySignetEvents(central);
    await run.source.querySignetEvents(central);
    expect(run.requests).toHaveLength(1);
  });

  it('caches both real response emits, filters other requests, and deduplicates replay', async () => {
    const run = transport();
    for (const event of fixtures) run.emit(event);
    for (const event of fixtures) run.emit(event);
    const cached = await run.source.querySignetEvents(central);
    expect(cached.map(event => event.name)).toEqual([
      'SignatureRespondedEvent',
      'RespondBidirectionalEvent',
    ]);
    expect(Buffer.from(cached[0].payload).toString('hex')).toBe(
      fixtures[0].payload
    );
    cached[0].payload.fill(0);
    expect(
      Buffer.from(
        (await run.source.querySignetEvents(central))[0].payload
      ).toString('hex')
    ).toBe(fixtures[0].payload);
    expect(run.requests).toHaveLength(1);
  });

  it('aborts and explicitly closes the underlying subscription', async () => {
    const aborted = transport();
    aborted.controller.abort();
    expect(aborted.stopped()).toBe(true);
    await expect(aborted.source.querySignetEvents(central)).rejects.toThrow(
      /aborted/
    );
    const closed = transport();
    closed.source.close();
    expect(closed.stopped()).toBe(true);
    await expect(closed.source.querySignetEvents(central)).rejects.toThrow(
      /closed/
    );
  });

  it('fails closed on stream errors and unexpected completion without reconnecting', async () => {
    for (const end of ['error', 'complete'] as const) {
      const run = transport();
      run.emit(fixtures[0]);
      run[end]();
      await expect(run.source.querySignetEvents(central)).rejects.toThrow(
        /stream failed|stream ended/
      );
      expect(run.stopped()).toBe(true);
      expect(run.requests).toHaveLength(1);
    }
  });

  it('bounds matching posts and tears down even on synchronous overflow', async () => {
    const events = Array.from({ length: MAX_REQUEST_EVENTS + 1 }, (_, id) => ({
      ...fixtures[0],
      id,
    }));
    const run = transport(events);
    await expect(run.source.querySignetEvents(central)).rejects.toThrow(
      /cache limit/
    );
    expect(run.stopped()).toBe(true);
  });

  it('bounds total received traffic, including unrelated events and replay', async () => {
    const run = transport();
    for (let id = 0; id <= MAX_RECEIVED_EVENTS; id += 1) run.emit(fixtures[2]);
    await expect(run.source.querySignetEvents(central)).rejects.toThrow(
      /receive budget/
    );
    expect(run.stopped()).toBe(true);
  });

  it('rejects invalid anchors, malformed wire data, and a mismatched getter address', async () => {
    const run = transport();
    expect(() =>
      createRequestEventSource(
        run.provider,
        central,
        request,
        -1,
        new AbortController().signal
      )
    ).toThrow(/block height/);
    await expect(run.source.querySignetEvents('ff'.repeat(32))).rejects.toThrow(
      /another contract/
    );
    run.emit({ ...fixtures[0], payload: 'not-hex' });
    await expect(run.source.querySignetEvents(central)).rejects.toThrow(
      /payload encoding/
    );
    expect(run.stopped()).toBe(true);
  });
});
