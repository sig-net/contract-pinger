import { getAddress, type Hex, type PublicClient } from 'viem';
import { chainAdapters, type contracts } from '@sig-net/signet.js';
import { KEY_VERSION } from './bidirectionalTx';

type ChainSigContract = InstanceType<
  typeof contracts.solana.ChainSignatureContract
>;

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
  client,
  requester,
  paths,
}: {
  chainSigContract: ChainSigContract;
  client: PublicClient;
  requester: string;
  paths: readonly string[];
}): Promise<DerivedWorker[]> => {
  // One adapter for the whole set: it holds no per-path state, and derivation
  // is pure crypto over the contract's root key. The client goes unused here —
  // the adapter takes one to construct, for the RPC methods this never calls.
  const adapter = new chainAdapters.evm.EVM({
    publicClient: client,
    contract: chainSigContract,
  });

  const derived: DerivedWorker[] = [];
  for (const path of paths) {
    const { address } = await adapter.deriveAddressAndPublicKey(
      requester,
      path,
      KEY_VERSION
    );
    derived.push({ path, address: address as Hex });
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
 *
 * signet.js has `utils.cryptography.verifyRecoveredAddress`, which is the same
 * check, but it re-derives the address — spinning up an adapter against a
 * placeholder RPC host to do so — and returns a boolean, swallowing which
 * address it actually recovered. Both are already in hand here, and the
 * mismatch itself is the diagnostic: it says which network's key was paired
 * with which program. A boolean would not.
 */
export const assertDerivedSender = (expected: Hex, recovered: Hex): void => {
  if (getAddress(expected) !== getAddress(recovered)) {
    throw new DerivationMismatchError(
      getAddress(expected),
      getAddress(recovered)
    );
  }
};
