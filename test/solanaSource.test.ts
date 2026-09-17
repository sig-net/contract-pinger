import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PublicKey,
  TransactionInstruction,
  type Transaction,
} from '@solana/web3.js';
import type { PublicClient } from 'viem';
import { constants, contracts } from '@sig-net/signet.js';
import type { BuiltTransaction } from '../src/utils/bidirectionalTx';
import { ETHEREUM_CAIP2_ID, KEY_VERSION } from '../src/utils/bidirectionalTx';
import type { Worker } from '../src/utils/workerPool';

const mock = vi.hoisted(() => ({
  sendAndConfirm: vi.fn(
    async (_transaction: Transaction, _signers: unknown[]) =>
      'submitted-solana-signature'
  ),
  waitForEvent: vi.fn(),
  buildInstruction: vi.fn(),
  deriveWorkers: vi.fn(async () => []),
}));

vi.mock('../src/utils/initSolana', async () => {
  const { PublicKey } = await import('@solana/web3.js');
  return {
    getSharedSolana: () => ({
      chainSigContract: { waitForEvent: mock.waitForEvent },
      keypair: { publicKey: new PublicKey('11111111111111111111111111111111') },
      provider: { sendAndConfirm: mock.sendAndConfirm },
    }),
  };
});
vi.mock('../src/utils/signBidirectionalIx', () => ({
  buildSignBidirectionalInstruction: mock.buildInstruction,
}));
vi.mock('../src/utils/derivation', () => ({
  deriveWorkerAddresses: mock.deriveWorkers,
}));

import { createSolanaSource } from '../src/utils/solanaSource';

const built: BuiltTransaction = {
  nonce: 5,
  gasCostWei: 10n,
  unsigned: { type: 'eip1559', chainId: 11155111, nonce: 5 },
  rlpEncoded: '0x020304',
  outputDeserializationSchema: Buffer.from('[]'),
  respondSerializationSchema: Buffer.from('"bool"'),
};
const worker: Worker = {
  path: 'pinger-0',
  address: '0x1111111111111111111111111111111111111111',
  balanceWei: 10n ** 18n,
  busy: true,
  underfunded: false,
  leases: 1,
};
const rsv = { r: '01', s: '02', v: 27 };

beforeEach(() => {
  vi.clearAllMocks();
  mock.buildInstruction.mockResolvedValue(
    new TransactionInstruction({
      programId: new PublicKey('11111111111111111111111111111111'),
      keys: [],
      data: Buffer.alloc(0),
    })
  );
  mock.waitForEvent.mockImplementation(async ({ eventName }) =>
    eventName === 'signatureRespondedEvent'
      ? rsv
      : { serializedOutput: Uint8Array.of(1) }
  );
});

describe('Solana bidirectional source', () => {
  it('preserves request derivation, instruction bytes and both event wait budgets', async () => {
    const source = createSolanaSource('dev');
    const signal = new AbortController().signal;
    const result = await source.submit({
      built,
      worker,
      signal,
      signatureTimeoutMs: 100,
      responseTimeoutMs: 600,
    });
    expect(result.requestId).toBe(
      contracts.solana.getRequestIdBidirectional({
        sender: '11111111111111111111111111111111',
        payload: [2, 3, 4],
        caip2Id: ETHEREUM_CAIP2_ID,
        keyVersion: KEY_VERSION,
        path: worker.path,
        algo: 'ECDSA',
        dest: 'ethereum',
        params: '',
      })
    );
    expect(mock.buildInstruction.mock.calls[0][0].args).toEqual({
      serializedTransaction: Buffer.from([2, 3, 4]),
      caip2Id: ETHEREUM_CAIP2_ID,
      keyVersion: KEY_VERSION,
      path: worker.path,
      algo: 'ECDSA',
      dest: 'ethereum',
      params: '',
      outputDeserializationSchema: built.outputDeserializationSchema,
      respondSerializationSchema: built.respondSerializationSchema,
    });
    expect(mock.sendAndConfirm.mock.calls[0][0].instructions).toHaveLength(2);
    expect(result.sourceTx).toBe('submitted-solana-signature');
    await expect(result.signature).resolves.toEqual(rsv);
    await expect(result.response).resolves.toBe('0x01');
    expect(mock.waitForEvent).toHaveBeenNthCalledWith(1, {
      eventName: 'signatureRespondedEvent',
      requestId: result.requestId,
      signer: new PublicKey(constants.CONTRACT_ADDRESSES.SOLANA.TESTNET_DEV),
      afterSignature: result.sourceTx,
      timeoutMs: 100,
      backfillIntervalMs: 15_000,
      healthCheckIntervalMs: 15_000,
      signal,
    });
    expect(mock.waitForEvent).toHaveBeenNthCalledWith(2, {
      eventName: 'respondBidirectionalEvent',
      requestId: result.requestId,
      signer: new PublicKey(constants.CONTRACT_ADDRESSES.SOLANA.TESTNET_DEV),
      afterSignature: result.sourceTx,
      timeoutMs: 600,
      backfillIntervalMs: 120_000,
      healthCheckIntervalMs: 60_000,
      signal,
    });
  });

  it('uses the source requester when deriving worker addresses', async () => {
    const client = {} as PublicClient;
    await createSolanaSource('dev').deriveWorkers(client, [
      'pinger-0',
      'pinger-1',
    ]);
    expect(mock.deriveWorkers).toHaveBeenCalledWith({
      chainSigContract: { waitForEvent: mock.waitForEvent },
      client,
      requester: '11111111111111111111111111111111',
      paths: ['pinger-0', 'pinger-1'],
    });
  });

  it('stops before a source transaction when shutdown arrives during instruction preparation', async () => {
    const controller = new AbortController();
    const reason = new Error('shutdown');
    mock.buildInstruction.mockImplementationOnce(async () => {
      controller.abort(reason);
      return new TransactionInstruction({
        programId: new PublicKey('11111111111111111111111111111111'),
        keys: [],
      });
    });
    await expect(
      createSolanaSource('dev').submit({
        built,
        worker,
        signal: controller.signal,
        signatureTimeoutMs: 100,
        responseTimeoutMs: 600,
      })
    ).rejects.toBe(reason);
    expect(mock.sendAndConfirm).not.toHaveBeenCalled();
    expect(mock.waitForEvent).not.toHaveBeenCalled();
  });
});
