import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract as SignetContract } from '@sig-net/midnight-contract';
import {
  calculateRequestId,
  decodeSignBidirectionalNotification,
  decodeSignBidirectionalEventNotificationPayload,
  decodeSignetLogEvents,
  lookupSignetRequestAt,
  requestIdHex,
  respondBidirectionalEventToCircuitInput,
  signBidirectionalEventToUnsignedEvmTransaction,
  SignetRequestResponseReader,
  signatureRespondedEventToSignature,
} from '@sig-net/midnight';
import {
  calculateSignetAttestationDigest,
  ecdsaSignatureToMpcSignature,
  secp256k1PublicKeyOf,
  signAttestationDigest,
} from '@sig-net/midnight/testing';
import { describe, expect, it, vi } from 'vitest';
import { SigningKey, computeAddress } from 'ethers';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { buildTransaction, type TxMode } from '../src/utils/bidirectionalTx.js';
import { toCallerTransaction } from '../src/midnight/transaction.mjs';
import {
  Contract,
  ledger,
  pureCircuits,
  witnesses,
  type CallerPrivateState,
  type CallerTransaction,
} from '../src/midnight/caller.mjs';

const operatorSecret = new Uint8Array(32).fill(17);
const responseSecret = new Uint8Array(32).fill(42);
const responseKey = secp256k1PublicKeyOf(responseSecret);
const callerAddress = sampleContractAddress();
const centralAddress = sampleContractAddress();
const coinPublicKey = '0'.repeat(64);
const derivationPath = new Uint8Array(32).fill(7);
const native: CallerTransaction = {
  chainId: 11155111n,
  nonce: 3n,
  maxPriorityFeePerGas: 1000000000n,
  maxFeePerGas: 30000000000n,
  gasLimit: 25200n,
  to: new Uint8Array(20).fill(0x33),
  value: 0n,
  calldata: {
    is_some: false,
    value: {
      selector: new Uint8Array(4),
      noWords: 0n,
      words: [new Uint8Array(32), new Uint8Array(32)],
    },
  },
  accessListEntryCount: 0n,
  accessList: [],
};
const token: CallerTransaction = {
  ...native,
  gasLimit: 65000n,
  calldata: {
    is_some: true,
    value: {
      selector: new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]),
      noWords: 2n,
      words: [
        new Uint8Array([...new Uint8Array(12), ...native.to]),
        new Uint8Array(32),
      ],
    },
  },
};

async function deploy(secret = operatorSecret, initialise = true) {
  const contract = new Contract<CallerPrivateState>(witnesses);
  const initial = await contract.initialState(
    createConstructorContext({ secretKey: secret }, coinPublicKey),
    pureCircuits.operatorCommitment(operatorSecret),
    { bytes: Uint8Array.from(Buffer.from(centralAddress, 'hex')) },
    11155111n
  );
  const central = await new SignetContract({}).initialState(
    createConstructorContext(undefined, coinPublicKey)
  );
  let context = createCircuitContext(
    'submitNative',
    callerAddress,
    coinPublicKey,
    initial.currentContractState,
    initial.currentPrivateState,
    { getContractState: async () => central.currentContractState },
    undefined,
    undefined,
    undefined,
    '0'.repeat(64)
  );
  if (initialise)
    context = (await contract.circuits.initialise(context, responseKey))
      .context;
  return { contract, context };
}

const attestation = (
  id: Uint8Array,
  output: Uint8Array,
  secret = responseSecret
) =>
  respondBidirectionalEventToCircuitInput({
    signature: ecdsaSignatureToMpcSignature(
      signAttestationDigest(
        calculateSignetAttestationDigest(id, output),
        secret
      )
    ),
  });

it('SDK signed transaction composition preserves verified signature selection', async () => {
  const { contract, context } = await deploy();
  const submitted = await contract.circuits.submitNative(
    context,
    native,
    derivationPath
  );
  const id = requestIdHex(submitted.result);
  const queryContractState = vi.fn(async () => ({
    data: submitted.context.callContext.currentQueryContext.state,
  }));
  const reader = new SignetRequestResponseReader({
    requesterContractAddress: callerAddress,
    requesterRequestsPath: [0],
    signetContractAddress: centralAddress,
    publicDataProvider: { queryContractState },
    eventSource: { async *streamSignetEvents() {} },
  });
  const unsigned = await reader.getUnsignedEvmTransaction(id);
  const response = (secret: Uint8Array) => {
    const signed = new SigningKey(secret).sign(unsigned.unsignedHash);
    return {
      signature: ecdsaSignatureToMpcSignature({
        r: BigInt(signed.r),
        s: BigInt(signed.s),
        recoveryId: signed.yParity,
      }),
    };
  };
  const valid = response(responseSecret);
  const wrong = response(operatorSecret);
  const malformed = { signature: { ...valid.signature, recoveryId: 3n } };
  const posts = vi.spyOn(reader, 'getSignatureRespondedEvents');
  const expectedSigner = computeAddress(
    new SigningKey(responseSecret).publicKey
  );
  for (const candidates of [
    [],
    [malformed, wrong],
    [malformed, wrong, valid],
  ]) {
    posts.mockResolvedValue(candidates);
    const previous = await reader.getVerifiedSignatureRespondedEvent(
      id,
      expectedSigner
    );
    const expected =
      previous.verified &&
      signatureRespondedEventToSignature(previous.verified);
    const signed = await reader.getSignedEvmTransaction(id, expectedSigner);
    expect(signed?.signature?.serialized).toBe(expected?.serialized);
    expect(!!signed).toBe(candidates.includes(valid));
    if (signed) {
      expect(signed.unsignedSerialized).toBe(unsigned.unsignedSerialized);
      expect(signed.from).toBe(expectedSigner);
    }
  }
  expect(queryContractState).toHaveBeenCalledOnce();
});

describe('Midnight pinger operator authority', () => {
  it('pins the response key once and rejects a stranger before initialisation', async () => {
    const outsider = await deploy(new Uint8Array(32).fill(18), false);
    await expect(
      outsider.contract.circuits.initialise(outsider.context, responseKey)
    ).rejects.toThrow('Not the operator');
    const owner = await deploy();
    await expect(
      owner.contract.circuits.initialise(owner.context, responseKey)
    ).rejects.toThrow('Already initialised');
  });

  it.each(['submitNative', 'submitErc20'] as const)(
    '%s requires the operator after initialisation',
    async circuit => {
      const { contract, context } = await deploy();
      const outsider = {
        ...context,
        callContext: {
          ...context.callContext,
          currentPrivateState: { secretKey: new Uint8Array(32).fill(18) },
        },
      };
      await expect(
        contract.circuits[circuit](
          outsider,
          circuit === 'submitNative' ? native : token,
          derivationPath
        )
      ).rejects.toThrow('Not the operator');
    }
  );

  it('rejects submission before the response key is pinned', async () => {
    const { contract, context } = await deploy(operatorSecret, false);
    await expect(
      contract.circuits.submitNative(context, native, derivationPath)
    ).rejects.toThrow('Not initialised');
  });
});

describe('Midnight request producer and completion', () => {
  it.each([
    {
      submit: 'submitNative',
      complete: 'completeNative',
      tx: native,
      field: 0,
      outputSchema: '[]',
    },
    {
      submit: 'submitErc20',
      complete: 'completeErc20',
      tx: token,
      field: 1,
      outputSchema: '[{"name":"success","type":"bool"}]',
    },
  ] as const)(
    '$submit emits a real ledger path and consumes only an authenticated attestation',
    async ({ submit, complete, tx, field, outputSchema }) => {
      const { contract, context } = await deploy();
      const submitted = await contract.circuits[submit](
        context,
        tx,
        derivationPath
      );
      const id = submitted.result;
      const state = submitted.context.callContext.currentQueryContext.state;
      const request = lookupSignetRequestAt(state, [field], requestIdHex(id));
      expect(request).toBeDefined();
      if (!request) throw new Error('request missing');
      expect(requestIdHex(calculateRequestId(request))).toBe(requestIdHex(id));
      expect(request.sender.bytes).toEqual(
        Uint8Array.from(Buffer.from(callerAddress, 'hex'))
      );
      expect(request.path).toEqual(derivationPath);
      expect(request.keyVersion).toBe(1n);
      expect(request.txParams).toEqual(tx);
      expect(
        new TextDecoder().decode(request.outputDeserializationSchema)
      ).toBe(outputSchema);
      expect(new TextDecoder().decode(request.respondSerializationSchema)).toBe(
        '[{"name":"success","type":"bool"}]'
      );
      const events = decodeSignetLogEvents(submitted.context.events);
      expect(events).toHaveLength(1);
      const post = decodeSignBidirectionalEventNotificationPayload(
        events[0]!.payload
      );
      const notification = decodeSignBidirectionalNotification(post.event);
      expect(requestIdHex(post.requestId)).toBe(requestIdHex(id));
      expect(notification.requestsPath).toEqual([field]);
      const unsigned = signBidirectionalEventToUnsignedEvmTransaction(request);
      expect(unsigned.chainId).toBe(11155111n);
      expect(unsigned.nonce).toBe(3);
      const output = new Uint8Array([1]);
      await expect(
        contract.circuits[complete](
          submitted.context,
          id,
          attestation(id, output, operatorSecret),
          output
        )
      ).rejects.toThrow('Invalid attestation signature');
      await expect(
        contract.circuits[complete](
          submitted.context,
          id,
          attestation(id, output),
          new Uint8Array([0])
        )
      ).rejects.toThrow('Invalid attestation signature');
      const completed = await contract.circuits[complete](
        submitted.context,
        id,
        attestation(id, output),
        output
      );
      const after = ledger(
        completed.context.callContext.currentQueryContext.state
      );
      expect(
        (field === 0 ? after.nativeRequests : after.erc20Requests).member(id)
      ).toBe(false);
      await expect(
        contract.circuits[complete](
          completed.context,
          id,
          attestation(id, output),
          output
        )
      ).rejects.toThrow('Request not found');
    }
  );

  it.each(['native', 'erc20'] as const)(
    'consumes an authenticated false %s return value',
    async mode => {
      const { contract, context } = await deploy();
      const submitted = await contract.circuits[
        mode === 'native' ? 'submitNative' : 'submitErc20'
      ](context, mode === 'native' ? native : token, derivationPath);
      const output = new Uint8Array([0]);
      const completed = await contract.circuits[
        mode === 'native' ? 'completeNative' : 'completeErc20'
      ](
        submitted.context,
        submitted.result,
        attestation(submitted.result, output),
        output
      );
      const after = ledger(
        completed.context.callContext.currentQueryContext.state
      );
      expect(
        (mode === 'native'
          ? after.nativeRequests
          : after.erc20Requests
        ).isEmpty()
      ).toBe(true);
    }
  );

  it('uses an independent request nonce for otherwise identical submits', async () => {
    const { contract, context } = await deploy();
    const first = await contract.circuits.submitNative(
      context,
      native,
      derivationPath
    );
    const second = await contract.circuits.submitNative(
      first.context,
      native,
      derivationPath
    );
    expect(requestIdHex(second.result)).not.toBe(requestIdHex(first.result));
    expect(
      ledger(
        second.context.callContext.currentQueryContext.state
      ).nativeRequests.size()
    ).toBe(2n);
  });

  it.each([
    { tx: native, error: 'ERC20 transfer requires calldata' },
    {
      tx: {
        ...token,
        calldata: {
          ...token.calldata,
          value: { ...token.calldata.value, selector: new Uint8Array(4) },
        },
      },
      error: 'Not an ERC20 transfer',
    },
    {
      tx: {
        ...token,
        calldata: {
          ...token.calldata,
          value: { ...token.calldata.value, noWords: 1n },
        },
      },
      error: 'ERC20 transfer requires two words',
    },
    {
      tx: {
        ...token,
        calldata: {
          ...token.calldata,
          value: {
            ...token.calldata.value,
            words: [token.calldata.value.words[0]!, new Uint8Array(32).fill(1)],
          },
        },
      },
      error: 'Nonzero ERC20 amount',
    },
  ])('rejects unsupported token input: $error', async ({ tx, error }) => {
    const { contract, context } = await deploy();
    await expect(
      contract.circuits.submitErc20(context, tx, derivationPath)
    ).rejects.toThrow(error);
  });

  it.each([
    { tx: { ...native, chainId: 1n }, error: 'Wrong destination chain' },
    { tx: { ...native, value: 1n }, error: 'Nonzero transfer value' },
    {
      tx: { ...native, accessListEntryCount: 1n },
      error: 'Access list not supported',
    },
    {
      tx: { ...native, maxPriorityFeePerGas: native.maxFeePerGas + 1n },
      error: 'Priority fee exceeds max fee',
    },
    { tx: token, error: 'Native transfer has calldata' },
  ])('rejects unsupported native input: $error', async ({ tx, error }) => {
    const { contract, context } = await deploy();
    await expect(
      contract.circuits.submitNative(context, tx, derivationPath)
    ).rejects.toThrow(error);
  });
});

describe('Midnight byte agreement with the shared Ethereum producer', () => {
  it.each(['eth_self_transfer', 'erc20_zero_transfer'] as const)(
    '%s preserves every unsigned signing byte',
    async (mode: TxMode) => {
      const client = createPublicClient({
        chain: sepolia,
        transport: http('http://unused.invalid'),
      });
      vi.spyOn(client, 'getTransactionCount').mockResolvedValue(3);
      vi.spyOn(client, 'estimateFeesPerGas').mockResolvedValue({
        maxFeePerGas: 30000000000n,
        maxPriorityFeePerGas: 1000000000n,
      });
      vi.spyOn(client, 'estimateGas').mockResolvedValue(50000n);
      const built = await buildTransaction({
        client,
        environment: 'testnet',
        mode,
        from: '0x3333333333333333333333333333333333333333',
        erc20Address: '0x4444444444444444444444444444444444444444',
      });
      const { contract, context } = await deploy();
      const circuit =
        mode === 'eth_self_transfer' ? 'submitNative' : 'submitErc20';
      const field = mode === 'eth_self_transfer' ? 0 : 1;
      const submitted = await contract.circuits[circuit](
        context,
        toCallerTransaction(built.unsigned),
        derivationPath
      );
      const request = lookupSignetRequestAt(
        submitted.context.callContext.currentQueryContext.state,
        [field],
        requestIdHex(submitted.result)
      );
      if (!request) throw new Error('request missing');
      expect(
        signBidirectionalEventToUnsignedEvmTransaction(request)
          .unsignedSerialized
      ).toBe(built.rlpEncoded);
    }
  );
});
