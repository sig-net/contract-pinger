import { describe, it, expect, beforeEach } from 'vitest';
import { privateKeyToAccount, sign } from 'viem/accounts';
import {
  serializeTransaction,
  type TransactionSerializableEIP1559,
} from 'viem';
import { keccak256 } from 'viem/utils';

import { RateLimiter } from '../src/utils/rateLimiter';
import {
  buildPaths,
  NoWorkerAvailableError,
  WorkerPool,
} from '../src/utils/workerPool';
import { JobStore } from '../src/jobs/store';
import {
  attachSignature,
  ETHEREUM_TARGETS,
  EXPECTED_SERIALIZED_OUTPUT,
  isTxMode,
} from '../src/utils/bidirectionalTx';
import {
  assertDerivedSender,
  DerivationMismatchError,
} from '../src/utils/derivation';

describe('RateLimiter', () => {
  it('allows exactly the configured number of requests per window', () => {
    const limiter = new RateLimiter(10, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryAcquire(t0 + i)).toBe(true);
    }
    expect(limiter.tryAcquire(t0 + 10)).toBe(false);
  });

  it('reports how long until a slot frees, and frees it on schedule', () => {
    const limiter = new RateLimiter(2, 60_000);
    const t0 = 1_000_000;
    limiter.tryAcquire(t0);
    limiter.tryAcquire(t0 + 1_000);

    expect(limiter.retryAfterMs(t0 + 10_000)).toBe(50_000);
    expect(limiter.tryAcquire(t0 + 10_000)).toBe(false);

    // The first hit ages out of the window.
    expect(limiter.tryAcquire(t0 + 60_001)).toBe(true);
  });

  it('gives a usable delay when intake is frozen at zero', () => {
    // Zero is a supported way to stop accepting work. `hits[0]` is undefined
    // in that state, so the naive arithmetic yields NaN and the endpoint
    // serialises Retry-After: NaN.
    const limiter = new RateLimiter(0, 60_000);
    expect(limiter.tryAcquire(1_000_000)).toBe(false);
    const retry = limiter.retryAfterMs(1_000_000);
    expect(Number.isFinite(retry)).toBe(true);
    expect(retry).toBeGreaterThan(0);
  });

  it('slides rather than resetting on a fixed boundary', () => {
    const limiter = new RateLimiter(10, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) limiter.tryAcquire(t0 + i * 1_000);
    // 9s later the oldest hit is 69s old, so exactly one slot is free.
    expect(limiter.tryAcquire(t0 + 60_500)).toBe(true);
    expect(limiter.tryAcquire(t0 + 60_500)).toBe(false);
  });
});

describe('WorkerPool', () => {
  let pool: WorkerPool;

  beforeEach(() => {
    pool = new WorkerPool(buildPaths('load', 3));
    pool.all().forEach((w, i) => {
      pool.setAddress(w.path, `0x${String(i + 1).repeat(40)}` as `0x${string}`);
      pool.setBalance(w.path, 10n, 1n);
    });
  });

  it('builds one path per slot', () => {
    expect(buildPaths('load', 3)).toEqual(['load-0', 'load-1', 'load-2']);
  });

  it('hands out a distinct worker per concurrent lease', () => {
    const a = pool.acquire();
    const b = pool.acquire();
    expect(a.path).not.toBe(b.path);
  });

  it('refuses once every worker is leased, and recovers on release', () => {
    const leased = [pool.acquire(), pool.acquire(), pool.acquire()];
    expect(() => pool.acquire()).toThrowError(NoWorkerAvailableError);
    try {
      pool.acquire();
    } catch (error) {
      expect((error as NoWorkerAvailableError).reason).toBe('all_busy');
    }

    pool.release(leased[0].path);
    expect(pool.acquire().path).toBe(leased[0].path);
  });

  it('queues for a free address instead of failing while one is in use', async () => {
    // Leases run about as long as signing plus two confirmations, so a burst
    // arriving mid-lease would otherwise fail outright rather than waiting.
    const leased = [pool.acquire(), pool.acquire(), pool.acquire()];
    const queued = pool.acquireWithin(5_000);
    expect(pool.waiting).toBe(1);

    pool.release(leased[1].path);
    await expect(queued).resolves.toMatchObject({ path: leased[1].path });
    expect(pool.waiting).toBe(0);
  });

  it('gives up waiting rather than queueing forever', async () => {
    [pool.acquire(), pool.acquire(), pool.acquire()];
    await expect(pool.acquireWithin(20)).rejects.toThrowError(
      NoWorkerAvailableError
    );
    expect(pool.waiting).toBe(0);
  });

  it('does not wait when the problem is funding rather than contention', async () => {
    // Patience does not refill a wallet, so this still fails immediately.
    pool.all().forEach(w => pool.setBalance(w.path, 0n, 1n));
    const started = Date.now();
    await expect(pool.acquireWithin(10_000)).rejects.toThrowError(
      NoWorkerAvailableError
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reports why it refused: every worker busy vs every worker underfunded', () => {
    const leased = [pool.acquire(), pool.acquire(), pool.acquire()];
    try {
      pool.acquire();
      throw new Error('expected acquire to throw');
    } catch (error) {
      expect((error as NoWorkerAvailableError).reason).toBe('all_busy');
    }

    leased.forEach(w => pool.release(w.path));
    pool.all().forEach(w => pool.setBalance(w.path, 0n, 1n));
    try {
      pool.acquire();
      throw new Error('expected acquire to throw');
    } catch (error) {
      expect((error as NoWorkerAvailableError).reason).toBe('all_underfunded');
    }
  });

  it('withholds an address whose broadcast outcome is unknown', () => {
    // Releasing it would let the next job read the same `latest` nonce while
    // the previous transaction is still pending, producing two signatures over
    // one nonce — the collision the pool exists to prevent.
    const leased = pool.acquire();
    pool.quarantine(leased.path, 7);
    pool.release(leased.path);

    expect(pool.acquire().path).not.toBe(leased.path);
    expect(pool.acquire().path).not.toBe(leased.path);
    expect(() => pool.acquire()).toThrowError(NoWorkerAvailableError);
  });

  it('keeps a withheld address out while a transaction is still outstanding', () => {
    const leased = pool.acquire();
    pool.quarantine(leased.path, 7);
    pool.release(leased.path);

    pool.reconcile(leased.path, true);
    expect(pool.all().find(w => w.path === leased.path)!.pendingNonce).toBe(7);
  });

  it('releases a withheld address whether its transaction mined or was dropped', () => {
    // Keyed on nothing being outstanding rather than on the nonce advancing —
    // a dropped transaction leaves `latest` where it was, so a nonce
    // comparison would withhold that address permanently.
    for (const path of ['load-0', 'load-1']) {
      pool.quarantine(path, 7);
      pool.reconcile(path, false);
      expect(
        pool.all().find(w => w.path === path)!.pendingNonce
      ).toBeUndefined();
    }
    expect(pool.quarantined()).toHaveLength(0);
  });

  it('takes an underfunded worker back once its balance recovers', () => {
    // Nothing inside the service tops these up, and an underfunded worker is
    // never acquired — so if its balance is not re-read somewhere, the pool
    // sheds an address permanently on every low-balance event.
    pool.all().forEach(w => pool.setBalance(w.path, 0n, 1n));
    expect(() => pool.acquire()).toThrowError(NoWorkerAvailableError);

    pool.setBalance('load-1', 10n, 1n);
    expect(pool.acquire().path).toBe('load-1');
  });

  it('skips underfunded workers rather than handing out a job that cannot broadcast', () => {
    pool.setBalance('load-0', 0n, 1n);
    pool.setBalance('load-1', 0n, 1n);

    expect(pool.acquire().path).toBe('load-2');
    try {
      pool.acquire();
      throw new Error('expected acquire to throw');
    } catch (error) {
      expect((error as NoWorkerAvailableError).reason).toBe('all_underfunded');
    }
  });
});

describe('JobStore', () => {
  it('preserves acceptedAt when a later patch updates other timings', () => {
    const store = new JobStore(10);
    const job = store.create('dev', 'eth_self_transfer');
    const acceptedAt = job.timings.acceptedAt;

    store.update(job.id, { timings: { signSentAt: acceptedAt + 500 } });
    store.fail(job.id, 'signature_timeout', new Error('timed out'));

    const view = store.view(job.id)!;
    expect(view.timings.acceptedAt).toBe(acceptedAt);
    expect(view.state).toBe('failed');
    expect(view.failureReason).toBe('signature_timeout');
    expect(view.durations.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('distinguishes a busy pool from an unfunded one', () => {
    // These call for different actions by different people — resize the pool
    // versus top up the wallets — so they must not share a reason code.
    const store = new JobStore(10);
    const busy = store.create('testnet', 'eth_self_transfer');
    const broke = store.create('testnet', 'eth_self_transfer');

    store.fail(
      busy.id,
      'all_workers_busy',
      new NoWorkerAvailableError('all_busy')
    );
    store.fail(
      broke.id,
      'all_workers_underfunded',
      new NoWorkerAvailableError('all_underfunded')
    );

    expect(store.view(busy.id)!.failureReason).toBe('all_workers_busy');
    expect(store.view(broke.id)!.failureReason).toBe('all_workers_underfunded');
  });

  it('distinguishes signature timeouts from respond timeouts', () => {
    const store = new JobStore(10);
    const a = store.create('dev', 'eth_self_transfer');
    const b = store.create('dev', 'eth_self_transfer');

    store.fail(a.id, 'signature_timeout', new Error('no signature'));
    store.fail(b.id, 'respond_timeout', new Error('no respond'));

    expect(store.view(a.id)!.failureReason).toBe('signature_timeout');
    expect(store.view(b.id)!.failureReason).toBe('respond_timeout');
  });

  it('drops the oldest finished jobs rather than growing without bound', () => {
    const store = new JobStore(100, 2);
    // Distinct finishedAt values, and deliberately not in creation order, so
    // the assertion depends on the comparator rather than on sort stability.
    const ids = [3000, 1000, 2000].map(finishedAt => {
      const job = store.create('testnet', 'eth_self_transfer');
      store.update(job.id, { state: 'responded', timings: { finishedAt } });
      return job.id;
    });
    // Creating a fourth pushes the oldest finished job out.
    store.create('testnet', 'eth_self_transfer');

    // ids[1] finished earliest (1000), so it is the one dropped.
    expect(store.view(ids[1])).toBeUndefined();
    expect(store.view(ids[0])).toBeDefined();
    expect(store.view(ids[2])).toBeDefined();
  });

  it('counts jobs against the ceiling their work actually belongs to', () => {
    // A job past confirmation holds an event subscription; one before it holds
    // an address and a stream of RPC calls. Counting them together lets the
    // cheap ones — which vastly outnumber the others — crowd out the expensive.
    const store = new JobStore(3, 1000, 2);
    const active = [1, 2].map(() =>
      store.create('testnet', 'eth_self_transfer')
    );
    expect(store.atCapacity()).toBe('active');

    // Confirming moves them off the active ceiling and onto the respond one.
    active.forEach(j => store.update(j.id, { state: 'confirmed' }));
    expect(store.activeCount).toBe(0);
    expect(store.awaitingRespondCount).toBe(2);
    expect(store.atCapacity()).toBe(null);

    // Filling the respond ceiling is reported as its own limit.
    store.update(store.create('testnet', 'eth_self_transfer').id, {
      state: 'confirmed',
    });
    expect(store.atCapacity()).toBe('awaiting_respond');
  });

  it('stops counting a job once it reaches a terminal state', () => {
    const store = new JobStore(10, 1000, 2);
    const job = store.create('testnet', 'eth_self_transfer');
    expect(store.liveCount).toBe(1);

    store.update(job.id, { state: 'responded' });
    expect(store.liveCount).toBe(0);
    expect(store.atCapacity()).toBe(null);
  });
});

describe('transaction modes', () => {
  it('accepts only the two supported modes', () => {
    expect(isTxMode('eth_self_transfer')).toBe(true);
    expect(isTxMode('erc20_zero_transfer')).toBe(true);
    expect(isTxMode('erc20_transfer')).toBe(false);
    expect(isTxMode(undefined)).toBe(false);
  });

  it('expects a single Borsh true from both modes', () => {
    expect(EXPECTED_SERIALIZED_OUTPUT).toBe('0x01');
  });

  it('signs for the Ethereum each network actually settles on', () => {
    // The CAIP-2 id announced to the MPC is always mainnet's, so the chain id
    // inside the transaction is the only thing separating the two networks.
    expect(ETHEREUM_TARGETS.dev.chainId).toBe(11155111);
    expect(ETHEREUM_TARGETS.testnet.chainId).toBe(11155111);
    expect(ETHEREUM_TARGETS.mainnet.chainId).toBe(1);
  });
});

describe('signature attachment and derivation check', () => {
  const privateKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const account = privateKeyToAccount(privateKey);

  const unsigned: TransactionSerializableEIP1559 = {
    type: 'eip1559',
    chainId: ETHEREUM_TARGETS.testnet.chainId,
    nonce: 7,
    to: account.address,
    value: 0n,
    gas: 21_000n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  };

  it('recovers the signer that actually produced the signature', async () => {
    const signature = await sign({
      hash: keccak256(serializeTransaction(unsigned)),
      privateKey,
    });

    const attached = await attachSignature({
      unsigned,
      signature: { r: signature.r, s: signature.s, v: signature.v! },
    });

    expect(attached.recoveredFrom.toLowerCase()).toBe(
      account.address.toLowerCase()
    );
    expect(() =>
      assertDerivedSender(account.address, attached.recoveredFrom)
    ).not.toThrow();
  });

  it('flags a signature that recovers to a different address', async () => {
    const signature = await sign({
      hash: keccak256(serializeTransaction(unsigned)),
      privateKey,
    });
    const attached = await attachSignature({
      unsigned,
      signature: { r: signature.r, s: signature.s, v: signature.v! },
    });

    const somebodyElse = '0x0000000000000000000000000000000000000042' as const;
    expect(() =>
      assertDerivedSender(somebodyElse, attached.recoveredFrom)
    ).toThrowError(DerivationMismatchError);
  });

  it('accepts v in either form the MPC reports it', async () => {
    // signet.js's transformRSVSignature computes v - 27, so 0/1 has to be
    // normalized before it. Both forms have been observed from the network.
    const signature = await sign({
      hash: keccak256(serializeTransaction(unsigned)),
      privateKey,
    });
    const legacy = await attachSignature({
      unsigned,
      signature: { r: signature.r, s: signature.s, v: Number(signature.v) },
    });
    const parity = await attachSignature({
      unsigned,
      signature: {
        r: signature.r,
        s: signature.s,
        v: Number(BigInt(signature.v!) - 27n),
      },
    });

    expect(legacy.serialized).toBe(parity.serialized);
    expect(legacy.recoveredFrom.toLowerCase()).toBe(
      account.address.toLowerCase()
    );
  });

  it('rejects a signature over different bytes than the transaction carries', async () => {
    // Signing a transaction that differs only in nonce stands in for any
    // serialization drift between what we announced and what we rebuild.
    const signature = await sign({
      hash: keccak256(serializeTransaction({ ...unsigned, nonce: 8 })),
      privateKey,
    });
    const attached = await attachSignature({
      unsigned,
      signature: { r: signature.r, s: signature.s, v: signature.v! },
    });

    expect(attached.recoveredFrom.toLowerCase()).not.toBe(
      account.address.toLowerCase()
    );
    expect(() =>
      assertDerivedSender(account.address, attached.recoveredFrom)
    ).toThrowError(DerivationMismatchError);
  });
});
