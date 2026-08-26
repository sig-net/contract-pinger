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
export const sweepFunding = async ({
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
      // `evmSk` rotates on each read, so each top-up draws from the next key.
      const key = env.evmSk;
      if (!key) {
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
      pool.setBalance(worker.path, topupWei, minBalanceWei);
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
