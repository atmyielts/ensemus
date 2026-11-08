// Control-order doubles only. Actual restore/operator/native role proof belongs to the0422/0512 gate.
import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { EnsemusDrizzle } from './connection';
import {
  attestNativePaymentIdentity,
  attestNativePaymentWebhook,
  attestNativePaymentLookup,
  readSealedSecret,
} from './secrets';

function database(generation: string | null) {
  const queries: string[] = [];
  const dialect = new PgDialect();
  const select = vi.fn(() => {
    throw new Error('TEST_SECRET_BODY_MUST_NOT_BE_READ');
  });
  const tx = {
    select,
    execute: vi.fn(async (query: SQL) => {
      const parsed = dialect.sqlToQuery(query);
      queries.push(parsed.sql);
      if (parsed.sql.includes('current_auth_restore_generation')) {
        if (generation === null)
          throw Object.assign(new Error('RESTORE_ADMISSION_REQUIRED'), { code: 'EN422' });
        return { rows: [{ generation }] };
      }
      throw new Error('TEST_STALE_PROOF_MUST_NOT_REACH_SCOPE_OR_ATTESTER');
    }),
  };
  const db = {
    transaction: async <T>(fn: (value: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as EnsemusDrizzle;
  return { db, queries, select };
}
const identity = () => ({
  organizationId: randomUUID(),
  paymentId: randomUUID(),
  billingOrganizationId: randomUUID(),
  connectionId: randomUUID(),
  processor: 'test_scripted',
  adapterVersion: '1.0.0',
  apiOrigin: 'https://generated.mcp.invalid',
  authoritySha256: 'a'.repeat(64),
  identitySha256: 'b'.repeat(64),
  accountNamespaceSha256: 'c'.repeat(64),
  readReceiptSha256: 'd'.repeat(64),
  restoreGeneration: randomUUID(),
});
const webhook = () => ({
  organizationId: randomUUID(),
  deliveryId: randomUUID(),
  rowVersion: '1',
  endpointId: randomUUID(),
  connectionId: randomUUID(),
  signingSecretId: randomUUID(),
  processor: 'test_scripted',
  adapterVersion: '1.0.0',
  providerEventId: randomUUID(),
  bodySha256: 'a'.repeat(64),
  requestDigest: 'b'.repeat(64),
  headersSha256: 'c'.repeat(64),
  factSha256: 'd'.repeat(64),
  accountNamespaceSha256: null,
  executionIdentitySha256: null,
  restoreGeneration: randomUUID(),
});
const lookup = () => ({
  organizationId: randomUUID(),
  paymentId: randomUUID(),
  attemptId: randomUUID(),
  executionBindingId: randomUUID(),
  lookupOperationId: randomUUID(),
  restoreGeneration: randomUUID(),
  authoritySha256: 'a'.repeat(64),
  requestKeySha256: 'b'.repeat(64),
  factCanonical: '{"found":"not_found"}',
});
const attest = (kind: 'identity' | 'webhook' | 'lookup', db: EnsemusDrizzle) =>
  kind === 'identity'
    ? attestNativePaymentIdentity(db, identity())
    : kind === 'webhook'
      ? attestNativePaymentWebhook(db, webhook())
      : attestNativePaymentLookup(db, lookup());
describe('native secret/payment restore admission ordering', () => {
  it('denies a pending restore before selecting a sealed secret or establishing a tenant scope', async () => {
    const d = database(null);
    await expect(readSealedSecret(d.db, randomUUID(), randomUUID())).rejects.toMatchObject({
      code: 'EN422',
    });
    expect(d.select).not.toHaveBeenCalled();
    expect(d.queries).toHaveLength(1);
    expect(d.queries[0]).toContain('app.current_auth_restore_generation()');
  });
  it.each(['identity', 'webhook', 'lookup'] as const)(
    'denies cached %s evidence before direct tenant scope or token mint',
    async (kind) => {
      const d = database(randomUUID());
      await expect(attest(kind, d.db)).rejects.toThrow('PAYMENT_RESTORE_GENERATION_CHANGED');
      expect(d.queries).toHaveLength(1);
      expect(d.queries[0]).toContain('app.current_auth_restore_generation()');
      expect(d.select).not.toHaveBeenCalled();
    },
  );
  it.each(['identity', 'webhook', 'lookup'] as const)(
    'denies %s attestation while restore is pending',
    async (kind) => {
      const d = database(null);
      await expect(attest(kind, d.db)).rejects.toMatchObject({ code: 'EN422' });
      expect(d.queries).toHaveLength(1);
    },
  );
});
