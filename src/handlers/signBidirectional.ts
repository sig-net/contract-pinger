import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js';
import { constants, contracts } from 'signet.js';
import type { Hex, PublicClient } from 'viem';
import {
  buildTransaction,
  attachSignature,
  createSepoliaClient,
  ETHEREUM_CAIP2_ID,
  EXPECTED_SERIALIZED_OUTPUT,
  KEY_VERSION,
  type TxMode,
} from '../utils/bidirectionalTx';
import { assertDerivedSender, deriveEthAddress } from '../utils/derivation';
import { buildSignBidirectionalInstruction } from '../utils/signBidirectionalIx';
import { getSharedSolana, type SolanaEnvironment } from '../utils/initSolana';
import { useEnv } from '../utils/useEnv';
import {
  buildPaths,
  NoWorkerAvailableError,
  WorkerPool,
  type Worker,
} from '../utils/workerPool';
import { sweepFunding, type SweepResult } from '../utils/funding';
import { RateLimiter } from '../utils/rateLimiter';
import { JobStore, type JobRecord } from '../jobs/store';

const contractAddresses = {
  dev: constants.CONTRACT_ADDRESSES.SOLANA.TESTNET_DEV,
  testnet: constants.CONTRACT_ADDRESSES.SOLANA.TESTNET,
  mainnet: constants.CONTRACT_ADDRESSES.SOLANA.MAINNET,
};

const toHexString = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.startsWith('0x') ? value : `0x${value}`;
  }
  return `0x${Buffer.from(value as Uint8Array).toString('hex')}`;
};

/**
 * Owns everything shared across jobs for one environment: the address pool,
 * the arrival-rate limiter, the job store, and the Sepolia client.
 *
 * Kept per-environment rather than per-request so the derived addresses (and
 * their funding) persist, and so every job in an environment waits on the same
 * `ChainSignatureContract` instance.
 */
export class BidirectionalService {
  readonly pool: WorkerPool;
  readonly jobs: JobStore;
  readonly limiter: RateLimiter;
  private readonly client: PublicClient;
  private addressesReady = false;
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    readonly environment: SolanaEnvironment,
    private readonly rpcUrl: string
  ) {
    const { bidirectional } = useEnv();
    this.pool = new WorkerPool(
      buildPaths(bidirectional.pathPrefix, bidirectional.paths)
    );
    this.jobs = new JobStore(bidirectional.maxJobs);
    this.limiter = new RateLimiter(bidirectional.maxRequestsPerMinute);
    this.client = createSepoliaClient(rpcUrl);
  }

  private solana() {
    return getSharedSolana({
      contractAddress: contractAddresses[this.environment],
      environment: this.environment,
    });
  }

  /**
   * Derive every path's address once. A misconfigured root-key override shows
   * up here, at startup, as addresses that hold no gas — rather than as a
   * transaction that silently never mines half an hour later.
   */
  async ensureAddresses(): Promise<void> {
    if (this.addressesReady) return;
    const { chainSigContract, keypair } = this.solana();
    for (const worker of this.pool.all()) {
      const address = await deriveEthAddress({
        chainSigContract,
        predecessor: keypair.publicKey.toString(),
        path: worker.path,
      });
      this.pool.setAddress(worker.path, address);
    }
    this.addressesReady = true;
  }

  async refreshBalances(): Promise<void> {
    const { minBalanceWei } = useEnv().bidirectional;
    for (const worker of this.pool.all()) {
      if (worker.address === ('0x' as Hex)) continue;
      const balance = await this.client.getBalance({ address: worker.address });
      this.pool.setBalance(worker.path, balance, minBalanceWei);
    }
  }

  async sweep(): Promise<SweepResult> {
    await this.ensureAddresses();
    return sweepFunding({
      client: this.client,
      pool: this.pool,
      rpcUrl: this.rpcUrl,
    });
  }

  /** Periodic top-up so pool size stays a setting rather than a chore. */
  startFundingSweeps(): void {
    const { fundingSweepIntervalMs } = useEnv().bidirectional;
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweep().catch(error =>
        console.error('bidirectional funding sweep failed:', error)
      );
    }, fundingSweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** Accepts a job and runs it in the background. */
  start(mode: TxMode): JobRecord {
    const job = this.jobs.create(this.environment, mode);
    void this.run(job).catch(error => {
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
    const { bidirectional } = useEnv();
    const { chainSigContract, provider, keypair } = this.solana();
    let worker: Worker | undefined;
    let leaseReleased = false;

    const releaseLease = () => {
      if (worker && !leaseReleased) {
        this.pool.release(worker.path);
        leaseReleased = true;
      }
    };

    try {
      await this.ensureAddresses();

      // --- Steps 1-2: derive and preflight -------------------------------
      worker = this.pool.acquire();
      this.jobs.update(job.id, {
        path: worker.path,
        derivedAddress: worker.address,
        timings: { leaseAcquiredAt: Date.now() },
      });

      const built = await buildTransaction({
        client: this.client,
        mode: job.mode,
        from: worker.address,
        erc20Address: bidirectional.erc20Address as Hex,
      });

      // Checked after the build because the gas price is only known now.
      const balance = await this.client.getBalance({ address: worker.address });
      if (balance < built.gasCostWei) {
        this.pool.setBalance(worker.path, balance, bidirectional.minBalanceWei);
        this.jobs.fail(
          job.id,
          'preflight_underfunded',
          new Error(
            `${worker.address} holds ${balance} wei, needs ${built.gasCostWei} for gas`
          )
        );
        return;
      }

      // --- Steps 3-4: request id ------------------------------------------
      const requestId = contracts.solana.getRequestIdBidirectional({
        sender: keypair.publicKey.toString(),
        payload: Array.from(Buffer.from(built.rlpEncoded.slice(2), 'hex')),
        caip2Id: ETHEREUM_CAIP2_ID,
        keyVersion: KEY_VERSION,
        path: worker.path,
        algo: 'ECDSA',
        dest: 'ethereum',
        params: '',
      });
      this.jobs.update(job.id, { requestId, nonce: built.nonce });

      // --- Step 5: send sign_bidirectional --------------------------------
      const instruction = await buildSignBidirectionalInstruction({
        chainSigContract,
        requester: keypair.publicKey,
        feePayer: keypair.publicKey,
        args: {
          serializedTransaction: Buffer.from(built.rlpEncoded.slice(2), 'hex'),
          caip2Id: ETHEREUM_CAIP2_ID,
          keyVersion: KEY_VERSION,
          path: worker.path,
          algo: 'ECDSA',
          dest: 'ethereum',
          params: '',
          outputDeserializationSchema: built.outputDeserializationSchema,
          respondSerializationSchema: built.respondSerializationSchema,
        },
      });

      const transaction = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
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
      const signer = new PublicKey(contractAddresses[this.environment]);
      const signaturePromise = chainSigContract.waitForEvent({
        eventName: 'signatureRespondedEvent',
        requestId,
        signer,
        afterSignature: solanaTx,
        timeoutMs: bidirectional.signatureTimeoutMs,
        backfillIntervalMs: 15_000,
        healthCheckIntervalMs: 15_000,
      });
      const respondPromise = chainSigContract.waitForEvent({
        eventName: 'respondBidirectionalEvent',
        requestId,
        signer,
        afterSignature: solanaTx,
        timeoutMs: bidirectional.respondTimeoutMs,
        backfillIntervalMs: 15_000,
        healthCheckIntervalMs: 15_000,
      });
      // Nothing awaits this until step 9; without a no-op handler a timeout
      // there would surface as an unhandled rejection first.
      respondPromise.catch(() => undefined);

      this.jobs.update(job.id, { state: 'awaiting_signature' });

      let rsv;
      try {
        rsv = await signaturePromise;
      } catch (error) {
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
      let ethTxHash: Hex;
      try {
        ethTxHash = await this.client.sendRawTransaction({
          serializedTransaction: signed.serialized,
        });
      } catch (error) {
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
        this.jobs.fail(job.id, 'confirmation_timeout', error);
        return;
      }

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

      // The nonce is spent and the transaction is buried; the address can take
      // the next job while this one waits out the MPC's finality window.
      releaseLease();

      // --- Steps 9-10: respond and verify ---------------------------------
      let respond;
      try {
        respond = await respondPromise;
      } catch (error) {
        this.jobs.fail(job.id, 'respond_timeout', error);
        return;
      }

      const serializedOutput = toHexString(respond.serializedOutput);
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

      this.assertRespondSigned(respond.signature, worker.path);

      this.jobs.update(job.id, {
        state: 'responded',
        timings: { finishedAt: Date.now() },
      });
    } finally {
      releaseLease();
    }
  }

  /**
   * Assert the respond carried a signature at all.
   *
   * Deliberately weaker than it sounds. Verifying *whose* signature it is
   * would need the key the MPC signs respond payloads with, and that is not
   * derivable from anything this service holds — on Ethereum the responses
   * come from the nodes' own accounts, which is a different key schedule from
   * the request path. Until that is pinned down, presence is the only claim
   * this can honestly make, so it does not pretend to more.
   */
  private assertRespondSigned(signature: unknown, path: string): void {
    if (!signature) {
      throw new Error(
        `respondBidirectionalEvent for path ${path} carried no signature`
      );
    }
  }
}

const services = new Map<string, BidirectionalService>();

export const getService = (
  environment: SolanaEnvironment,
  rpcUrl: string
): BidirectionalService => {
  const existing = services.get(environment);
  if (existing) return existing;
  const service = new BidirectionalService(environment, rpcUrl);
  services.set(environment, service);
  return service;
};

export const listServices = (): readonly BidirectionalService[] => [
  ...services.values(),
];
