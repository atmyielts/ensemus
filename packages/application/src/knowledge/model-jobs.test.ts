// A qualification request refused by the erasure birth fence (0533, FOR SHARE NOWAIT on the tenant's
// organization row) while a purge holds that row did nothing, and its caller hears TENANT_BUSY, not 500.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { requestModelQualification } from './model-jobs';

const context = createServiceContext(randomUUID());
const request = () => ({
  profileId: randomUUID(),
  expectedProfileVersion: 1,
  purpose: 'embed' as const,
  dimension: 4,
  vectorSpaceVersion: 'generated-v1',
  requestKey: randomUUID(),
  bounds: {
    maxCalls: 1,
    maxInputTokens: 64,
    maxOutputTokens: 64,
    maxTotalTokens: 128,
    maxCostMicros: 0,
    timeoutSeconds: 60,
  },
});
const refusing = (code: string) => {
  const error = new Error('Private SQL', { cause: { code } });
  return {
    error,
    database: { transaction: vi.fn().mockRejectedValue(error) } as unknown as AppDatabase,
  };
};

describe('a model qualification request refused by lock contention', () => {
  it('answers TENANT_BUSY, once, for 55P03', async () => {
    const { database } = refusing('55P03');
    await expect(requestModelQualification(database, context, request())).rejects.toMatchObject({
      code: 'TENANT_BUSY',
      message:
        'This organization is busy with another change right now, so nothing was changed. Try again in a moment.',
    });
    // Nothing is resent here: the caller decides, with the same request key.
    expect(database.transaction).toHaveBeenCalledTimes(1);
  });

  it.each(['40001', '23505', '42501'])('preserves unrelated database refusal %s', async (code) => {
    const { error, database } = refusing(code);
    await expect(requestModelQualification(database, context, request())).rejects.toBe(error);
  });

  it('refuses a malformed request before it reaches the database', async () => {
    const { database } = refusing('55P03');
    await expect(
      requestModelQualification(database, context, { ...request(), requestKey: 'not-an-id' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
