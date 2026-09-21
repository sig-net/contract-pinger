import 'dotenv/config';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  FundingError,
  nightShortfall,
  parseFundingArgs,
  pingerSeedFile,
  planNightTransfer,
  recordFundingIntent,
  requireNoPendingTransfer,
} from '../src/midnight/funding.mjs';

const help = `fund:midnight --target-night N --max-transfer-night N --reserve-night N --minimum-dust N [--execute]
NIGHT amounts use integer base units; minimum DUST uses SPECKs.
Dry run is the default: reads synced balances and prints the proposed top-up.
--execute saves the separate child identity in .midnight/pinger.env (0600),
tops NIGHT up to the target, registers NIGHT for DUST, and waits for minimum DUST.
MPC_MIDNIGHT_FUNDING_SEED supplies the treasury's 32-byte hex seed via environment only.
The child is derived deterministically; the treasury seed is never written.
MPC_MIDNIGHT_STATE_DIR overrides .midnight. Run while the pinger wallet is stopped.
An unresolved funding-pending.json blocks retries: inspect its transaction and
recipient balance before removing that receipt. Never blindly resend a timeout.
No default balances or daily runway are assumed.`;

export async function fundMidnight(
  args: string[],
  values: NodeJS.ProcessEnv
): Promise<void> {
  if (args.includes('--help')) {
    console.log(help);
    return;
  }
  const limits = parseFundingArgs(args);
  const fundingSeed = values.MPC_MIDNIGHT_FUNDING_SEED;
  if (!fundingSeed || !/^[0-9a-fA-F]{64}$/.test(fundingSeed)) {
    throw new FundingError(
      'MPC_MIDNIGHT_FUNDING_SEED must contain a 32-byte hex treasury seed'
    );
  }
  const { derivePingerSeed, resolveMidnightConfig } =
    await import('../src/midnight/config.mjs');
  const seed = derivePingerSeed(fundingSeed);
  if (
    values.MPC_MIDNIGHT_PINGER_SEED &&
    values.MPC_MIDNIGHT_PINGER_SEED.toLowerCase() !== seed
  ) {
    throw new FundingError(
      'Configured pinger seed differs from the derived child'
    );
  }
  const config = resolveMidnightConfig(
    { ...values, MPC_MIDNIGHT_PINGER_SEED: seed },
    false
  );
  const seedFile = join(config.stateDirectory, 'pinger.env');
  const pendingFile = join(config.stateDirectory, 'funding-pending.json');
  await pingerSeedFile(seedFile, seed, false);
  await requireNoPendingTransfer(pendingFile);
  const { WalletRegistry, readAccountFunding, ensureFeeReady, transferNight } =
    await import('@sig-net/midnight-contract-deploy');
  const wallets = new WalletRegistry(config.node);
  let submitted = false;
  try {
    let child = await readAccountFunding(wallets, seed, 'pinger');
    // Syncing a wallet is a full chain scan on a cold runner, and the treasury
    // balance is only consulted to guard the reserve. Nothing due, nothing to
    // read.
    const due = nightShortfall(child.night, limits);
    let treasury =
      due > 0n
        ? await readAccountFunding(wallets, fundingSeed, 'treasury')
        : undefined;
    // Reported before the plan is validated, so a refusal arrives with the
    // balances that caused it rather than needing a second run to discover.
    console.log(
      JSON.stringify(
        {
          execute: limits.execute,
          network: config.node.networkId,
          recipient: child.addresses.unshielded,
          currentNight: child.night.toString(),
          targetNight: limits.targetNight.toString(),
          transferNight: due.toString(),
          treasuryNight:
            treasury?.night.toString() ?? 'not read: no transfer is due',
          reserveNight: limits.reserveNight.toString(),
          currentDust: child.dust.toString(),
          minimumDust: limits.minimumDust.toString(),
        },
        null,
        2
      )
    );
    let amount = planNightTransfer(child.night, treasury?.night, limits);
    if (!limits.execute) return;
    await pingerSeedFile(seedFile, seed, true);
    if (amount > 0n) {
      const root = await wallets.wallet(fundingSeed, 'treasury');
      // This may register treasury NIGHT. The SDK transfer balances its actual
      // DUST fee and waits for that fee when necessary; no guessed fee budget.
      await ensureFeeReady(
        root.facade,
        root.keys,
        await root.facade.waitForSyncedState(),
        config.node.networkId
      );
      child = await readAccountFunding(wallets, seed, 'pinger');
      treasury = await readAccountFunding(wallets, fundingSeed, 'treasury');
      amount = planNightTransfer(child.night, treasury.night, limits);
      if (amount > 0n) {
        await recordFundingIntent(
          pendingFile,
          child.addresses.unshielded,
          amount,
          limits.targetNight
        );
        const transactionId = await transferNight(
          root.facade,
          root.keys,
          await root.facade.waitForSyncedState(),
          child.addresses.unshielded,
          config.node.networkId,
          amount
        );
        submitted = true;
        console.log(`NIGHT transfer submitted: ${transactionId}`);
        const receipt = await open(
          pendingFile,
          constants.O_WRONLY | constants.O_NOFOLLOW
        );
        try {
          await receipt.truncate();
          await receipt.writeFile(
            JSON.stringify({
              network: config.node.networkId,
              recipient: child.addresses.unshielded,
              amount: amount.toString(),
              target: limits.targetNight.toString(),
              status: 'submitted',
              transactionId,
            }) + '\n'
          );
          await receipt.sync();
        } finally {
          await receipt.close();
        }
      }
    }
    const deadline = Date.now() + 120_000;
    while (child.night < limits.targetNight && Date.now() < deadline) {
      await sleep(3_000);
      child = await readAccountFunding(wallets, seed, 'pinger');
    }
    if (child.night < limits.targetNight)
      throw new FundingError(
        'Transferred NIGHT has not reached the target in the indexed wallet; inspect the submitted transaction before retrying'
      );
    if (submitted) await unlink(pendingFile);
    const account = await wallets.wallet(seed, 'pinger');
    const dust = await ensureFeeReady(
      account.facade,
      account.keys,
      await account.facade.waitForSyncedState(),
      config.node.networkId,
      undefined,
      limits.minimumDust
    );
    console.log(
      `Pinger funded: NIGHT=${child.night}, DUST=${dust}; private child identity saved`
    );
  } finally {
    await wallets.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  fundMidnight(process.argv.slice(2), process.env).catch(error => {
    // SDK errors may carry provider inputs. Keep treasury/configuration secrets
    // out of logs; the last public phase/transaction output bounds the failure.
    console.error(
      error instanceof FundingError
        ? error.message
        : 'Midnight funding failed. Check private identity, balances and endpoints; inspect any submitted transaction before retrying. Use --help for required inputs.'
    );
    process.exitCode = 1;
  });
}
