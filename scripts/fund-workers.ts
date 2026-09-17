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
 *   pnpm fund --env testnet --topup 0.01    # a different target than the default
 *
 * Fills every address below SIG_BIDIRECTIONAL_FUND_TOPUP_ETH to it, or to the
 * --topup figure when given. SIG_BIDIRECTIONAL_MIN_BALANCE_WEI is the floor the
 * service stops leasing at, and bounds how far a pool drains between sweeps.
 *
 * Requires SIG_BIDIRECTIONAL_FUNDING_SK in the environment. Never pass a key
 * as an argument: argv is visible in `ps` and shell history.
 */
import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { constants } from '@sig-net/signet.js';
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
  withHexPrefix,
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
type Env = keyof typeof ENVIRONMENTS | 'stagenet';

/** A `--name value` argument, or the fallback. */
function arg(name: string, fallback: string): string;
function arg(name: string, fallback?: string): string | undefined;
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/**
 * Declared rather than assigned to a const: TypeScript only narrows past a
 * `never`-returning call for function declarations, so the arrow form left
 * every value it guards still possibly-undefined and needed a `return` or a
 * `!` at each use.
 */
function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

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
    const res = await fetch(
      `${url}/sign_bidirectional/workers?env=${env}&sourceChain=${env === 'stagenet' ? 'midnight' : 'solana'}`,
      {
        headers: { 'x-api-secret': secret },
        signal: AbortSignal.timeout(10_000),
      }
    );
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
    if (other !== address) {
      differences.push(
        `${path}: this run derived ${address}, the service reports ${other} — ` +
          'worker path, MPC root key or requester/caller address disagree'
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
  const sourceChain = arg('source-chain', 'solana');
  if (sourceChain !== 'solana' && sourceChain !== 'midnight')
    fail('Invalid --source-chain');
  const envs = arg('env', sourceChain === 'midnight' ? 'stagenet' : 'testnet')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean) as Env[];
  if (
    sourceChain === 'midnight' &&
    envs.some(network => network !== 'stagenet')
  )
    fail('Midnight supports only --env stagenet');
  if (flag('include-midnight') && !envs.includes('stagenet'))
    envs.push('stagenet');
  if (!envs.length || new Set(envs).size !== envs.length)
    fail('Choose at least one distinct environment');
  for (const env of envs) {
    if (!(env in ENVIRONMENTS) && env !== 'stagenet') {
      fail(
        `--env values must be among: ${[...Object.keys(ENVIRONMENTS), 'stagenet'].join(', ')}`
      );
    }
  }

  const fundingKey = env.funding.key;
  if (!fundingKey) fail('SIG_BIDIRECTIONAL_FUNDING_SK is not set');

  // Every network in one run must settle on the same Ethereum: a single wallet
  // sends the transfers, and its nonce sequence belongs to one chain.
  const targets = new Set(envs.map(e => ETHEREUM_TARGETS[e].chainId));
  if (targets.size > 1) {
    fail(
      `${envs.join(', ')} settle on different Ethereum networks. Fund them in separate runs.`
    );
  }
  const rpcUrl = ETHEREUM_TARGETS[envs[0]].rpcUrl();
  if (!rpcUrl) {
    fail(
      `No Ethereum RPC configured for ${envs[0]} (chain ${ETHEREUM_TARGETS[envs[0]].chainId})`
    );
  }

  // Derived from the signing key rather than configured, so there is nothing
  // to keep in step: the requester *is* SIG_SOL_SK's public key, and every
  // worker address follows from it. Configuring it separately would mean two
  // places that can disagree, and disagreeing means funding addresses no job
  // will ever spend from while the real pool runs dry.
  const needsSolana = envs.some(network => network !== 'stagenet');
  const derivedRequester =
    needsSolana && env.solSk
      ? Keypair.fromSecretKey(
          new Uint8Array(JSON.parse(env.solSk))
        ).publicKey.toBase58()
      : undefined;

  // Optional, and only ever a check. Set it when this runs against a service
  // holding a different key — a mismatch then fails the run instead of
  // silently funding the wrong addresses.
  const expectedRequester = env.funding.requesterPubkey;
  if (
    expectedRequester &&
    derivedRequester &&
    expectedRequester !== derivedRequester
  ) {
    fail(
      `SIG_SOL_SK derives requester ${derivedRequester}, but ` +
        `SIG_BIDIRECTIONAL_REQUESTER_PUBKEY says ${expectedRequester}. ` +
        'Every worker address follows from this key, so the two must agree.'
    );
  }

  const requester = derivedRequester ?? expectedRequester;
  if (needsSolana && !requester) {
    fail(
      'Set SIG_SOL_SK to the key the service signs with (the requester is its ' +
        'public key), or SIG_BIDIRECTIONAL_REQUESTER_PUBKEY to that public key directly'
    );
  }

  if (requester) new PublicKey(requester); // rejects a malformed value before anything is sent

  // --- safety limits ------------------------------------------------------
  //
  // The band between min and top-up is the headroom an address has before it
  // needs the next sweep. How it is sized, and why the schedule follows from
  // it rather than the other way round, is written down beside the defaults
  // in src/utils/env.ts.
  //
  // Defaults come from the shared schema, so a value set for the service is
  // the same value here — two readings would be two chances to disagree, and
  // the addresses derived from them would differ.
  const expectedWorkers = Number(arg('paths', String(env.bidirectional.paths)));
  const pathPrefix = env.bidirectional.pathPrefix;
  // The same figure the service leases against, read from the same variable
  // rather than a second one kept level by hand. Not overridable per-run: an
  // override is how the two drift apart for the length of a sweep, and an
  // address stranded between the two figures is not visible from either side.
  const minBalance = env.bidirectional.minBalanceWei;

  // The target is the trigger too: every address below it is filled to it.
  // The default target is sized so that a full pool holds a day of the
  // scheduled load, and refilling only what fell through the floor left the
  // pool short of that for as long as its addresses took to drain — a pool
  // sitting just above the floor everywhere passed a sweep with almost no
  // headroom. At a job a minute one address spends at a time, so a sweep
  // tops up the one or two that moved, not all ten.
  //
  // --topup only changes the figure, as the ad hoc load test does to fund for
  // a specific run.
  const requestedTopUp = arg('topup');
  const topUpTo = parseEther(requestedTopUp ?? env.funding.topUpEth);
  // What "funded" means once the transfers land. A caller naming a target is
  // about to spend against it, so falling short of it is a failure. The
  // scheduled sweep runs beside a live service that may lease an address
  // between its transfer and this check, landing it a job below the target;
  // for that caller the floor is what says the pool can still serve.
  const fundedAt = requestedTopUp ? topUpTo : minBalance;
  const maxPerAddress = parseEther(env.funding.maxPerAddressEth);
  const maxPerRun = parseEther(env.funding.maxPerRunEth);
  const reserve = parseEther(env.funding.reserveEth);
  const dryRun = flag('dry-run');

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
  const solanaRpc = env.solRpcUrlDevnet;
  if (needsSolana && !solanaRpc) fail('SIG_SOL_RPC_URL_DEV is not set');

  const provider = needsSolana
    ? new anchor.AnchorProvider(
        new Connection(solanaRpc, 'confirmed'),
        new anchor.Wallet(Keypair.generate()),
        {}
      )
    : undefined;

  const client = createEthereumClient(envs[0], rpcUrl);
  const chainId = await client.getChainId();
  const expectedChainId = ETHEREUM_TARGETS[envs[0]].chainId;
  if (chainId !== expectedChainId) {
    fail(`RPC reports chain ${chainId}, expected ${expectedChainId}`);
  }

  const workers: (DerivedWorker & { env: Env })[] = [];
  for (const env of envs) {
    if (env === 'stagenet') {
      const { deriveMidnightWorkers } =
        await import('../src/midnight/derivation.mjs');
      const derived = deriveMidnightWorkers(buildPaths(pathPrefix, 1));
      workers.push(...derived.map(d => ({ ...d, env })));
      continue;
    }
    if (!provider || !requester)
      fail('Solana derivation is missing its provider or requester');
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
      requester: requester,
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
  const serviceUrl = arg('url', env.funding.serviceUrl);
  if (serviceUrl && env.apiSecret) {
    console.log('\nchecking against the service:');
    for (const network of envs) {
      await crossCheck({
        url: serviceUrl,
        secret: env.apiSecret,
        env: network,
        derived: workers.filter(w => w.env === network),
      });
    }
  }

  const account = privateKeyToAccount(withHexPrefix(fundingKey));

  if (needsSolana) console.log(`Solana requester: ${requester}`);
  if (needsSolana)
    console.log(
      `root key    : ${env.solRootPublicKey ? 'SIG_SOL_ROOT_PUBLIC_KEY override' : 'paired to the program address'}`
    );
  console.log(`funding from: ${account.address}`);
  console.log(
    `band        : ${formatEther(minBalance)} → ${formatEther(topUpTo)} ETH` +
      (requestedTopUp ? '  (--topup target)' : '') +
      '\n'
  );

  // --- decide -------------------------------------------------------------
  const balances = await Promise.all(
    workers.map(w => client.getBalance({ address: w.address }))
  );
  const plan = workers
    .map((w, i) => ({ ...w, balance: balances[i], top: topUpTo - balances[i] }))
    .filter(w => w.balance < topUpTo);

  workers.forEach((w, i) => {
    const short = balances[i] < topUpTo ? '  ← short' : '';
    console.log(
      `  ${w.env.padEnd(8)} ${w.path.padEnd(8)} ${w.address}  ${formatEther(balances[i])} ETH${short}`
    );
  });

  if (plan.length === 0) {
    console.log(
      `\n✓ every address already holds the ${formatEther(topUpTo)} ETH target`
    );
    return;
  }

  const total = plan.reduce((sum, w) => sum + w.top, 0n);
  console.log(
    `\n${plan.length} address(es) short, ${formatEther(total)} ETH to send`
  );

  if (total > maxPerRun) {
    fail(
      // Self-contained rather than "that exceeds": this goes to stderr and the
      // total above to stdout, and CI logs do not keep the two in order.
      `${formatEther(total)} ETH across ${plan.length} address(es) exceeds the ` +
        `per-run cap of ${formatEther(maxPerRun)} ETH. Raise ` +
        'SIG_BIDIRECTIONAL_FUND_MAX_PER_RUN_ETH deliberately, or fund fewer addresses.'
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
    transport: http(rpcUrl),
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
  // Against `fundedAt`, not the target: see where it is set for why the two
  // callers differ.
  const stillShort = workers.filter((_, i) => after[i] < fundedAt);

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
