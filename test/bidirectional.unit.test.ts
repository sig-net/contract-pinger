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
  EXPECTED_SERIALIZED_OUTPUT,
  isTxMode,
  SEPOLIA_CHAIN_ID,
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

  it('counts only unfinished jobs toward capacity', () => {
    const store = new JobStore(2);
    const a = store.create('dev', 'eth_self_transfer');
    store.create('dev', 'eth_self_transfer');
    expect(store.atCapacity()).toBe(true);

    store.update(a.id, { state: 'responded' });
    expect(store.atCapacity()).toBe(false);
    expect(store.activeCount).toBe(1);
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
});

describe('signature attachment and derivation check', () => {
  const privateKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const account = privateKeyToAccount(privateKey);

  const unsigned: TransactionSerializableEIP1559 = {
    type: 'eip1559',
    chainId: SEPOLIA_CHAIN_ID,
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
