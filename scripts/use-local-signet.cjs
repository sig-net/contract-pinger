// Build and install the package consumers receive, including CommonJS declarations.
const { spawnSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const pinger = resolve(__dirname, '..');
const sdk = resolve(process.argv[2] || resolve(pinger, '../signet.js'));
const archive = resolve(pinger, '.local/signet-http.tgz');
mkdirSync(resolve(pinger, '.local'), { recursive: true });
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run('corepack', ['yarn', 'build'], sdk);
run('corepack', ['yarn', 'pack', '--out', archive], sdk);
run('pnpm', ['add', '@sig-net/signet.js@file:.local/signet-http.tgz'], pinger);
console.log('Local signet.js installed. Run pnpm dev to start pinger.');
