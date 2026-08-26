"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPaths = exports.WorkerPool = exports.NoWorkerAvailableError = void 0;
class NoWorkerAvailableError extends Error {
    reason;
    constructor(reason) {
        super(reason === 'all_busy'
            ? 'All derived addresses are mid-transaction; retry shortly.'
            : 'No derived address holds enough gas. Fund them or run a top-up sweep.');
        this.reason = reason;
        this.name = 'NoWorkerAvailableError';
    }
}
exports.NoWorkerAvailableError = NoWorkerAvailableError;
/**
 * A pool of derivation paths, each owning one Ethereum address.
 *
 * The pool exists because an Ethereum nonce is per-address and strictly
 * ordered. Two concurrent jobs on one path both read nonce N, both receive
 * valid signatures over different payloads, and the second broadcast is
 * rejected as underpriced — half an hour after the MPC work is finished.
 * Distinct paths give distinct addresses and therefore independent nonce
 * spaces.
 *
 * A lease covers only the window from reading the nonce to seeing the
 * transaction confirmed, *not* the respond wait. The nonce is consumed when
 * the transaction mines; the MPC's finality wait happens long after the
 * address is free to move on.
 */
class WorkerPool {
    workers;
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
        const candidate = this.workers.find(w => !w.busy && !w.underfunded);
        if (!candidate) {
            const anyIdle = this.workers.some(w => !w.busy);
            throw new NoWorkerAvailableError(anyIdle ? 'all_underfunded' : 'all_busy');
        }
        candidate.busy = true;
        candidate.leases += 1;
        candidate.lastLeasedAt = Date.now();
        return candidate;
    }
    release(path) {
        const worker = this.workers.find(w => w.path === path);
        if (worker)
            worker.busy = false;
    }
}
exports.WorkerPool = WorkerPool;
const buildPaths = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
exports.buildPaths = buildPaths;
