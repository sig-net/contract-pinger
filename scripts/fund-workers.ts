/**
 * Top up the derived worker addresses for a bidirectional environment.
 *
 * Deliberately independent of the pinger. The addresses are derived here from
 * public inputs and balances are read straight from the Ethereum RPC, so this
 * neither trusts the service to name its own payees nor needs it to be
 * running — which is plausibly when funding most needs to already be correct.
 *
 *   pnpm fund --env testnet
 *   pnpm fund --env dev,testnet          # one run, one spend cap
 *   pnpm fund --env testnet --dry-run
 *   pnpm fund --env testnet --url http://localhost:3001   # cross-check first
 *
 * Requires SIG_BIDIRECTIONAL_FUNDING_SK in the environment. Never pass a key
 * as an argument: argv is visible in `ps` and shell history.
 */
import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { constants } from 'signet.js';
import {
  createWalletClient,
  formatEther,
  http,
  parseEther,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  deriveWorkerAddresses,
  type DerivedWorker,
} from '../src/utils/derivation';
import { buildChainSignatureContract } from '../src/utils/initSolana';
import {
  createEthereumClient,
  ETHEREUM_TARGETS,
} from '../src/utils/bidirectionalTx';
import { buildPaths } from '../src/utils/workerPool';
import { env } from '../src/utils/env';

const ENVIRONMENTS = {
  dev: 'TESTNET_DEV',
  testnet: 'TESTNET',
  mainnet: 'MAINNET',
} as const;
/** Intrinsic cost of a value transfer to an account with no code. */
const PLAIN_TRANSFER_GAS = 21_000n;
type Env = keyof typeof ENVIRONMENTS;

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const fail = (message: string): never => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

/**
 * Compare the locally derived addresses against what the service reports.
 *
 * Five values have to agree across the process boundary — the path count and
 * prefix, the root key, the requester key, and the balance minimum — and
 * nothing else notices when they drift. The symptom is silent: ETH goes to
 * addresses no job uses while the real pool starves, which reads as an MPC
 * fault rather than a configuration one.
 *
 * The service's answer is never used as input; funding always targets the
 * locally derived list. This only decides whether to proceed. An unreachable
 * service is not a disagreement — deriving locally exists so funding works
 * when the service is down — but a reachable one that disagrees stops the run
 * before anything is spent.
 */
const crossCheck = async ({
  url,
  secret,
  env,
  derived,
}: {
  url: string;
  secret: string;
  env: Env;
  derived: readonly DerivedWorker[];
}): Promise<void> => {
  let reported: { path: string; address: string }[];
  try {
    const res = await fetch(`${url}/sign_bidirectional/workers?env=${env}`, {
      headers: { 'x-api-secret': secret },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.log(
        `  ${env}: service returned ${res.status}, skipping cross-check`
      );
      return;
    }
    reported = (await res.json()).workers ?? [];
  } catch {
    console.log(`  ${env}: service unreachable, skipping cross-check`);
    return;
  }

  const mine = new Map(derived.map(d => [d.path, d.address.toLowerCase()]));
  const theirs = new Map(
    reported.map(w => [w.path, (w.address ?? '').toLowerCase()])
  );

  const differences: string[] = [];
  if (mine.size !== theirs.size) {
    differences.push(
      `this run derived ${mine.size} address(es), the service reports ${theirs.size} — ` +
        'SIG_BIDIRECTIONAL_PATHS or SIG_BIDIRECTIONAL_PATH_PREFIX disagree'
    );
  }
  for (const [path, address] of mine) {
    const other = theirs.get(path);
    if (other && other !== address) {
      differences.push(
        `${path}: this run derived ${address}, the service reports ${other} — ` +
          'SIG_SOL_ROOT_PUBLIC_KEY or the requester key disagree'
      );
    }
  }

  if (differences.length > 0) {
    fail(
      `configuration drift against the ${env} service:\n  - ` +
        differences.join('\n  - ') +
        '\n\nNothing was sent. Funding the wrong addresses would starve the real ' +
        'pool while reporting success.'
    );
  }
  console.log(`  ${env}: agrees with the service (${mine.size} addresses)`);
};

const main = async () => {
  // Comma-separated, and swept in one process on purpose: the spend caps below
  // govern a run, and a separate process per environment would enforce each cap
  // against its own total — letting the combined spend reach a multiple of the
  // figure that was set.
  const envs = (arg('env', 'testnet') ?? 'testnet')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean) as Env[];
  for (const env of envs) {
    if (!(env in ENVIRONMENTS)) {
      fail(
        `--env values must be among: ${Object.keys(ENVIRONMENTS).join(', ')}`
      );
    }
  }

  const fundingKey = process.env.SIG_BIDIRECTIONAL_FUNDING_SK;
  if (!fundingKey) fail('SIG_BIDIRECTIONAL_FUNDING_SK is not set');

  // Every network in one run must settle on the same Ethereum: a single wallet
  // sends the transfers, and its nonce sequence belongs to one chain.
  const targets = new Set(envs.map(e => ETHEREUM_TARGETS[e].rpcVar));
  if (targets.size > 1) {
    fail(
      `${envs.join(', ')} settle on different Ethereum networks. Fund them in separate runs.`
    );
  }
  const rpcVar = ETHEREUM_TARGETS[envs[0]].rpcVar;
  const rpcUrl = process.env[rpcVar];
  if (!rpcUrl) fail(`${rpcVar} is not set`);

  // Public by construction — the requester is SIG_SOL_SK's *public* key. It
  // must match the deployed service exactly: rotating that keypair moves every
  // address below, and this script would then fund addresses nothing spends
  // from while the real ones run dry.
  const requester =
    process.env.SIG_BIDIRECTIONAL_REQUESTER_PUBKEY ??
    (env.solSk
      ? Keypair.fromSecretKey(
          new Uint8Array(JSON.parse(env.solSk))
        ).publicKey.toBase58()
      : undefined);
  if (!requester) {
    fail(
      "Set SIG_BIDIRECTIONAL_REQUESTER_PUBKEY to the deployed service's Solana public key " +
        '(or SIG_SOL_SK locally, from which it is derived)'
    );
    return;
  }
  new PublicKey(requester); // rejects a malformed value before anything is sent

  // --- safety limits ------------------------------------------------------
  //
  // The band between min and top-up is the headroom an address has before it
  // needs the next sweep, so it has to absorb the scheduler running late.
  //
  //   runs of headroom = (topup - min) / gas per run
  //
  // At the measured 0.0000234 ETH for eth_self_transfer and 10 jobs/min spread
  // over 10 addresses — one run per address per minute — the 0.002/0.0035
  // default gives ~64 minutes, or four missed fifteen-minute sweeps. Re-measure
  // when the transaction mode or Sepolia gas moves; these are variables, not
  // constants, precisely because that number is not fixed.
  const expectedWorkers = Number(
    arg('paths', process.env.SIG_BIDIRECTIONAL_PATHS ?? '10')
  );
  const pathPrefix = process.env.SIG_BIDIRECTIONAL_PATH_PREFIX ?? 'load';
  const minBalance = parseEther(
    arg('min', process.env.SIG_BIDIRECTIONAL_FUND_MIN_ETH ?? '0.002')!
  );
  const topUpTo = parseEther(
    arg('topup', process.env.SIG_BIDIRECTIONAL_FUND_TOPUP_ETH ?? '0.0035')!
  );
  const maxPerAddress = parseEther(
    process.env.SIG_BIDIRECTIONAL_FUND_MAX_PER_ADDRESS_ETH ?? '0.02'
  );
  const maxPerRun = parseEther(
    process.env.SIG_BIDIRECTIONAL_FUND_MAX_PER_RUN_ETH ?? '0.1'
  );
  const reserve = parseEther(
    process.env.SIG_BIDIRECTIONAL_FUND_RESERVE_ETH ?? '0.02'
  );
  const dryRun = flag('dry-run');

  // The service refuses to lease below SIG_BIDIRECTIONAL_MIN_BALANCE_WEI. If
  // this sweep only tops up below some lower figure, an address between the two
  // is stranded — unusable and never refilled — and the pool quietly shrinks.
  // Read through the service's own schema rather than re-parsed here: two
  // readings of the same variable are two chances to disagree about its
  // default, and this comparison exists precisely to catch a disagreement.
  const serviceMin = env.bidirectional.minBalanceWei;
  if (minBalance < serviceMin) {
    fail(
      `SIG_BIDIRECTIONAL_FUND_MIN_ETH (${formatEther(minBalance)}) is below the service's ` +
        `SIG_BIDIRECTIONAL_MIN_BALANCE_WEI (${formatEther(serviceMin)}). Addresses between ` +
        'the two would be refused by the service and ignored by this sweep.'
    );
  }

  if (topUpTo <= minBalance) {
    fail(
      `top-up target (${formatEther(topUpTo)}) must exceed the minimum (${formatEther(minBalance)})`
    );
  }
  if (topUpTo > maxPerAddress) {
    fail(
      `top-up target (${formatEther(topUpTo)}) exceeds the per-address cap (${formatEther(maxPerAddress)})`
    );
  }

  // --- derive, locally ----------------------------------------------------
  const solanaRpc = process.env.SIG_SOL_RPC_URL_DEV;
  if (!solanaRpc) fail('SIG_SOL_RPC_URL_DEV is not set');

  const provider = new anchor.AnchorProvider(
    new Connection(solanaRpc!, 'confirmed'),
    new anchor.Wallet(Keypair.generate()),
    {}
  );

  const client = createEthereumClient(envs[0], rpcUrl!);
  const chainId = await client.getChainId();
  const expectedChainId = ETHEREUM_TARGETS[envs[0]].chainId;
  if (chainId !== expectedChainId) {
    fail(`RPC reports chain ${chainId}, expected ${expectedChainId}`);
  }

  const workers: (DerivedWorker & { env: Env })[] = [];
  for (const env of envs) {
    const programId = constants.CONTRACT_ADDRESSES.SOLANA[ENVIRONMENTS[env]];
    // Built through the service's own constructor, not a local equivalent.
    // That is where SIG_SOL_ROOT_PUBLIC_KEY is applied: a contract assembled
    // here would fall back to the key paired with the program address and
    // derive an entirely different address set, funding addresses no worker
    // uses while the real ones ran dry. The provider is never used for
    // derivation — it is pure crypto.
    const chainSigContract = buildChainSignatureContract({
      contractAddress: programId,
      provider,
    });
    const derived = await deriveWorkerAddresses({
      chainSigContract,
      client,
      requester: requester!,
      paths: buildPaths(pathPrefix, expectedWorkers),
    });
    if (derived.length !== expectedWorkers) {
      fail(
        `derived ${derived.length} addresses for ${env}, expected ${expectedWorkers}`
      );
    }
    console.log(`${env.padEnd(8)} program ${programId}`);
    workers.push(...derived.map(d => ({ ...d, env })));
  }

  // Reachable and disagreeing stops the run; unreachable does not.
  const serviceUrl = arg('url', process.env.SIG_BIDIRECTIONAL_SERVICE_URL);
  if (serviceUrl && process.env.API_SECRET) {
    console.log('\nchecking against the service:');
    for (const env of envs) {
      await crossCheck({
        url: serviceUrl,
        secret: process.env.API_SECRET,
        env,
        derived: workers.filter(w => w.env === env),
      });
    }
  }

  const account = privateKeyToAccount(
    (fundingKey!.startsWith('0x') ? fundingKey! : `0x${fundingKey}`) as Hex
  );

  console.log(`requester   : ${requester}`);
  console.log(
    `root key    : ${process.env.SIG_SOL_ROOT_PUBLIC_KEY ? 'SIG_SOL_ROOT_PUBLIC_KEY override' : 'paired to the program address'}`
  );
  console.log(`funding from: ${account.address}`);
  console.log(
    `band        : ${formatEther(minBalance)} → ${formatEther(topUpTo)} ETH\n`
  );

  // --- decide -------------------------------------------------------------
  const balances = await Promise.all(
    workers.map(w => client.getBalance({ address: w.address }))
  );
  const plan = workers
    .map((w, i) => ({ ...w, balance: balances[i], top: topUpTo - balances[i] }))
    .filter(w => w.balance < minBalance);

  workers.forEach((w, i) => {
    const short = balances[i] < minBalance ? '  ← short' : '';
    console.log(
      `  ${w.env.padEnd(8)} ${w.path.padEnd(8)} ${w.address}  ${formatEther(balances[i])} ETH${short}`
    );
  });

  if (plan.length === 0) {
    console.log('\n✓ every address is above the minimum');
    return;
  }

  const total = plan.reduce((sum, w) => sum + w.top, 0n);
  console.log(
    `\n${plan.length} address(es) short, ${formatEther(total)} ETH to send`
  );

  if (total > maxPerRun) {
    fail(
      `that exceeds the per-run cap of ${formatEther(maxPerRun)} ETH. ` +
        'Raise SIG_BIDIRECTIONAL_FUND_MAX_PER_RUN_ETH deliberately, or fund fewer addresses.'
    );
  }

  // Every transfer costs gas on top of its value. Checking only `total` lets a
  // wallet holding exactly total + reserve pass, then finish below the reserve
  // it was supposed to keep — and the balance check at the end can only report
  // that after the money is gone.
  const fees = await client.estimateFeesPerGas();
  const gasBudget =
    BigInt(plan.length) * PLAIN_TRANSFER_GAS * fees.maxFeePerGas;
  const required = total + gasBudget + reserve;

  const sourceBalance = await client.getBalance({ address: account.address });
  if (sourceBalance < required) {
    fail(
      `funding wallet holds ${formatEther(sourceBalance)} ETH; needs ` +
        `${formatEther(total)} to send, ~${formatEther(gasBudget)} for gas across ` +
        `${plan.length} transfer(s), and a ${formatEther(reserve)} reserve. ` +
        `Top up ${account.address}.`
    );
  }

  if (dryRun) {
    console.log('\n(dry run — nothing sent)');
    return;
  }

  // --- send, and confirm ---------------------------------------------------
  const wallet = createWalletClient({
    account,
    chain: ETHEREUM_TARGETS[envs[0]].chain,
    transport: http(rpcUrl!),
  });

  for (const w of plan) {
    const hash = await wallet.sendTransaction({ to: w.address, value: w.top });
    // Waited on rather than assumed: a submitted transaction is not a funded
    // address, and reporting one as the other is how a run starts against a
    // pool that is still dry.
    const receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: 180_000,
    });
    const status = receipt.status === 'success' ? '✓' : '✗';
    console.log(`  ${status} ${w.path}  +${formatEther(w.top)} ETH  ${hash}`);
  }

  // --- verify --------------------------------------------------------------
  const after = await Promise.all(
    workers.map(w => client.getBalance({ address: w.address }))
  );
  const stillShort = workers.filter((_, i) => after[i] < minBalance);

  const remaining = await client.getBalance({ address: account.address });
  const perRunBurn = topUpTo - minBalance;
  const runway = perRunBurn > 0n ? remaining / perRunBurn : 0n;
  console.log(
    `\nfunding wallet: ${formatEther(remaining)} ETH ` +
      `(~${runway} more top-ups at this band)`
  );

  if (remaining < reserve) {
    fail(`funding wallet is below its ${formatEther(reserve)} ETH reserve`);
  }
  if (stillShort.length > 0) {
    fail(
      `still short after funding: ${stillShort.map(w => `${w.env}/${w.path}`).join(', ')}`
    );
  }
  console.log('✓ all addresses funded');
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
