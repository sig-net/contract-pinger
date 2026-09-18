import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { contracts } from '@sig-net/signet.js';

type ChainSigContract = InstanceType<
  typeof contracts.solana.ChainSignatureContract
>;

export interface SignBidirectionalArgs {
  /** The unsigned, RLP-encoded transaction the MPC will sign. */
  serializedTransaction: Buffer;
  /** CAIP-2 id of the target chain. MPC nodes only recognise mainnet ids. */
  caip2Id: string;
  keyVersion: number;
  path: string;
  algo: string;
  dest: string;
  params: string;
  /**
   * Consumed only when the target transaction is a contract call. For a plain
   * transfer the node never parses it, so empty bytes are correct.
   */
  outputDeserializationSchema: Buffer;
  /**
   * Always parsed, and it drives the shape of the respond payload. Must be
   * non-empty and resolve to `bool` or `string` fields only: for a plain
   * transfer the node synthesizes the value from this schema rather than
   * decoding anything on-chain.
   */
  respondSerializationSchema: Buffer;
}

/** The SDK owns instruction accounts, seeds and callback defaults. */
export const buildSignBidirectionalInstruction = async ({
  chainSigContract,
  requester,
  feePayer,
  args,
}: {
  chainSigContract: ChainSigContract;
  requester: PublicKey;
  feePayer: PublicKey;
  args: SignBidirectionalArgs;
}): Promise<TransactionInstruction> =>
  chainSigContract.getSignBidirectionalInstruction(args, {
    requester,
    feePayer,
  });
