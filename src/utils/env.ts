import { z } from 'zod';

/**
 * Every environment variable this service reads, validated in one place.
 *
 * Parsed once at module load, so a malformed value stops the process at start
 * rather than surfacing as a 500 from whichever request happened to touch it
 * first. Defaults live here too, rather than at each use site, so two readers
 * of the same variable cannot disagree about what it means when unset.
 */

/**
 * An unset variable and one set to the empty string are not the same to zod:
 * `.optional()` accepts `undefined`, not `''`, and a `.default()` does not
 * apply to `''`. CI runners export an empty string for every secret that is
 * not configured, so drop empty values and let the schema see them as absent.
 */
const withoutEmptyValues = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));

/** A count or duration. `min` is 1 where zero is meaningless. */
const integer = (fallback: number, min = 1) =>
  z.coerce.number().int().min(min).default(fallback);

/** An amount in wei. Rejected here rather than throwing inside a handler. */
const wei = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .refine(v => /^\d+$/.test(v), 'must be a whole number of wei')
    .transform(v => BigInt(v));

const boolish = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform(v => v === 'true');

// The MPC waits for Ethereum finality before reading a transaction's result
// back, so the respond leg is budgeted against Chain::Ethereum's finality
// expectation (1800s) plus slack. The signature leg never touches Ethereum:
// the node's own expectation for a Solana-sourced request is 11s.
const RESPOND_TIMEOUT_FINALITY_MS = 2_100_000;
const RESPOND_TIMEOUT_INCLUSION_MS = 300_000;

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.string().default('development'),
  // Required: every route but the health check is behind it, so a process
  // without one serves nothing and should say so at startup.
  API_SECRET: z.string({
    error: 'is required — every route but the health check is behind it',
  }),

  SIG_ETH_RPC_URL_SEPOLIA: z.string().url().optional(),
  SIG_ETH_RPC_URL_MAINNET: z.string().url().optional(),

  SIG_SOL_RPC_URL_DEV: z.string().url().optional(),
  SIG_SOL_RPC_URL_MAINNET: z.string().url().optional(),
  SIG_SOL_SK: z.string().optional(),

  /**
   * Optional override for the MPC root key.
   *
   * Only the uncompressed SEC1 form is accepted. Compressed keys would need
   * converting somewhere, and the natural place is out of sight of whoever set
   * the variable; rejecting here says so at start instead.
   *
   * Leaving it unset is the safe configuration: signet.js then pairs the root
   * key to the chain-signatures program address, and the two cannot disagree.
   * Setting it to one network's key while pointing at another's program yields
   * signatures that recover to an unexpected address, whose only symptom is a
   * transaction that never mines.
   */
  SIG_SOL_ROOT_PUBLIC_KEY: z
    .string()
    .regex(
      /^04[0-9a-fA-F]{128}$/,
      'must be an uncompressed SEC1 public key: 04 followed by 128 hex characters'
    )
    // The regex proves the shape; this carries that proof into the type so
    // signet.js accepts it without a cast at the use site.
    .transform(v => v as `04${string}`)
    .optional(),

  SIG_BIDIRECTIONAL_PATHS: integer(10, 0),
  SIG_BIDIRECTIONAL_PATH_PREFIX: z.string().default('load'),

  // Holding an address and doing chain work; bounded by the pool and RPC
  // throughput, so it sits near the path count rather than the arrival rate.
  SIG_BIDIRECTIONAL_MAX_ACTIVE_JOBS: integer(20, 0),
  // Past confirmation, waiting only on the MPC's respond. These hold an event
  // subscription and nothing else, and there are far more of them: at ten jobs
  // a minute with a thirty-five-minute respond leg, roughly 350 are live.
  SIG_BIDIRECTIONAL_MAX_JOBS: integer(400, 0),
  SIG_BIDIRECTIONAL_RETAINED_JOBS: integer(1000),
  SIG_BIDIRECTIONAL_MAX_REQUESTS_PER_MIN: integer(10, 0),
  SIG_BIDIRECTIONAL_LEASE_WAIT_MS: integer(180_000),

  SIG_BIDIRECTIONAL_TX_MODE: z
    .enum(['eth_self_transfer', 'erc20_zero_transfer'])
    .default('eth_self_transfer'),
  SIG_BIDIRECTIONAL_ERC20_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
    .optional(),

  SIG_BIDIRECTIONAL_WAITS_FOR_ETH_FINALITY: boolish(true),
  SIG_BIDIRECTIONAL_SIGNATURE_TIMEOUT_MS: integer(300_000),
  SIG_BIDIRECTIONAL_RESPOND_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .optional(),
  SIG_BIDIRECTIONAL_ETH_CONFIRM_TIMEOUT_MS: integer(600_000),
  SIG_BIDIRECTIONAL_CONFIRMATIONS: integer(2),

  // Read-only in the service: it reports balances and refuses to lease an
  // address below this, but never spends. Topping up is scripts/fund-workers.
  SIG_BIDIRECTIONAL_MIN_BALANCE_WEI: wei('2000000000000000'),
});

const parse = () => {
  const result = schema.safeParse(withoutEmptyValues(process.env));
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
};

const parsed = parse();

/**
 * The respond budget follows the finality flag unless set explicitly.
 *
 * Derived rather than defaulted so that flipping the flag actually changes
 * behaviour: a fixed default alongside the flag meant an explicit value could
 * silently win and leave the respond leg waiting thirty-five minutes with the
 * flag off.
 */
const respondTimeoutMs =
  parsed.SIG_BIDIRECTIONAL_RESPOND_TIMEOUT_MS ??
  (parsed.SIG_BIDIRECTIONAL_WAITS_FOR_ETH_FINALITY
    ? RESPOND_TIMEOUT_FINALITY_MS
    : RESPOND_TIMEOUT_INCLUSION_MS);

/** In-memory rotation index for the Ethereum keys (module-private). */
let evmKeyIndex = 0;

export const env = {
  port: parsed.PORT,
  nodeEnv: parsed.NODE_ENV,
  apiSecret: parsed.API_SECRET,

  /** Rotates on each read; all five slots are visited regardless of how many are set. */
  get evmSk() {
    evmKeyIndex = (evmKeyIndex % 5) + 1;
    return process.env[`SIG_EVM_SK_${evmKeyIndex}`] ?? '';
  },
  ethRpcUrlSepolia: parsed.SIG_ETH_RPC_URL_SEPOLIA ?? '',
  ethRpcUrlMainnet: parsed.SIG_ETH_RPC_URL_MAINNET ?? '',

  solRpcUrlDevnet: parsed.SIG_SOL_RPC_URL_DEV ?? '',
  solRpcUrlMainnet: parsed.SIG_SOL_RPC_URL_MAINNET ?? '',
  solSk: parsed.SIG_SOL_SK ?? '',
  solRootPublicKey: parsed.SIG_SOL_ROOT_PUBLIC_KEY,

  bidirectional: {
    paths: parsed.SIG_BIDIRECTIONAL_PATHS,
    pathPrefix: parsed.SIG_BIDIRECTIONAL_PATH_PREFIX,
    maxActiveJobs: parsed.SIG_BIDIRECTIONAL_MAX_ACTIVE_JOBS,
    maxJobs: parsed.SIG_BIDIRECTIONAL_MAX_JOBS,
    retainedJobs: parsed.SIG_BIDIRECTIONAL_RETAINED_JOBS,
    maxRequestsPerMinute: parsed.SIG_BIDIRECTIONAL_MAX_REQUESTS_PER_MIN,
    leaseWaitMs: parsed.SIG_BIDIRECTIONAL_LEASE_WAIT_MS,
    txMode: parsed.SIG_BIDIRECTIONAL_TX_MODE,
    erc20Address: parsed.SIG_BIDIRECTIONAL_ERC20_ADDRESS,
    waitsForEthFinality: parsed.SIG_BIDIRECTIONAL_WAITS_FOR_ETH_FINALITY,
    signatureTimeoutMs: parsed.SIG_BIDIRECTIONAL_SIGNATURE_TIMEOUT_MS,
    respondTimeoutMs,
    ethConfirmTimeoutMs: parsed.SIG_BIDIRECTIONAL_ETH_CONFIRM_TIMEOUT_MS,
    confirmations: parsed.SIG_BIDIRECTIONAL_CONFIRMATIONS,
    minBalanceWei: parsed.SIG_BIDIRECTIONAL_MIN_BALANCE_WEI,
  },
} as const;

export type Env = typeof env;
