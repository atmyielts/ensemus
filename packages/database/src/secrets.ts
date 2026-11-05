// For the secret broker in workers only (enforced by lint). This role can read sealed secrets for
// the bound tenant and nothing else.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection.js';
import { sealedSecrets } from './schema.js';

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

export function revokeSecret(db: EnsemusDrizzle, organizationId: string, secretId: string) {
  return bound(db, organizationId, (tx) =>
    tx.update(sealedSecrets).set({ revokedAt: new Date() }).where(eq(sealedSecrets.id, secretId)),
  );
}
