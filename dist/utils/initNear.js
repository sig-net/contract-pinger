"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.initNearNew = exports.initNear = void 0;
const useEnv_1 = require("./useEnv");
const nearAPI = __importStar(require("near-api-js"));
const signetJs = __importStar(require("signet.js"));
const initNear = async ({ contractAddress, }) => {
    const { nearAccount, nearNetworkId, nearPrivateKey } = (0, useEnv_1.useEnv)();
    const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
    const keyPair = nearAPI.KeyPair.fromString(nearPrivateKey);
    await keyStore.setKey(nearNetworkId, nearAccount, keyPair);
    const config = {
        networkId: nearNetworkId,
        keyStore,
        nodeUrl: nearNetworkId === 'mainnet'
            ? 'https://free.rpc.fastnear.com'
            : 'https://test.rpc.fastnear.com',
        helperUrl: nearNetworkId === 'mainnet'
            ? 'https://helper.mainnet.near.org'
            : 'https://helper.testnet.near.org',
    };
    const connection = await nearAPI.connect(config);
    const account = await connection.account(nearAccount);
    const chainSigContract = new signetJs.chains.near.ChainSignatureContract({
        networkId: nearNetworkId,
        contractId: contractAddress,
        accountId: nearAccount,
        keypair: keyPair,
    });
    return { connection, account, keyPair, chainSigContract };
};
exports.initNear = initNear;
const initNearNew = async ({ contractAddress, environment, }) => {
    const { nearAccountIdMainnet, nearAccountIdTestnet, nearPrivateKeyMainnet, nearPrivateKeyTestnet, } = (0, useEnv_1.useEnv)();
    const { nearAccount, nearPrivateKey, nearNetworkId } = {
        dev: {
            nearAccount: nearAccountIdTestnet,
            nearPrivateKey: nearPrivateKeyTestnet,
            nearNetworkId: 'testnet',
        },
        testnet: {
            nearAccount: nearAccountIdTestnet,
            nearPrivateKey: nearPrivateKeyTestnet,
            nearNetworkId: 'testnet',
        },
        mainnet: {
            nearAccount: nearAccountIdMainnet,
            nearPrivateKey: nearPrivateKeyMainnet,
            nearNetworkId: 'mainnet',
        },
    }[environment];
    if (!nearAccount) {
        throw new Error(`NEAR account ID for ${environment} environment is missing. Please set the ${environment === 'mainnet'
            ? 'nearAccountIdMainnet'
            : 'nearAccountIdTestnet'} environment variable.`);
    }
    if (!nearPrivateKey) {
        throw new Error(`NEAR private key for ${environment} environment is missing. Please set the ${environment === 'mainnet'
            ? 'nearPrivateKeyMainnet'
            : 'nearPrivateKeyTestnet'} environment variable.`);
    }
    const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
    const keyPair = nearAPI.KeyPair.fromString(nearPrivateKey);
    await keyStore.setKey(nearNetworkId, nearAccount, keyPair);
    const config = {
        networkId: nearNetworkId,
        keyStore,
        nodeUrl: nearNetworkId === 'mainnet'
            ? 'https://free.rpc.fastnear.com'
            : 'https://test.rpc.fastnear.com',
        helperUrl: nearNetworkId === 'mainnet'
            ? 'https://helper.mainnet.near.org'
            : 'https://helper.testnet.near.org',
    };
    const connection = await nearAPI.connect(config);
    const account = await connection.account(nearAccount);
    const chainSigContract = new signetJs.chains.near.ChainSignatureContract({
        networkId: nearNetworkId,
        contractId: contractAddress,
        accountId: nearAccount,
        keypair: keyPair,
    });
    return { connection, account, keyPair, chainSigContract };
};
exports.initNearNew = initNearNew;
