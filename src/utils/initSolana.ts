import { Connection, Keypair } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { contracts } from 'signet.js';
import { env } from './env';

export type SolanaEnvironment = 'dev' | 'testnet' | 'mainnet';

const resolveConfig = (environment: SolanaEnvironment) => {
  const { solRpcUrlDevnet, solRpcUrlMainnet, solSk } = env;
  const config = {
    dev: { solanaRpcUrl: solRpcUrlDevnet, solanaPrivateKey: solSk },
    testnet: { solanaRpcUrl: solRpcUrlDevnet, solanaPrivateKey: solSk },
    mainnet: { solanaRpcUrl: solRpcUrlMainnet, solanaPrivateKey: solSk },
  }[environment];

  if (!config.solanaRpcUrl) {
    throw new Error(
      `Solana RPC URL for ${environment} environment is missing. Please set ${
        environment === 'mainnet'
          ? 'SIG_SOL_RPC_URL_MAINNET'
          : 'SIG_SOL_RPC_URL_DEV'
      } in your environment.`
    );
  }

  if (!config.solanaPrivateKey) {
    throw new Error(
      `Solana secret key is missing. Please set SIG_SOL_SK in your environment.`
    );
  }

  return config;
};

const buildProvider = (environment: SolanaEnvironment) => {
  const config = resolveConfig(environment);
  const connection = new Connection(config.solanaRpcUrl, 'confirmed');
  const keypairArray = JSON.parse(config.solanaPrivateKey);
  const keypair = Keypair.fromSecretKey(new Uint8Array(keypairArray));
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });
  return { provider, keypair };
};

/**
 * Build a chain-signatures contract the way the service does.
 *
 * Exported so `scripts/fund-workers.ts` derives against the same root key.
 * The override enters here, and a funding script that constructed its own
 * contract would silently fall back to the program's default key and send ETH
 * to a different address set than the one the workers actually use.
 */
export const buildChainSignatureContract = ({
  contractAddress,
  provider,
  requesterAddress,
  disableRetryOnRateLimit = false,
}: {
  contractAddress: string;
  provider: anchor.AnchorProvider;
  requesterAddress?: string;
  disableRetryOnRateLimit?: boolean;
}) => {
  const { solRootPublicKey } = env;
  return new contracts.solana.ChainSignatureContract({
    provider,
    programId: contractAddress,
    config: {
      // Passed as `undefined` rather than `''` when the override is absent.
      // signet.js falls back to pairing the root key to the program address,
      // and that fallback is an `||`, so an empty string happens to work
      // today — but it would stop working the moment upstream switched to
      // `??`, sending the empty string through to key normalization.
      // Validated at load as an uncompressed SEC1 key, and absent rather than
      // empty when unset — so signet.js falls back to pairing the root key to
      // the program address, which is the configuration that cannot disagree.
      rootPublicKey: solRootPublicKey,
      requesterAddress,
      disableRetryOnRateLimit,
    },
  });
};

export const initSolana = ({
  contractAddress,
  environment,
}: {
  contractAddress: string;
  environment: SolanaEnvironment;
}) => {
  const { provider } = buildProvider(environment);
  const requesterKeypair = Keypair.generate();
  const chainSigContract = buildChainSignatureContract({
    contractAddress,
    provider,
    requesterAddress: requesterKeypair.publicKey.toString(),
  });
  return { chainSigContract, provider, requesterKeypair };
};

export interface SharedSolanaContext {
  provider: anchor.AnchorProvider;
  /** Fee payer for every Solana transaction, and the bidirectional requester. */
  keypair: Keypair;
  chainSigContract: InstanceType<
    typeof contracts.solana.ChainSignatureContract
  >;
}

const sharedContexts = new Map<string, SharedSolanaContext>();

/**
 * One provider and one `ChainSignatureContract` per environment, reused across
 * requests.
 *
 * The bidirectional flow opens two long-lived event waits per job, and a
 * subscription shared across waiters can only ever be shared if the waiters
 * come from the same contract instance. Constructing a fresh instance per
 * request — as `initSolana` does for the unidirectional path — forecloses
 * that, so this is deliberately memoized.
 */
export const getSharedSolana = ({
  contractAddress,
  environment,
}: {
  contractAddress: string;
  environment: SolanaEnvironment;
}): SharedSolanaContext => {
  const key = `${environment}:${contractAddress}`;
  const existing = sharedContexts.get(key);
  if (existing) return existing;

  const { provider, keypair } = buildProvider(environment);
  const context: SharedSolanaContext = {
    provider,
    keypair,
    chainSigContract: buildChainSignatureContract({
      contractAddress,
      provider,
      requesterAddress: keypair.publicKey.toString(),
      // Only the bidirectional path disables it. web3.js retrying 429s fights
      // the backfill loop in `waitForEvent` and multiplies requests against an
      // endpoint already refusing them, which signet.js documents. The
      // unidirectional `/ping` path runs no backfill, so it keeps the retry
      // that has always carried it through a rate-limited endpoint.
      disableRetryOnRateLimit: true,
    }),
  };
  sharedContexts.set(key, context);
  return context;
};
