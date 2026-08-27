import { createWalletClient, http, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { useEnv } from './useEnv';
import type { WorkerPool } from './workerPool';

export interface TopUp {
  path: string;
  address: Hex;
  amountWei: bigint;
  txHash: Hex;
}

export interface SweepResult {
  checked: number;
  toppedUp: TopUp[];
  stillUnderfunded: string[];
  errors: { path: string; message: string }[];
}

const asHexKey = (key: string): Hex =>
  (key.startsWith('0x') ? key : `0x${key}`) as Hex;

/**
 * Refresh every worker's balance and top up the ones that are short.
 *
 * Concurrency here is bounded by how many derived addresses hold gas, so
 * leaving that to manual funding would make the pool size a record of the last
 * time someone remembered rather than a real setting. The service already
 * holds Sepolia ETH for the Ethereum ping path; this reuses those keys.
 */
/**
 * One sweep at a time across the whole process.
 *
 * The guard belongs here rather than on a service: every environment's sweep
 * draws from the same SIG_EVM_SK_1..5 accounts, and the configuration
 * explicitly allows those slots to share a key. Two services sweeping at once
 * would read the same pending nonce on one wallet and have one top-up replace
 * the other.
 */
let queue: Promise<unknown> = Promise.resolve();

export const sweepFunding = (args: {
  client: PublicClient;
  pool: WorkerPool;
  rpcUrl: string;
}): Promise<SweepResult> => {
  // Queued rather than shared. Handing a second caller the first one's promise
  // would return them a result for a different pool, leaving their own
  // addresses unswept while reporting success.
  const run = queue.then(
    () => runSweep(args),
    () => runSweep(args)
  );
  queue = run.catch(() => undefined);
  return run;
};

const runSweep = async ({
  client,
  pool,
  rpcUrl,
}: {
  client: PublicClient;
  pool: WorkerPool;
  rpcUrl: string;
}): Promise<SweepResult> => {
  const env = useEnv();
  const { minBalanceWei, topupWei } = env.bidirectional;

  const result: SweepResult = {
    checked: 0,
    toppedUp: [],
    stillUnderfunded: [],
    errors: [],
  };

  for (const worker of pool.all()) {
    if (worker.address === ('0x' as Hex)) continue;
    result.checked += 1;

    try {
      const balance = await client.getBalance({ address: worker.address });
      pool.setBalance(worker.path, balance, minBalanceWei);
      if (balance >= minBalanceWei) continue;

      const shortfall = topupWei - balance;
      if (shortfall <= 0n) {
        // Reachable when the top-up target is set below the minimum, which
        // would otherwise send a negative value and throw on every sweep
        // while the worker never reaches the minimum it is aimed at.
        result.errors.push({
          path: worker.path,
          message: `SIG_BIDIRECTIONAL_TOPUP_WEI (${topupWei}) is not above this address's balance (${balance}); it can never reach SIG_BIDIRECTIONAL_MIN_BALANCE_WEI (${minBalanceWei})`,
        });
        result.stillUnderfunded.push(worker.path);
        continue;
      }

      // `evmSk` rotates on each read, so each top-up draws from the next key.
      const key = env.evmSk;
      if (!key) {
        // Recorded rather than silently counted as underfunded: the cause is a
        // missing SIG_EVM_SK_n, not a balance, and the rotation visits all
        // five indices regardless of how many are configured.
        result.errors.push({
          path: worker.path,
          message:
            'No funding key available for this rotation slot. All of SIG_EVM_SK_1..5 must be set; they may share a value.',
        });
        result.stillUnderfunded.push(worker.path);
        continue;
      }

      const wallet = createWalletClient({
        account: privateKeyToAccount(asHexKey(key)),
        chain: sepolia,
        transport: http(rpcUrl),
      });
      const txHash = await wallet.sendTransaction({
        to: worker.address,
        value: shortfall,
      });

      result.toppedUp.push({
        path: worker.path,
        address: worker.address,
        amountWei: shortfall,
        txHash,
      });
      // The recorded balance is deliberately left at its observed value. The
      // top-up is only broadcast here, not mined, and marking the worker
      // funded now would hand it out for the 12-60s until it lands, where it
      // would fail the gas preflight against its real balance.
    } catch (error) {
      result.errors.push({
        path: worker.path,
        message: error instanceof Error ? error.message : String(error),
      });
      result.stillUnderfunded.push(worker.path);
    }
  }

  return result;
};
