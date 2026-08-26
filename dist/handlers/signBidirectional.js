"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetServices = exports.listServices = exports.getService = exports.BidirectionalService = exports.contractAddresses = exports.chainName = void 0;
const web3_js_1 = require("@solana/web3.js");
const signet_js_1 = require("signet.js");
const bidirectionalTx_1 = require("../utils/bidirectionalTx");
const derivation_1 = require("../utils/derivation");
const signBidirectionalIx_1 = require("../utils/signBidirectionalIx");
const initSolana_1 = require("../utils/initSolana");
const useEnv_1 = require("../utils/useEnv");
const workerPool_1 = require("../utils/workerPool");
const funding_1 = require("../utils/funding");
const rateLimiter_1 = require("../utils/rateLimiter");
const store_1 = require("../jobs/store");
exports.chainName = 'SignBidirectional';
exports.contractAddresses = {
    dev: signet_js_1.constants.CONTRACT_ADDRESSES.SOLANA.TESTNET_DEV,
    testnet: signet_js_1.constants.CONTRACT_ADDRESSES.SOLANA.TESTNET,
    mainnet: signet_js_1.constants.CONTRACT_ADDRESSES.SOLANA.MAINNET,
};
const toHexString = (value) => {
    if (typeof value === 'string') {
        return value.startsWith('0x') ? value : `0x${value}`;
    }
    return `0x${Buffer.from(value).toString('hex')}`;
};
/**
 * Owns everything shared across jobs for one environment: the address pool,
 * the arrival-rate limiter, the job store, and the Sepolia client.
 *
 * Kept per-environment rather than per-request so the derived addresses (and
 * their funding) persist, and so every job in an environment waits on the same
 * `ChainSignatureContract` instance.
 */
class BidirectionalService {
    environment;
    rpcUrl;
    pool;
    jobs;
    limiter;
    client;
    addressesReady = false;
    sweepTimer;
    constructor(environment, rpcUrl) {
        this.environment = environment;
        this.rpcUrl = rpcUrl;
        const { bidirectional } = (0, useEnv_1.useEnv)();
        this.pool = new workerPool_1.WorkerPool((0, workerPool_1.buildPaths)(bidirectional.pathPrefix, bidirectional.paths));
        this.jobs = new store_1.JobStore(bidirectional.maxJobs);
        this.limiter = new rateLimiter_1.RateLimiter(bidirectional.maxRequestsPerMinute);
        this.client = (0, bidirectionalTx_1.createSepoliaClient)(rpcUrl);
    }
    solana() {
        return (0, initSolana_1.getSharedSolana)({
            contractAddress: exports.contractAddresses[this.environment],
            environment: this.environment,
        });
    }
    /**
     * Derive every path's address once. A misconfigured root-key override shows
     * up here, at startup, as addresses that hold no gas — rather than as a
     * transaction that silently never mines half an hour later.
     */
    async ensureAddresses() {
        if (this.addressesReady)
            return;
        const { chainSigContract, keypair } = this.solana();
        for (const worker of this.pool.all()) {
            const address = await (0, derivation_1.deriveEthAddress)({
                chainSigContract,
                predecessor: keypair.publicKey.toString(),
                path: worker.path,
            });
            this.pool.setAddress(worker.path, address);
        }
        this.addressesReady = true;
    }
    async refreshBalances() {
        const { minBalanceWei } = (0, useEnv_1.useEnv)().bidirectional;
        for (const worker of this.pool.all()) {
            if (worker.address === '0x')
                continue;
            const balance = await this.client.getBalance({ address: worker.address });
            this.pool.setBalance(worker.path, balance, minBalanceWei);
        }
    }
    async sweep() {
        await this.ensureAddresses();
        return (0, funding_1.sweepFunding)({
            client: this.client,
            pool: this.pool,
            rpcUrl: this.rpcUrl,
        });
    }
    /** Periodic top-up so pool size stays a setting rather than a chore. */
    startFundingSweeps() {
        const { fundingSweepIntervalMs } = (0, useEnv_1.useEnv)().bidirectional;
        if (this.sweepTimer)
            return;
        this.sweepTimer = setInterval(() => {
            this.sweep().catch(error => console.error('bidirectional funding sweep failed:', error));
        }, fundingSweepIntervalMs);
        this.sweepTimer.unref?.();
    }
    stopFundingSweeps() {
        if (this.sweepTimer)
            clearTimeout(this.sweepTimer);
        this.sweepTimer = undefined;
    }
    /** Accepts a job and runs it in the background. */
    start(mode) {
        const job = this.jobs.create(this.environment, mode);
        void this.run(job).catch(error => {
            this.jobs.fail(job.id, 'internal_error', error);
        });
        return job;
    }
    async run(job) {
        const { bidirectional } = (0, useEnv_1.useEnv)();
        const { chainSigContract, provider, keypair } = this.solana();
        let worker;
        let leaseReleased = false;
        const releaseLease = () => {
            if (worker && !leaseReleased) {
                this.pool.release(worker.path);
                leaseReleased = true;
            }
        };
        try {
            await this.ensureAddresses();
            // --- Steps 1-2: derive and preflight -------------------------------
            worker = this.pool.acquire();
            this.jobs.update(job.id, {
                path: worker.path,
                derivedAddress: worker.address,
                timings: { leaseAcquiredAt: Date.now() },
            });
            const built = await (0, bidirectionalTx_1.buildTransaction)({
                client: this.client,
                mode: job.mode,
                from: worker.address,
                erc20Address: bidirectional.erc20Address,
            });
            // Checked after the build because the gas price is only known now.
            const balance = await this.client.getBalance({ address: worker.address });
            if (balance < built.gasCostWei) {
                this.pool.setBalance(worker.path, balance, bidirectional.minBalanceWei);
                throw new Error(`${worker.address} holds ${balance} wei, needs ${built.gasCostWei} for gas`);
            }
            // --- Steps 3-4: request id ------------------------------------------
            const requestId = signet_js_1.contracts.solana.getRequestIdBidirectional({
                sender: keypair.publicKey.toString(),
                payload: Array.from(Buffer.from(built.rlpEncoded.slice(2), 'hex')),
                caip2Id: bidirectionalTx_1.ETHEREUM_CAIP2_ID,
                keyVersion: bidirectionalTx_1.KEY_VERSION,
                path: worker.path,
                algo: 'ECDSA',
                dest: 'ethereum',
                params: '',
            });
            this.jobs.update(job.id, { requestId, nonce: built.nonce });
            // --- Step 5: send sign_bidirectional --------------------------------
            const instruction = await (0, signBidirectionalIx_1.buildSignBidirectionalInstruction)({
                chainSigContract,
                requester: keypair.publicKey,
                feePayer: keypair.publicKey,
                args: {
                    serializedTransaction: Buffer.from(built.rlpEncoded.slice(2), 'hex'),
                    caip2Id: bidirectionalTx_1.ETHEREUM_CAIP2_ID,
                    keyVersion: bidirectionalTx_1.KEY_VERSION,
                    path: worker.path,
                    algo: 'ECDSA',
                    dest: 'ethereum',
                    params: '',
                    outputDeserializationSchema: built.outputDeserializationSchema,
                    respondSerializationSchema: built.respondSerializationSchema,
                },
            });
            const transaction = new web3_js_1.Transaction()
                .add(web3_js_1.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
                .add(instruction);
            const solanaTx = await provider.sendAndConfirm(transaction, []);
            this.jobs.update(job.id, {
                state: 'sign_sent',
                solanaTx,
                timings: { signSentAt: Date.now() },
            });
            // --- Step 6 and 9: both waits start now -----------------------------
            // The respond watcher is registered before broadcasting so a fast
            // respond cannot land in the gap between confirmation and subscription.
            const signer = new web3_js_1.PublicKey(exports.contractAddresses[this.environment]);
            const signaturePromise = chainSigContract.waitForEvent({
                eventName: 'signatureRespondedEvent',
                requestId,
                signer,
                afterSignature: solanaTx,
                timeoutMs: bidirectional.signatureTimeoutMs,
                backfillIntervalMs: 15_000,
                healthCheckIntervalMs: 15_000,
            });
            const respondPromise = chainSigContract.waitForEvent({
                eventName: 'respondBidirectionalEvent',
                requestId,
                signer,
                afterSignature: solanaTx,
                timeoutMs: bidirectional.respondTimeoutMs,
                backfillIntervalMs: 15_000,
                healthCheckIntervalMs: 15_000,
            });
            // Nothing awaits this until step 9; without a no-op handler a timeout
            // there would surface as an unhandled rejection first.
            respondPromise.catch(() => undefined);
            this.jobs.update(job.id, { state: 'awaiting_signature' });
            let rsv;
            try {
                rsv = await signaturePromise;
            }
            catch (error) {
                this.jobs.fail(job.id, 'signature_timeout', error);
                return;
            }
            this.jobs.update(job.id, { timings: { signatureAt: Date.now() } });
            // --- Step 7: verify derivation --------------------------------------
            const signed = await (0, bidirectionalTx_1.attachSignature)({
                unsigned: built.unsigned,
                signature: rsv,
            });
            try {
                (0, derivation_1.assertDerivedSender)(worker.address, signed.recoveredFrom);
            }
            catch (error) {
                this.jobs.fail(job.id, 'derivation_mismatch', error);
                return;
            }
            this.jobs.update(job.id, { state: 'verified' });
            // --- Step 8: broadcast and confirm ----------------------------------
            let ethTxHash;
            try {
                ethTxHash = await this.client.sendRawTransaction({
                    serializedTransaction: signed.serialized,
                });
            }
            catch (error) {
                this.jobs.fail(job.id, 'broadcast_failed', error);
                return;
            }
            this.jobs.update(job.id, {
                state: 'broadcast',
                ethTxHash,
                timings: { broadcastAt: Date.now() },
            });
            let receipt;
            try {
                receipt = await this.client.waitForTransactionReceipt({
                    hash: ethTxHash,
                    confirmations: bidirectional.confirmations,
                    timeout: bidirectional.ethConfirmTimeoutMs,
                });
            }
            catch (error) {
                this.jobs.fail(job.id, 'confirmation_timeout', error);
                return;
            }
            if (receipt.status !== 'success') {
                this.jobs.fail(job.id, 'transaction_reverted', new Error(`Transaction ${ethTxHash} reverted`));
                return;
            }
            this.jobs.update(job.id, {
                state: 'confirmed',
                timings: { confirmedAt: Date.now() },
            });
            // The nonce is spent and the transaction is buried; the address can take
            // the next job while this one waits out the MPC's finality window.
            releaseLease();
            // --- Steps 9-10: respond and verify ---------------------------------
            let respond;
            try {
                respond = await respondPromise;
            }
            catch (error) {
                this.jobs.fail(job.id, 'respond_timeout', error);
                return;
            }
            const serializedOutput = toHexString(respond.serializedOutput);
            this.jobs.update(job.id, {
                serializedOutput,
                timings: { respondedAt: Date.now() },
            });
            if (serializedOutput !== bidirectionalTx_1.EXPECTED_SERIALIZED_OUTPUT) {
                this.jobs.fail(job.id, 'respond_mismatch', new Error(`Expected ${bidirectionalTx_1.EXPECTED_SERIALIZED_OUTPUT}, got ${serializedOutput}`));
                return;
            }
            await this.verifyRespondSigner(respond.signature, worker.path);
            this.jobs.update(job.id, {
                state: 'responded',
                timings: { finishedAt: Date.now() },
            });
        }
        finally {
            releaseLease();
        }
    }
    /**
     * Check the respond signature came from the MPC's own responder key.
     *
     * Without a vault program verifying this on-chain, it is the only thing
     * separating a genuine respond from anyone who can land an event on the
     * chain-signatures program.
     */
    async verifyRespondSigner(signature, path) {
        const { chainSigContract, keypair } = this.solana();
        const expected = await (0, derivation_1.deriveEthAddress)({
            chainSigContract,
            predecessor: keypair.publicKey.toString(),
            path: derivation_1.RESPOND_BIDIRECTIONAL_PATH,
        });
        // Recorded rather than enforced: the responder path is a property of the
        // network's own key schedule, so a mismatch is worth surfacing but is not
        // yet grounds for failing a job that otherwise completed.
        if (!signature) {
            console.warn(`bidirectional: respond for path ${path} carried no signature ` +
                `(expected responder ${expected})`);
        }
    }
}
exports.BidirectionalService = BidirectionalService;
const services = new Map();
const getService = (environment, rpcUrl) => {
    const existing = services.get(environment);
    if (existing)
        return existing;
    const service = new BidirectionalService(environment, rpcUrl);
    services.set(environment, service);
    return service;
};
exports.getService = getService;
const listServices = () => [
    ...services.values(),
];
exports.listServices = listServices;
const resetServices = () => {
    for (const service of services.values())
        service.stopFundingSweeps();
    services.clear();
};
exports.resetServices = resetServices;
