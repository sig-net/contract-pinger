/**
 * Print the resolved funding figures as `name=value` lines.
 *
 * The workflows used to repeat each default beside its variable, so the same
 * number lived in the schema and in every `${{ vars.X || '...' }}` beside it,
 * and changing one meant finding all of them. They now pass the variable
 * through unset and read whatever this prints, which is what the schema
 * resolved — the single place a default is written down.
 *
 * Only for the figures a shell step computes with. Anything handed straight to
 * `pnpm fund` needs nothing here: an unset variable reaches the script as an
 * empty string, and the schema already treats that as absent.
 *
 *   pnpm fund:config >> "${GITHUB_OUTPUT}"
 */
import 'dotenv/config';
import { env } from '../src/utils/env';

const lines = {
  min_balance_wei: env.bidirectional.minBalanceWei.toString(),
  topup_eth: env.funding.topUpEth,
  gas_per_run_eth: env.funding.gasPerRunEth,
  gas_margin: String(env.funding.gasMargin),
};

for (const [name, value] of Object.entries(lines)) {
  console.log(`${name}=${value}`);
}
