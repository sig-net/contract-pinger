"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertDerivedSender = exports.DerivationMismatchError = exports.deriveWorkerAddresses = void 0;
const viem_1 = require("viem");
const utils_1 = require("viem/utils");
const bidirectionalTx_1 = require("./bidirectionalTx");
/**
 * Derive the Ethereum address a `(requester, path)` pair controls.
 *
 * `getDerivedPublicKey` already wraps `deriveChildPublicKey` with the Solana
 * KDF chain id and whichever root key the contract resolved — the configured
 * override, or the one signet.js paired to the program address.
 */
const deriveEthAddress = async ({ chainSigContract, predecessor, path, }) => {
    const publicKey = await chainSigContract.getDerivedPublicKey({
        predecessor,
        path,
        keyVersion: bidirectionalTx_1.KEY_VERSION,
    });
    return (0, utils_1.publicKeyToAddress)((publicKey.startsWith('0x') ? publicKey : `0x${publicKey}`));
};
/**
 * Derive every worker address for a requester.
 *
 * Shared with `scripts/fund-workers.ts`, which sends ETH to these addresses
 * without asking the service where to send it. Two implementations of this
 * would be two chances to disagree, and disagreeing means funding addresses
 * nothing will ever spend from.
 *
 * Note what fixes the result: the requester is the public key of the same
 * `SIG_SOL_SK` that pays Solana fees, so rotating that key moves every address
 * here. So does pointing at a different environment, whose program address
 * pairs to a different root key.
 */
const deriveWorkerAddresses = async ({ chainSigContract, requester, paths, }) => {
    const derived = [];
    for (const path of paths) {
        derived.push({
            path,
            address: await deriveEthAddress({
                chainSigContract,
                predecessor: requester,
                path,
            }),
        });
    }
    return derived;
};
exports.deriveWorkerAddresses = deriveWorkerAddresses;
class DerivationMismatchError extends Error {
    expected;
    recovered;
    constructor(expected, recovered) {
        super(`Signed transaction recovers to ${recovered}, expected the derived address ${expected}. ` +
            'The MPC root key and the chain-signatures program are probably from different networks.');
        this.expected = expected;
        this.recovered = recovered;
        this.name = 'DerivationMismatchError';
    }
}
exports.DerivationMismatchError = DerivationMismatchError;
/**
 * Assert the signed transaction was produced by the key we derived.
 *
 * This is the cheapest possible detector for a root key paired with the wrong
 * program: every other symptom of that mistake shows up as a transaction that
 * silently never mines.
 */
const assertDerivedSender = (expected, recovered) => {
    if ((0, viem_1.getAddress)(expected) !== (0, viem_1.getAddress)(recovered)) {
        throw new DerivationMismatchError((0, viem_1.getAddress)(expected), (0, viem_1.getAddress)(recovered));
    }
};
exports.assertDerivedSender = assertDerivedSender;
