import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fundMidnight } from '../scripts/fund-midnight.mjs';
import {
  parseFundingArgs,
  pingerSeedFile,
  planNightTransfer,
  recordFundingIntent,
  requireNoPendingTransfer,
} from '../src/midnight/funding.mjs';

const sdk = vi.hoisted(() => ({
  readAccountFunding: vi.fn(),
  ensureFeeReady: vi.fn(async () => 10n),
  transferNight: vi.fn(async () => 'transaction-id'),
  close: vi.fn(async () => {}),
  wallet: vi.fn(async () => ({
    facade: { waitForSyncedState: async () => ({}) },
    keys: {},
  })),
}));
vi.mock('@sig-net/midnight-contract-deploy', () => ({
  ...sdk,
  WalletRegistry: class {
    wallet = sdk.wallet;
    close = sdk.close;
  },
}));
vi.mock('../src/midnight/config.mjs', () => ({
  derivePingerSeed: () => '22'.repeat(32),
  resolveMidnightConfig: (values: NodeJS.ProcessEnv) => ({
    node: { networkId: 'stagenet' },
    stateDirectory: values.MPC_MIDNIGHT_STATE_DIR,
  }),
}));
vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }));

const directories: string[] = [];
async function temporary() {
  const root = resolve(process.cwd(), '.midnight/tests');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(resolve(root, 'funding-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const limits = {
  targetNight: 100n,
  maxTransferNight: 50n,
  reserveNight: 20n,
  minimumDust: 10n,
};
const args = [
  '--target-night',
  '100',
  '--max-transfer-night',
  '50',
  '--reserve-night',
  '20',
  '--minimum-dust',
  '10',
];

describe('Midnight funding limits', () => {
  it('requires explicit base-unit budgets and defaults to dry run', () => {
    expect(parseFundingArgs(args)).toEqual({ ...limits, execute: false });
    expect(parseFundingArgs([...args, '--execute']).execute).toBe(true);
    expect(() => parseFundingArgs([])).toThrow(/Required argument/);
    for (const value of ['-1', '1.5', '1e6', '0x10', 'secret']) {
      expect(() =>
        parseFundingArgs(['--target-night', value, ...args.slice(2)])
      ).toThrow(/unsigned integer/);
    }
    expect(() => parseFundingArgs([...args, '--target-night', '20'])).toThrow(
      /repeated/
    );
    expect(() => parseFundingArgs([...args, '--seed', 'secret'])).toThrow(
      /Unknown/
    );
  });
  it('replenishes a nonzero balance by exactly its shortfall', () => {
    expect(planNightTransfer(70n, 50n, limits)).toBe(30n);
    expect(planNightTransfer(50n, 70n, limits)).toBe(50n);
  });
  it('refuses over-cap transfers and preserves the full treasury reserve', () => {
    expect(() => planNightTransfer(49n, 1000n, limits)).toThrow(/cap/);
    expect(() => planNightTransfer(70n, 49n, limits)).toThrow(/reserve/);
    expect(planNightTransfer(70n, 50n, limits)).toBe(30n);
  });
  it('does not transfer from an unfunded treasury when the target is already met', () => {
    expect(planNightTransfer(100n, 0n, limits)).toBe(0n);
    expect(planNightTransfer(101n, 0n, limits)).toBe(0n);
  });
});

describe('Midnight child identity persistence', () => {
  const child = '22'.repeat(32);
  it('does not create a seed file on dry run', async () => {
    const filename = resolve(await temporary(), 'pinger.env');
    await pingerSeedFile(filename, child, false);
    await expect(stat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('writes only the child seed with mode 0600 and preserves matching files', async () => {
    const filename = resolve(await temporary(), 'pinger.env');
    await pingerSeedFile(filename, child, true);
    const before = await stat(filename);
    expect(before.mode & 0o777).toBe(0o600);
    expect(await readFile(filename, 'utf8')).toBe(
      `MPC_MIDNIGHT_PINGER_SEED=${child}\n`
    );
    await pingerSeedFile(filename, child, true);
    expect((await stat(filename)).mtimeMs).toBe(before.mtimeMs);
  });
  it('refuses an identity mismatch without overwriting the saved child', async () => {
    const filename = resolve(await temporary(), 'pinger.env');
    await pingerSeedFile(filename, child, true);
    await expect(
      pingerSeedFile(filename, '33'.repeat(32), true)
    ).rejects.toThrow(/refusing overwrite/);
    expect(await readFile(filename, 'utf8')).toContain(child);
  });
  it('rejects insecure permissions and symbolic links', async () => {
    const directory = await temporary();
    const filename = resolve(directory, 'pinger.env');
    await pingerSeedFile(filename, child, true);
    await chmod(filename, 0o644);
    await expect(pingerSeedFile(filename, child, true)).rejects.toThrow(/0600/);
    const link = resolve(directory, 'alias.env');
    await symlink(filename, link);
    await expect(pingerSeedFile(link, child, true)).rejects.toThrow();
    expect(await readFile(filename, 'utf8')).toContain(child);
  });
});

it('preserves a public pending receipt and blocks an ambiguous retry', async () => {
  const filename = resolve(await temporary(), 'funding-pending.json');
  await requireNoPendingTransfer(filename);
  await recordFundingIntent(filename, 'recipient', 30n, 100n);
  const before = await readFile(filename, 'utf8');
  expect(JSON.parse(before)).toEqual({
    network: 'stagenet',
    recipient: 'recipient',
    amount: '30',
    target: '100',
    status: 'submitting',
  });
  await expect(requireNoPendingTransfer(filename)).rejects.toThrow(
    /previous submission may have succeeded/
  );
  await expect(
    recordFundingIntent(filename, 'other', 50n, 100n)
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(filename, 'utf8')).toBe(before);
});

describe('funding CLI transaction boundary', () => {
  async function environment() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let childReads = 0;
    sdk.readAccountFunding.mockImplementation(
      async (_wallets, _seed, label) => ({
        addresses: { unshielded: `${label}-address` },
        night: label === 'treasury' ? 100n : ++childReads > 2 ? 100n : 70n,
        dust: 0n,
      })
    );
    return {
      MPC_MIDNIGHT_FUNDING_SEED: '11'.repeat(32),
      MPC_MIDNIGHT_STATE_DIR: await temporary(),
    };
  }
  it('dry run reads balances but neither stores seeds nor registers or transfers', async () => {
    const values = await environment();
    await fundMidnight(args, values);
    expect(sdk.readAccountFunding).toHaveBeenCalledTimes(2);
    expect(sdk.ensureFeeReady).not.toHaveBeenCalled();
    expect(sdk.transferNight).not.toHaveBeenCalled();
    expect(sdk.close).toHaveBeenCalledOnce();
    await expect(
      stat(resolve(values.MPC_MIDNIGHT_STATE_DIR, 'pinger.env'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('execute transfers the rechecked difference and waits for child DUST', async () => {
    const values = await environment();
    await fundMidnight([...args, '--execute'], values);
    expect(sdk.transferNight).toHaveBeenCalledOnce();
    expect(sdk.transferNight).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'pinger-address',
      'stagenet',
      30n
    );
    expect(sdk.ensureFeeReady).toHaveBeenCalledTimes(2);
    expect(sdk.ensureFeeReady.mock.calls.at(-1)?.at(-1)).toBe(10n);
    expect(
      await readFile(
        resolve(values.MPC_MIDNIGHT_STATE_DIR, 'pinger.env'),
        'utf8'
      )
    ).not.toContain(values.MPC_MIDNIGHT_FUNDING_SEED);
    await expect(
      stat(resolve(values.MPC_MIDNIGHT_STATE_DIR, 'funding-pending.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('ambiguous submission leaves the receipt and blocks the next invocation', async () => {
    const values = await environment();
    sdk.transferNight.mockRejectedValueOnce(new Error('submission timeout'));
    await expect(fundMidnight([...args, '--execute'], values)).rejects.toThrow(
      /submission timeout/
    );
    expect(sdk.close).toHaveBeenCalledOnce();
    await expect(fundMidnight([...args, '--execute'], values)).rejects.toThrow(
      /previous submission may have succeeded/
    );
    expect(sdk.transferNight).toHaveBeenCalledOnce();
  });
});
