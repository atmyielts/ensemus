// The parts of the context source that need no database. Real roles and real rows are in
// tests/integration/ai-context.test.ts.
import { createHash, randomUUID } from 'node:crypto';
import type { AgentContext, AppDatabase } from '@ensemus/database';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors';
import {
  createContextSource,
  decodeText,
  isTextMimeType,
  readTextArtifact,
  type ArtifactRow,
} from './context-source';

const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');

const rowFor = (body: Buffer, overrides: Partial<ArtifactRow> = {}): ArtifactRow => ({
  id: randomUUID(),
  objectKey: 'tenant/artifacts/one',
  mimeType: 'text/plain',
  sizeBytes: body.length,
  sha256: sha(body),
  classification: 'internal',
  ...overrides,
});

describe('which files count as text', () => {
  it.each([
    'text/plain',
    'text/markdown',
    'text/csv',
    'TEXT/PLAIN',
    'text/plain; charset=utf-8',
    'application/json',
    'application/yaml',
  ])('takes %s', (mimeType) => {
    expect(isTextMimeType(mimeType)).toBe(true);
  });

  it.each([
    'application/pdf',
    'application/octet-stream',
    'image/png',
    'application/zip',
    'textual/plain',
    '',
  ])('refuses %j', (mimeType) => {
    expect(isTextMimeType(mimeType)).toBe(false);
  });

  it('checks the bytes as well as the claim', () => {
    expect(decodeText(Buffer.from('plain words, and ünïcode'))).toBe('plain words, and ünïcode');
    expect(decodeText(Buffer.from([0x61, 0x00, 0x62]))).toBeNull();
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x61]))).toBeNull();
  });
});

describe('reading a file', () => {
  const body = Buffer.from('The file says this.');

  it('hands back text with the class and hash of its row', async () => {
    const row = rowFor(body, { classification: 'confidential' });
    const read = vi.fn(async () => body);
    expect(await readTextArtifact(row, 1000, read)).toEqual({
      id: row.id,
      classification: 'confidential',
      sha256: row.sha256,
      text: 'The file says this.',
    });
    expect(read).toHaveBeenCalledWith(row.objectKey, 1000);
  });

  it('refuses a binary type without reading any of it', async () => {
    const read = vi.fn(async () => body);
    const row = rowFor(body, { mimeType: 'application/pdf' });
    expect(await readTextArtifact(row, 1000, read)).toEqual({ refused: 'NOT_TEXT' });
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses an enormous file without reading any of it', async () => {
    const read = vi.fn(async () => body);
    const row = rowFor(body, { sizeBytes: 25 * 1024 * 1024 });
    expect(await readTextArtifact(row, 1000, read)).toEqual({ refused: 'TOO_LARGE' });
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses when the row understates the size', async () => {
    const big = Buffer.alloc(2000, 0x61);
    const row = rowFor(big, { sizeBytes: 10 });
    expect(await readTextArtifact(row, 1000, async () => big)).toEqual({ refused: 'TOO_LARGE' });
  });

  it('refuses binary bytes under a text type', async () => {
    const binary = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]);
    expect(await readTextArtifact(rowFor(binary), 1000, async () => binary)).toEqual({
      refused: 'NOT_TEXT',
    });
  });

  it('refuses bytes that are not what was attached', async () => {
    const row = rowFor(body);
    const altered = Buffer.from('The file says something else.');
    expect(await readTextArtifact(row, 1000, async () => altered)).toEqual({ refused: 'DELETED' });
  });

  it('never passes part of a file as all of it', async () => {
    const row = rowFor(body);
    const cut = body.subarray(0, 5);
    expect(await readTextArtifact(row, 1000, async () => cut)).toEqual({ refused: 'DELETED' });
  });

  it('calls a file gone only when the store clearly says so', async () => {
    const gone = Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } });
    await expect(readTextArtifact(rowFor(body), 1000, () => Promise.reject(gone))).resolves.toEqual(
      { refused: 'DELETED' },
    );
    const named = Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    await expect(
      readTextArtifact(rowFor(body), 1000, () => Promise.reject(named)),
    ).resolves.toEqual({ refused: 'DELETED' });
  });

  it('lets any other store failure surface, so the Activity retries with the file in place', async () => {
    const down = Object.assign(new Error('unavailable'), { $metadata: { httpStatusCode: 503 } });
    await expect(readTextArtifact(rowFor(body), 1000, () => Promise.reject(down))).rejects.toBe(
      down,
    );
  });

  it('treats a class it does not know as the strongest', async () => {
    const row = rowFor(body, { classification: 'not-a-class' });
    expect(await readTextArtifact(row, 1000, async () => body)).toMatchObject({
      classification: 'restricted',
    });
  });
});

describe('what is refused before any query', () => {
  const runId = randomUUID();
  /** Any query fails the test, so each refusal below is known to come before the database. */
  const database = new Proxy(
    {},
    {
      get() {
        throw new Error('The database was touched');
      },
    },
  ) as AppDatabase;
  const source = createContextSource({
    database,
    readObject: () => Promise.reject(new Error('The store was touched')),
  });
  const agent = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    membershipId: randomUUID(),
    role: 'member',
    actorType: 'agent',
    agentRunId: runId,
  } as unknown as AgentContext;
  const service = { ...agent, actorType: 'service' } as unknown as AgentContext;
  const workUnitId = randomUUID();

  const refusesWith = async (call: () => Promise<unknown>, code: AppError['code']) => {
    const error = await call().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  };

  it('refuses a service context everywhere, since it would skip every Work Unit check', async () => {
    await refusesWith(() => source.loadWork(service, workUnitId), 'FORBIDDEN');
    await refusesWith(
      () =>
        source.loadArtifactText(service, {
          workUnitId,
          artifactId: randomUUID(),
          maxBytes: 10,
        }),
      'FORBIDDEN',
    );
    await refusesWith(() => source.loadTranscript(service, runId), 'FORBIDDEN');
    await refusesWith(
      () => source.loadRunBrief(service, { runId, workUnitId, agentVersionId: randomUUID() }),
      'FORBIDDEN',
    );
  });

  it("refuses another run's transcript and brief", async () => {
    const other = randomUUID();
    await refusesWith(() => source.loadTranscript(agent, other), 'NOT_FOUND');
    await refusesWith(
      () =>
        source.loadRunBrief(agent, {
          runId: other,
          workUnitId,
          agentVersionId: randomUUID(),
        }),
      'NOT_FOUND',
    );
  });

  it('reports an ID that is no ID as not found or not permitted, without asking', async () => {
    await refusesWith(() => source.loadWork(agent, 'not-an-id'), 'NOT_FOUND');
    await expect(
      source.loadArtifactText(agent, { workUnitId, artifactId: "x' or 1=1", maxBytes: 10 }),
    ).resolves.toEqual({ refused: 'NOT_PERMITTED' });
  });

  it('needs a real byte limit', async () => {
    for (const maxBytes of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      await refusesWith(
        () => source.loadArtifactText(agent, { workUnitId, artifactId: randomUUID(), maxBytes }),
        'INVALID_INPUT',
      );
    }
  });
});
