"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useEnv = void 0;
const useEnv = () => {
    const getRotatingKey = () => {
        const currentTime = new Date().getTime();
        const keyIndex = (currentTime % 5) + 1;
        return process.env[`SIG_EVM_SK_${keyIndex}`];
    };
    return {
        // Server configuration
        port: process.env.PORT || '3001',
        nodeEnv: process.env.NODE_ENV || 'development',
        // Ethereum
        ethRpcUrlSepolia: process.env.SIG_ETH_RPC_URL_SEPOLIA || '',
        ethRpcUrlMainnet: process.env.SIG_ETH_RPC_URL_MAINNET || '',
        evmSk: getRotatingKey(),
        // Solana
        solRpcUrlDevnet: process.env.SIG_SOL_RPC_URL_DEV || '',
        solRpcUrlMainnet: process.env.SIG_SOL_RPC_URL_MAINNET || '',
        solSk: process.env.SIG_SOL_SK || '',
    };
};
exports.useEnv = useEnv;
