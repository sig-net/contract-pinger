import { Connection, Keypair } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { contracts, type RootPublicKey } from 'signet.js';
import { useEnv } from './useEnv';

export type SolanaEnvironment = 'dev' | 'testnet' | 'mainnet';

const resolveConfig = (environment: SolanaEnvironment) => {
  const { solRpcUrlDevnet, solRpcUrlMainnet, solSk } = useEnv();
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
 * Narrow the `SIG_SOL_ROOT_PUBLIC_KEY` override to the shape signet.js accepts.
 *
 * The override is arbitrary environment input, and a malformed value would
 * otherwise travel all the way to key normalization and fail there with an
 * error that says nothing about where it came from.
 */
const asRootPublicKey = (value: string): RootPublicKey => {
  if (
    value.startsWith('secp256k1:') ||
    value.startsWith('04') ||
    value.startsWith('02') ||
    value.startsWith('03')
  ) {
    return value as RootPublicKey;
  }
  throw new Error(
    `SIG_SOL_ROOT_PUBLIC_KEY must be a naj key ("secp256k1:...") or a hex ` +
      `public key starting 02, 03 or 04. Got "${value.slice(0, 12)}...". ` +
      `Leave it unset to pair the root key to the program address instead.`
  );
};

const buildContract = ({
  contractAddress,
  provider,
  requesterAddress,
}: {
  contractAddress: string;
  provider: anchor.AnchorProvider;
  requesterAddress?: string;
}) => {
  const { solRootPublicKey } = useEnv();
  return new contracts.solana.ChainSignatureContract({
    provider,
    programId: contractAddress,
    config: {
      // Passed as `undefined` rather than `''` when the override is absent.
      // signet.js falls back to pairing the root key to the program address,
      // and that fallback is an `||`, so an empty string happens to work
      // today — but it would stop working the moment upstream switched to
      // `??`, sending the empty string through to key normalization.
      rootPublicKey: solRootPublicKey
        ? asRootPublicKey(solRootPublicKey)
        : undefined,
      requesterAddress,
      // web3.js retries 429s on its own, which fights the backfill loop in
      // `waitForEvent` and multiplies requests against an endpoint that is
      // already refusing them. signet.js documents disabling it as the
      // recommended pairing with backfill.
      disableRetryOnRateLimit: true,
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
  const chainSigContract = buildContract({
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
    chainSigContract: buildContract({
      contractAddress,
      provider,
      requesterAddress: keypair.publicKey.toString(),
    }),
  };
  sharedContexts.set(key, context);
  return context;
};

/** Test seam: drops memoized contexts so a suite can vary the environment. */
export const resetSharedSolana = () => sharedContexts.clear();
