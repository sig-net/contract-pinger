"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSignRequest = exports.getCustomTransactionArgs = exports.getSignArgs = void 0;
const getSignArgs = () => {
    const payload = new Uint8Array(Array(32)
        .fill(0)
        .map(() => Math.floor(Math.random() * 256)));
    return [
        { payload, path: '', key_version: 1 },
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
const createSignRequest = async ({ chainSigContract, publicClient, walletClient, }) => {
    const transactionArgs = await (0, exports.getCustomTransactionArgs)({
        publicClient,
        walletClient,
    });
    const signArgs = (0, exports.getSignArgs)();
    const signatureRequest = await chainSigContract.createSignatureRequest(signArgs[0], {
        ...signArgs[1],
        transaction: transactionArgs,
    });
    console.log({ signatureRequest });
    return signatureRequest;
};
exports.createSignRequest = createSignRequest;
