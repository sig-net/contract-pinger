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
            evmPrivateKey: evmSk,
            infuraUrl: ethRpcUrlSepolia,
        },
        testnet: {
            chain: chains_1.sepolia,
            evmPrivateKey: evmSk,
            infuraUrl: ethRpcUrlSepolia,
        },
        mainnet: {
            chain: chains_1.mainnet,
            evmPrivateKey: evmSk,
            infuraUrl: ethRpcUrlMainnet,
        },
    }[environment];
    if (!config.infuraUrl) {
        throw new Error(`Infura URL for ${environment} environment is missing. Please set the ${environment === 'mainnet' ? 'mainnetInfuraUrl' : 'sepoliaInfuraUrl'} environment variable.`);
    }
    if (!config.evmPrivateKey) {
        throw new Error(`EVM private key for ${environment} environment is missing. Please set the ${environment === 'mainnet'
            ? 'evmPrivateKeyMainnet'
            : 'evmPrivateKeySepolia'} environment variable.`);
    }
    const publicClient = (0, viem_1.createPublicClient)({
        chain: config.chain,
        transport: (0, viem_1.http)(config.infuraUrl),
    });
    const account = (0, accounts_1.privateKeyToAccount)((config.evmPrivateKey.startsWith('0x')
        ? config.evmPrivateKey
        : `0x${config.evmPrivateKey}`));
    const walletClient = (0, viem_1.createWalletClient)({
        account,
        chain: config.chain,
        transport: (0, viem_1.http)(config.infuraUrl),
    });
    const chainSigContract = new signet_js_1.contracts.evm.ChainSignatureContract({
        publicClient,
        walletClient,
        contractAddress: contractAddress,
    });
    return { publicClient, walletClient, chainSigContract };
};
exports.initEthereum = initEthereum;
