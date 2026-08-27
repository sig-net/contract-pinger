import { getAddress, type Hex } from 'viem';
import { publicKeyToAddress } from 'viem/utils';
import type { contracts } from 'signet.js';
import { KEY_VERSION } from './bidirectionalTx';

type ChainSigContract = InstanceType<
  typeof contracts.solana.ChainSignatureContract
>;

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

export interface DerivedWorker {
  path: string;
  address: Hex;
}

/**
 * Derive every worker address for a requester.
 *
 * Shared with `scripts/fund-workers.ts`, which sends ETH to these addresses
 * without asking the service where to send it. Two implementations of this
 * would be two chances to disagree, and disagreeing means funding addresses
 * nothing will ever spend from.
 *
 * Note what fixes the result: the requester is the public key of the same
 * `SIG_SOL_SK` that pays Solana fees, so rotating that key moves every address
 * here. So does pointing at a different environment, whose program address
 * pairs to a different root key.
 */
export const deriveWorkerAddresses = async ({
  chainSigContract,
  requester,
  paths,
}: {
  chainSigContract: ChainSigContract;
  requester: string;
  paths: readonly string[];
}): Promise<DerivedWorker[]> => {
  const derived: DerivedWorker[] = [];
  for (const path of paths) {
    derived.push({
      path,
      address: await deriveEthAddress({
        chainSigContract,
        predecessor: requester,
        path,
      }),
    });
  }
  return derived;
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
