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
    rpcVar: 'SIG_ETH_RPC_URL_SEPOLIA',
    erc20: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
  testnet: {
    chain: sepolia,
    chainId: 11155111,
    rpcVar: 'SIG_ETH_RPC_URL_SEPOLIA',
    erc20: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  },
  mainnet: {
    chain: mainnet,
    chainId: 1,
    rpcVar: 'SIG_ETH_RPC_URL_MAINNET',
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

export interface RsvSignature {
  r: string;
  s: string;
  v: number | string | bigint;
}

const hex = (value: string): Hex =>
  (value.startsWith('0x') ? value : `0x${value}`) as Hex;

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
 * Not routed through signet.js's `EVM#finalizeTransactionSigning`, which is a
 * one-line wrapper over the same `serializeTransaction` call and whose
 * `transformRSVSignature` hardcodes `v - 27`. The MPC sends `v` as 0/1 as well
 * as 27/28, so using it would mean normalizing to 27/28 purely for the adapter
 * to subtract 27 again — and it would require constructing an adapter, with a
 * client, to call what is otherwise a pure function.
 */
export const attachSignature = async ({
  unsigned,
  signature,
}: {
  unsigned: TransactionSerializableEIP1559;
  signature: RsvSignature;
}): Promise<{ serialized: Hex; recoveredFrom: Hex }> => {
  const v = BigInt(signature.v);
  const serialized = serializeTransaction(unsigned, {
    r: hex(signature.r),
    s: hex(signature.s),
    // viem wants yParity for EIP-1559; MPC nodes report v as 0/1 or 27/28.
    yParity: Number(v >= 27n ? v - 27n : v),
  });

  const recoveredFrom = await recoverAddress({
    hash: keccak256(serializeTransaction(unsigned)),
    signature: {
      r: hex(signature.r),
      s: hex(signature.s),
      yParity: Number(v >= 27n ? v - 27n : v),
    },
  });

  return { serialized, recoveredFrom };
};
