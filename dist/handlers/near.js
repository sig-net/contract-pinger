"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contractAddresses = exports.chainName = void 0;
exports.execute = execute;
const initNear_1 = require("../utils/initNear");
const evmTransactions_1 = require("../utils/evmTransactions");
const signet_js_1 = require("signet.js");
exports.chainName = 'NEAR';
exports.contractAddresses = {
    dev: signet_js_1.constants.CONTRACT_ADDRESSES.NEAR.TESTNET_DEV,
    testnet: signet_js_1.constants.CONTRACT_ADDRESSES.NEAR.TESTNET,
    mainnet: signet_js_1.constants.CONTRACT_ADDRESSES.NEAR.MAINNET,
};
async function execute({ environment, }) {
    const contractAddress = exports.contractAddresses[environment];
    const { chainSigContract } = await (0, initNear_1.initNearNew)({
        contractAddress,
        environment,
    });
    const txHash = await (0, evmTransactions_1.createSignRequestAndWaitSignature)({ chainSigContract });
    return { txHash };
}
