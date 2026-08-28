/**
 * Claim Sepolia ETH from the Chainstack faucet into the funding wallet.
 *
 * The wallet this tops up is the one `pnpm fund` spends from, so this is the
 * first half of the supply chain and the sweep is the second. Kept separate
 * because the faucet is rate limited to roughly a claim a day while the sweep
 * runs far more often — folding them together would mean either sweeping
 * daily or hammering the faucet.
 *
 *   pnpm claim
 *   pnpm claim --dry-run
 *
 * Requires SIG_BIDIRECTIONAL_FUNDING_SK and CHAINSTACK_API_KEY in the
 * environment; neither is ever taken as an argument.
 */
import 'dotenv/config';
import { formatEther, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  createEthereumClient,
  ETHEREUM_TARGETS,
  withHexPrefix,
} from '../src/utils/bidirectionalTx';
import { env } from '../src/utils/env';

const FAUCET_URL = 'https://api.chainstack.com/v1/faucet/sepolia';

const flag = (name: string) => process.argv.includes(`--${name}`);

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

const main = async () => {
  const apiKey = process.env.CHAINSTACK_API_KEY;
  if (!apiKey) fail('CHAINSTACK_API_KEY is not set');

  const fundingKey = env.funding.key;
  if (!fundingKey) fail('SIG_BIDIRECTIONAL_FUNDING_SK is not set');

  const account = privateKeyToAccount(withHexPrefix(fundingKey));
  const client = createEthereumClient(
    'testnet',
    ETHEREUM_TARGETS.testnet.rpcUrl() ?? ''
  );

  // Above this, skip. The faucet allows roughly one claim a day, so spending
  // it on a wallet that does not need topping up means none is available on
  // the day it does.
  const skipAbove = parseEther(
    process.env.SIG_BIDIRECTIONAL_CLAIM_SKIP_ABOVE_ETH ?? '0.1'
  );

  const before = await client.getBalance({ address: account.address });
  console.log(`wallet  : ${account.address}`);
  console.log(`balance : ${formatEther(before)} ETH`);
  console.log(`claim if below : ${formatEther(skipAbove)} ETH`);

  if (before >= skipAbove) {
    console.log("\n✓ above the threshold; leaving today's claim unspent");
    return;
  }

  if (flag('dry-run')) {
    console.log('\n(dry run — would claim)');
    return;
  }

  const response = await fetch(FAUCET_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ address: account.address }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // A rate limit is the expected answer on a day the quota is already spent,
    // not a fault: the wallet keeps whatever it has and the sweep carries on.
    if (response.status === 429) {
      console.log(
        `\n✓ faucet rate limited (${body.slice(0, 200)}); nothing claimed`
      );
      return;
    }
    fail(`faucet returned ${response.status}: ${body.slice(0, 300)}`);
  }

  console.log('\nclaim accepted; waiting for it to land');

  // Polled rather than slept: the claim is a transaction like any other and
  // the wait is however long it takes to mine, not a fixed guess.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10_000));
    const now = await client.getBalance({ address: account.address });
    if (now > before) {
      console.log(
        `✓ received ${formatEther(now - before)} ETH; balance now ${formatEther(now)} ETH`
      );
      return;
    }
  }

  fail(
    'the faucet accepted the claim but the balance did not change within five ' +
      'minutes. It may still land; check before claiming again.'
  );
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
