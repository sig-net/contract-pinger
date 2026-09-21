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
import { JobStore, type JobRecord, type FailureReason } from '../jobs/store';

/** Raised at a phase boundary when the process is shutting down. */
class ShutdownError extends Error {
  constructor() {
    super('Process is shutting down; job abandoned before it could proceed');
    this.name = 'ShutdownError';
  }
}

/** Carry the existing failure reason without discarding the provider's diagnostic. */
class JobFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    readonly cause: unknown
  ) {
    super('Expected bidirectional job failure');
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
    // Mainnet and Midnight traffic caps cannot be raised by load-test settings.
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

  async ensureAddresses(): Promise<void> {
    // Recovery state can change after addresses have been derived and cached.
    await this.assertReady();
    // Share in-flight derivation across jobs; retry if it fails.
    this.addressesReady ??= (async () => {
      const source = await this.source();
      const derived = await source.deriveWorkers(
        this.client,
        this.pool.all().map(w => w.path)
      );
      for (const { path, address } of derived) {
        this.pool.setAddress(path, address);
      }
    })().catch(error => {
      this.addressesReady = undefined;
      throw error;
    });
    return this.addressesReady;
  }

  async refreshBalances(): Promise<void> {
    await this.updateBalances();
    await this.reconcileQuarantined();
  }

  private async updateBalances(onlyUnderfunded = false): Promise<void> {
    const { minBalanceWei } = env.bidirectional;
    for (const worker of this.pool.all()) {
      if (worker.address === '0x' || (onlyUnderfunded && !worker.underfunded))
        continue;
      const balance = await this.client.getBalance({ address: worker.address });
      this.pool.setBalance(worker.path, balance, minBalanceWei);
    }
  }

  /** Resolve quarantined nonces before acquisition as well as worker diagnostics. */
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
    void this.run(job).catch(error => this.recordFailure(job, error));
    return job;
  }

  private recordFailure(job: JobRecord, error: unknown): void {
    let reason: FailureReason = 'internal_error';
    if (error instanceof JobFailure) {
      reason = error.reason;
      error = error.cause;
    } else if (error instanceof ShutdownError) {
      reason = 'shutdown';
    } else if (error instanceof NoWorkerAvailableError) {
      reason =
        error.reason === 'all_underfunded'
          ? 'all_workers_underfunded'
          : 'all_workers_busy';
    } else {
      console.error(`sign_bidirectional job ${job.id} failed:`, error);
    }
    this.jobs.fail(job.id, reason, error);
  }

  private async prepareTransaction(
    worker: Worker,
    mode: TxMode,
    checkShutdown: () => void
  ) {
    const { bidirectional } = env;
    // Check funds first: estimateGas may reject an unfunded sender outright.
    const balance = await this.client.getBalance({ address: worker.address });
    const underfunded = (minimum: bigint, error: unknown): never => {
      this.pool.setBalance(worker.path, balance, minimum);
      throw new JobFailure('preflight_underfunded', error);
    };
    if (balance < bidirectional.minBalanceWei) {
      underfunded(
        bidirectional.minBalanceWei,
        new Error(
          `${worker.address} holds ${balance} wei, below the ${bidirectional.minBalanceWei} minimum`
        )
      );
    }

    checkShutdown();
    let built;
    try {
      built = await buildTransaction({
        client: this.client,
        environment: this.environment,
        mode,
        from: worker.address,
        erc20Address: (bidirectional.erc20Address ||
          ETHEREUM_TARGETS[this.environment].erc20) as Hex,
      });
    } catch (error) {
      // Exclude the address until funding recovers.
      if (/insufficient funds/i.test(String(error))) {
        underfunded(balance + 1n, error);
      }
      throw error;
    }

    if (balance < built.gasCostWei) {
      // Mark underfunded using actual gas cost, even if the static minimum is met.
      underfunded(
        built.gasCostWei,
        new Error(
          `${worker.address} holds ${balance} wei, needs ${built.gasCostWei} for gas`
        )
      );
    }

    return built;
  }

  private async run(job: JobRecord): Promise<void> {
    const { bidirectional } = env;
    let releaseLease = () => {};
    let respondDeadline: ReturnType<typeof setTimeout> | undefined;
    // Stop both event waits when any phase fails or the process shuts down.
    const watches = new AbortController();
    activeJobs.add(watches);

    // Some RPCs cannot be cancelled; check shutdown before starting the next phase.
    const abortIfShuttingDown = () => {
      if (
        watches.signal.aborted &&
        watches.signal.reason instanceof ShutdownError
      ) {
        throw new ShutdownError();
      }
    };

    try {
      await this.ensureAddresses();
      await this.reconcileQuarantined();
      await this.updateBalances(true);

      abortIfShuttingDown();
      const worker = await this.pool.acquireWithin(bidirectional.leaseWaitMs);
      releaseLease = () => {
        this.pool.release(worker.path);
        releaseLease = () => {};
      };
      this.jobs.update(job.id, {
        path: worker.path,
        derivedAddress: worker.address,
        timings: { leaseAcquiredAt: Date.now() },
      });

      const built = await this.prepareTransaction(
        worker,
        job.mode,
        abortIfShuttingDown
      );

      const stage = async <T>(
        reason:
          | 'signature_timeout'
          | 'broadcast_failed'
          | 'confirmation_timeout'
          | 'respond_timeout',
        operation: () => Promise<T>
      ): Promise<T> => {
        try {
          return await operation();
        } catch (error) {
          if (
            reason === 'broadcast_failed' ||
            reason === 'confirmation_timeout'
          ) {
            this.pool.quarantine(worker.path, built.nonce);
          }
          abortIfShuttingDown();
          throw new JobFailure(reason, error);
        }
      };

      abortIfShuttingDown();
      this.jobs.update(job.id, { nonce: built.nonce });
      const source = await this.source();
      const submitted = await source.submit({
        built,
        worker,
        signal: watches.signal,
        onProgress: progress => {
          // Keep late identifiers without reviving a terminal job or clearing known values.
          this.jobs.update(job.id, {
            ...(progress.requestId !== undefined
              ? { requestId: progress.requestId }
              : {}),
            ...(progress.sourceTx !== undefined
              ? {
                  sourceTx: progress.sourceTx,
                  ...(this.sourceChain === 'solana'
                    ? { solanaTx: progress.sourceTx }
                    : {}),
                }
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
      submitted.signature.catch(() => undefined);
      submitted.response.catch(() => undefined);
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

      const rsv = await stage('signature_timeout', () => submitted.signature);
      abortIfShuttingDown();
      this.jobs.update(job.id, { timings: { signatureAt: Date.now() } });

      const signed = await attachSignature({
        unsigned: built.unsigned,
        signature: rsv,
      });
      try {
        assertDerivedSender(worker.address, signed.recoveredFrom);
      } catch (error) {
        throw new JobFailure('derivation_mismatch', error);
      }
      this.jobs.update(job.id, { state: 'verified' });

      abortIfShuttingDown();
      const ethTxHash = await stage('broadcast_failed', () =>
        this.client.sendRawTransaction({
          serializedTransaction: signed.serialized,
        })
      );
      this.jobs.update(job.id, {
        state: 'broadcast',
        ethTxHash,
        timings: { broadcastAt: Date.now() },
      });

      const receipt = await stage('confirmation_timeout', () =>
        this.client.waitForTransactionReceipt({
          hash: ethTxHash,
          confirmations: bidirectional.confirmations,
          timeout: bidirectional.ethConfirmTimeoutMs,
        })
      );

      abortIfShuttingDown();
      if (receipt.status !== 'success') {
        throw new JobFailure(
          'transaction_reverted',
          new Error(`Transaction ${ethTxHash} reverted`)
        );
      }

      this.jobs.update(job.id, {
        state: 'confirmed',
        timings: { confirmedAt: Date.now() },
      });

      // Solana can advance to the next nonce during finality. Midnight retains
      // the lease until settlement because its caller and wallet are shared.
      if (this.sourceChain === 'solana') releaseLease();

      // The response budget starts at Ethereum confirmation, after signing.
      respondDeadline = setTimeout(
        () =>
          watches.abort(
            new Error(
              `respondBidirectionalEvent not received within ` +
                `${bidirectional.respondTimeoutMs}ms of confirmation`
            )
          ),
        bidirectional.respondTimeoutMs
      );
      respondDeadline.unref?.();

      const serializedOutput = await stage(
        'respond_timeout',
        () => submitted.response
      );
      abortIfShuttingDown();

      this.jobs.update(job.id, {
        serializedOutput,
        timings: { respondedAt: Date.now() },
      });

      if (serializedOutput !== EXPECTED_SERIALIZED_OUTPUT) {
        throw new JobFailure(
          'respond_mismatch',
          new Error(
            `Expected ${EXPECTED_SERIALIZED_OUTPUT}, got ${serializedOutput}`
          )
        );
      }

      this.jobs.update(job.id, {
        state: 'responded',
        timings: { finishedAt: Date.now() },
      });
    } catch (error) {
      if (error instanceof JobFailure) {
        // Expected failures are visible to the next lease holder before handoff.
        this.recordFailure(job, error);
        return;
      }
      abortIfShuttingDown();
      throw error;
    } finally {
      clearTimeout(respondDeadline);
      releaseLease();
      watches.abort();
      activeJobs.delete(watches);
    }
  }
}

/** Detached jobs must stop their subscriptions when the HTTP server shuts down. */
const activeJobs = new Set<AbortController>();

/** Abandon every in-flight job. Their records stay, marked failed. */
export const abortActiveJobs = (): number => {
  const count = activeJobs.size;
  for (const controller of activeJobs) controller.abort(new ShutdownError());
  activeJobs.clear();
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
