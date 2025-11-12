"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initEthereum = void 0;
const viem_1 = require("viem");
const accounts_1 = require("viem/accounts");
const chains_1 = require("viem/chains");
const useEnv_1 = require("./useEnv");
const signet_js_1 = require("signet.js");
const initEthereum = ({ contractAddress, environment, }) => {
    const { ethRpcUrlSepolia, ethRpcUrlMainnet, evmSk } = (0, useEnv_1.useEnv)();
    const config = {
        dev: {
            chain: chains_1.sepolia,
            rpcUrl: ethRpcUrlSepolia,
        },
        testnet: {
            chain: chains_1.sepolia,
            rpcUrl: ethRpcUrlSepolia,
        },
        mainnet: {
            chain: chains_1.mainnet,
            rpcUrl: ethRpcUrlMainnet,
        },
    }[environment];
    if (!config.rpcUrl) {
        throw new Error(`Ethereum RPC URL for ${environment} environment is missing. Please set ${environment === 'mainnet'
            ? 'SIG_ETH_RPC_URL_MAINNET'
            : 'SIG_ETH_RPC_URL_SEPOLIA'} in your environment.`);
    }
    if (!evmSk) {
        throw new Error(`EVM secret key for ${environment} environment is missing. Please set the evmSk environment variable.`);
    }
    const publicClient = (0, viem_1.createPublicClient)({
        chain: config.chain,
        transport: (0, viem_1.http)(config.rpcUrl),
    });
    const account = (0, accounts_1.privateKeyToAccount)((evmSk.startsWith('0x') ? evmSk : `0x${evmSk}`));
    const walletClient = (0, viem_1.createWalletClient)({
        account,
        chain: config.chain,
        transport: (0, viem_1.http)(config.rpcUrl),
    });
    const chainSigContract = new signet_js_1.contracts.evm.ChainSignatureContract({
        publicClient,
        walletClient,
        contractAddress: contractAddress,
    });
    return { publicClient, walletClient, chainSigContract };
};
exports.initEthereum = initEthereum;
