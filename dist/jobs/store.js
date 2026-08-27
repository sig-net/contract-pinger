"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobStore = void 0;
const crypto_1 = require("crypto");
const durationsFor = (t) => {
    const span = (from, to) => from !== undefined && to !== undefined ? to - from : undefined;
    const entries = [
        ['leaseWaitMs', span(t.acceptedAt, t.leaseAcquiredAt)],
        ['signatureMs', span(t.signSentAt, t.signatureAt)],
        ['confirmationMs', span(t.broadcastAt, t.confirmedAt)],
        ['respondMs', span(t.confirmedAt, t.respondedAt)],
        ['totalMs', span(t.acceptedAt, t.finishedAt)],
    ];
    return Object.fromEntries(entries.filter((e) => e[1] !== undefined));
};
class JobStore {
    maxJobs;
    retained;
    maxActiveJobs;
    jobs = new Map();
    /**
     * @param maxActiveJobs jobs holding an address and doing chain work
     * @param maxJobs   jobs awaiting the MPC's respond after confirmation
     * @param retained  finished jobs kept for inspection and aggregates. Without
     *                  a bound the map grows for the life of the process, and
     *                  `/stats` sorts across every job ever recorded, so both
     *                  memory and that endpoint degrade steadily on a
     *                  long-running instance.
     */
    constructor(maxJobs, retained = 1000, maxActiveJobs = 20) {
        this.maxJobs = maxJobs;
        this.retained = retained;
        this.maxActiveJobs = maxActiveJobs;
    }
    /** Drops the oldest finished jobs once more than `retained` have piled up. */
    prune() {
        const finished = [...this.jobs.values()].filter(j => j.state === 'responded' || j.state === 'failed');
        if (finished.length <= this.retained)
            return;
        finished
            .sort((a, b) => (a.timings.finishedAt ?? 0) - (b.timings.finishedAt ?? 0))
            .slice(0, finished.length - this.retained)
            .forEach(j => this.jobs.delete(j.id));
    }
    /**
     * Jobs holding an address and doing chain work.
     *
     * Counted apart from the finality wait because they are bounded by different
     * things. Everything up to `confirmed` holds an address lease and a stream of
     * RPC calls for about a minute; `confirmed` holds nothing but an event
     * subscription, for half an hour. Lumping them lets the cheap ones — which
     * vastly outnumber the others — crowd out the expensive ones, so a single cap
     * of N means a sustainable rate of N over the respond budget rather than
     * anything to do with how many addresses exist.
     */
    get activeCount() {
        let active = 0;
        for (const job of this.jobs.values()) {
            if (job.state !== 'responded' &&
                job.state !== 'failed' &&
                job.state !== 'confirmed') {
                active += 1;
            }
        }
        return active;
    }
    /** Jobs whose transaction is buried and which only await the MPC's respond. */
    get awaitingRespondCount() {
        let waiting = 0;
        for (const job of this.jobs.values()) {
            if (job.state === 'confirmed')
                waiting += 1;
        }
        return waiting;
    }
    get liveCount() {
        return this.activeCount + this.awaitingRespondCount;
    }
    /**
     * Which ceiling, if either, is reached. The distinction is the point: an
     * active rejection says add addresses or slow arrivals, a respond rejection
     * says the RPC's subscription ceiling is the limit and a shared dispatcher
     * is what would raise it.
     */
    atCapacity() {
        if (this.activeCount >= this.maxActiveJobs)
            return 'active';
        if (this.awaitingRespondCount >= this.maxJobs)
            return 'awaiting_respond';
        return null;
    }
    create(environment, mode) {
        const job = {
            id: (0, crypto_1.randomUUID)(),
            environment,
            mode,
            state: 'pending',
            timings: { acceptedAt: Date.now() },
        };
        this.jobs.set(job.id, job);
        this.prune();
        return job;
    }
    view(id) {
        const job = this.jobs.get(id);
        if (!job)
            return undefined;
        return { ...job, durations: durationsFor(job.timings) };
    }
    all() {
        return [...this.jobs.values()];
    }
    update(id, patch) {
        const job = this.jobs.get(id);
        if (!job)
            return;
        const { timings, ...rest } = patch;
        Object.assign(job, rest);
        if (timings)
            job.timings = { ...job.timings, ...timings };
        // Also pruned here, not only on create: a batch that finishes after the
        // last job was submitted would otherwise hold every record until the next
        // request arrived, leaving /stats reporting well outside its window.
        if (job.state === 'responded' || job.state === 'failed')
            this.prune();
    }
    fail(id, reason, error) {
        this.update(id, {
            state: 'failed',
            failureReason: reason,
            error: error instanceof Error ? error.message : String(error),
            timings: { finishedAt: Date.now() },
        });
    }
}
exports.JobStore = JobStore;
