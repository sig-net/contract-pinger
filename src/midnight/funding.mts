import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FundingLimits {
  targetNight: bigint;
  maxTransferNight: bigint;
  reserveNight: bigint;
  minimumDust: bigint;
}

/** Only locally authored messages from this class are safe to print. */
export class FundingError extends Error {}

export function parseFundingArgs(
  args: string[]
): FundingLimits & { execute: boolean } {
  const names = new Map([
    ['--target-night', 'targetNight'],
    ['--max-transfer-night', 'maxTransferNight'],
    ['--reserve-night', 'reserveNight'],
    ['--minimum-dust', 'minimumDust'],
  ] as const);
  const values: Partial<FundingLimits> = {};
  let execute = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--execute' && !execute) {
      execute = true;
      continue;
    }
    const key = names.get(arg as Parameters<typeof names.get>[0]);
    if (!key || values[key] !== undefined)
      throw new FundingError('Unknown or repeated funding argument');
    const value = args[++index];
    if (!value || !/^(0|[1-9][0-9]*)$/.test(value))
      throw new FundingError(
        `${arg} requires an unsigned integer in base units`
      );
    values[key] = BigInt(value);
  }
  for (const [arg, key] of names) {
    if (values[key] === undefined)
      throw new FundingError(`Required argument: ${arg}`);
  }
  const limits = values as FundingLimits;
  if (
    limits.targetNight === 0n ||
    limits.maxTransferNight === 0n ||
    limits.minimumDust === 0n
  ) {
    throw new FundingError(
      'Target, transfer cap and minimum DUST must be positive'
    );
  }
  return { ...limits, execute };
}

/**
 * What the recipient is short of its target, before the treasury is consulted.
 *
 * Separate from the plan because the treasury balance is only ever read to
 * guard the reserve: a caller that learns nothing is due can skip syncing the
 * treasury wallet at all, which on a cold runner is a full chain scan.
 */
export function nightShortfall(
  currentNight: bigint,
  limits: FundingLimits
): bigint {
  if (currentNight < 0n) throw new FundingError('Negative account balance');
  return currentNight < limits.targetNight
    ? limits.targetNight - currentNight
    : 0n;
}

/**
 * NIGHT fees are paid separately in DUST by the SDK transfer balancer.
 *
 * `treasuryNight` may be omitted when the caller has not read the treasury;
 * that is only valid while nothing is due, and is refused otherwise.
 */
export function planNightTransfer(
  currentNight: bigint,
  treasuryNight: bigint | undefined,
  limits: FundingLimits
): bigint {
  const amount = nightShortfall(currentNight, limits);
  if (amount > limits.maxTransferNight)
    throw new FundingError(
      `NIGHT top-up exceeds the transfer cap: ${amount} needed, cap is ${limits.maxTransferNight}`
    );
  if (amount === 0n) return amount;
  // Only reached when a transfer is actually due, so the treasury must have
  // been read by now.
  if (treasuryNight === undefined)
    throw new FundingError(
      'The treasury balance is required to plan a NIGHT transfer'
    );
  if (treasuryNight < 0n) throw new FundingError('Negative account balance');
  if (treasuryNight < amount + limits.reserveNight) {
    // The figures, not just the verdict: this is reached after minutes of
    // wallet syncing, and a bare refusal costs another full run to diagnose.
    throw new FundingError(
      `NIGHT top-up would consume the treasury reserve: transferring ${amount} ` +
        `and keeping ${limits.reserveNight} in reserve needs ${amount + limits.reserveNight}, ` +
        `but the treasury holds ${treasuryNight}`
    );
  }
  return amount;
}

/** Exclusive creation and no-follow reads keep an existing identity intact. */
export async function pingerSeedFile(
  filename: string,
  seed: string,
  create: boolean
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(seed))
    throw new FundingError('Invalid derived pinger seed');
  const expected = `MPC_MIDNIGHT_PINGER_SEED=${seed}\n`;
  if (create) {
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
    try {
      const file = await open(
        filename,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600
      );
      try {
        await file.writeFile(expected);
        await file.sync();
      } finally {
        await file.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  try {
    const file = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) {
        throw new FundingError(
          'Pinger seed file must be a private regular file with mode 0600'
        );
      }
      if ((await file.readFile('utf8')) !== expected)
        throw new FundingError(
          'Stored pinger identity differs from the derived child; refusing overwrite'
        );
    } finally {
      await file.close();
    }
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

export async function requireNoPendingTransfer(
  filename: string
): Promise<void> {
  try {
    await readFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new FundingError(
    'A funding-pending.json receipt exists. Inspect its transaction and recipient balance before removing it and retrying; the previous submission may have succeeded'
  );
}

/** Written before submission, so an ambiguous timeout cannot trigger a resend. */
export async function recordFundingIntent(
  filename: string,
  recipient: string,
  amount: bigint,
  target: bigint
): Promise<void> {
  const file = await open(
    filename,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.writeFile(
      JSON.stringify({
        network: 'stagenet',
        recipient,
        amount: amount.toString(),
        target: target.toString(),
        status: 'submitting',
      }) + '\n'
    );
    await file.sync();
  } finally {
    await file.close();
  }
}
