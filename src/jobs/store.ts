import { randomUUID } from 'crypto';
import type { Hex } from 'viem';
import type { TxMode } from '../utils/bidirectionalTx';

export type JobState =
  | 'pending'
  | 'sign_sent'
  | 'awaiting_signature'
  | 'verified'
  | 'broadcast'
  | 'confirmed'
  | 'responded'
  | 'failed';

/**
 * A signature timeout and a respond timeout are different diagnoses — the MPC
 * stopped signing, versus the MPC stopped reading results back — so they never
 * collapse into one bucket.
 */
export type FailureReason =
  // Three distinct operational causes, deliberately not merged. Every address
  // is leased means the arrival rate outran the pool; every address is below
  // the minimum means the wallets need topping up; and the preflight case is
  // narrower still — the leased address cleared the minimum but cannot cover
  // this transaction's gas at the current price.
  | 'all_workers_busy'
  | 'all_workers_underfunded'
  | 'preflight_underfunded'
  | 'signature_timeout'
  | 'derivation_mismatch'
  | 'broadcast_failed'
  | 'confirmation_timeout'
  | 'transaction_reverted'
  | 'respond_timeout'
  | 'respond_mismatch'
  | 'internal_error';

export interface JobTimings {
  acceptedAt: number;
  leaseAcquiredAt?: number;
  signSentAt?: number;
  signatureAt?: number;
  broadcastAt?: number;
  confirmedAt?: number;
  respondedAt?: number;
  finishedAt?: number;
}

export interface JobRecord {
  id: string;
  environment: string;
  mode: TxMode;
  state: JobState;
  path?: string;
  derivedAddress?: Hex;
  requestId?: string;
  solanaTx?: string;
  ethTxHash?: Hex;
  nonce?: number;
  serializedOutput?: string;
  failureReason?: FailureReason;
  error?: string;
  timings: JobTimings;
}

export type JobPatch = Partial<Omit<JobRecord, 'timings'>> & {
  timings?: Partial<JobTimings>;
};

export interface JobView extends Omit<JobRecord, 'timings'> {
  timings: JobTimings;
  durations: Record<string, number>;
}

const durationsFor = (t: JobTimings): Record<string, number> => {
  const span = (from?: number, to?: number) =>
    from !== undefined && to !== undefined ? to - from : undefined;

  const entries: [string, number | undefined][] = [
    ['leaseWaitMs', span(t.acceptedAt, t.leaseAcquiredAt)],
    ['signatureMs', span(t.signSentAt, t.signatureAt)],
    ['confirmationMs', span(t.broadcastAt, t.confirmedAt)],
    ['respondMs', span(t.confirmedAt, t.respondedAt)],
    ['totalMs', span(t.acceptedAt, t.finishedAt)],
  ];

  return Object.fromEntries(
    entries.filter((e): e is [string, number] => e[1] !== undefined)
  );
};

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();

  constructor(private readonly maxJobs: number) {}

  get activeCount(): number {
    let active = 0;
    for (const job of this.jobs.values()) {
      if (job.state !== 'responded' && job.state !== 'failed') active += 1;
    }
    return active;
  }

  atCapacity(): boolean {
    return this.activeCount >= this.maxJobs;
  }

  create(environment: string, mode: TxMode): JobRecord {
    const job: JobRecord = {
      id: randomUUID(),
      environment,
      mode,
      state: 'pending',
      timings: { acceptedAt: Date.now() },
    };
    this.jobs.set(job.id, job);
    return job;
  }

  view(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    return { ...job, durations: durationsFor(job.timings) };
  }

  all(): readonly JobRecord[] {
    return [...this.jobs.values()];
  }

  update(id: string, patch: JobPatch): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const { timings, ...rest } = patch;
    Object.assign(job, rest);
    if (timings) job.timings = { ...job.timings, ...timings };
  }

  fail(id: string, reason: FailureReason, error: unknown): void {
    this.update(id, {
      state: 'failed',
      failureReason: reason,
      error: error instanceof Error ? error.message : String(error),
      timings: { finishedAt: Date.now() },
    });
  }
}
