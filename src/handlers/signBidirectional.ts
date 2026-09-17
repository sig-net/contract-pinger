import type { Hex, PublicClient } from 'viem';
import {
  buildTransaction,
  attachSignature,
  createEthereumClient,
  ETHEREUM_TARGETS,
  EXPECTED_SERIALIZED_OUTPUT,
  type TxMode,
  type BidirectionalEnvironment,
} from '../utils/bidirectionalTx';
import { assertDerivedSender } from '../utils/derivation';
import { createSolanaSource } from '../utils/solanaSource';
import {
  isSourceEnvironment,
  type BidirectionalSource,
  type SourceChain,
} from '../utils/bidirectionalSource';
import { env } from '../utils/env';
import {
  buildPaths,
  NoWorkerAvailableError,
  WorkerPool,
  type Worker,
} from '../utils/workerPool';
import { RateLimiter } from '../utils/rateLimiter';
import { JobStore, type JobRecord } from '../jobs/store';

/** Raised at a phase boundary when the process is shutting down. */
class ShutdownError extends Error {
  constructor() {
    super('Process is shutting down; job abandoned before it could proceed');
    this.name = 'ShutdownError';
  }
}

export class BidirectionalService {
  readonly pool: WorkerPool;
  readonly jobs: JobStore;
  readonly limiter: RateLimiter;
  private readonly client: PublicClient;
  private addressesReady?: Promise<void>;
  private sourceReady?: Promise<BidirectionalSource>;
  readonly maxActiveJobs: number;
  readonly maxAwaitingRespond: number;
  readonly maxRequestsPerMinute: number;

  constructor(
    readonly environment: BidirectionalEnvironment,
    rpcUrl: string,
    readonly sourceChain: SourceChain = 'solana'
  ) {
    if (!isSourceEnvironment(sourceChain, environment)) {
      throw new Error(
        `Unsupported source/environment: ${sourceChain}/${environment}`
      );
    }
    const { bidirectional } = env;
    // Mainnet settles on real Ethereum, so its limits are fixed here rather
    // than read from configuration: one address, one job a minute. It exists
    // to answer whether signing and responding still work, and a setting meant
    // for a testnet load run must not be able to point volume at it.
    const isMainnet = environment === 'mainnet';
    const serialized = isMainnet || sourceChain === 'midnight';
    this.maxActiveJobs = serialized ? 1 : bidirectional.maxActiveJobs;
    this.maxAwaitingRespond = isMainnet ? 2 : bidirectional.maxJobs;
    this.maxRequestsPerMinute = serialized
      ? 1
      : bidirectional.maxRequestsPerMinute;
    this.pool = new WorkerPool(
      buildPaths(bidirectional.pathPrefix, serialized ? 1 : bidirectional.paths)
    );
    this.jobs = new JobStore(
      this.maxAwaitingRespond,
      bidirectional.retainedJobs,
      this.maxActiveJobs
    );
    this.limiter = new RateLimiter(this.maxRequestsPerMinute);
    this.client = createEthereumClient(environment, rpcUrl);
  }

  private source(): Promise<BidirectionalSource> {
    this.sourceReady ??= (
      this.sourceChain === 'solana'
        ? Promise.resolve(
            createSolanaSource(
              this.environment as 'dev' | 'testnet' | 'mainnet'
            )
          )
        : import('../midnight/source.mjs').then(m =>
            m.createMidnightSource(this.environment, this.client)
          )
    ).catch(error => {
      this.sourceReady = undefined;
      throw error;
    });
    return this.sourceReady;
  }

  async assertReady(): Promise<void> {
    // An active job owns its pending request; capacity still blocks another job.
    if (this.jobs.activeCount > 0) return;
    await (await this.source()).assertReady?.();
  }

  async close(): Promise<void> {
    if (this.sourceReady) await (await this.sourceReady).close?.();
  }

  /**
   * Derive every path's address once. A misconfigured root-key override shows
   * up here, at startup, as addresses that hold no gas — rather than as a
   * transaction that silently never mines half an hour later.
   */
  async ensureAddresses(): Promise<void> {
    // Recovery state can change after addresses have been derived and cached.
    await this.assertReady();
    // The in-flight promise is memoized rather than a completion flag: a burst
    // of jobs at start would otherwise each run the whole derivation loop
    // before any of them finished setting the flag.
    this.addressesReady ??= (async () => {
      const derived = await (
        await this.source()
      ).deriveWorkers(
        this.client,
        this.pool.all().map(w => w.path)
      );
      for (const { path, address } of derived) {
        this.pool.setAddress(path, address);
      }
    })().catch(error => {
      // Not cached on failure, so a transient RPC error does not permanently
      // leave the pool without addresses.
      this.addressesReady = undefined;
      throw error;
    });
    return this.addressesReady;
  }

  async refreshBalances(): Promise<void> {
    const { minBalanceWei } = env.bidirectional;
    for (const worker of this.pool.all()) {
      if (worker.address === ('0x' as Hex)) continue;
      const balance = await this.client.getBalance({ address: worker.address });
      this.pool.setBalance(worker.path, balance, minBalanceWei);
    }
    await this.reconcileQuarantined();
  }

  /**
   * Re-read the balance of any address currently held back as underfunded.
   *
   * Nothing inside the service tops these up any more, and an underfunded
   * worker is never acquired, so its balance would never be looked at again —
   * the pool would shed an address permanently on each low-balance event and
   * end up reporting all_workers_underfunded against a pool the funding
   * workflow had already refilled. Costs nothing while none are short.
   */
  private async refreshUnderfunded(): Promise<void> {
    const { minBalanceWei } = env.bidirectional;
    for (const worker of this.pool.all()) {
      if (!worker.underfunded || worker.address === ('0x' as Hex)) continue;
      const balance = await this.client.getBalance({ address: worker.address });
      this.pool.setBalance(worker.path, balance, minBalanceWei);
    }
  }

  /**
   * Release addresses whose outstanding transaction has resolved, either way.
   *
   * Run before every acquisition rather than only from the diagnostics
   * endpoint: a quarantine that only lifts when somebody happens to call
   * `/workers` would shrink the pool silently on an unattended run. Costs
   * nothing when nothing is quarantined.
   */
  private async reconcileQuarantined(): Promise<void> {
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

  /** Accepts a job and runs it in the background. */
  start(mode: TxMode): JobRecord {
    const job = this.jobs.create(this.environment, mode, this.sourceChain);
    void this.run(job).catch(error => {
      if (error instanceof ShutdownError) {
        this.jobs.fail(job.id, 'shutdown', error);
        return;
      }
      if (error instanceof NoWorkerAvailableError) {
        // The pool already knows which of the two it was; collapsing them here
        // would leave the distinction only in the message text, where no
        // metric can group by it.
        this.jobs.fail(
          job.id,
          error.reason === 'all_underfunded'
            ? 'all_workers_underfunded'
            : 'all_workers_busy',
          error
        );
        return;
      }
      // Logged with its stack: `internal_error` means we did not anticipate
      // this, so swallowing the detail leaves nothing to debug from.
      console.error(`sign_bidirectional job ${job.id} failed:`, error);
      this.jobs.fail(job.id, 'internal_error', error);
    });
    return job;
  }

  private async run(job: JobRecord): Promise<void> {
    const { bidirectional } = env;
    let worker: Worker | undefined;
    let leaseReleased = false;
    // Both event waits are registered before the transaction is broadcast, but
    // most failure paths return long before the respond leg would settle. Its
    // subscription and backfill timers would otherwise stay alive for the full
    // respond timeout — up to thirty-five minutes after the job is already
    // recorded as failed, and against the same RPC every other job is using.
    const watches = new AbortController();
    activeJobs.add(watches);

    // The controller's signal only reaches the event waits, which are created
    // well into the run. Shutdown arriving during derivation, the preflight, or
    // the source send would otherwise be ignored, and those RPC calls keep the
    // process alive past its grace period. Checked between phases instead:
    // in-flight requests cannot be cancelled, but no further work starts.
    const abortIfShuttingDown = () => {
      if (
        watches.signal.aborted &&
        watches.signal.reason instanceof ShutdownError
      ) {
        throw new ShutdownError();
      }
    };

    const releaseLease = () => {
      if (worker && !leaseReleased) {
        this.pool.release(worker.path);
        leaseReleased = true;
      }
    };

    try {
      await this.ensureAddresses();
      await this.reconcileQuarantined();
      await this.refreshUnderfunded();

      // --- Steps 1-2: derive and preflight -------------------------------
      abortIfShuttingDown(); // before taking an address
      worker = await this.pool.acquireWithin(bidirectional.leaseWaitMs);
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
        this.jobs.fail(
          job.id,
          'preflight_underfunded',
          new Error(
            `${worker.address} holds ${balance} wei, below the ${bidirectional.minBalanceWei} minimum`
          )
        );
        return;
      }

      abortIfShuttingDown(); // before building the transaction
      let built;
      try {
        built = await buildTransaction({
          client: this.client,
          environment: this.environment,
          mode: job.mode,
          from: worker.address,
          erc20Address: (bidirectional.erc20Address ||
            ETHEREUM_TARGETS[this.environment].erc20) as Hex,
        });
      } catch (error) {
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
        this.jobs.fail(
          job.id,
          'preflight_underfunded',
          new Error(
            `${worker.address} holds ${balance} wei, needs ${built.gasCostWei} for gas`
          )
        );
        return;
      }

      abortIfShuttingDown();
      this.jobs.update(job.id, { nonce: built.nonce });
      const submitted = await (
        await this.source()
      ).submit({
        built,
        worker,
        signal: watches.signal,
        onProgress: progress => {
          // A timeout ends the job's wait, not an accepted source operation.
          // Late identifiers enrich the terminal record without reviving it.
          this.jobs.update(job.id, {
            ...(progress.requestId !== undefined
              ? { requestId: progress.requestId }
              : {}),
            ...(progress.sourceTx !== undefined
              ? { sourceTx: progress.sourceTx }
              : {}),
            ...(progress.nonce !== undefined ? { nonce: progress.nonce } : {}),
          });
        },
        signatureTimeoutMs: bidirectional.signatureTimeoutMs,
        responseTimeoutMs:
          bidirectional.signatureTimeoutMs +
          bidirectional.ethConfirmTimeoutMs +
          bidirectional.respondTimeoutMs,
      });
      const signaturePromise = submitted.signature;
      const respondPromise = submitted.response;
      signaturePromise.catch(() => undefined);
      respondPromise.catch(() => undefined);
      this.jobs.update(job.id, {
        requestId: submitted.requestId,
        nonce: built.nonce,
        sourceTx: submitted.sourceTx,
        ...(this.sourceChain === 'solana'
          ? { solanaTx: submitted.sourceTx }
          : {}),
        state: 'sign_sent',
        timings: { signSentAt: Date.now() },
      });
      abortIfShuttingDown();

      this.jobs.update(job.id, { state: 'awaiting_signature' });

      let rsv;
      try {
        rsv = await signaturePromise;
        abortIfShuttingDown();
      } catch (error) {
        abortIfShuttingDown();
        this.jobs.fail(job.id, 'signature_timeout', error);
        return;
      }
      this.jobs.update(job.id, { timings: { signatureAt: Date.now() } });

      // --- Step 7: verify derivation --------------------------------------
      const signed = await attachSignature({
        unsigned: built.unsigned,
        signature: rsv,
      });
      try {
        assertDerivedSender(worker.address, signed.recoveredFrom);
      } catch (error) {
        this.jobs.fail(job.id, 'derivation_mismatch', error);
        return;
      }
      this.jobs.update(job.id, { state: 'verified' });

      // --- Step 8: broadcast and confirm ----------------------------------
      abortIfShuttingDown();
      let ethTxHash: Hex;
      try {
        ethTxHash = await this.client.sendRawTransaction({
          serializedTransaction: signed.serialized,
        });
      } catch (error) {
        // A throw here does not prove the transaction was refused: the node may
        // have accepted it and lost the response. Treated like an unconfirmed
        // broadcast, since reusing the nonce on that assumption is the one
        // outcome that cannot be undone.
        this.pool.quarantine(worker.path, built.nonce);
        abortIfShuttingDown();
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
      } catch (error) {
        // Broadcast succeeded but the outcome is unknown. `latest` still
        // reports the old nonce while the transaction is pending, so handing
        // this address to another job would sign the same nonce twice.
        this.pool.quarantine(worker.path, built.nonce);
        abortIfShuttingDown();
        this.jobs.fail(job.id, 'confirmation_timeout', error);
        return;
      }

      abortIfShuttingDown();
      if (receipt.status !== 'success') {
        this.jobs.fail(
          job.id,
          'transaction_reverted',
          new Error(`Transaction ${ethTxHash} reverted`)
        );
        return;
      }

      this.jobs.update(job.id, {
        state: 'confirmed',
        timings: { confirmedAt: Date.now() },
      });

      // Solana can reuse the spent nonce during finality. Midnight retains
      // the lease until settlement because its caller and wallet are shared.
      if (this.sourceChain === 'solana') releaseLease();

      // The respond budget runs from here, not from registration. Aborting is
      // safe: the signature wait has already settled, so only the respond
      // watcher is still listening.
      const respondDeadline = setTimeout(
        () =>
          // Aborting with a reason: signet.js rejects with `signal.reason`, so
          // without one the job records "This operation was aborted", which
          // says nothing about which of the three waits gave up or when.
          watches.abort(
            new Error(
              `respondBidirectionalEvent not received within ` +
                `${bidirectional.respondTimeoutMs}ms of confirmation`
            )
          ),
        bidirectional.respondTimeoutMs
      );
      respondDeadline.unref?.();

      // --- Steps 9-10: respond and verify ---------------------------------
      let respond;
      try {
        respond = await respondPromise;
        abortIfShuttingDown();
      } catch (error) {
        abortIfShuttingDown();
        this.jobs.fail(job.id, 'respond_timeout', error);
        return;
      } finally {
        clearTimeout(respondDeadline);
      }

      const serializedOutput = respond;
      this.jobs.update(job.id, {
        serializedOutput,
        timings: { respondedAt: Date.now() },
      });

      if (serializedOutput !== EXPECTED_SERIALIZED_OUTPUT) {
        this.jobs.fail(
          job.id,
          'respond_mismatch',
          new Error(
            `Expected ${EXPECTED_SERIALIZED_OUTPUT}, got ${serializedOutput}`
          )
        );
        return;
      }

      this.jobs.update(job.id, {
        state: 'responded',
        timings: { finishedAt: Date.now() },
      });
    } catch (error) {
      abortIfShuttingDown();
      throw error;
    } finally {
      releaseLease();
      // No-op once both have settled; tears down the subscriptions otherwise.
      watches.abort();
      activeJobs.delete(watches);
    }
  }
}

/**
 * Every in-flight job's watches, so shutdown can stop them.
 *
 * Jobs are detached from the request that started them and hold subscriptions
 * and timers for as long as their budgets allow. Closing the HTTP listener
 * alone leaves those alive, and the process stays up until the orchestrator
 * loses patience and kills it.
 */
const activeJobs = new Set<AbortController>();

/** Abandon every in-flight job. Their records stay, marked failed. */
export const abortActiveJobs = (): number => {
  const count = activeJobs.size;
  for (const controller of activeJobs) controller.abort(new ShutdownError());
  activeJobs.clear();
  // Jobs parked waiting for an address would otherwise sit until their wait
  // expired, holding the process open past its grace period.
  for (const service of services.values()) {
    service.pool.rejectWaiters(new Error('Process is shutting down'));
  }
  return count;
};

const services = new Map<string, BidirectionalService>();

export const getService = (
  environment: BidirectionalEnvironment,
  rpcUrl: string,
  sourceChain: SourceChain = 'solana'
): BidirectionalService => {
  const key = `${sourceChain}:${environment}`;
  const existing = services.get(key);
  if (existing) return existing;
  const service = new BidirectionalService(environment, rpcUrl, sourceChain);
  services.set(key, service);
  return service;
};

export const listServices = (): readonly BidirectionalService[] => [
  ...services.values(),
];
