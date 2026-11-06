// For the operator's commands only (lint blocks the web tier). They use the migrator role, as the setup code
// does, because each is something no tenant may do for itself (ADR-031 D8, D9).
import { and, eq } from 'drizzle-orm';
import { openDatabase } from './connection';
import { users } from './schema';
import { sessionAssurances, ssoConnections, ssoProviders, twoFactors } from './schema-product';

/**
 * Says this tenant holds this email domain, having checked it outside the product (for instance a DNS record
 * the operator looked up). Marks the tenant's row and the plugin's row in one transaction. A domain another
 * tenant has verified is refused by the unique index, so a domain has one owner at a time.
 */
export async function verifySsoDomain(
  migratorUrl: string,
  input: { providerId: string },
  now = new Date(),
): Promise<'verified' | 'not_found'> {
  const { db, close } = openDatabase(migratorUrl, { max: 1 });
  try {
    return await db.transaction(async (tx) => {
      const [connection] = await tx
        .update(ssoConnections)
        .set({ domainState: 'verified', domainVerifiedAt: now, updatedAt: now })
        .where(eq(ssoConnections.providerId, input.providerId))
        .returning({ domain: ssoConnections.domain });
      if (!connection) return 'not_found';
      const [provider] = await tx
        .update(ssoProviders)
        .set({ domainVerified: true, updatedAt: now })
        .where(
          and(
            eq(ssoProviders.providerId, input.providerId),
            eq(ssoProviders.domain, connection.domain),
          ),
        )
        .returning({ id: ssoProviders.id });
      if (!provider) throw new Error('SSO_PROVIDER_MISMATCH');
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
