import { spawnSync } from 'node:child_process';
import {
  lstat,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const managed = resolve(root, 'contracts/midnight/managed');
const central = await realpath(
  resolve(dirname(require.resolve('@sig-net/midnight-contract')), 'managed')
);
const link = resolve(root, 'contracts/midnight/SignetSigner');
try {
  await symlink(relative(dirname(link), central), link, 'dir');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (
    !(await lstat(link)).isSymbolicLink() ||
    (await realpath(link)) !== central
  ) {
    throw new Error(
      `${link} exists but does not link to the installed Signet contract assets`
    );
  }
}

const full = process.argv.includes('--zk');
const args = process.env.COMPACTC ? [] : ['compile', '+0.33.0-rc.2'];
if (!full) args.push('--skip-zk');
args.push('--feature-zkir-v3', 'contracts/midnight/pinger.compact', managed);
const compiled = spawnSync(process.env.COMPACTC || 'compact', args, {
  cwd: root,
  env: { ...process.env, COMPACT_PATH: resolve(root, 'node_modules') },
  stdio: 'inherit',
});
if (compiled.error) throw compiled.error;
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
await writeFile(resolve(managed, 'package.json'), '{"type":"module"}\n');

if (full) {
  // Use the runtime provider to validate manifest hashes and load every proof
  // bundle, including the central signBidirectional cross-contract call.
  for (const assets of [managed, central]) {
    const info = JSON.parse(
      await readFile(resolve(assets, 'compiler/contract-info.json'), 'utf8')
    );
    const provider = new NodeZkConfigProvider(assets);
    for (const circuit of info.circuits.filter(circuit => circuit.proof)) {
      await provider.get(circuit.name);
      console.log(`Verified proof assets: ${circuit.name}`);
    }
  }
}
