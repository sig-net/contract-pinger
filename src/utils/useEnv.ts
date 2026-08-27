// In-memory rotation index for Ethereum key (module-private)
let evmKeyIndex = 0;

const getNextEvmSk = (): string => {
  evmKeyIndex = (evmKeyIndex % 5) + 1;
  return process.env[
    `SIG_EVM_SK_${evmKeyIndex}` as keyof NodeJS.ProcessEnv
  ] as string;
};

/**
 * `min` defaults to 1 because most of these are durations, where zero is a
 * mistake. Counters that can meaningfully be zero — freezing intake during an
 * incident, for instance — pass `min: 0` so a deliberate 0 is not silently
 * replaced by the fallback.
 */
const num = (value: string | undefined, fallback: number, min = 1): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
};

/** Fails at load rather than inside a request handler. */
const wei = (value: string | undefined, fallback: string, name: string) => {
  try {
    return BigInt(value ?? fallback);
  } catch {
    throw new Error(
      `${name} must be an integer number of wei. Got "${value}".`
    );
  }
};

// The MPC waits for Ethereum finality before it reads a transaction's result
// back, so the respond leg is budgeted against Chain::Ethereum's finality
// expectation (1800s) plus slack. The signature leg never touches Ethereum:
// the node's own expectation for a Solana-sourced request is 11s.
const RESPOND_TIMEOUT_FINALITY_MS = 2_100_000;
const RESPOND_TIMEOUT_INCLUSION_MS = 300_000;

export const useEnv = () => {
  const waitsForEthFinality =
    (process.env.SIG_BIDIRECTIONAL_WAITS_FOR_ETH_FINALITY ?? 'true') !==
    'false';

  return {
    // Server configuration
    port: process.env.PORT || '3001',
    nodeEnv: process.env.NODE_ENV || 'development',

    // Ethereum (lazy getter — only rotates key when accessed)
    get evmSk() {
      return getNextEvmSk();
    },
    ethRpcUrlSepolia: process.env.SIG_ETH_RPC_URL_SEPOLIA || '',
    ethRpcUrlMainnet: process.env.SIG_ETH_RPC_URL_MAINNET || '',

    // Solana
    solRpcUrlDevnet: process.env.SIG_SOL_RPC_URL_DEV || '',
    solRpcUrlMainnet: process.env.SIG_SOL_RPC_URL_MAINNET || '',
    solSk: process.env.SIG_SOL_SK || '',
    // Optional override. Left unset, signet.js pairs the root key to the
    // program address itself, which is the safe configuration: supplying one
    // network's key alongside another's program yields signatures that recover
    // to an unexpected address.
    solRootPublicKey: process.env.SIG_SOL_ROOT_PUBLIC_KEY || '',

    // Bidirectional sign/respond load test
    bidirectional: {
      // Concurrent address leases. Each path derives its own Ethereum address
      // with its own nonce space, and each needs its own gas balance.
      paths: num(process.env.SIG_BIDIRECTIONAL_PATHS, 10, 0),
      pathPrefix: process.env.SIG_BIDIRECTIONAL_PATH_PREFIX || 'load',
      // Concurrent jobs including respond waits. Larger than `paths`, since an
      // address is released once its transaction mines, long before the MPC
      // finishes waiting for finality.
      //
      // Bounded well below the arrival rate times the respond budget on
      // purpose. Every live job runs its own event subscription and backfill
      // loop — signet.js has no shared dispatcher — so concurrency here is
      // paid in requests against the Solana endpoint. Raising it needs either
      // a dispatcher upstream or an endpoint measured to take the load.
      maxJobs: num(process.env.SIG_BIDIRECTIONAL_MAX_JOBS, 60, 0),
      // Finished jobs kept for inspection and for /stats. Bounded so a
      // long-running instance does not accumulate them indefinitely.
      retainedJobs: num(process.env.SIG_BIDIRECTIONAL_RETAINED_JOBS, 1000),
      maxRequestsPerMinute: num(
        process.env.SIG_BIDIRECTIONAL_MAX_REQUESTS_PER_MIN,
        10,
        0
      ),
      txMode: process.env.SIG_BIDIRECTIONAL_TX_MODE || 'eth_self_transfer',
      erc20Address:
        process.env.SIG_BIDIRECTIONAL_ERC20_ADDRESS ||
        '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      waitsForEthFinality,
      signatureTimeoutMs: num(
        process.env.SIG_BIDIRECTIONAL_SIGNATURE_TIMEOUT_MS,
        300_000
      ),
      respondTimeoutMs: num(
        process.env.SIG_BIDIRECTIONAL_RESPOND_TIMEOUT_MS,
        waitsForEthFinality
          ? RESPOND_TIMEOUT_FINALITY_MS
          : RESPOND_TIMEOUT_INCLUSION_MS
      ),
      ethConfirmTimeoutMs: num(
        process.env.SIG_BIDIRECTIONAL_ETH_CONFIRM_TIMEOUT_MS,
        600_000
      ),
      // Confirmations to wait for before releasing an address. One is enough
      // to consume the nonce; a second guards against a shallow reorg
      // stranding the next transaction behind a nonce gap.
      confirmations: num(process.env.SIG_BIDIRECTIONAL_CONFIRMATIONS, 2),
      minBalanceWei: wei(
        process.env.SIG_BIDIRECTIONAL_MIN_BALANCE_WEI,
        '2000000000000000',
        'SIG_BIDIRECTIONAL_MIN_BALANCE_WEI'
      ),
      topupWei: wei(
        process.env.SIG_BIDIRECTIONAL_TOPUP_WEI,
        '10000000000000000',
        'SIG_BIDIRECTIONAL_TOPUP_WEI'
      ),
      fundingSweepIntervalMs: num(
        process.env.SIG_BIDIRECTIONAL_FUNDING_SWEEP_MS,
        300_000
      ),
    },
  };
};
