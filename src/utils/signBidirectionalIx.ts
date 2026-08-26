import * as anchor from '@coral-xyz/anchor';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { contracts } from 'signet.js';

type ChainSigContract = InstanceType<
  typeof contracts.solana.ChainSignatureContract
>;

/**
 * The chain-signatures program echoes this argument into
 * `SignBidirectionalEvent` and does nothing else with it — no CPI, no
 * validation. The node drops it entirely: its own `SignBidirectionalEvent`
 * struct has no such field. The IDL documents it as a post-execution callback
 * target that is "not yet enabled", so the default pubkey is passed to mean
 * "no callback" rather than leaving a stale pointer at some program.
 */
export const NO_CALLBACK_PROGRAM = PublicKey.default;

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

/**
 * Build a `sign_bidirectional` instruction.
 *
 * signet.js exposes `waitForEvent` and `getRequestIdBidirectional` but no
 * builder for this instruction, so it is assembled here against the IDL the
 * library already carries. Anchor resolves `programState` and `eventAuthority`
 * from their constant seeds; `requester` and `feePayer` are supplied.
 */
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
}): Promise<TransactionInstruction> => {
  const program = (
    chainSigContract as unknown as { program: anchor.Program<anchor.Idl> }
  ).program;

  return (
    program.methods
      .signBidirectional(
        args.serializedTransaction,
        args.caip2Id,
        args.keyVersion,
        args.path,
        args.algo,
        args.dest,
        args.params,
        NO_CALLBACK_PROGRAM,
        args.outputDeserializationSchema,
        args.respondSerializationSchema
      )
      // `instructions` is optional in the program but Anchor still requires it
      // to be named. `sign_bidirectional` only emits an event, so the sysvar is
      // not needed and is omitted explicitly.
      .accounts({
        requester,
        feePayer,
        instructions: null,
      } as never)
      .instruction()
  );
};
