// For the secret broker in workers only (enforced by lint). This role can read sealed secrets for
// the bound tenant and nothing else.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection';
import { sealedSecrets } from './schema';

export type SealedSecretRow = typeof sealedSecrets.$inferSelect;

export function openSecretsDatabase(url: string) {
  return openDatabase(url, { max: 3 });
}

async function bound<T>(
  db: EnsemusDrizzle,
  organizationId: string,
  fn: (tx: Parameters<Parameters<EnsemusDrizzle['transaction']>[0]>[0]) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    // Native secret reads/rotation never run during pending restore, even through a direct GUC scope.
    await tx.execute(sql`select app.current_auth_restore_generation()`);
    await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
    return fn(tx);
  });
}

export async function readSealedSecret(
  db: EnsemusDrizzle,
  organizationId: string,
  secretId: string,
): Promise<SealedSecretRow | null> {
  const rows = await bound(db, organizationId, (tx) =>
    tx
      .select()
      .from(sealedSecrets)
      .where(and(eq(sealedSecrets.id, secretId), isNull(sealedSecrets.revokedAt))),
  );
  return rows[0] ?? null;
}

export function listTenantSecrets(db: EnsemusDrizzle, organizationId: string) {
  return bound(db, organizationId, (tx) =>
    tx.select().from(sealedSecrets).where(isNull(sealedSecrets.revokedAt)),
  );
}

export function replaceWrappedKey(
  db: EnsemusDrizzle,
  organizationId: string,
  secretId: string,
  wrapped: { keyId: string; wrappedKey: Buffer },
) {
  return bound(db, organizationId, (tx) =>
    tx.update(sealedSecrets).set(wrapped).where(eq(sealedSecrets.id, secretId)),
  );
}

/** A whole new seal for one secret: a fresh data key, wrapped, and the value under it. */
export type ResealedFields = {
  keyId: string;
  wrappedKey: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
};

/**
 * Replaces a live secret's sealed value in place, under the same ID, tenant and purpose (0562). The row
 * is locked first, so two refreshes that both rotated cannot both write: the second sees the first's
 * value, and `reseal` answers null for it. `reseal` runs inside the lock and decides from the row it is
 * handed. 'missing' covers gone, revoked and another purpose alike.
 */
export function resealSecret(
  db: EnsemusDrizzle,
  binding: { organizationId: string; secretId: string; purpose: string },
  reseal: (row: SealedSecretRow) => ResealedFields | null,
): Promise<'stored' | 'stale' | 'missing'> {
  return bound(db, binding.organizationId, async (tx) => {
    const live = and(
      eq(sealedSecrets.id, binding.secretId),
      eq(sealedSecrets.purpose, binding.purpose),
      isNull(sealedSecrets.revokedAt),
    );
    const [row] = await tx.select().from(sealedSecrets).where(live).for('update');
    if (!row) return 'missing';
    const next = reseal(row);
    if (!next) return 'stale';
    const written = await tx
      .update(sealedSecrets)
      .set(next)
      .where(live)
      .returning({ id: sealedSecrets.id });
    return written.length === 1 ? 'stored' : 'missing';
  });
}

/** One sweep's worth. A tenant with more is caught up by the sweeps after it. */
const LIVE_SECRET_LIST_LIMIT = 1000;

/**
 * The tenant's sealed values of these purposes that are not yet revoked: IDs, purposes and when each was
 * sealed, never a value. The consent sweep reads what is still live here, because the application role
 * sees no more of this table than its tenant column.
 */
export function listLiveSecretsByPurpose(
  db: EnsemusDrizzle,
  organizationId: string,
  purposes: readonly string[],
): Promise<{ id: string; purpose: string; createdAt: Date }[]> {
  if (purposes.length === 0) return Promise.resolve([]);
  return bound(db, organizationId, (tx) =>
    tx
      .select({
        id: sealedSecrets.id,
        purpose: sealedSecrets.purpose,
        createdAt: sealedSecrets.createdAt,
      })
      .from(sealedSecrets)
      .where(and(inArray(sealedSecrets.purpose, [...purposes]), isNull(sealedSecrets.revokedAt)))
      .limit(LIVE_SECRET_LIST_LIMIT),
  );
}

export function revokeSecret(db: EnsemusDrizzle, organizationId: string, secretId: string) {
  return bound(db, organizationId, (tx) =>
    tx.update(sealedSecrets).set({ revokedAt: new Date() }).where(eq(sealedSecrets.id, secretId)),
  );
}

/** Fixed payment metadata calls for the native broker. The worker verifies its process-local native
 * proof before calling these; SQL still verifies the actual secrets login and original live binding.
 * This layer accepts no raw body, header, config, credential or arbitrary SQL. */
export type PaymentIdentityAttestationInput = {
  organizationId: string;
  paymentId: string;
  billingOrganizationId: string;
  connectionId: string;
  processor: string;
  adapterVersion: string;
  apiOrigin: string;
  authoritySha256: string;
  identitySha256: string;
  accountNamespaceSha256: string;
  readReceiptSha256: string;
  restoreGeneration: string;
};
export type PaymentWebhookAttestationInput = {
  organizationId: string;
  deliveryId: string;
  rowVersion: string;
  restoreGeneration: string;
  endpointId: string;
  connectionId: string;
  signingSecretId: string;
  processor: string;
  adapterVersion: string;
  providerEventId: string;
  bodySha256: string;
  requestDigest: string;
  headersSha256: string;
  factSha256: string;
  accountNamespaceSha256: string | null;
  executionIdentitySha256: string | null;
};
type PaymentAttestation = { token: string; expiresAt: Date };
async function assertPaymentGeneration(
  tx: Parameters<Parameters<EnsemusDrizzle['transaction']>[0]>[0],
  expected: string,
) {
  const current = await tx.execute<{ generation: string }>(
    sql`select app.current_auth_restore_generation() as generation`,
  );
  if (current.rows.length !== 1 || current.rows[0]?.generation !== expected)
    throw new Error('PAYMENT_RESTORE_GENERATION_CHANGED');
}
// drizzle's node-postgres driver hands timestamptz back as PostgreSQL's text form from `execute`, never a
// Date, so the expiry is parsed here. Anything that does not parse to a real instant is still refused.
type PaymentAttestationRow = { token: string; expiresAt: Date | string };
const paymentAttestation = (rows: PaymentAttestationRow[]): PaymentAttestation => {
  const row = rows[0];
  const expiresAt =
    row?.expiresAt instanceof Date
      ? row.expiresAt
      : typeof row?.expiresAt === 'string'
        ? new Date(row.expiresAt)
        : null;
  if (
    rows.length !== 1 ||
    !row ||
    typeof row.token !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row.token) ||
    !expiresAt ||
    !Number.isFinite(expiresAt.getTime())
  )
    throw new Error('PAYMENT_ATTESTATION_UNAVAILABLE');
  return { token: row.token, expiresAt };
};

export function attestNativePaymentIdentity(
  db: EnsemusDrizzle,
  input: PaymentIdentityAttestationInput,
): Promise<PaymentAttestation> {
  return db.transaction(async (tx) => {
    await assertPaymentGeneration(tx, input.restoreGeneration);
    await tx.execute(
      sql`select set_config('app.organization_id',${input.billingOrganizationId},true)`,
    );
    const result =
      await tx.execute<PaymentAttestationRow>(sql`select * from billing.attest_payment_identity(
      ${input.organizationId}::uuid,${input.paymentId}::uuid,${input.billingOrganizationId}::uuid,${input.connectionId}::uuid,
      ${input.processor},${input.adapterVersion},${input.apiOrigin},${input.authoritySha256},${input.identitySha256},
      ${input.accountNamespaceSha256},${input.readReceiptSha256},${input.restoreGeneration}::uuid)`);
    return paymentAttestation(result.rows);
  });
}

export function attestNativePaymentWebhook(
  db: EnsemusDrizzle,
  input: PaymentWebhookAttestationInput,
): Promise<PaymentAttestation> {
  return db.transaction(async (tx) => {
    await assertPaymentGeneration(tx, input.restoreGeneration);
    await tx.execute(sql`select set_config('app.organization_id',${input.organizationId},true)`);
    const result =
      await tx.execute<PaymentAttestationRow>(sql`select * from billing.attest_payment_webhook(
      ${input.deliveryId}::uuid,${input.rowVersion},${input.endpointId}::uuid,${input.connectionId}::uuid,${input.signingSecretId}::uuid,
      ${input.processor},${input.adapterVersion},${input.providerEventId},${input.bodySha256},${input.requestDigest},${input.headersSha256},
      ${input.factSha256},${input.accountNamespaceSha256},${input.executionIdentitySha256},${input.restoreGeneration}::uuid)`);
    return paymentAttestation(result.rows);
  });
}

/** Only the existing secrets-role worker may call this after checking the process-local native brand. */
export function attestNativePaymentLookup(
  db: EnsemusDrizzle,
  input: {
    organizationId: string;
    paymentId: string;
    attemptId: string;
    executionBindingId: string;
    lookupOperationId: string;
    restoreGeneration: string;
    authoritySha256: string;
    requestKeySha256: string;
    factCanonical: string;
  },
): Promise<PaymentAttestation> {
  return db.transaction(async (tx) => {
    await assertPaymentGeneration(tx, input.restoreGeneration);
    await tx.execute(sql`select set_config('app.organization_id',${input.organizationId},true)`);
    const result =
      await tx.execute<PaymentAttestationRow>(sql`select * from billing.attest_payment_lookup(
      ${input.organizationId}::uuid,${input.paymentId}::uuid,${input.attemptId}::uuid,${input.executionBindingId}::uuid,
      ${input.lookupOperationId}::uuid,${input.restoreGeneration}::uuid,${input.authoritySha256},
      ${input.requestKeySha256},${input.factCanonical})`);
    return paymentAttestation(result.rows);
  });
}
