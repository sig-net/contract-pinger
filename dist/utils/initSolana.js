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
exports.initSolanaNew = exports.initSolana = void 0;
const web3_js_1 = require("@solana/web3.js");
const anchor = __importStar(require("@coral-xyz/anchor"));
const signet_js_1 = require("signet.js");
const useEnv_1 = require("./useEnv");
const initSolana = () => {
    const { solanaRpcUrl, solanaPrivateKey, chainSigAddressSolana, chainSigRootPublicKeySolana, } = (0, useEnv_1.useEnv)();
    const connection = new web3_js_1.Connection(solanaRpcUrl, 'confirmed');
    const keypairArray = JSON.parse(solanaPrivateKey);
    const keypair = web3_js_1.Keypair.fromSecretKey(new Uint8Array(keypairArray));
    const wallet = new anchor.Wallet(keypair);
    const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment: 'confirmed',
    });
    const requesterKeypair = web3_js_1.Keypair.generate();
    const chainSigContract = new signet_js_1.contracts.solana.ChainSignatureContract({
        provider,
        programId: chainSigAddressSolana,
        rootPublicKey: chainSigRootPublicKeySolana,
        requesterAddress: requesterKeypair.publicKey.toString(),
    });
    return { chainSigContract, provider, requesterKeypair };
};
exports.initSolana = initSolana;
const initSolanaNew = ({ contractAddress, environment, }) => {
    const { solanaRpcUrlDevnet, solanaRpcUrlMainnet, solanaPrivateKeyDevnet, solanaPrivateKeyMainnet, } = (0, useEnv_1.useEnv)();
    const config = {
        dev: {
            solanaRpcUrl: solanaRpcUrlDevnet,
            solanaPrivateKey: solanaPrivateKeyDevnet,
        },
        testnet: {
            solanaRpcUrl: solanaRpcUrlDevnet,
            solanaPrivateKey: solanaPrivateKeyDevnet,
        },
        mainnet: {
            solanaRpcUrl: solanaRpcUrlMainnet,
            solanaPrivateKey: solanaPrivateKeyMainnet,
        },
    }[environment];
    const connection = new web3_js_1.Connection(config.solanaRpcUrl, 'confirmed');
    const keypairArray = JSON.parse(config.solanaPrivateKey);
    const keypair = web3_js_1.Keypair.fromSecretKey(new Uint8Array(keypairArray));
    const wallet = new anchor.Wallet(keypair);
    const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment: 'confirmed',
    });
    const requesterKeypair = web3_js_1.Keypair.generate();
    // You may want to pass a real rootPublicKey here if needed
    const chainSigContract = new signet_js_1.contracts.solana.ChainSignatureContract({
        provider,
        programId: contractAddress,
        rootPublicKey: '',
        requesterAddress: requesterKeypair.publicKey.toString(),
    });
    return { chainSigContract, provider, requesterKeypair };
};
exports.initSolanaNew = initSolanaNew;
