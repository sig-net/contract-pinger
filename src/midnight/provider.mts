import { setTimeout as delay } from 'node:timers/promises';
import { createHmac } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import {
  createProofProvider,
  ZKConfigRegistry,
  type WalletProvider,
  type MidnightProvider,
  type ZKConfigProvider,
} from '@midnight-ntwrk/midnight-js/types';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  deriveAccountKeys,
  dustShortfall,
  ensureFeeReady,
  initialiseWalletFacade,
  signetContractManagedPath,
  type WalletFacade,
  type AccountKeys,
  type NetworkId,
} from '@sig-net/midnight-contract-deploy';
import {
  managedPath,
  type CallerCircuitId,
  type CallerProviders,
  type CallerPrivateState,
  PRIVATE_STATE_ID,
} from './caller.mjs';
import type { MidnightConfig } from './config.mjs';

/** Retry spendable-coin fee estimation while NIGHT generates DUST, within transaction validity. */
export async function ensureTransactionFee(
  wallet: WalletFacade,
  keys: AccountKeys,
  networkId: NetworkId,
  tx: Parameters<WalletFacade['estimateTransactionFee']>[0],
  expires: number
): Promise<void> {
  const deadline = expires - 60_000;
  const remaining = () => {
    if (Date.now() >= deadline)
      throw new Error('Midnight transaction expired during fee preparation');
    return deadline - Date.now();
  };
  remaining();
  const floor = await wallet.calculateTransactionFee(tx);
  let minimum = floor;
  for (;;) {
    const state = await wallet.waitForSyncedState();
    await ensureFeeReady(
      wallet,
      keys,
      state,
      networkId,
      undefined,
      minimum,
      remaining()
    );
    remaining();
    try {
      const fee = await wallet.estimateTransactionFee(tx, keys.dustSecretKey, {
        ttl: new Date(expires),
      });
      const synced = await wallet.waitForSyncedState();
      remaining();
      if (synced.dust.balance(new Date()) >= fee) return;
      minimum = fee;
    } catch (error) {
      const shortfall = dustShortfall(error);
      // The pinned SDK's estimator exposes Wallet.InsufficientFunds; older
      // balancing paths retain the SDK's amount-bearing shortfall diagnostic.
      const insufficient =
        error instanceof Error &&
        '_tag' in error &&
        error._tag === 'Wallet.InsufficientFunds';
      if (
        !insufficient &&
        shortfall === undefined &&
        !String(error).includes('could not balance dust')
      )
        throw error;
      const synced = await wallet.waitForSyncedState();
      const night = Object.values(synced.unshielded.balances).reduce(
        (sum, value) => sum + value,
        0n
      );
      if (night === 0n)
        throw new Error(
          'Insufficient DUST for balancing and no NIGHT to generate more',
          { cause: error }
        );
      minimum = shortfall?.need ?? floor;
      await delay(Math.min(3_000, remaining()));
    }
  }
}

/** One wallet owns all pinger fee inputs and the caller's private-state database. */
export async function openMidnightSession(config: MidnightConfig) {
  setNetworkId(config.node.networkId);
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const keys = deriveAccountKeys(config.seed, config.node.networkId);
  const wallet = await initialiseWalletFacade(keys, config.node);
  try {
    await wallet.start(keys.shieldedSecretKeys, keys.dustSecretKey);
    await wallet.waitForSyncedState();
    const walletProvider: WalletProvider & MidnightProvider = {
      getCoinPublicKey: () => keys.shieldedSecretKeys.coinPublicKey,
      getEncryptionPublicKey: () => keys.shieldedSecretKeys.encryptionPublicKey,
      async balanceTx(tx, ttl) {
        const expires = Math.min(
          ttl?.getTime() ?? Date.now() + 1_800_000,
          ...[...(tx.intents?.values() ?? [])].map(intent =>
            intent.ttl.getTime()
          )
        );
        await ensureTransactionFee(
          wallet,
          keys,
          config.node.networkId,
          tx,
          expires
        );
        const recipe = await wallet.balanceUnboundTransaction(
          tx,
          {
            shieldedSecretKeys: keys.shieldedSecretKeys,
            dustSecretKey: keys.dustSecretKey,
          },
          { ttl: new Date(expires) }
        );
        const signed = await wallet.signRecipe(
          recipe,
          keys.unshieldedKeystore.signDataAsync
        );
        return wallet.finalizeRecipe(signed);
      },
      submitTx: tx => wallet.submitTransaction(tx),
    };
    const zkConfigProvider = new NodeZkConfigProvider<CallerCircuitId>(
      managedPath
    );
    const sources: ZKConfigProvider<string>[] = [
      zkConfigProvider,
      new NodeZkConfigProvider<string>(signetContractManagedPath),
    ];
    const registry = new ZKConfigRegistry(sources);
    const base = httpClientProvingProvider(
      config.node.proofServerUrl,
      registry,
      { timeout: 900_000 }
    );
    const privateStateProvider = levelPrivateStateProvider<
      typeof PRIVATE_STATE_ID,
      CallerPrivateState
    >({
      midnightDbName: resolve(config.stateDirectory, 'wallet.db'),
      privateStateStoreName: 'private-state',
      signingKeyStoreName: 'signing-keys',
      accountId: keys.shieldedSecretKeys.coinPublicKey,
      privateStoragePasswordProvider: () =>
        'Aa1!' +
        createHmac('sha256', Buffer.from(config.seed, 'hex'))
          .update('signet:pinger:private-state')
          .digest('hex')
          .split('')
          .join('-'),
    });
    const publicDataProvider = indexerPublicDataProvider({
      queryURL: config.node.indexerUrl,
      subscriptionURL: config.node.indexerWsUrl,
    });
    const providers: CallerProviders = {
      privateStateProvider,
      publicDataProvider,
      zkConfigProvider,
      proofProvider: createProofProvider(base),
      walletProvider,
      midnightProvider: walletProvider,
    };
    return {
      wallet,
      keys,
      providers,
      async close() {
        await Promise.all([wallet.stop(), publicDataProvider.dispose()]);
      },
    };
  } catch (error) {
    await wallet.stop();
    throw error;
  }
}
