import { Connection, Keypair } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { contracts } from '@sig-net/signet.js';
import type { BidirectionalEnvironment } from './bidirectionalTx';
import { env } from './env';

/**
 * Re-exported rather than declared again: an MPC network selects a Solana
 * cluster and an Ethereum together, so two lists of the same names would drift
 * the moment one gained a network.
 */
export type { BidirectionalEnvironment as SolanaEnvironment } from './bidirectionalTx';
type SolanaEnvironment = BidirectionalEnvironment;

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
  const connection = new Connection(config.solanaRpcUrl, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: (input, init) =>
      globalThis.fetch(input, {
        ...init,
        signal: AbortSignal.any([
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(15_000),
        ]),
      }),
  });
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
  eventPoller,
  transactionConfirmer,
}: {
  contractAddress: string;
  provider: anchor.AnchorProvider;
  requesterAddress?: string;
  eventPoller?: InstanceType<typeof contracts.solana.SolanaEventPoller>;
  transactionConfirmer?: InstanceType<
    typeof contracts.solana.HttpTransactionConfirmer
  >;
}) => {
  const { solRootPublicKey } = env;
  return new contracts.solana.ChainSignatureContract({
    provider,
    programId: contractAddress,
    eventPoller,
    transactionConfirmer,
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
  const { provider, eventPoller, transactionConfirmer } = getSharedSolana({
    contractAddress,
    environment,
  });
  const requesterKeypair = Keypair.generate();
  const chainSigContract = buildChainSignatureContract({
    contractAddress,
    provider,
    requesterAddress: requesterKeypair.publicKey.toString(),
    eventPoller,
    transactionConfirmer,
  });
  return { chainSigContract, provider, requesterKeypair };
};

export interface SharedSolanaContext {
  eventPoller: InstanceType<typeof contracts.solana.SolanaEventPoller>;
  transactionConfirmer: InstanceType<
    typeof contracts.solana.HttpTransactionConfirmer
  >;
  provider: anchor.AnchorProvider;
  /** Fee payer for every Solana transaction, and the bidirectional requester. */
  keypair: Keypair;
  chainSigContract: InstanceType<
    typeof contracts.solana.ChainSignatureContract
  >;
}

const sharedContexts = new Map<string, SharedSolanaContext>();

/** Shared HTTP services live until server shutdown, including between load runs. */
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
  const eventPoller = new contracts.solana.SolanaEventPoller({
    connection: provider.connection,
    programId: contractAddress,
    pollIntervalMs: 1_000,
    fetchConcurrency: 8,
  });
  const transactionConfirmer = new contracts.solana.HttpTransactionConfirmer(
    provider.connection
  );
  const context: SharedSolanaContext = {
    eventPoller,
    transactionConfirmer,
    provider,
    keypair,
    chainSigContract: buildChainSignatureContract({
      contractAddress,
      provider,
      requesterAddress: keypair.publicKey.toString(),
      eventPoller,
      transactionConfirmer,
    }),
  };
  sharedContexts.set(key, context);
  return context;
};

/** Read-only diagnostics; does not create services or start RPC work. */
export const solanaPollingStats = () =>
  [...sharedContexts.entries()].map(([key, context]) => ({
    key,
    ...context.eventPoller.stats,
    pendingConfirmations: context.transactionConfirmer.pendingCount,
  }));

export const closeSharedSolana = (): void => {
  for (const context of sharedContexts.values()) {
    context.eventPoller.close();
    context.transactionConfirmer.close();
  }
  sharedContexts.clear();
};
