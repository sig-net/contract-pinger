import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  session: vi.fn(),
  build: vi.fn(),
  estimate: vi.fn(),
  ensureFee: vi.fn(),
  submit: vi.fn(),
  find: vi.fn(),
  query: vi.fn(),
  close: vi.fn(),
  initialise: vi.fn(),
  ledger: vi.fn(),
}));
vi.mock('dotenv/config', () => ({}));
vi.mock('../src/midnight/config.mjs', () => ({
  resolveMidnightConfig: mocks.config,
}));
vi.mock('../src/midnight/provider.mjs', () => ({
  openMidnightSession: mocks.session,
}));
vi.mock('@midnight-ntwrk/midnight-js/contracts', () => ({
  findDeployedContract: mocks.find,
}));
vi.mock('@sig-net/midnight-contract-deploy', () => ({
  buildDeployTransaction: mocks.build,
  estimateUnprovenTransactionFee: mocks.estimate,
  ensureFeeReady: mocks.ensureFee,
  submitUnprovenTransaction: mocks.submit,
}));
vi.mock('../src/midnight/caller.mjs', () => ({
  compiledContract: {},
  PRIVATE_STATE_ID: 'midnight-pinger',
  pureCircuits: { operatorCommitment: () => new Uint8Array(32) },
  ledger: mocks.ledger,
}));

import {
  deriveMidnightResponseKey,
  getMpcRootPublicKey,
  MidnightNetwork,
} from '@sig-net/midnight';

const address = '33'.repeat(32);
const central = '44'.repeat(32);
const metadata = {
  contractAddress: address,
  centralAddress: central,
  networkId: 'stagenet',
  destinationChainId: '11155111',
};
const originalArgv = process.argv;
let directory: string;
const receiptPath = () => resolve(directory, 'deployment.json');
const receipt = async () => JSON.parse(await readFile(receiptPath(), 'utf8'));
async function run(...args: string[]) {
  vi.resetModules();
  process.argv = ['node', resolve('scripts/deploy-midnight.mts'), ...args];
  await import('../scripts/deploy-midnight.mjs');
}

beforeEach(async () => {
  vi.resetAllMocks();
  const root = resolve('.midnight/tests');
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(resolve(root, 'deployment-'));
  const rootPublicKey = getMpcRootPublicKey(MidnightNetwork.Stagenet);
  mocks.config.mockReturnValue({
    stateDirectory: directory,
    centralAddress: central,
    rootPublicKey,
    operatorSecret: new Uint8Array(32).fill(17),
    node: { networkId: 'stagenet' },
  });
  mocks.session.mockResolvedValue({
    wallet: { waitForSyncedState: async () => ({}) },
    keys: { shieldedSecretKeys: { coinPublicKey: '00'.repeat(32) } },
    providers: { publicDataProvider: { queryContractState: mocks.query } },
    close: mocks.close,
  });
  mocks.build.mockResolvedValue({
    contractAddress: address,
    serializedTransaction: new Uint8Array([1]),
  });
  mocks.estimate.mockResolvedValue(10n);
  mocks.submit.mockImplementation(async () => {
    expect(await receipt()).toEqual({ ...metadata, status: 'prepared' });
    return 'deployment-transaction';
  });
  mocks.find.mockResolvedValue({ callTx: { initialise: mocks.initialise } });
  mocks.query.mockResolvedValue({ data: {} });
  mocks.ledger.mockReturnValue({
    initialised: 0n,
    destinationChainId: 11155111n,
    mpcResponseKey: deriveMidnightResponseKey(rootPublicKey, address),
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  await rm(directory, { recursive: true });
});

it.each(['estimate', 'ensureFee'] as const)(
  'allows a fresh deployment after %s fails before submission',
  async phase => {
    mocks[phase].mockRejectedValueOnce(new Error('fee preparation failed'));
    await expect(run()).rejects.toThrow('fee preparation failed');
    expect(mocks.submit).not.toHaveBeenCalled();
    await expect(readFile(receiptPath())).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(mocks.close).toHaveBeenCalledOnce();
    await run();
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(await receipt()).toEqual({
      ...metadata,
      transactionId: 'deployment-transaction',
      status: 'initialised',
    });
  }
);

it.each(['prepared', 'submitted'])(
  'preserves a %s receipt and reports an unindexed caller without watching forever',
  async status => {
    const saved = { ...metadata, status };
    await writeFile(receiptPath(), JSON.stringify(saved));
    mocks.query.mockResolvedValue(null);
    mocks.find.mockRejectedValue(
      new Error('unbounded deployment watcher entered')
    );
    await expect(run('--initialise')).rejects.toThrow(
      'Caller is not indexed yet'
    );
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(await receipt()).toEqual(saved);
    expect(mocks.close).toHaveBeenCalledOnce();
  }
);

it('retains the prepared receipt after an ambiguous submission failure', async () => {
  mocks.submit.mockRejectedValueOnce(new Error('submission connection lost'));
  await expect(run()).rejects.toThrow('submission connection lost');
  expect(await receipt()).toEqual({ ...metadata, status: 'prepared' });
  await expect(run()).rejects.toThrow('already recorded/configured');
  expect(mocks.build).toHaveBeenCalledOnce();
  expect(mocks.submit).toHaveBeenCalledOnce();
});

it('checks indexed state before joining and initialises the submitted caller', async () => {
  await run();
  expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.find.mock.invocationCallOrder[0]
  );
  expect(mocks.initialise).toHaveBeenCalledOnce();
  expect(await receipt()).toMatchObject({ status: 'initialised' });
  expect(mocks.close).toHaveBeenCalledOnce();
});
