import {
  createPublicClient,
  encodeFunctionData,
  http,
  recoverAddress,
  serializeTransaction,
  type Hex,
  type PublicClient,
  type TransactionSerializableEIP1559,
} from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { chainAdapters, type RSVSignature } from 'signet.js';
import { env } from './env';
import { keccak256 } from 'viem/utils';

export const TX_MODES = ['eth_self_transfer', 'erc20_zero_transfer'] as const;
export type TxMode = (typeof TX_MODES)[number];

export const isTxMode = (value: unknown): value is TxMode =>
  typeof value === 'string' && (TX_MODES as readonly string[]).includes(value);

/**
 * MPC nodes recognise only mainnet CAIP-2 ids, so a Sepolia transaction is
 * still announced as `eip155:1`. The chain id inside the signed transaction is
 * what actually selects the network, which is why this constant does not vary
 * with the target below.
 */
export const ETHEREUM_CAIP2_ID = 'eip155:1';
export const KEY_VERSION = 1;

export type BidirectionalEnvironment = 'dev' | 'testnet' | 'mainnet';

/**
 * Which Ethereum each MPC network's round trip settles on.
 *
 * `dev` and `testnet` both sign for Sepolia; `mainnet` signs for Ethereum
 * mainnet and therefore spends real ETH on every job. The per-network limits
 * that keep that from becoming expensive live in the service, not here.
 */
export const ETHEREUM_TARGETS = {
  dev: {
    chain: sepolia,
    chainId: 11155111,
    rpcUrl: () => env.ethRpcUrlSepolia,
    erc20: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
  testnet: {
    chain: sepolia,
    chainId: 11155111,
    rpcUrl: () => env.ethRpcUrlSepolia,
    erc20: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
  mainnet: {
    chain: mainnet,
    chainId: 1,
    rpcUrl: () => env.ethRpcUrlMainnet,
    erc20: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
} as const satisfies Record<BidirectionalEnvironment, unknown>;

/**
 * Both modes resolve to a single Borsh-encoded `true`.
 *
 * `erc20_zero_transfer` decodes the real `bool` returned by `transfer`;
 * `eth_self_transfer` has no return data at all, so the node synthesizes the
 * value from the respond schema instead. Either way the wire result is 0x01,
 * which is why one verification path covers both.
 */
export const EXPECTED_SERIALIZED_OUTPUT = '0x01';

/**
 * A bare JSON string. The node's `parse_schema_fields` accepts this as a
 * single field named "", and Borsh — the format for Solana-sourced requests —
 * requires exactly one field. Empty bytes fail to parse; `[]` fails the
 * one-field check.
 */
const RESPOND_SERIALIZATION_SCHEMA = Buffer.from(JSON.stringify('bool'));

/** Matches the ABI JSON the vault program derives from `transfer`'s outputs. */
const ERC20_OUTPUT_SCHEMA = Buffer.from(
  JSON.stringify([{ name: '', type: 'bool' }])
);

const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const GAS_BUFFER_PERCENT = 20n;

export const createEthereumClient = (
  environment: BidirectionalEnvironment,
  rpcUrl: string
): PublicClient =>
  createPublicClient({
    chain: ETHEREUM_TARGETS[environment].chain,
    transport: http(rpcUrl),
  }) as PublicClient;

export interface BuiltTransaction {
  unsigned: TransactionSerializableEIP1559;
  /** The exact bytes the MPC signs, and the payload the requestId hashes. */
  rlpEncoded: Hex;
  nonce: number;
  gasCostWei: bigint;
  outputDeserializationSchema: Buffer;
  respondSerializationSchema: Buffer;
}

/**
 * Build the unsigned transaction for a mode.
 *
 * `eth_self_transfer` sends zero value to the derived address itself with no
 * calldata: the cheapest transaction that still exercises the full round trip,
 * and one that depends on no contract. `erc20_zero_transfer` calls
 * `transfer(self, 0)`, which is valid for any ERC20 regardless of balance and
 * is the only mode that drives the node's trace-based extraction path.
 */
export const buildTransaction = async ({
  client,
  environment,
  mode,
  from,
  erc20Address,
}: {
  client: PublicClient;
  environment: BidirectionalEnvironment;
  mode: TxMode;
  from: Hex;
  erc20Address: Hex;
}): Promise<BuiltTransaction> => {
  const [nonce, fees] = await Promise.all([
    client.getTransactionCount({ address: from, blockTag: 'latest' }),
    client.estimateFeesPerGas(),
  ]);

  const isErc20 = mode === 'erc20_zero_transfer';
  const to = isErc20 ? erc20Address : from;
  const data = isErc20
    ? encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [from, 0n],
      })
    : undefined;

  const gasEstimate = await client.estimateGas({
    account: from,
    to,
    value: 0n,
    data,
  });
  const gas = (gasEstimate * (100n + GAS_BUFFER_PERCENT)) / 100n;

  const unsigned: TransactionSerializableEIP1559 = {
    type: 'eip1559',
    chainId: ETHEREUM_TARGETS[environment].chainId,
    nonce,
    to,
    value: 0n,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    ...(data ? { data } : {}),
  };

  return {
    unsigned,
    rlpEncoded: serializeTransaction(unsigned),
    nonce,
    gasCostWei: gas * fees.maxFeePerGas,
    outputDeserializationSchema: isErc20
      ? ERC20_OUTPUT_SCHEMA
      : Buffer.alloc(0),
    respondSerializationSchema: RESPOND_SERIALIZATION_SCHEMA,
  };
};

/**
 * Attach an MPC signature to the unsigned transaction and recover the sender
 * it actually produces.
 *
 * The recovered address is the check that matters: the MPC signs the bytes we
 * emitted, so if our reassembly differs from those bytes by even a field
 * ordering, the signature recovers to something other than the derived
 * address. Catching that here costs nothing; catching it after broadcast costs
 * a stuck nonce.
 *
 * Assembly is signet.js's, so a change to how it serializes or transforms a
 * signature reaches this code rather than leaving a private copy to diverge.
 * The adapter needs neither a client nor a contract for this — it touches
 * those only for RPC — so it is constructed here and the function stays pure
 * and directly testable.
 */
export const attachSignature = async ({
  unsigned,
  signature,
}: {
  unsigned: TransactionSerializableEIP1559;
  signature: RSVSignature;
}): Promise<{ serialized: Hex; recoveredFrom: Hex }> => {
  // `transformRSVSignature` computes `v - 27`, so the value has to arrive in
  // that form. The MPC reports `v` either way — 0/1 and 27/28 have both been
  // observed — and normalizing here is what makes the two equivalent.
  // `transformRSVSignature` computes `v - 27`, so the value has to arrive in
  // that form. The MPC has been seen reporting `v` both ways — 0/1 and 27/28 —
  // and normalizing here is what makes the two equivalent.
  const rsv: RSVSignature = {
    r: signature.r.replace(/^0x/, ''),
    s: signature.s.replace(/^0x/, ''),
    v: signature.v < 27 ? signature.v + 27 : signature.v,
  };

  const adapter = new chainAdapters.evm.EVM({
    publicClient: undefined as never,
    contract: undefined as never,
  });
  const serialized = adapter.finalizeTransactionSigning({
    transaction: unsigned as never,
    rsvSignatures: [rsv],
  }) as Hex;

  // Recovery stays ours: the adapter attaches a signature but never checks
  // whose it is. The MPC signs the bytes we emitted, so a reassembly differing
  // by even a field ordering recovers to something other than the derived
  // address — catching that here costs nothing, catching it after broadcast
  // costs a stuck nonce.
  const recoveredFrom = await recoverAddress({
    hash: keccak256(serializeTransaction(unsigned)),
    signature: {
      r: `0x${rsv.r}` as Hex,
      s: `0x${rsv.s}` as Hex,
      yParity: rsv.v - 27,
    },
  });

  return { serialized, recoveredFrom };
};
