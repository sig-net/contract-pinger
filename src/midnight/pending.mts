import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const pendingSchema = z.object({
  callerAddress: z.string().regex(/^[\da-f]{64}$/i),
  centralAddress: z.string().regex(/^[\da-f]{64}$/i),
  requestId: z.string().regex(/^[\da-f]{64}$/i),
  path: z.string(),
  nonce: z.number().int().nonnegative(),
  createdAt: z.string(),
  sourceTx: z.string().min(1).optional(),
  settlementTx: z.string().min(1).optional(),
});
export type PendingRequest = z.infer<typeof pendingSchema>;

/** Public recovery data only. Transaction identifiers describe attempts, not confirmation. */
export function pendingRequestStore(stateDirectory: string) {
  const filename = resolve(stateDirectory, 'pending-request.json');
  const read = async (): Promise<PendingRequest | undefined> => {
    try {
      return pendingSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const write = async (target: string, record: PendingRequest) => {
    const file = await open(target, 'wx', 0o600);
    try {
      await file.writeFile(
        JSON.stringify(pendingSchema.parse(record), null, 2) + '\n'
      );
      await file.sync();
    } finally {
      await file.close();
    }
  };
  const requireCurrent = async (requestId: string) => {
    const current = await read();
    if (!current || current.requestId !== requestId)
      throw new Error(
        'Midnight pending request changed; refusing recovery metadata update'
      );
    return current;
  };
  return {
    filename,
    read,
    async assertEmpty() {
      const pending = await read();
      if (pending)
        throw new Error(
          `Midnight request ${pending.requestId} requires reconciliation before another submission. Inspect ${filename}${pending.sourceTx ? ` (source transaction ${pending.sourceTx})` : ''}`
        );
    },
    async create(record: PendingRequest) {
      await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
      await write(filename, record);
    },
    async update(
      requestId: string,
      patch: Pick<Partial<PendingRequest>, 'sourceTx' | 'settlementTx'>
    ) {
      const current = await requireCurrent(requestId);
      const temporary = `${filename}.${randomUUID()}.tmp`;
      await write(temporary, { ...current, ...patch });
      await rename(temporary, filename);
    },
    async clear(requestId: string) {
      await requireCurrent(requestId);
      await unlink(filename);
    },
  };
}
