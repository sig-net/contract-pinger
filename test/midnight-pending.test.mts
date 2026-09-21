import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  pendingRequestStore,
  type PendingRequest,
} from '../src/midnight/pending.mjs';
const folders: string[] = [];
const record: PendingRequest = {
  callerAddress: '11'.repeat(32),
  centralAddress: '22'.repeat(32),
  requestId: '33'.repeat(32),
  path: 'load-0',
  nonce: 7,
  createdAt: new Date(0).toISOString(),
};
async function fixture() {
  const root = resolve('.midnight/tests');
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(resolve(root, 'pending-'));
  folders.push(folder);
  return { folder, store: pendingRequestStore(folder) };
}
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true });
});
it('persists public recovery data and refuses another request after restart', async () => {
  const { folder, store } = await fixture();
  await store.assertEmpty();
  await store.create(record);
  await expect(pendingRequestStore(folder).assertEmpty()).rejects.toThrow(
    record.requestId
  );
  await expect(
    store.create({ ...record, requestId: '44'.repeat(32) })
  ).rejects.toThrow();
  expect(await store.read()).toEqual(record);
  expect((await stat(store.filename)).mode & 0o777).toBe(0o600);
});
it('retains source and settlement attempts until the same request is cleared', async () => {
  const { store } = await fixture();
  await store.create(record);
  await store.update(record.requestId, { sourceTx: 'source-identifier' });
  await store.update(record.requestId, {
    settlementTx: 'settlement-identifier',
  });
  expect(await store.read()).toMatchObject({
    ...record,
    sourceTx: 'source-identifier',
    settlementTx: 'settlement-identifier',
  });
  await expect(
    store.update('44'.repeat(32), { sourceTx: 'wrong' })
  ).rejects.toThrow(/changed/);
  await expect(store.clear('44'.repeat(32))).rejects.toThrow(/changed/);
  await store.clear(record.requestId);
  await store.assertEmpty();
});
it('fails closed on corrupt recovery data and does not serialize private fields', async () => {
  const { store } = await fixture();
  await store.create({
    ...record,
    secretKey: 'private-witness',
  } as PendingRequest);
  expect(await readFile(store.filename, 'utf8')).not.toContain(
    'private-witness'
  );
  await writeFile(store.filename, '{}');
  await expect(store.assertEmpty()).rejects.toThrow();
});
