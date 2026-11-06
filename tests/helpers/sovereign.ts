// Test seeds for ADR-030, shared by every M6 slice. Generated keys and values only: nothing here is real, and
// everything signed here says it was signed with a test key.
import { createHash, randomUUID } from 'node:crypto';
import {
  licenseRecords,
  organizationExports,
  organizationImports,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import {
  exportRecipientPublicKey,
  generateRecipientKeyPair,
  recipientKeyId,
} from '@ensemus/sovereign/sealed';
import {
  generateTestSigningKey,
  signForTest,
  testLicense,
  testTrustRoot,
  type TestSigningKey,
} from '@ensemus/sovereign/testing';

export const sha256Hex = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

/** A key, and a trust root that believes it. A new pair each call, so tests cannot lean on each other. */
export function testKeyring(keyId = 'test-key-1') {
  const key = generateTestSigningKey(keyId);
  return { key, trustRoot: testTrustRoot([key]) };
}

/** A pair for sealing, as the customer's own tool would make one. */
export function testRecipient() {
  const { publicKey, privateKey } = generateRecipientKeyPair();
  return {
    publicKey,
    privateKey,
    publicKeyBase64: exportRecipientPublicKey(publicKey),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: recipientKeyId(publicKey),
  };
}

/**
 * A license row written directly, for a slice testing something on top of one. Going around the verifier is
 * the point: a row proves nothing, and `getLicenseStatus` has to check the envelope each time.
 */
export async function seedLicenseRow(
  database: AppDatabase,
  context: TenantContext,
  key: TestSigningKey,
  overrides: Record<string, unknown> = {},
) {
  const document = testLicense({ license_id: randomUUID(), ...overrides }) as ReturnType<
    typeof testLicense
  > & { license_id: string; issued_at: string };
  const envelope = signForTest('license', document, [key]);
  const id = randomUUID();
  await withTenantTx(database, context, (tx) =>
    tx.insert(licenseRecords).values({
      organizationId: context.organizationId,
      id,
      licenseId: document.license_id,
      edition: 'sovereign',
      licensedVersion: '2.0.0',
      termKind: 'perpetual',
      keyIds: [key.keyId],
      envelope,
      envelopeSha256: sha256Hex(envelope),
      issuedAt: new Date(document.issued_at),
    }),
  );
  return { id, licenseId: document.license_id, envelope };
}

/** An export row at `requested`, as if an owner had asked. No event, so no workflow starts from it. */
export async function seedExportRow(
  database: AppDatabase,
  context: TenantContext,
  recipient: { publicKeyBase64: string; keyId: string },
  overrides: Partial<typeof organizationExports.$inferInsert> = {},
) {
  const id = randomUUID();
  await withTenantTx(database, context, (tx) =>
    tx.insert(organizationExports).values({
      organizationId: context.organizationId,
      id,
      recipientPublicKey: recipient.publicKeyBase64,
      recipientKeyId: recipient.keyId,
      requestedByMembershipId: context.membershipId,
      sourceRelease: 'test',
      ...overrides,
    }),
  );
  return id;
}

/** An import row at `requested`, with the caller as who holds what is not linked yet. */
export async function seedImportRow(
  database: AppDatabase,
  context: TenantContext,
  overrides: Partial<typeof organizationImports.$inferInsert> = {},
) {
  const id = randomUUID();
  await withTenantTx(database, context, (tx) =>
    tx.insert(organizationImports).values({
      organizationId: context.organizationId,
      id,
      requestedByMembershipId: context.membershipId,
      fallbackMembershipId: context.membershipId,
      ...overrides,
    }),
  );
  return id;
}
