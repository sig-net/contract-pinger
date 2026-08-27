"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listServices = exports.getService = exports.BidirectionalService = void 0;
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
const contractAddresses = {
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
    addressesReady;
    sweepTimer;
    constructor(environment, rpcUrl) {
        this.environment = environment;
        this.rpcUrl = rpcUrl;
        const { bidirectional } = (0, useEnv_1.useEnv)();
        this.pool = new workerPool_1.WorkerPool((0, workerPool_1.buildPaths)(bidirectional.pathPrefix, bidirectional.paths));
        this.jobs = new store_1.JobStore(bidirectional.maxJobs, bidirectional.retainedJobs);
        this.limiter = new rateLimiter_1.RateLimiter(bidirectional.maxRequestsPerMinute);
        this.client = (0, bidirectionalTx_1.createSepoliaClient)(rpcUrl);
    }
    solana() {
        return (0, initSolana_1.getSharedSolana)({
            contractAddress: contractAddresses[this.environment],
            environment: this.environment,
        });
    }
    /**
     * Derive every path's address once. A misconfigured root-key override shows
     * up here, at startup, as addresses that hold no gas — rather than as a
     * transaction that silently never mines half an hour later.
     */
    async ensureAddresses() {
        // The in-flight promise is memoized rather than a completion flag: a burst
        // of jobs at start would otherwise each run the whole derivation loop
        // before any of them finished setting the flag.
        this.addressesReady ??= (async () => {
            const { chainSigContract, keypair } = this.solana();
            for (const worker of this.pool.all()) {
                const address = await (0, derivation_1.deriveEthAddress)({
                    chainSigContract,
                    predecessor: keypair.publicKey.toString(),
                    path: worker.path,
                });
                this.pool.setAddress(worker.path, address);
            }
        })().catch(error => {
            // Not cached on failure, so a transient RPC error does not permanently
            // leave the pool without addresses.
            this.addressesReady = undefined;
            throw error;
        });
        return this.addressesReady;
    }
    async refreshBalances() {
        const { minBalanceWei } = (0, useEnv_1.useEnv)().bidirectional;
        for (const worker of this.pool.all()) {
            if (worker.address === '0x')
                continue;
            const balance = await this.client.getBalance({ address: worker.address });
            this.pool.setBalance(worker.path, balance, minBalanceWei);
        }
        await this.reconcileQuarantined();
    }
    /**
     * Release addresses whose outstanding transaction has resolved, either way.
     *
     * Run before every acquisition rather than only from the diagnostics
     * endpoint: a quarantine that only lifts when somebody happens to call
     * `/workers` would shrink the pool silently on an unattended run. Costs
     * nothing when nothing is quarantined.
     */
    async reconcileQuarantined() {
        for (const worker of this.pool.quarantined()) {
            const [latest, pending] = await Promise.all([
                this.client.getTransactionCount({
                    address: worker.address,
                    blockTag: 'latest',
                }),
                this.client.getTransactionCount({
                    address: worker.address,
                    blockTag: 'pending',
                }),
            ]);
            this.pool.reconcile(worker.path, pending > latest);
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
    /** Accepts a job and runs it in the background. */
    start(mode) {
        const job = this.jobs.create(this.environment, mode);
        void this.run(job).catch(error => {
            if (error instanceof workerPool_1.NoWorkerAvailableError) {
                // The pool already knows which of the two it was; collapsing them here
                // would leave the distinction only in the message text, where no
                // metric can group by it.
                this.jobs.fail(job.id, error.reason === 'all_underfunded'
                    ? 'all_workers_underfunded'
                    : 'all_workers_busy', error);
                return;
            }
            // Logged with its stack: `internal_error` means we did not anticipate
            // this, so swallowing the detail leaves nothing to debug from.
            console.error(`sign_bidirectional job ${job.id} failed:`, error);
            this.jobs.fail(job.id, 'internal_error', error);
        });
        return job;
    }
    async run(job) {
        const { bidirectional } = (0, useEnv_1.useEnv)();
        const { chainSigContract, provider, keypair } = this.solana();
        let worker;
        let leaseReleased = false;
        // Both event waits are registered before the transaction is broadcast, but
        // most failure paths return long before the respond leg would settle. Its
        // subscription and backfill timers would otherwise stay alive for the full
        // respond timeout — up to thirty-five minutes after the job is already
        // recorded as failed, and against the same RPC every other job is using.
        const watches = new AbortController();
        const releaseLease = () => {
            if (worker && !leaseReleased) {
                this.pool.release(worker.path);
                leaseReleased = true;
            }
        };
        try {
            await this.ensureAddresses();
            await this.reconcileQuarantined();
            // --- Steps 1-2: derive and preflight -------------------------------
            worker = this.pool.acquire();
            this.jobs.update(job.id, {
                path: worker.path,
                derivedAddress: worker.address,
                timings: { leaseAcquiredAt: Date.now() },
            });
            // Balance is read before the build, not after. `estimateGas` is
            // rejected outright by many nodes when the sender cannot cover the
            // transaction, so building first turns an unfunded address into an
            // unclassified error and leaves it at the head of the queue for the next
            // job to fail on identically.
            const balance = await this.client.getBalance({ address: worker.address });
            if (balance < bidirectional.minBalanceWei) {
                this.pool.setBalance(worker.path, balance, bidirectional.minBalanceWei);
                this.jobs.fail(job.id, 'preflight_underfunded', new Error(`${worker.address} holds ${balance} wei, below the ${bidirectional.minBalanceWei} minimum`));
                return;
            }
            let built;
            try {
                built = await (0, bidirectionalTx_1.buildTransaction)({
                    client: this.client,
                    mode: job.mode,
                    from: worker.address,
                    erc20Address: bidirectional.erc20Address,
                });
            }
            catch (error) {
                // A node refusing to estimate for lack of funds is a funding problem,
                // not an unanticipated one, and the address must leave the rotation.
                if (/insufficient funds/i.test(String(error))) {
                    this.pool.setBalance(worker.path, balance, balance + 1n);
                    this.jobs.fail(job.id, 'preflight_underfunded', error);
                    return;
                }
                throw error;
            }
            if (balance < built.gasCostWei) {
                // Measured against the gas this transaction actually needs. The static
                // minimum is what got us here — the address cleared it and still
                // cannot pay — so marking it against the minimum again would leave it
                // first in line to fail identically.
                this.pool.setBalance(worker.path, balance, built.gasCostWei);
                this.jobs.fail(job.id, 'preflight_underfunded', new Error(`${worker.address} holds ${balance} wei, needs ${built.gasCostWei} for gas`));
                return;
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
            const signer = new web3_js_1.PublicKey(contractAddresses[this.environment]);
            const signaturePromise = chainSigContract.waitForEvent({
                eventName: 'signatureRespondedEvent',
                requestId,
                signer,
                afterSignature: solanaTx,
                timeoutMs: bidirectional.signatureTimeoutMs,
                backfillIntervalMs: 15_000,
                healthCheckIntervalMs: 15_000,
                signal: watches.signal,
            });
            const respondPromise = chainSigContract.waitForEvent({
                eventName: 'respondBidirectionalEvent',
                requestId,
                signer,
                afterSignature: solanaTx,
                timeoutMs: bidirectional.respondTimeoutMs,
                backfillIntervalMs: 15_000,
                healthCheckIntervalMs: 15_000,
                signal: watches.signal,
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
                // A throw here does not prove the transaction was refused: the node may
                // have accepted it and lost the response. Treated like an unconfirmed
                // broadcast, since reusing the nonce on that assumption is the one
                // outcome that cannot be undone.
                this.pool.quarantine(worker.path, built.nonce);
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
                // Broadcast succeeded but the outcome is unknown. `latest` still
                // reports the old nonce while the transaction is pending, so handing
                // this address to another job would sign the same nonce twice.
                this.pool.quarantine(worker.path, built.nonce);
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
            this.jobs.update(job.id, {
                state: 'responded',
                timings: { finishedAt: Date.now() },
            });
        }
        finally {
            releaseLease();
            // No-op once both have settled; tears down the subscriptions otherwise.
            watches.abort();
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
