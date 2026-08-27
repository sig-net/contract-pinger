"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPaths = exports.WorkerPool = exports.NoWorkerAvailableError = void 0;
class NoWorkerAvailableError extends Error {
    reason;
    constructor(reason) {
        super(reason === 'all_busy'
            ? 'All derived addresses are mid-transaction or awaiting nonce reconciliation; retry shortly.'
            : 'No derived address holds enough gas. Fund them or run a top-up sweep.');
        this.reason = reason;
        this.name = 'NoWorkerAvailableError';
    }
}
exports.NoWorkerAvailableError = NoWorkerAvailableError;
class WorkerPool {
    workers;
    waiters = [];
    constructor(paths) {
        this.workers = paths.map(path => ({
            path,
            address: '0x',
            busy: false,
            underfunded: false,
            balanceWei: 0n,
            leases: 0,
        }));
    }
    get size() {
        return this.workers.length;
    }
    all() {
        return this.workers;
    }
    setAddress(path, address) {
        const worker = this.workers.find(w => w.path === path);
        if (worker)
            worker.address = address;
    }
    setBalance(path, balanceWei, minBalanceWei) {
        const worker = this.workers.find(w => w.path === path);
        if (!worker)
            return;
        worker.balanceWei = balanceWei;
        worker.underfunded = balanceWei < minBalanceWei;
    }
    /**
     * Take an idle, funded worker. Underfunded workers are skipped rather than
     * handed out so a job fails in seconds with a balance error instead of
     * spending an MPC round trip to discover it cannot broadcast.
     */
    acquire() {
        const candidate = this.workers.find(w => !w.busy && !w.underfunded && w.pendingNonce === undefined);
        if (!candidate) {
            const anyIdle = this.workers.some(w => !w.busy && w.pendingNonce === undefined);
            throw new NoWorkerAvailableError(anyIdle ? 'all_underfunded' : 'all_busy');
        }
        candidate.busy = true;
        candidate.leases += 1;
        candidate.lastLeasedAt = Date.now();
        return candidate;
    }
    /**
     * Wait for a free address rather than failing the moment none is idle.
     *
     * A lease lasts about as long as signing plus two confirmations, so a burst
     * arriving while the previous one is still settling would otherwise fail
     * outright — pool pressure as a cliff rather than a queue. Waiting turns it
     * into lease-wait latency, which is measurable and tells you when to add
     * addresses.
     *
     * Only `all_busy` waits. An empty wallet is not resolved by patience, so
     * `all_underfunded` still fails immediately.
     */
    acquireWithin(timeoutMs) {
        try {
            return Promise.resolve(this.acquire());
        }
        catch (error) {
            if (!(error instanceof NoWorkerAvailableError) ||
                error.reason !== 'all_busy') {
                return Promise.reject(error);
            }
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const i = this.waiters.indexOf(waiter);
                if (i >= 0)
                    this.waiters.splice(i, 1);
                reject(new NoWorkerAvailableError('all_busy'));
            }, timeoutMs);
            const waiter = {
                resolve: worker => {
                    clearTimeout(timer);
                    resolve(worker);
                },
                reject: error => {
                    clearTimeout(timer);
                    reject(error);
                },
            };
            this.waiters.push(waiter);
        });
    }
    release(path) {
        const worker = this.workers.find(w => w.path === path);
        if (worker)
            worker.busy = false;
        this.handOff();
    }
    /**
     * Give freed addresses to anyone waiting, before a new arrival can take one.
     */
    handOff() {
        while (this.waiters.length > 0) {
            let worker;
            try {
                worker = this.acquire();
            }
            catch {
                return; // nothing available; the waiters stay queued
            }
            this.waiters.shift().resolve(worker);
        }
    }
    /** Abandon anyone still waiting — used when the process is shutting down. */
    rejectWaiters(error) {
        while (this.waiters.length > 0)
            this.waiters.shift().reject(error);
    }
    get waiting() {
        return this.waiters.length;
    }
    /**
     * Withhold an address whose broadcast transaction was never seen confirmed.
     */
    quarantine(path, nonce) {
        const worker = this.workers.find(w => w.path === path);
        if (worker)
            worker.pendingNonce = nonce;
    }
    /**
     * Return a quarantined address to service once nothing is outstanding from
     * it.
     *
     * Keyed on whether the account has any unmined transaction, not on the nonce
     * advancing: a dropped transaction leaves `latest` exactly where it was, so a
     * nonce comparison alone would quarantine that address forever. Comparing the
     * pending and latest counts covers both endings — mined moves both forward,
     * dropped leaves both equal, and only a still-pending transaction keeps them
     * apart.
     */
    reconcile(path, hasOutstanding) {
        const worker = this.workers.find(w => w.path === path);
        if (worker?.pendingNonce !== undefined && !hasOutstanding) {
            worker.pendingNonce = undefined;
        }
    }
    quarantined() {
        return this.workers.filter(w => w.pendingNonce !== undefined);
    }
}
exports.WorkerPool = WorkerPool;
const buildPaths = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
exports.buildPaths = buildPaths;
