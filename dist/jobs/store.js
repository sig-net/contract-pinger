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
    jobs = new Map();
    constructor(maxJobs) {
        this.maxJobs = maxJobs;
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
