import { Connection, Keypair } from '@solana/web3.js';
import { constants } from '@sig-net/signet.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/env', async () => {
  const { Keypair } = await import('@solana/web3.js');
  return {
    env: {
      solRpcUrlDevnet: 'http://localhost:8899',
      solSk: JSON.stringify(Array.from(Keypair.generate().secretKey)),
    },
  };
});

import { execute } from '../src/handlers/solana';
import { withEthereumSubmission } from '../src/utils/initEvm';
import {
  closeSharedSolana,
  getSharedSolana,
  initSolana,
  solanaPollingStats,
} from '../src/utils/initSolana';
import { buildSignBidirectionalInstruction } from '../src/utils/signBidirectionalIx';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Connection.prototype, 'onLogs').mockImplementation(() => {
    throw new Error('WebSockets forbidden');
  });
  vi.spyOn(Connection.prototype, 'onSignature').mockImplementation(() => {
    throw new Error('WebSockets forbidden');
  });
  vi.spyOn(Connection.prototype, 'confirmTransaction').mockImplementation(
    () => {
      throw new Error('WebSocket confirmation forbidden');
    }
  );
  vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 200,
  });
  vi.spyOn(Connection.prototype, 'sendRawTransaction').mockImplementation(
    async () => `tx-${Math.random()}`
  );
  vi.spyOn(Connection.prototype, 'getSignatureStatuses').mockImplementation(
    async signatures => ({
      context: { slot: 100 },
      value: signatures.map(() => ({
        slot: 100,
        confirmations: 2,
        err: null,
        confirmationStatus: 'confirmed',
      })),
    })
  );
  vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(100);
  vi.spyOn(Connection.prototype, 'getSignaturesForAddress').mockResolvedValue(
    []
  );
});
afterEach(() => {
  closeSharedSolana();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const config = {
  contractAddress: constants.CONTRACT_ADDRESSES.SOLANA.TESTNET_DEV,
  environment: 'dev' as const,
};

describe('packaged SDK integration', () => {
  it('reuses shared services across two ping batches with HTTP-only confirmation', async () => {
    const context = getSharedSolana(config);
    for (let run = 0; run < 2; run++) {
      const batch = Promise.all(
        Array.from({ length: 20 }, () =>
          execute({ environment: 'dev', check_signature: false })
        )
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(await batch).toHaveLength(20);
      expect(getSharedSolana(config)).toBe(context);
      expect(solanaPollingStats()).toHaveLength(1);
    }
    expect(Connection.prototype.sendRawTransaction).toHaveBeenCalledTimes(40);
    expect(
      vi.mocked(Connection.prototype.getSignatureStatuses).mock.calls.length
    ).toBeLessThan(10);
    expect(Connection.prototype.onSignature).not.toHaveBeenCalled();
    expect(Connection.prototype.onLogs).not.toHaveBeenCalled();
    expect(Connection.prototype.confirmTransaction).not.toHaveBeenCalled();
  });

  it('shares ping and bidirectional waits while keeping requester identities separate', async () => {
    const shared = getSharedSolana(config);
    const first = initSolana(config);
    const second = initSolana(config);
    expect(first.provider).toBe(shared.provider);
    expect(
      second.requesterKeypair.publicKey.equals(first.requesterKeypair.publicKey)
    ).toBe(false);
    await shared.chainSigContract.prepareEventPolling();
    const abort = new AbortController();
    const pending = [
      first.chainSigContract,
      second.chainSigContract,
      shared.chainSigContract,
    ].map(contract =>
      contract
        .waitForEvent({
          eventName: 'signatureRespondedEvent',
          requestId: '0x01',
          signer: shared.eventPoller.programId,
          signal: abort.signal,
        })
        .catch(error => error)
    );
    expect(shared.eventPoller.stats.pendingWaiters).toBe(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(Connection.prototype.getSlot).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(Connection.prototype.getSignaturesForAddress).mock.calls.length
    ).toBeLessThanOrEqual(3);
    abort.abort(new Error('done'));
    await Promise.all(pending);
    expect(shared.eventPoller.stats.running).toBe(true);
    expect(shared.eventPoller.stats.pendingWaiters).toBe(0);
    closeSharedSolana();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('builds bidirectional instructions through the public SDK API', async () => {
    const shared = getSharedSolana(config);
    const instruction = await buildSignBidirectionalInstruction({
      chainSigContract: shared.chainSigContract,
      requester: shared.keypair.publicKey,
      feePayer: shared.keypair.publicKey,
      args: {
        serializedTransaction: Buffer.from([1]),
        caip2Id: 'eip155:1',
        keyVersion: 1,
        path: 'test',
        algo: 'ECDSA',
        dest: 'ethereum',
        params: '',
        outputDeserializationSchema: Buffer.alloc(0),
        respondSerializationSchema: Buffer.from([1]),
      },
    });
    expect(instruction.programId.toString()).toBe(config.contractAddress);
    expect(
      instruction.keys.some(
        key => key.pubkey.equals(shared.keypair.publicKey) && key.isSigner
      )
    ).toBe(true);
  });
});

it('serializes same-account submissions and recovers the queue after failure', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const first = withEthereumSubmission('chain:account', async () => {
    await gate;
    throw new Error('RPC failure');
  }).catch(error => error);
  const send = vi.fn(async () => 'next');
  const second = withEthereumSubmission('chain:account', send);
  expect(
    await withEthereumSubmission('chain:other', async () => 'independent')
  ).toBe('independent');
  expect(send).not.toHaveBeenCalled();
  release();
  expect((await first).message).toBe('RPC failure');
  expect(await second).toBe('next');
});
