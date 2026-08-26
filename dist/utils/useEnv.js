"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useEnv = void 0;
// In-memory rotation index for Ethereum key (module-private)
let evmKeyIndex = 0;
const getNextEvmSk = () => {
    evmKeyIndex = (evmKeyIndex % 5) + 1;
    return process.env[`SIG_EVM_SK_${evmKeyIndex}`];
};
const num = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
// The MPC waits for Ethereum finality before it reads a transaction's result
// back, so the respond leg is budgeted against Chain::Ethereum's finality
// expectation (1800s) plus slack. The signature leg never touches Ethereum:
// the node's own expectation for a Solana-sourced request is 11s.
const RESPOND_TIMEOUT_FINALITY_MS = 2_100_000;
const RESPOND_TIMEOUT_INCLUSION_MS = 300_000;
const useEnv = () => {
    const waitsForEthFinality = (process.env.SIG_BIDIRECTIONAL_WAITS_FOR_ETH_FINALITY ?? 'true') !==
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
            paths: num(process.env.SIG_BIDIRECTIONAL_PATHS, 10),
            pathPrefix: process.env.SIG_BIDIRECTIONAL_PATH_PREFIX || 'load',
            // Concurrent jobs including respond waits. Far larger than `paths`
            // because an address is released once its transaction mines, long
            // before the MPC finishes waiting for finality.
            maxJobs: num(process.env.SIG_BIDIRECTIONAL_MAX_JOBS, 400),
            maxRequestsPerMinute: num(process.env.SIG_BIDIRECTIONAL_MAX_REQUESTS_PER_MIN, 10),
            txMode: process.env.SIG_BIDIRECTIONAL_TX_MODE || 'eth_self_transfer',
            erc20Address: process.env.SIG_BIDIRECTIONAL_ERC20_ADDRESS ||
                '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
            waitsForEthFinality,
            signatureTimeoutMs: num(process.env.SIG_BIDIRECTIONAL_SIGNATURE_TIMEOUT_MS, 300_000),
            respondTimeoutMs: num(process.env.SIG_BIDIRECTIONAL_RESPOND_TIMEOUT_MS, waitsForEthFinality
                ? RESPOND_TIMEOUT_FINALITY_MS
                : RESPOND_TIMEOUT_INCLUSION_MS),
            ethConfirmTimeoutMs: num(process.env.SIG_BIDIRECTIONAL_ETH_CONFIRM_TIMEOUT_MS, 600_000),
            // Confirmations to wait for before releasing an address. One is enough
            // to consume the nonce; a second guards against a shallow reorg
            // stranding the next transaction behind a nonce gap.
            confirmations: num(process.env.SIG_BIDIRECTIONAL_CONFIRMATIONS, 2),
            minBalanceWei: BigInt(process.env.SIG_BIDIRECTIONAL_MIN_BALANCE_WEI || '2000000000000000'),
            topupWei: BigInt(process.env.SIG_BIDIRECTIONAL_TOPUP_WEI || '10000000000000000'),
            fundingSweepIntervalMs: num(process.env.SIG_BIDIRECTIONAL_FUNDING_SWEEP_MS, 300_000),
        },
    };
};
exports.useEnv = useEnv;
