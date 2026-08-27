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
    jobs = new Map();
    /**
     * @param maxJobs   concurrent unfinished jobs allowed
     * @param retained  finished jobs kept for inspection and aggregates. Without
     *                  a bound the map grows for the life of the process, and
     *                  `/stats` sorts across every job ever recorded, so both
     *                  memory and that endpoint degrade steadily on a
     *                  long-running instance.
     */
    constructor(maxJobs, retained = 1000) {
        this.maxJobs = maxJobs;
        this.retained = retained;
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
    get activeCount() {
        let active = 0;
        for (const job of this.jobs.values()) {
            if (job.state !== 'responded' && job.state !== 'failed')
                active += 1;
        }
        return active;
    }
    atCapacity() {
        return this.activeCount >= this.maxJobs;
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
