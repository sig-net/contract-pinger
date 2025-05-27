"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contractAddresses = exports.chainName = void 0;
exports.execute = execute;
const initEvm_1 = require("../utils/initEvm");
const evmTransactions_1 = require("../utils/evmTransactions");
const signet_js_1 = require("signet.js");
exports.chainName = 'Ethereum';
exports.contractAddresses = {
    dev: signet_js_1.constants.CONTRACT_ADDRESSES.ETHEREUM.TESTNET_DEV,
    testnet: signet_js_1.constants.CONTRACT_ADDRESSES.ETHEREUM.TESTNET,
    mainnet: signet_js_1.constants.CONTRACT_ADDRESSES.ETHEREUM.MAINNET,
};
async function execute({ check_signature, environment, }) {
    const contractAddress = exports.contractAddresses[environment];
    const { chainSigContract, publicClient, walletClient } = (0, initEvm_1.initEthereum)({
        contractAddress,
        environment,
    });
    if (check_signature) {
        const signature = await (0, evmTransactions_1.createSignRequestAndWaitSignature)({
            chainSigContract,
            publicClient,
            walletClient,
        });
        return { signature };
    }
    else {
        const signatureRequest = await (0, evmTransactions_1.createSignRequest)({
            chainSigContract,
            publicClient,
            walletClient,
        });
        return { signatureRequest };
    }
}
