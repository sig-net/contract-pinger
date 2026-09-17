import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Same prerelease/checksum as midnight-integration's ledger-9 toolchain.
const version = '0.33.0-rc.2';
const checksum =
  '3055ab92bbc8d5bb0d6282b661b83761d2a0de2ee37e21cf7107e25aaf2a9aad';
if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(
    'The pinned installer requires Linux x64; build Docker with --platform=linux/amd64'
  );
}
if (!process.argv[2])
  throw new Error('Usage: node scripts/install-compact.mjs <tool-directory>');
const target = resolve(process.argv[2]);
await mkdir(target, { recursive: true });
const archive = resolve(target, 'compact.zip');
const response = await fetch(
  `https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v${version}/compactc_v${version}_x86_64-unknown-linux-musl.zip`
);
if (!response.ok)
  throw new Error(`Compact download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== checksum) {
  throw new Error('Compact compiler archive checksum mismatch');
}
await writeFile(archive, bytes);
execFileSync('unzip', ['-qo', archive, '-d', target], { stdio: 'inherit' });
for (const name of await readdir(target)) {
  if (name !== 'compact.zip') await chmod(resolve(target, name), 0o755);
}
console.log(`Installed Compact ${version} in ${target}`);
