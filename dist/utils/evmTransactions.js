"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSignRequest = exports.createSignRequestAndWaitSignature = exports.getCustomTransactionArgs = exports.getSignArgs = void 0;
const getSignArgs = () => {
    const payload = new Uint8Array(Array(32)
        .fill(0)
        .map(() => Math.floor(Math.random() * 256)));
    return [
        { payload, path: '', key_version: 0 },
        { sign: { algo: '', dest: '', params: '' } },
    ];
};
exports.getSignArgs = getSignArgs;
const getCustomTransactionArgs = async ({ publicClient, walletClient, }) => {
    const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
    const nonce = await publicClient.getTransactionCount({
        address: walletClient.account.address,
        blockTag: 'latest',
    });
    return {
        maxFeePerGas: (maxFeePerGas * 12n) / 10n,
        maxPriorityFeePerGas: (maxPriorityFeePerGas * 12n) / 10n,
        nonce,
    };
};
exports.getCustomTransactionArgs = getCustomTransactionArgs;
const createSignRequestAndWaitSignature = async ({ chainSigContract, publicClient, walletClient, }) => {
    const transactionArgs = publicClient && walletClient
        ? await (0, exports.getCustomTransactionArgs)({ publicClient, walletClient })
        : {};
    const signArgs = (0, exports.getSignArgs)();
    const rsvSignature = await chainSigContract.sign(signArgs[0], transactionArgs);
    return rsvSignature;
};
exports.createSignRequestAndWaitSignature = createSignRequestAndWaitSignature;
const createSignRequest = async ({ chainSigContract, publicClient, walletClient, }) => {
    const transactionArgs = publicClient && walletClient
        ? await (0, exports.getCustomTransactionArgs)({ publicClient, walletClient })
        : {};
    const signArgs = (0, exports.getSignArgs)();
    const signatureRequest = await chainSigContract.createSignRequest(signArgs[0], transactionArgs);
    return signatureRequest;
};
exports.createSignRequest = createSignRequest;
