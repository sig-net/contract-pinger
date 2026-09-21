import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  derivePingerSeed,
  resolveMidnightConfig,
  resolveMidnightIdentity,
} from '../src/midnight/config.mjs';
import { deriveMidnightWorkers } from '../src/midnight/derivation.mjs';

const centralAddress =
  '1df4ce25fc9f9c03dc6f4d0eb12ddf3d0db094995d4c70aca1142eebb3b77a5d';
const receiptMetadata = {
  centralAddress,
  networkId: 'stagenet',
  destinationChainId: '11155111',
};
const directories: string[] = [];
const temporary = () => {
  const root = resolve(process.cwd(), '.midnight/tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(resolve(root, 'config-'));
  directories.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true });
});

describe('Midnight deployment and wallet configuration', () => {
  it('requires a dedicated wallet even when a treasury seed is present', () => {
    expect(() =>
      resolveMidnightConfig(
        {
          MPC_MIDNIGHT_STATE_DIR: temporary(),
          MPC_MIDNIGHT_FUNDING_SEED: '11'.repeat(32),
        },
        false
      )
    ).toThrow();
  });
  it('allows resuming a prepared or submitted deployment without enabling it for jobs', () => {
    const values = {
      MPC_MIDNIGHT_STATE_DIR: temporary(),
      MPC_MIDNIGHT_PINGER_SEED: '22'.repeat(32),
    };
    for (const status of ['prepared', 'submitted']) {
      writeFileSync(
        resolve(values.MPC_MIDNIGHT_STATE_DIR, 'deployment.json'),
        JSON.stringify({
          ...receiptMetadata,
          status,
          contractAddress: '33'.repeat(32),
        })
      );
      expect(
        resolveMidnightConfig(values, false).callerAddress
      ).toBeUndefined();
      expect(() => resolveMidnightConfig(values)).toThrow(
        /deploy and initialise/
      );
    }
    writeFileSync(
      resolve(values.MPC_MIDNIGHT_STATE_DIR, 'deployment.json'),
      JSON.stringify({
        ...receiptMetadata,
        status: 'initialised',
        contractAddress: '33'.repeat(32),
      })
    );
    expect(resolveMidnightConfig(values).callerAddress).toBe('33'.repeat(32));
  });
  it('rejects a receipt pointing to another central contract or network', () => {
    const dir = temporary();
    const receipt = {
      ...receiptMetadata,
      status: 'initialised',
      contractAddress: '33'.repeat(32),
    };
    writeFileSync(resolve(dir, 'deployment.json'), JSON.stringify(receipt));
    expect(() =>
      resolveMidnightIdentity({
        MPC_MIDNIGHT_STATE_DIR: dir,
        MPC_MIDNIGHT_CENTRAL_ADDRESS: '55'.repeat(32),
      })
    ).toThrow(/receipt/);
    writeFileSync(
      resolve(dir, 'deployment.json'),
      JSON.stringify({ ...receipt, networkId: 'preview' })
    );
    expect(() =>
      resolveMidnightIdentity({ MPC_MIDNIGHT_STATE_DIR: dir })
    ).toThrow();
  });
  it('derives Ethereum payees using only public inputs', () => {
    const values = {
      MPC_MIDNIGHT_STATE_DIR: temporary(),
      MPC_MIDNIGHT_CALLER_ADDRESS: '33'.repeat(32),
    };
    const workers = deriveMidnightWorkers(['load-0'], values);
    expect(workers).toHaveLength(1);
    expect(workers[0].address).toMatch(/^0x[\da-fA-F]{40}$/);
    expect(deriveMidnightWorkers(['load-1'], values)[0].address).not.toBe(
      workers[0].address
    );
    expect(
      deriveMidnightWorkers(['load-0'], {
        ...values,
        MPC_MIDNIGHT_CALLER_ADDRESS: '44'.repeat(32),
      })[0].address
    ).not.toBe(workers[0].address);
  });
  it('uses the dedicated saved seed and the supplied public endpoint names', () => {
    const dir = temporary();
    writeFileSync(
      resolve(dir, 'pinger.env'),
      `MPC_MIDNIGHT_PINGER_SEED=${'22'.repeat(32)}\n`
    );
    const config = resolveMidnightConfig({
      MPC_MIDNIGHT_STATE_DIR: dir,
      MPC_MIDNIGHT_CALLER_ADDRESS: '33'.repeat(32),
      MPC_MIDNIGHT_PROOF_SERVER_URL: 'http://midnight-proof-server:6300/',
    });
    expect(config.seed).toBe('22'.repeat(32));
    expect(config.node.networkId).toBe('stagenet');
    expect(config.node.proofServerUrl).toBe(
      'http://midnight-proof-server:6300/'
    );
    expect(Buffer.from(config.operatorSecret).toString('hex')).not.toBe(
      config.seed
    );
  });
  it('keeps endpoint overrides independent and ignores unrelated SDK environment', () => {
    const values = {
      MPC_MIDNIGHT_STATE_DIR: temporary(),
      MPC_MIDNIGHT_PINGER_SEED: '22'.repeat(32),
      MPC_MIDNIGHT_CALLER_ADDRESS: '33'.repeat(32),
      NETWORK_ID: 'mainnet',
      MIDNIGHT_NODE_URL: 'https://unrelated.invalid',
    };
    const defaults = resolveMidnightConfig(values).node;
    expect(defaults.networkId).toBe('stagenet');
    expect(defaults.nodeUrl).toBe('https://rpc.stagenet.shielded.tools');
    for (const [variable, field, url] of [
      ['MPC_MIDNIGHT_NODE_URL', 'nodeUrl', 'https://node.invalid'],
      [
        'MPC_MIDNIGHT_INDEXER_URL',
        'indexerUrl',
        'https://indexer.invalid/graphql',
      ],
      [
        'MPC_MIDNIGHT_INDEXER_WS_URL',
        'indexerWsUrl',
        'wss://events.invalid/ws',
      ],
      [
        'MPC_MIDNIGHT_PROOF_SERVER_URL',
        'proofServerUrl',
        'http://proof.invalid',
      ],
    ] as const) {
      expect(
        resolveMidnightConfig({ ...values, [variable]: '  ' }).node
      ).toEqual(defaults);
      expect(
        resolveMidnightConfig({ ...values, [variable]: `  ${url}  ` }).node
      ).toEqual({
        ...defaults,
        [field]: url,
      });
      expect(
        resolveMidnightConfig({
          ...values,
          [variable]: url.replace('.invalid', '\n.invalid'),
        }).node
      ).toEqual({ ...defaults, [field]: url });
      expect(() =>
        resolveMidnightConfig({ ...values, [variable]: 'invalid' })
      ).toThrow();
    }
  });
  it('fails on a malformed receipt instead of silently switching callers', () => {
    const dir = temporary();
    writeFileSync(resolve(dir, 'deployment.json'), 'invalid json');
    expect(() =>
      resolveMidnightIdentity({ MPC_MIDNIGHT_STATE_DIR: dir })
    ).toThrow();
  });
  it('derives a stable child identity distinct from its treasury', () => {
    const root = '11'.repeat(32);
    expect(derivePingerSeed(root)).toBe(derivePingerSeed(root.toUpperCase()));
    expect(derivePingerSeed(root)).not.toBe(root);
    expect(derivePingerSeed('22'.repeat(32))).not.toBe(derivePingerSeed(root));
    expect(() => derivePingerSeed('bad')).toThrow();
  });
});
