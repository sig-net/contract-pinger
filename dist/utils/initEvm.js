"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initEthereum = exports.initEvm = void 0;
const viem_1 = require("viem");
const accounts_1 = require("viem/accounts");
const chains_1 = require("viem/chains");
const useEnv_1 = require("./useEnv");
const signet_js_1 = require("signet.js");
const initEvm = ({ contractAddress }) => {
    const { sepoliaInfuraUrl, evmPrivateKey } = (0, useEnv_1.useEnv)();
    const publicClient = (0, viem_1.createPublicClient)({
        chain: chains_1.sepolia,
        transport: (0, viem_1.http)(sepoliaInfuraUrl),
    });
    const account = (0, accounts_1.privateKeyToAccount)((evmPrivateKey.startsWith('0x')
        ? evmPrivateKey
        : `0x${evmPrivateKey}`));
    const walletClient = (0, viem_1.createWalletClient)({
        account,
        chain: chains_1.sepolia,
        transport: (0, viem_1.http)(sepoliaInfuraUrl),
    });
    const chainSigContract = new signet_js_1.contracts.evm.ChainSignatureContract({
        publicClient,
        walletClient,
        contractAddress: contractAddress,
    });
    return { publicClient, walletClient, chainSigContract };
};
exports.initEvm = initEvm;
const initEthereum = ({ contractAddress, environment, }) => {
    const { sepoliaInfuraUrl, mainnetInfuraUrl, evmPrivateKeySepolia, evmPrivateKeyMainnet, } = (0, useEnv_1.useEnv)();
    const config = {
        dev: {
            chain: chains_1.sepolia,
            evmPrivateKey: evmPrivateKeySepolia,
            infuraUrl: sepoliaInfuraUrl,
        },
        testnet: {
            chain: chains_1.sepolia,
            evmPrivateKey: evmPrivateKeySepolia,
            infuraUrl: sepoliaInfuraUrl,
        },
        mainnet: {
            chain: chains_1.mainnet,
            evmPrivateKey: evmPrivateKeyMainnet,
            infuraUrl: mainnetInfuraUrl,
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
