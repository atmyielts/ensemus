// For @ensemus/auth only (enforced by lint). This role can read password hashes and sessions, and
// nothing tenant-related, so a bug in application queries cannot reach them.
import { createHash } from 'node:crypto';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
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
    /** Auth-role attempt reservation, never an HTTP form value. */
    factorId?: string;
  },
  now = new Date(),
) {
  if (input.kind !== 'sso_saml') {
    await db.transaction(async (tx) => {
      // The same user row is changed before factor disable. A concurrent accepted verifier either
      // records first and gets revoked afterwards, or sees disabled and cannot mint a new proof.
      const [person] = await tx
        .select({ enabled: users.twoFactorEnabled })
        .from(users)
        .where(eq(users.id, input.userId))
        .for('share');
      const [current] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, input.sessionId),
            eq(sessions.userId, input.userId),
            gt(sessions.expiresAt, now),
          ),
        )
        .for('share');
      if (!person?.enabled || !current) throw new Error('MFA_PROOF_NOT_CURRENT');
      if (input.factorId) {
        const reset = await tx
          .update(twoFactors)
          .set({ failedVerificationCount: 0, lockedUntil: null })
          .where(
            and(
              eq(twoFactors.id, input.factorId),
              eq(twoFactors.userId, input.userId),
              eq(twoFactors.verified, true),
            ),
          )
          .returning({ id: twoFactors.id });
        if (reset.length !== 1) throw new Error('MFA_PROOF_NOT_CURRENT');
      }
      await tx
        .insert(sessionAssurances)
        .values({
          sessionId: input.sessionId,
          userId: input.userId,
          kind: input.kind,
          ssoProviderId: null,
          verifiedAt: now,
        })
        .onConflictDoUpdate({
          target: [sessionAssurances.sessionId, sessionAssurances.kind],
          set: { verifiedAt: now, ssoProviderId: null },
        });
    });
    return;
  }
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

/** A removed factor invalidates its proof on every session, including other web replicas. The user
 * comes from the authoritative verified session in @ensemus/auth, never an application form. */
export async function revokeSessionAssurances(db: EnsemusDrizzle, userId: string) {
  await db
    .delete(sessionAssurances)
    .where(
      and(
        eq(sessionAssurances.userId, userId),
        inArray(sessionAssurances.kind, ['mfa_totp', 'mfa_backup_code']),
      ),
    );
}

/** Own-account setup metadata only. Never expose the stored secret or recovery material. */
export async function readMfaEnrollmentState(
  db: EnsemusDrizzle,
  userId: string,
): Promise<'absent' | 'pending' | 'enrolled' | 'inconsistent'> {
  const [person] = await db
    .select({ enabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, userId));
  const rows = await db
    .select({ verified: twoFactors.verified })
    .from(twoFactors)
    .where(eq(twoFactors.userId, userId))
    .limit(2);
  if (!person || rows.length > 1) return 'inconsistent';
  if (!rows.length) return person.enabled ? 'inconsistent' : 'absent';
  if (person.enabled && rows[0]!.verified) return 'enrolled';
  return rows[0]!.verified ? 'inconsistent' : 'pending';
}

/** Reserves the pinned plugin's account budget before verification across replicas. Failed, unknown
 * and in-flight attempts consume their reservation; only an admitted proof resets it atomically. */
export async function reserveMfaAttempt(
  db: EnsemusDrizzle,
  userId: string,
  policy: { maxFailedAttempts: number; durationSeconds: number },
  now = new Date(),
): Promise<{ outcome: 'reserved'; factorId: string } | { outcome: 'locked' | 'not_enrolled' }> {
  return db.transaction(async (tx) => {
    const factors = await tx
      .select()
      .from(twoFactors)
      .where(eq(twoFactors.userId, userId))
      .limit(2)
      .for('update');
    if (factors.length !== 1) return { outcome: 'not_enrolled' };
    const row = factors[0]!;
    if (row.lockedUntil && row.lockedUntil > now) return { outcome: 'locked' };
    const count = row.lockedUntil ? 0 : row.failedVerificationCount;
    if (count >= policy.maxFailedAttempts) {
      await tx
        .update(twoFactors)
        .set({ lockedUntil: new Date(now.getTime() + policy.durationSeconds * 1000) })
        .where(eq(twoFactors.id, row.id));
      return { outcome: 'locked' };
    }
    const next = count + 1;
    await tx
      .update(twoFactors)
      .set({
        failedVerificationCount: next,
        lockedUntil:
          next >= policy.maxFailedAttempts
            ? new Date(now.getTime() + policy.durationSeconds * 1000)
            : null,
      })
      .where(eq(twoFactors.id, row.id));
    return { outcome: 'reserved', factorId: row.id };
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
