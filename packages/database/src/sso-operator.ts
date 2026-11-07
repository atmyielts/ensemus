// For the operator's commands only (lint blocks the web tier). They use the migrator role, as the setup code
// does, because each is something no tenant may do for itself (ADR-031 D8, D9).
import { and, eq } from 'drizzle-orm';
import { X509Certificate } from 'node:crypto';
import { openDatabase } from './connection';
import { users } from './schema';
import { sessionAssurances, ssoConnections, ssoProviders, twoFactors } from './schema-product';
import { ssoConfigurationSha256 } from './sso-fingerprint';

/** Read-only review output. Never returns provider secrets, metadata XML, private keys or user data. */
export async function inspectSsoProvider(
  migratorUrl: string,
  providerId: string,
): Promise<{
  providerId: string;
  organizationId: string;
  domain: string;
  serviceProviderIssuer: string;
  identityProviderIssuer: string;
  entryPoint: string;
  entryPointHasQuery: boolean;
  signingCertificateSha256: readonly string[];
  expectedSha256: string;
} | null> {
  const { db, close } = openDatabase(migratorUrl, { max: 1 });
  try {
    return await db.transaction(async (tx) => {
      const [connection] = await tx
        .select()
        .from(ssoConnections)
        .where(eq(ssoConnections.providerId, providerId))
        .for('share');
      const [provider] = await tx
        .select()
        .from(ssoProviders)
        .where(eq(ssoProviders.providerId, providerId))
        .for('share');
      if (!connection || !provider || connection.domain !== provider.domain || !provider.samlConfig)
        return null;
      const config = JSON.parse(provider.samlConfig) as {
        issuer?: unknown;
        entryPoint?: unknown;
        idpMetadata?: { entityID?: unknown; cert?: unknown };
      };
      if (typeof config.entryPoint !== 'string' || typeof config.idpMetadata?.entityID !== 'string')
        throw new Error('SSO_CONFIGURATION_INVALID');
      const endpoint = new URL(config.entryPoint);
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password)
        throw new Error('SSO_CONFIGURATION_INVALID');
      const certificates = Array.isArray(config.idpMetadata.cert)
        ? config.idpMetadata.cert
        : [config.idpMetadata.cert];
      if (!certificates.length || certificates.some((cert) => typeof cert !== 'string'))
        throw new Error('SSO_CONFIGURATION_INVALID');
      return {
        providerId,
        organizationId: connection.organizationId,
        domain: connection.domain,
        serviceProviderIssuer: provider.issuer,
        identityProviderIssuer: config.idpMetadata.entityID,
        entryPoint: `${endpoint.origin}${endpoint.pathname}`,
        entryPointHasQuery: endpoint.search.length > 0,
        signingCertificateSha256: certificates.map(
          (cert) => new X509Certificate(cert as string).fingerprint256,
        ),
        expectedSha256: ssoConfigurationSha256(provider),
      };
    });
  } finally {
    await close();
  }
}

/**
 * Says this tenant holds this email domain, having checked it outside the product (for instance a DNS record
 * the operator looked up). Marks the tenant's row and the plugin's row in one transaction. A domain another
 * tenant has verified is refused by the unique index, so a domain has one owner at a time.
 */
export async function verifySsoDomain(
  migratorUrl: string,
  input: { providerId: string; expectedSha256: string },
  now = new Date(),
): Promise<'verified' | 'not_found' | 'review_required' | 'configuration_changed'> {
  if (typeof input.expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedSha256))
    return 'review_required';
  const { db, close } = openDatabase(migratorUrl, { max: 1 });
  try {
    return await db.transaction(async (tx) => {
      const [connection] = await tx
        .select()
        .from(ssoConnections)
        .where(eq(ssoConnections.providerId, input.providerId))
        .for('update');
      if (!connection) return 'not_found';
      const [provider] = await tx
        .select()
        .from(ssoProviders)
        .where(
          and(
            eq(ssoProviders.providerId, input.providerId),
            eq(ssoProviders.domain, connection.domain),
          ),
        )
        .for('update');
      if (!provider) throw new Error('SSO_PROVIDER_MISMATCH');
      if (ssoConfigurationSha256(provider) !== input.expectedSha256) return 'configuration_changed';
      await tx
        .update(ssoConnections)
        .set({ domainState: 'verified', domainVerifiedAt: now, updatedAt: now })
        .where(eq(ssoConnections.id, connection.id));
      await tx
        .update(ssoProviders)
        .set({ domainVerified: true, updatedAt: now })
        .where(eq(ssoProviders.id, provider.id));
      return 'verified';
    });
  } finally {
    await close();
  }
}

/**
 * Takes a second factor away from someone who lost the device and the backup codes, after the operator has
 * satisfied themselves who is asking. Also forgets what their sessions had proven. It says nothing about who
 * they are in any tenant, and it leaves a line in the operator's own terminal.
 */
export async function resetSecondFactor(
  migratorUrl: string,
  input: { email: string },
): Promise<'reset' | 'not_found'> {
  const { db, close } = openDatabase(migratorUrl, { max: 1 });
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .update(users)
        .set({ twoFactorEnabled: false, updatedAt: new Date() })
        .where(eq(users.email, input.email))
        .returning({ id: users.id });
      if (!user) return 'not_found';
      await tx.delete(twoFactors).where(eq(twoFactors.userId, user.id));
      await tx.delete(sessionAssurances).where(eq(sessionAssurances.userId, user.id));
      return 'reset';
    });
  } finally {
    await close();
  }
}
