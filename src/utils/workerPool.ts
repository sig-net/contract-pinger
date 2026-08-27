import type { Hex } from 'viem';

export interface Worker {
  path: string;
  address: Hex;
  busy: boolean;
  /** Set when the last balance check found too little gas to run a job. */
  underfunded: boolean;
  /**
   * Nonce of a transaction that was broadcast but never seen confirmed. While
   * this is set the address is withheld: its next nonce is not knowable, since
   * `latest` still reports the old one while the transaction is pending, and
   * handing it out would produce a second signature over the same nonce.
   */
  pendingNonce?: number;
  balanceWei: bigint;
  leases: number;
  lastLeasedAt?: number;
}

export class NoWorkerAvailableError extends Error {
  constructor(readonly reason: 'all_busy' | 'all_underfunded') {
    super(
      reason === 'all_busy'
        ? 'All derived addresses are mid-transaction or awaiting nonce reconciliation; retry shortly.'
        : 'No derived address holds enough gas. Fund them or run a top-up sweep.'
    );
    this.name = 'NoWorkerAvailableError';
  }
}

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
export class WorkerPool {
  private readonly workers: Worker[];

  constructor(paths: string[]) {
    this.workers = paths.map(path => ({
      path,
      address: '0x' as Hex,
      busy: false,
      underfunded: false,
      balanceWei: 0n,
      leases: 0,
    }));
  }

  get size(): number {
    return this.workers.length;
  }

  all(): readonly Worker[] {
    return this.workers;
  }

  setAddress(path: string, address: Hex): void {
    const worker = this.workers.find(w => w.path === path);
    if (worker) worker.address = address;
  }

  setBalance(path: string, balanceWei: bigint, minBalanceWei: bigint): void {
    const worker = this.workers.find(w => w.path === path);
    if (!worker) return;
    worker.balanceWei = balanceWei;
    worker.underfunded = balanceWei < minBalanceWei;
  }

  /**
   * Take an idle, funded worker. Underfunded workers are skipped rather than
   * handed out so a job fails in seconds with a balance error instead of
   * spending an MPC round trip to discover it cannot broadcast.
   */
  acquire(): Worker {
    const candidate = this.workers.find(
      w => !w.busy && !w.underfunded && w.pendingNonce === undefined
    );
    if (!candidate) {
      const anyIdle = this.workers.some(
        w => !w.busy && w.pendingNonce === undefined
      );
      throw new NoWorkerAvailableError(
        anyIdle ? 'all_underfunded' : 'all_busy'
      );
    }
    candidate.busy = true;
    candidate.leases += 1;
    candidate.lastLeasedAt = Date.now();
    return candidate;
  }

  release(path: string): void {
    const worker = this.workers.find(w => w.path === path);
    if (worker) worker.busy = false;
  }

  /**
   * Withhold an address whose broadcast transaction was never seen confirmed.
   */
  quarantine(path: string, nonce: number): void {
    const worker = this.workers.find(w => w.path === path);
    if (worker) worker.pendingNonce = nonce;
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
  reconcile(path: string, hasOutstanding: boolean): void {
    const worker = this.workers.find(w => w.path === path);
    if (worker?.pendingNonce !== undefined && !hasOutstanding) {
      worker.pendingNonce = undefined;
    }
  }

  quarantined(): readonly Worker[] {
    return this.workers.filter(w => w.pendingNonce !== undefined);
  }
}

export const buildPaths = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
