// Safe for the web tier: holds a public key only, so it can store a secret but never read one back
// (ADR-024 D5). Uses AES-256-GCM with a fresh data key, wrapped with RSA-OAEP-SHA-256.
import { constants, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import {
  appendAudit,
  sealedSecrets,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { encryptBound, keyIdOf, type SealedValue } from './format';

export function sealSecret(input: {
  publicKeyPem: string;
  organizationId: string;
  secretId: string;
  purpose: string;
  plaintext: string;
}): SealedValue {
  const dataKey = randomBytes(32);
  try {
    const plaintext = Buffer.from(input.plaintext, 'utf8');
    let encrypted: ReturnType<typeof encryptBound>;
    try {
      encrypted = encryptBound(dataKey, input, plaintext);
    } finally {
      plaintext.fill(0);
    }
    const wrappedKey = publicEncrypt(
      {
        key: input.publicKeyPem,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      dataKey,
    );
    return {
      keyId: keyIdOf(input.publicKeyPem),
      wrappedKey,
      ...encrypted,
    };
  } finally {
    dataKey.fill(0);
  }
}

/** Seals and stores a tenant secret, returning only an opaque reference. */
export async function storeSecret(
  database: AppDatabase,
  context: TenantContext,
  input: { publicKeyPem: string; purpose: string; plaintext: string },
): Promise<{ secretRef: string }> {
  const secretRef = randomUUID();
  const sealed = sealSecret({
    publicKeyPem: input.publicKeyPem,
    organizationId: context.organizationId,
    secretId: secretRef,
    purpose: input.purpose,
    plaintext: input.plaintext,
  });
  await withTenantTx(database, context, async (tx) => {
    await tx.insert(sealedSecrets).values({
      organizationId: context.organizationId,
      id: secretRef,
      purpose: input.purpose,
      ...sealed,
    });
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.userId,
      action: 'secret.stored',
      targetRef: `secret:${secretRef}`,
      decision: 'allow',
    });
  });
  return { secretRef };
}
