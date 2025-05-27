"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contractAddresses = exports.chainName = void 0;
exports.execute = execute;
const initSolana_1 = require("../utils/initSolana");
const evmTransactions_1 = require("../utils/evmTransactions");
const signet_js_1 = require("signet.js");
exports.chainName = 'Solana';
exports.contractAddresses = {
    dev: signet_js_1.constants.CONTRACT_ADDRESSES.SOLANA.TESTNET_DEV,
    testnet: signet_js_1.constants.CONTRACT_ADDRESSES.SOLANA.TESTNET,
    mainnet: signet_js_1.constants.CONTRACT_ADDRESSES.SOLANA.MAINNET,
};
async function execute({ check_signature, environment, }) {
    const contractAddress = exports.contractAddresses[environment];
    const { chainSigContract, provider, requesterKeypair } = (0, initSolana_1.initSolanaNew)({
        contractAddress,
        environment,
    });
    const signArgs = (0, evmTransactions_1.getSignArgs)();
    if (check_signature) {
        const signature = await chainSigContract.sign(signArgs[0], {
            ...signArgs[1],
            remainingAccounts: [
                {
                    pubkey: requesterKeypair.publicKey,
                    isWritable: false,
                    isSigner: true,
                },
            ],
            remainingSigners: [requesterKeypair],
            retry: { delay: 5000, retryCount: 6 },
        });
        return { signature };
    }
    else {
        const instruction = await chainSigContract.getSignRequestInstruction(signArgs[0], {
            ...signArgs[1],
            remainingAccounts: [
                {
                    pubkey: requesterKeypair.publicKey,
                    isWritable: false,
                    isSigner: true,
                },
            ],
        });
        return { instruction };
    }
}
