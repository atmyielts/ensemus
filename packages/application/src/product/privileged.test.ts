import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { withPrivilegeTx } from './privileged';

describe('interactive trigger refusal translation', () => {
  const context = createServiceContext(randomUUID());
  it('returns the completed effect value', async () => {
    const database = { transaction: async () => 42 } as unknown as AppDatabase;
    expect(await withPrivilegeTx(database, context, async () => 0)).toBe(42);
  });
  it('turns a nested trigger denial into fixed human-safe MFA_REQUIRED', async () => {
    const database = {
      transaction: async () => {
        throw new Error('SQL with confidential parameters', { cause: { code: 'EN405' } });
      },
    } as unknown as AppDatabase;
    await expect(withPrivilegeTx(database, context, async () => 0)).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
      message: 'Confirm it is you with your authenticator app, then try again.',
    });
  });
  it('preserves unrelated database failures', async () => {
    const error = { code: '40001' },
      database = {
        transaction: async () => {
          throw error;
        },
      } as unknown as AppDatabase;
    await expect(withPrivilegeTx(database, context, async () => 0)).rejects.toBe(error);
  });
  it('preserves a required company sign-in refusal instead of asking for another factor', async () => {
    const database = {
      transaction: async () => {
        throw new Error('Private SQL parameters', { cause: { code: 'EN410' } });
      },
    } as unknown as AppDatabase;
    await expect(withPrivilegeTx(database, context, async () => 0)).rejects.toMatchObject({
      code: 'SSO_REQUIRED',
      message: 'This organization asks you to sign in through its identity provider.',
    });
  });
});
