import { randomUUID } from 'node:crypto';
import { createServiceContext } from '@ensemus/database/service';
import type { TenantContext, Tx } from '@ensemus/database';
import { describe, expect, it, vi } from 'vitest';
import {
  artifactRetentionAuthorityInTx,
  assertArtifactRetentionInTx,
  type ArtifactRetentionAuthority,
} from './retention-authority';
import { createRawFilesRetentionSource } from './retention';

describe('retention authority and cursor boundaries', () => {
  const context = createServiceContext(randomUUID()),
    tx = {} as Tx,
    artifactId = randomUUID(),
    ruleId = randomUUID(),
    cutoff = new Date('2040-01-01T00:00:00.000Z');
  it('a user cannot mint an expiry authority', () => {
    const user = { ...context, actorType: 'user' } as TenantContext;
    expect(() => artifactRetentionAuthorityInTx(tx, user, { artifactId, ruleId, cutoff })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
  it('client data cannot stand in for the opaque proof', async () => {
    await expect(
      assertArtifactRetentionInTx(tx, context, artifactId, {} as ArtifactRetentionAuthority),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('binds the authority to its exact transaction, tenant and artifact', async () => {
    const proof = artifactRetentionAuthorityInTx(tx, context, { artifactId, ruleId, cutoff });
    for (const [transaction, who, id] of [
      [{} as Tx, context, artifactId],
      [tx, createServiceContext(randomUUID()), artifactId],
      [tx, context, randomUUID()],
    ] as const)
      await expect(assertArtifactRetentionInTx(transaction, who, id, proof)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
  });
  it('binds each source cursor to tenant, classification, cutoff and immutable rule version', async () => {
    const execute = vi
        .fn()
        .mockResolvedValue({ rows: [{ id: artifactId, at: '2039-01-01T00:00:00.123456Z' }] }),
      transaction = { execute } as unknown as Tx,
      source = createRawFilesRetentionSource(undefined),
      input = { before: cutoff, classification: 'internal', ruleId, limit: 2, after: null };
    const page = await source.findExpiredPage!(transaction, context, input),
      after = page.records[0]!.cursor;
    expect(page.more).toBe(false);
    expect(after).not.toContain(artifactId);
    for (const [who, changes] of [
      [createServiceContext(randomUUID()), {}],
      [context, { classification: 'restricted' }],
      [context, { before: new Date('2040-01-02T00:00:00.000Z') }],
      [context, { ruleId: randomUUID() }],
    ] as const)
      await expect(
        source.findExpiredPage!(transaction, who, { ...input, ...changes, after }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(Buffer.from(after, 'base64url').toString('utf8')).at).toBe(
      '2039-01-01T00:00:00.123456Z',
    );
  });
});
