import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js';
import { constants, contracts } from '@sig-net/signet.js';
import {
  ETHEREUM_CAIP2_ID,
  KEY_VERSION,
  withHexPrefix,
} from './bidirectionalTx';
import { deriveWorkerAddresses } from './derivation';
import { buildSignBidirectionalInstruction } from './signBidirectionalIx';
import { getSharedSolana, type SolanaEnvironment } from './initSolana';
import type { BidirectionalSource } from './bidirectionalSource';

const contractAddresses = {
  dev: constants.CONTRACT_ADDRESSES.SOLANA.TESTNET_DEV,
  testnet: constants.CONTRACT_ADDRESSES.SOLANA.TESTNET,
  mainnet: constants.CONTRACT_ADDRESSES.SOLANA.MAINNET,
};

export const createSolanaSource = (
  environment: SolanaEnvironment
): BidirectionalSource => {
  const solana = () =>
    getSharedSolana({
      contractAddress: contractAddresses[environment],
      environment,
    });
  return {
    async deriveWorkers(client, paths) {
      const { chainSigContract, keypair } = solana();
      return deriveWorkerAddresses({
        chainSigContract,
        client,
        requester: keypair.publicKey.toString(),
        paths,
      });
    },
    async submit({
      built,
      worker,
      signal,
      signatureTimeoutMs,
      responseTimeoutMs,
    }) {
      signal.throwIfAborted();
      const { chainSigContract, provider, keypair } = solana();
      const requestId = contracts.solana.getRequestIdBidirectional({
        sender: keypair.publicKey.toString(),
        payload: Array.from(Buffer.from(built.rlpEncoded.slice(2), 'hex')),
        caip2Id: ETHEREUM_CAIP2_ID,
        keyVersion: KEY_VERSION,
        path: worker.path,
        algo: 'ECDSA',
        dest: 'ethereum',
        params: '',
      });
      const instruction = await buildSignBidirectionalInstruction({
        chainSigContract,
        requester: keypair.publicKey,
        feePayer: keypair.publicKey,
        args: {
          serializedTransaction: Buffer.from(built.rlpEncoded.slice(2), 'hex'),
          caip2Id: ETHEREUM_CAIP2_ID,
          keyVersion: KEY_VERSION,
          path: worker.path,
          algo: 'ECDSA',
          dest: 'ethereum',
          params: '',
          outputDeserializationSchema: built.outputDeserializationSchema,
          respondSerializationSchema: built.respondSerializationSchema,
        },
      });
      signal.throwIfAborted();
      const transaction = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add(instruction);
      const sourceTx = await provider.sendAndConfirm(transaction, []);
      signal.throwIfAborted();
      const signer = new PublicKey(contractAddresses[environment]);
      const signature = chainSigContract.waitForEvent({
        eventName: 'signatureRespondedEvent',
        requestId,
        signer,
        afterSignature: sourceTx,
        timeoutMs: signatureTimeoutMs,
        backfillIntervalMs: 15_000,
        healthCheckIntervalMs: 15_000,
        signal,
      });
      // Registered before the Ethereum broadcast. The service starts its own
      // response deadline at confirmation; this watcher spans the whole job.
      const response = chainSigContract
        .waitForEvent({
          eventName: 'respondBidirectionalEvent',
          requestId,
          signer,
          afterSignature: sourceTx,
          timeoutMs: responseTimeoutMs,
          backfillIntervalMs: 120_000,
          healthCheckIntervalMs: 60_000,
          signal,
        })
        .then(respond =>
          typeof respond.serializedOutput === 'string'
            ? withHexPrefix(respond.serializedOutput)
            : withHexPrefix(
                Buffer.from(respond.serializedOutput).toString('hex')
              )
        );
      signature.catch(() => undefined);
      response.catch(() => undefined);
      return { requestId, sourceTx, signature, response };
    },
  };
};
