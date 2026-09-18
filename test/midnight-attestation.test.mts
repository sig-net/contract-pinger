import {
  createCircuitContext,
  createConstructorContext,
} from '@midnight-ntwrk/compact-runtime';
import { Contract as SignetContract } from '@sig-net/midnight-contract';
import {
  decodeRespondBidirectionalEventPayload,
  deriveMidnightResponseKey,
  normaliseSecp256k1PublicKey,
  requestIdHex,
  respondBidirectionalEventToCircuitInput,
  verifyRespondBidirectionalSignature,
} from '@sig-net/midnight';
import { calculateSignetAttestationDigest } from '@sig-net/midnight/testing';
import { expect, it } from 'vitest';
import fixture from './fixtures/midnight-testnet-response.json' with { type: 'json' };
import {
  Contract,
  ledger,
  pureCircuits,
  witnesses,
  type CallerPrivateState,
  type CallerTransaction,
} from '../src/midnight/caller.mjs';

// Captured from testnet MPC and the stagenet indexer; no local signing helper
// constructs this attestation. Its digest also matches the deployed Rust MPC.
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const response = decodeRespondBidirectionalEventPayload(
  bytes(fixture.responsePayload)
);
const responseKey = deriveMidnightResponseKey(
  normaliseSecp256k1PublicKey(fixture.rootPublicKey),
  fixture.callerAddress
);
const output = bytes(fixture.output);

it('verifies the real testnet success attestation using the MPC digest', () => {
  expect(requestIdHex(response.requestId)).toBe(fixture.requestId);
  expect(
    Buffer.from(
      calculateSignetAttestationDigest(response.requestId, output)
    ).toString('hex')
  ).toBe(fixture.attestationDigest);
  expect(
    verifyRespondBidirectionalSignature(
      response.requestId,
      output,
      response.event,
      responseKey
    )
  ).toBe(true);
  for (const changedOutput of [Uint8Array.of(0), Uint8Array.of(1, 0)]) {
    expect(
      verifyRespondBidirectionalSignature(
        response.requestId,
        changedOutput,
        response.event,
        responseKey
      )
    ).toBe(false);
  }
});

it('replays the captured request and settles its real attestation in the compiled caller', async () => {
  const contract = new Contract<CallerPrivateState>(witnesses);
  const secretKey = new Uint8Array(32).fill(17);
  const coinPublicKey = '0'.repeat(64);
  const initial = await contract.initialState(
    createConstructorContext({ secretKey }, coinPublicKey),
    pureCircuits.operatorCommitment(secretKey),
    { bytes: bytes(fixture.centralAddress) },
    BigInt(fixture.transaction.chainId)
  );
  const central = await new SignetContract({}).initialState(
    createConstructorContext(undefined, coinPublicKey)
  );
  const context = createCircuitContext(
    'submitNative',
    fixture.callerAddress,
    coinPublicKey,
    initial.currentContractState,
    initial.currentPrivateState,
    { getContractState: async () => central.currentContractState },
    undefined,
    undefined,
    undefined,
    '0'.repeat(64)
  );
  const initialised = await contract.circuits.initialise(context, responseKey);
  const tx = fixture.transaction;
  const transaction: CallerTransaction = {
    chainId: BigInt(tx.chainId),
    nonce: BigInt(tx.nonce),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    gasLimit: BigInt(tx.gasLimit),
    to: bytes(tx.to),
    value: BigInt(tx.value),
    calldata: {
      is_some: tx.calldata.is_some,
      value: {
        selector: bytes(tx.calldata.value.selector),
        noWords: BigInt(tx.calldata.value.noWords),
        words: tx.calldata.value.words.map(bytes),
      },
    },
    accessListEntryCount: BigInt(tx.accessListEntryCount),
    accessList: [],
  };
  const submitted = await contract.circuits.submitNative(
    initialised.context,
    transaction,
    bytes(fixture.path)
  );
  expect(requestIdHex(submitted.result)).toBe(fixture.requestId);
  const attestation = respondBidirectionalEventToCircuitInput(response.event);
  await expect(
    contract.circuits.completeNative(
      submitted.context,
      submitted.result,
      attestation,
      Uint8Array.of(0)
    )
  ).rejects.toThrow('Invalid attestation signature');
  const completed = await contract.circuits.completeNative(
    submitted.context,
    submitted.result,
    attestation,
    output
  );
  expect(
    ledger(
      completed.context.callContext.currentQueryContext.state
    ).nativeRequests.isEmpty()
  ).toBe(true);
});
