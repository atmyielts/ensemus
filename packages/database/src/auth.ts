// For @ensemus/auth only (enforced by lint). This role can read password hashes and sessions, and
// nothing tenant-related, so a bug in application queries cannot reach them.
import { createHash } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection';
import { accounts, rateLimits, sessions, setupTokens, users, verifications } from './schema';
import { sessionAssurances, ssoProviders, twoFactors } from './schema-product';

export const authSchema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  rateLimit: rateLimits,
  twoFactor: twoFactors,
  ssoProvider: ssoProviders,
};

export function openAuthDatabase(url: string) {
  return openDatabase(url, { max: 5 });
}

export const hashSetupToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Takes a setup code, if it is one that still works. Taking it and checking it are one statement, so
 * two people sending the same code cannot both get through. Returns its ID, or nothing.
 */
export async function claimSetupToken(
  db: EnsemusDrizzle,
  token: string,
  now = new Date(),
): Promise<string | null> {
  const [claimed] = await db
    .update(setupTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(setupTokens.tokenHash, hashSetupToken(token)),
        isNull(setupTokens.usedAt),
        gt(setupTokens.expiresAt, now),
      ),
    )
    .returning({ id: setupTokens.id });
  return claimed?.id ?? null;
}

/** Gives a code back when the account it was for could not be made. Nothing has used it. */
export async function releaseSetupToken(db: EnsemusDrizzle, id: string) {
  await db.update(setupTokens).set({ usedAt: null }).where(eq(setupTokens.id, id));
}

/**
 * Says what a session just proved. Only @ensemus/auth calls this, and only after Better Auth accepted a code
 * or an assertion. The application role can read these and has no way to write one (ADR-031 D8).
 */
export async function recordSessionAssurance(
  db: EnsemusDrizzle,
  input: {
    sessionId: string;
    userId: string;
    kind: 'mfa_totp' | 'mfa_backup_code' | 'sso_saml';
    ssoProviderId?: string;
  },
  now = new Date(),
) {
  await db
    .insert(sessionAssurances)
    .values({
      sessionId: input.sessionId,
      userId: input.userId,
      kind: input.kind,
      ssoProviderId: input.ssoProviderId ?? null,
      verifiedAt: now,
    })
    .onConflictDoUpdate({
      target: [sessionAssurances.sessionId, sessionAssurances.kind],
      set: { verifiedAt: now, ssoProviderId: input.ssoProviderId ?? null },
    });
}

/**
 * Stores a provider's settings for the SSO plugin to read. A new or changed row is never trusted by itself:
 * `domainVerified` is the operator's to set (ADR-031 D9).
 */
export async function storeSsoProvider(
  db: EnsemusDrizzle,
  input: { providerId: string; issuer: string; domain: string; samlConfig: string },
) {
  await db
    .insert(ssoProviders)
    .values({ ...input, domainVerified: false })
    .onConflictDoUpdate({
      target: ssoProviders.providerId,
      set: { issuer: input.issuer, samlConfig: input.samlConfig, updatedAt: new Date() },
    });
}

export async function removeSsoProvider(db: EnsemusDrizzle, providerId: string) {
  await db.delete(ssoProviders).where(eq(ssoProviders.providerId, providerId));
}
