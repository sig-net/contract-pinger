import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { z } from 'zod';
import {
  getMpcRootPublicKey,
  getSignetContractAddress,
  MidnightNetwork,
  normaliseSecp256k1PublicKey,
} from '@sig-net/midnight';
import {
  blankAsUndefined,
  DEFAULT_ENDPOINTS,
  getMidnightNodeConfig,
  type MidnightNodeConfig,
} from '@sig-net/midnight-contract-deploy';

const hex32 = z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes of hex');

export interface MidnightConfig {
  node: MidnightNodeConfig;
  seed: string;
  operatorSecret: Uint8Array;
  centralAddress: string;
  callerAddress?: string;
  rootPublicKey: string;
  stateDirectory: string;
}

/** Separate treasury and pinger identities without printing either seed. */
export function derivePingerSeed(fundingSeed: string): string {
  return createHmac('sha256', Buffer.from(hex32.parse(fundingSeed), 'hex'))
    .update('signet:contract-pinger:stagenet:wallet:v1')
    .digest('hex');
}

/** Public derivation inputs suffice to replenish Ethereum workers. */
export function resolveMidnightIdentity(
  values: NodeJS.ProcessEnv = process.env
) {
  const stateDirectory = resolve(
    blankAsUndefined(values.MPC_MIDNIGHT_STATE_DIR) ?? '.midnight'
  );
  let callerAddress = blankAsUndefined(values.MPC_MIDNIGHT_CALLER_ADDRESS);
  if (!callerAddress) {
    try {
      const receipt = z
        .object({
          contractAddress: hex32,
          centralAddress: hex32,
          networkId: z.literal('stagenet'),
          destinationChainId: z.literal('11155111'),
          status: z.enum(['prepared', 'submitted', 'initialised']),
        })
        .parse(
          JSON.parse(
            readFileSync(resolve(stateDirectory, 'deployment.json'), 'utf8')
          )
        );
      const centralAddress =
        blankAsUndefined(values.MPC_MIDNIGHT_CENTRAL_ADDRESS) ??
        getSignetContractAddress(MidnightNetwork.Stagenet);
      if (
        receipt.centralAddress.toLowerCase() !== centralAddress.toLowerCase()
      ) {
        throw new Error(
          'Deployment receipt belongs to another Signet central contract'
        );
      }
      if (receipt.status === 'initialised')
        callerAddress = receipt.contractAddress;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return {
    callerAddress: callerAddress ? hex32.parse(callerAddress) : undefined,
    rootPublicKey: normaliseSecp256k1PublicKey(
      blankAsUndefined(values.MPC_MIDNIGHT_ROOT_PUBLIC_KEY) ??
        getMpcRootPublicKey(MidnightNetwork.Stagenet)
    ),
  };
}

/** Resolve the pinger wallet and public stagenet endpoints; treasury keys are never read here. */
export function resolveMidnightConfig(
  values: NodeJS.ProcessEnv = process.env,
  requireCaller = true
): MidnightConfig {
  const stateDirectory = resolve(
    blankAsUndefined(values.MPC_MIDNIGHT_STATE_DIR) ?? '.midnight'
  );
  let stored: Record<string, string> = {};
  try {
    stored = parseDotenv(readFileSync(resolve(stateDirectory, 'pinger.env')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const seed = hex32.parse(
    blankAsUndefined(values.MPC_MIDNIGHT_PINGER_SEED) ??
      stored.MPC_MIDNIGHT_PINGER_SEED
  );
  const identity = resolveMidnightIdentity(values);
  const callerAddress = identity.callerAddress;
  if (requireCaller && !callerAddress)
    throw new Error(
      'MPC_MIDNIGHT_CALLER_ADDRESS is required; deploy and initialise the pinger caller first'
    );
  const node = {
    ...getMidnightNodeConfig({
      NETWORK_ID: MidnightNetwork.Stagenet,
      MIDNIGHT_NODE_URL: values.MPC_MIDNIGHT_NODE_URL,
      MIDNIGHT_NODE_INDEXER_URL: values.MPC_MIDNIGHT_INDEXER_URL,
      // The pinger's HTTP and WebSocket overrides are independent.
      MIDNIGHT_NODE_INDEXER_WS_URL:
        blankAsUndefined(values.MPC_MIDNIGHT_INDEXER_WS_URL) ??
        DEFAULT_ENDPOINTS[MidnightNetwork.Stagenet].indexerWsUrl,
      MIDNIGHT_NODE_PROOF_SERVER_URL: values.MPC_MIDNIGHT_PROOF_SERVER_URL,
    }),
  };
  for (const field of [
    'nodeUrl',
    'indexerUrl',
    'indexerWsUrl',
    'proofServerUrl',
  ] as const)
    node[field] = z.url().parse(node[field]);
  return {
    node,
    seed,
    operatorSecret: Buffer.from(
      blankAsUndefined(values.MPC_MIDNIGHT_OPERATOR_SECRET)
        ? hex32.parse(values.MPC_MIDNIGHT_OPERATOR_SECRET)
        : createHmac('sha256', Buffer.from(seed, 'hex'))
            .update('signet:contract-pinger:operator:v1')
            .digest('hex'),
      'hex'
    ),
    centralAddress: hex32.parse(
      blankAsUndefined(values.MPC_MIDNIGHT_CENTRAL_ADDRESS) ??
        getSignetContractAddress(MidnightNetwork.Stagenet)
    ),
    callerAddress: callerAddress ? hex32.parse(callerAddress) : undefined,
    rootPublicKey: identity.rootPublicKey,
    stateDirectory,
  };
}
