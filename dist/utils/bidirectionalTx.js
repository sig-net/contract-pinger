"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSerialized = exports.attachSignature = exports.buildTransaction = exports.createSepoliaClient = exports.EXPECTED_SERIALIZED_OUTPUT = exports.KEY_VERSION = exports.SEPOLIA_CHAIN_ID = exports.ETHEREUM_CAIP2_ID = exports.isTxMode = exports.TX_MODES = void 0;
const viem_1 = require("viem");
const chains_1 = require("viem/chains");
const utils_1 = require("viem/utils");
exports.TX_MODES = ['eth_self_transfer', 'erc20_zero_transfer'];
const isTxMode = (value) => typeof value === 'string' && exports.TX_MODES.includes(value);
exports.isTxMode = isTxMode;
/**
 * MPC nodes recognise only mainnet CAIP-2 ids, so a Sepolia transaction is
 * still announced as `eip155:1`. The chain id inside the signed transaction is
 * what actually selects the network.
 */
exports.ETHEREUM_CAIP2_ID = 'eip155:1';
exports.SEPOLIA_CHAIN_ID = 11155111;
exports.KEY_VERSION = 1;
/**
 * Both modes resolve to a single Borsh-encoded `true`.
 *
 * `erc20_zero_transfer` decodes the real `bool` returned by `transfer`;
 * `eth_self_transfer` has no return data at all, so the node synthesizes the
 * value from the respond schema instead. Either way the wire result is 0x01,
 * which is why one verification path covers both.
 */
exports.EXPECTED_SERIALIZED_OUTPUT = '0x01';
/**
 * A bare JSON string. The node's `parse_schema_fields` accepts this as a
 * single field named "", and Borsh — the format for Solana-sourced requests —
 * requires exactly one field. Empty bytes fail to parse; `[]` fails the
 * one-field check.
 */
const RESPOND_SERIALIZATION_SCHEMA = Buffer.from(JSON.stringify('bool'));
/** Matches the ABI JSON the vault program derives from `transfer`'s outputs. */
const ERC20_OUTPUT_SCHEMA = Buffer.from(JSON.stringify([{ name: '', type: 'bool' }]));
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
];
const GAS_BUFFER_PERCENT = 20n;
const createSepoliaClient = (rpcUrl) => (0, viem_1.createPublicClient)({
    chain: chains_1.sepolia,
    transport: (0, viem_1.http)(rpcUrl),
});
exports.createSepoliaClient = createSepoliaClient;
/**
 * Build the unsigned transaction for a mode.
 *
 * `eth_self_transfer` sends zero value to the derived address itself with no
 * calldata: the cheapest transaction that still exercises the full round trip,
 * and one that depends on no contract. `erc20_zero_transfer` calls
 * `transfer(self, 0)`, which is valid for any ERC20 regardless of balance and
 * is the only mode that drives the node's trace-based extraction path.
 */
const buildTransaction = async ({ client, mode, from, erc20Address, }) => {
    const [nonce, fees] = await Promise.all([
        client.getTransactionCount({ address: from, blockTag: 'latest' }),
        client.estimateFeesPerGas(),
    ]);
    const isErc20 = mode === 'erc20_zero_transfer';
    const to = isErc20 ? erc20Address : from;
    const data = isErc20
        ? (0, viem_1.encodeFunctionData)({
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
    const unsigned = {
        type: 'eip1559',
        chainId: exports.SEPOLIA_CHAIN_ID,
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
        rlpEncoded: (0, viem_1.serializeTransaction)(unsigned),
        nonce,
        gasCostWei: gas * fees.maxFeePerGas,
        outputDeserializationSchema: isErc20
            ? ERC20_OUTPUT_SCHEMA
            : Buffer.alloc(0),
        respondSerializationSchema: RESPOND_SERIALIZATION_SCHEMA,
    };
};
exports.buildTransaction = buildTransaction;
const hex = (value) => (value.startsWith('0x') ? value : `0x${value}`);
/**
 * Attach an MPC signature to the unsigned transaction and recover the sender
 * it actually produces.
 *
 * The recovered address is the check that matters: the MPC signs the bytes we
 * emitted, so if our reassembly differs from those bytes by even a field
 * ordering, the signature recovers to something other than the derived
 * address. Catching that here costs nothing; catching it after broadcast costs
 * a stuck nonce.
 */
const attachSignature = async ({ unsigned, signature, }) => {
    const v = BigInt(signature.v);
    const serialized = (0, viem_1.serializeTransaction)(unsigned, {
        r: hex(signature.r),
        s: hex(signature.s),
        // viem wants yParity for EIP-1559; MPC nodes report v as 0/1 or 27/28.
        yParity: Number(v >= 27n ? v - 27n : v),
    });
    const recoveredFrom = await (0, viem_1.recoverAddress)({
        hash: (0, utils_1.keccak256)((0, viem_1.serializeTransaction)(unsigned)),
        signature: {
            r: hex(signature.r),
            s: hex(signature.s),
            yParity: Number(v >= 27n ? v - 27n : v),
        },
    });
    return {
        serialized,
        hash: (0, utils_1.keccak256)(serialized),
        recoveredFrom,
    };
};
exports.attachSignature = attachSignature;
/** Re-parse a serialized transaction. Used by tests to assert field fidelity. */
const parseSerialized = (serialized) => (0, viem_1.parseTransaction)(serialized);
exports.parseSerialized = parseSerialized;
