"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sweepFunding = void 0;
const viem_1 = require("viem");
const accounts_1 = require("viem/accounts");
const chains_1 = require("viem/chains");
const useEnv_1 = require("./useEnv");
const asHexKey = (key) => (key.startsWith('0x') ? key : `0x${key}`);
/**
 * Refresh every worker's balance and top up the ones that are short.
 *
 * Concurrency here is bounded by how many derived addresses hold gas, so
 * leaving that to manual funding would make the pool size a record of the last
 * time someone remembered rather than a real setting. The service already
 * holds Sepolia ETH for the Ethereum ping path; this reuses those keys.
 */
const sweepFunding = async ({ client, pool, rpcUrl, }) => {
    const env = (0, useEnv_1.useEnv)();
    const { minBalanceWei, topupWei } = env.bidirectional;
    const result = {
        checked: 0,
        toppedUp: [],
        stillUnderfunded: [],
        errors: [],
    };
    for (const worker of pool.all()) {
        if (worker.address === '0x')
            continue;
        result.checked += 1;
        try {
            const balance = await client.getBalance({ address: worker.address });
            pool.setBalance(worker.path, balance, minBalanceWei);
            if (balance >= minBalanceWei)
                continue;
            const shortfall = topupWei - balance;
            // `evmSk` rotates on each read, so each top-up draws from the next key.
            const key = env.evmSk;
            if (!key) {
                result.stillUnderfunded.push(worker.path);
                continue;
            }
            const wallet = (0, viem_1.createWalletClient)({
                account: (0, accounts_1.privateKeyToAccount)(asHexKey(key)),
                chain: chains_1.sepolia,
                transport: (0, viem_1.http)(rpcUrl),
            });
            const txHash = await wallet.sendTransaction({
                to: worker.address,
                value: shortfall,
            });
            result.toppedUp.push({
                path: worker.path,
                address: worker.address,
                amountWei: shortfall,
                txHash,
            });
            pool.setBalance(worker.path, topupWei, minBalanceWei);
        }
        catch (error) {
            result.errors.push({
                path: worker.path,
                message: error instanceof Error ? error.message : String(error),
            });
            result.stillUnderfunded.push(worker.path);
        }
    }
    return result;
};
exports.sweepFunding = sweepFunding;
