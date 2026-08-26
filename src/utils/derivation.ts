import { getAddress, type Hex } from 'viem';
import { publicKeyToAddress } from 'viem/utils';
import type { contracts } from 'signet.js';
import { KEY_VERSION } from './bidirectionalTx';

type ChainSigContract = InstanceType<
  typeof contracts.solana.ChainSignatureContract
>;

/**
 * Path the MPC derives its own responder key at when answering a bidirectional
 * request. Used to check that a respond signature came from the network we
 * asked, rather than from anyone who can land a transaction on the program.
 */
export const RESPOND_BIDIRECTIONAL_PATH = 'respond_bidirectional';

/**
 * Derive the Ethereum address a `(requester, path)` pair controls.
 *
 * `getDerivedPublicKey` already wraps `deriveChildPublicKey` with the Solana
 * KDF chain id and whichever root key the contract resolved — the configured
 * override, or the one signet.js paired to the program address.
 */
export const deriveEthAddress = async ({
  chainSigContract,
  predecessor,
  path,
}: {
  chainSigContract: ChainSigContract;
  predecessor: string;
  path: string;
}): Promise<Hex> => {
  const publicKey: string = await chainSigContract.getDerivedPublicKey({
    predecessor,
    path,
    keyVersion: KEY_VERSION,
  });
  return publicKeyToAddress(
    (publicKey.startsWith('0x') ? publicKey : `0x${publicKey}`) as Hex
  );
};

export class DerivationMismatchError extends Error {
  constructor(
    readonly expected: Hex,
    readonly recovered: Hex
  ) {
    super(
      `Signed transaction recovers to ${recovered}, expected the derived address ${expected}. ` +
        'The MPC root key and the chain-signatures program are probably from different networks.'
    );
    this.name = 'DerivationMismatchError';
  }
}

/**
 * Assert the signed transaction was produced by the key we derived.
 *
 * This is the cheapest possible detector for a root key paired with the wrong
 * program: every other symptom of that mistake shows up as a transaction that
 * silently never mines.
 */
export const assertDerivedSender = (expected: Hex, recovered: Hex): void => {
  if (getAddress(expected) !== getAddress(recovered)) {
    throw new DerivationMismatchError(
      getAddress(expected),
      getAddress(recovered)
    );
  }
};
