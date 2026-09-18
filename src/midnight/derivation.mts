import { bytesToHex, deriveEvmAddress } from '@sig-net/midnight';
import type { Hex } from 'viem';
import { resolveMidnightIdentity } from './config.mjs';
import { midnightPath } from './transaction.mjs';

/** Shared public-only derivation for the source service and treasury sweep. */
export function deriveMidnightWorkers(
  paths: readonly string[],
  values: NodeJS.ProcessEnv = process.env
) {
  const identity = resolveMidnightIdentity(values);
  if (!identity.callerAddress)
    throw new Error(
      'MPC_MIDNIGHT_CALLER_ADDRESS is required for Midnight worker derivation'
    );
  return paths.map(path => ({
    path,
    address: deriveEvmAddress(
      identity.rootPublicKey,
      identity.callerAddress!,
      bytesToHex(midnightPath(path))
    ) as Hex,
  }));
}
