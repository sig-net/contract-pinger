"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useEnv = void 0;
// In-memory rotation index for Ethereum key (module-private)
let evmKeyIndex = 0;
const useEnv = () => {
    // Always rotate key on each call
    evmKeyIndex = (evmKeyIndex % 5) + 1;
    const evmSk = process.env[`SIG_EVM_SK_${evmKeyIndex}`];
    return {
        // Server configuration
        port: process.env.PORT || '3001',
        nodeEnv: process.env.NODE_ENV || 'development',
        // Ethereum
        ethRpcUrlSepolia: process.env.SIG_ETH_RPC_URL_SEPOLIA || '',
        ethRpcUrlMainnet: process.env.SIG_ETH_RPC_URL_MAINNET || '',
        evmSk,
        // Solana
        solRpcUrlDevnet: process.env.SIG_SOL_RPC_URL_DEV || '',
        solRpcUrlMainnet: process.env.SIG_SOL_RPC_URL_MAINNET || '',
        solSk: process.env.SIG_SOL_SK || '',
    };
};
exports.useEnv = useEnv;
