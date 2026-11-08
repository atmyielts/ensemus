// For @ensemus/auth only (enforced by lint). This role can read password hashes and sessions, and
// nothing tenant-related, so a bug in application queries cannot reach them.
import { createHash } from 'node:crypto';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { openDatabase, type EnsemusDrizzle } from './connection';
import { accounts, rateLimits, sessions, setupTokens, users, verifications } from './schema';
import { sessionAssurances, ssoProviders, twoFactors } from './schema-product';
import { ssoConfigurationSha256 } from './sso-fingerprint';
export { ssoConfigurationSha256 } from './sso-fingerprint';
export { createVerifiedInteractiveIdentity } from './interactive-identity';
export {prepareNativeSamlLinkSource,storeNativeSamlBrowserIntent,type SamlLinkPrimaryProof,type SamlLinkSource} from './auth-saml-link';

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

/** The accepted SAML callback's exact configuration and account must still exist when the trusted
 * tenant proof commits. Metadata reset takes the provider UPDATE lock before deleting old proofs. */
export async function recordSsoAssurance(
  db: EnsemusDrizzle,
  input: {
    sessionId: string;
    userId: string;
    providerId: string;
    externalSubject: string;
    expectedSha256: string;
  },
  now = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [provider] = await tx
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.providerId, input.providerId))
      .for('share');
    if (!provider?.domainVerified || ssoConfigurationSha256(provider) !== input.expectedSha256)
      return false;
    const [session] = await tx
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
    const [account] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, input.userId),
          eq(accounts.providerId, input.providerId),
          eq(accounts.accountId, input.externalSubject),
        ),
      )
      .for('share');
    if (!session || !account) return false;
    await tx
      .insert(sessionAssurances)
      .values({
        sessionId: input.sessionId,
        userId: input.userId,
        kind: 'sso_saml',
        ssoProviderId: input.providerId,
        primaryAccountId: account.id,
        verifiedAt: now,
      })
      .onConflictDoUpdate({
        target: [sessionAssurances.sessionId, sessionAssurances.kind],
        set: {
          userId: input.userId,
          ssoProviderId: input.providerId,
          primaryAccountId: account.id,
          verifiedAt: now,
        },
      });
    return true;
  });
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
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(ssoProviders)
      .where(eq(ssoProviders.providerId, input.providerId))
      .for('update');
    if (!current) {
      const inserted = await tx
        .insert(ssoProviders)
        .values({ ...input, domainVerified: false })
        .onConflictDoNothing()
        .returning({ id: ssoProviders.id });
      if (inserted.length !== 1) throw new Error('SSO_PROVIDER_CHANGED');
      return;
    }
    if (current.domain !== input.domain) throw new Error('SSO_PROVIDER_DOMAIN_FIXED');
    let boundaryChanged = true;
    try {
      boundaryChanged = ssoConfigurationSha256(current) !== ssoConfigurationSha256(input);
    } catch {
      /* Replacing unknown legacy configuration always requires new operator review. */
    }
    await tx
      .update(ssoProviders)
      .set({
        issuer: input.issuer,
        samlConfig: input.samlConfig,
        domainVerified: boundaryChanged ? false : current.domainVerified,
        updatedAt: new Date(),
      })
      .where(eq(ssoProviders.id, current.id));
    if (boundaryChanged)
      await tx
        .delete(sessionAssurances)
        .where(
          and(
            eq(sessionAssurances.kind, 'sso_saml'),
            eq(sessionAssurances.ssoProviderId, input.providerId),
          ),
        );
  });
}

export async function removeSsoProvider(db: EnsemusDrizzle, providerId: string) {
  await db.transaction(async (tx) => {
    await tx.delete(ssoProviders).where(eq(ssoProviders.providerId, providerId));
    await tx
      .delete(sessionAssurances)
      .where(
        and(
          eq(sessionAssurances.kind, 'sso_saml'),
          eq(sessionAssurances.ssoProviderId, providerId),
        ),
      );
  });
}

/** Auth-role provider metadata; this table is intentionally outside the base relational schema. */
export async function readSsoProvider(db: EnsemusDrizzle, providerId: string) {
  const [provider] = await db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.providerId, providerId));
  return provider ?? null;
}

/** Commit an immutable primary receipt only while its exact account and live resulting session
 * still exist. SAML additionally serializes against trust reset on its actual provider row. */
export async function admitPrimaryReceipt(
  db: EnsemusDrizzle,
  input: {
    kind: 'saml' | 'oidc';
    userId: string;
    sessionId: string;
    providerId: string;
    subject: string;
    accountId: string;
    expectedSamlSha256?: string;
    consumeBridge?: { id: string; value: string };
    receipt?: { id: string; identifier: string; value: string; createdAt: Date; expiresAt: Date };
  },
  now = new Date(),
): Promise<boolean> {
  if (!input.receipt && !input.consumeBridge) return false;
  return db.transaction(async (tx) => {
    if (input.kind === 'saml') {
      const [provider] = await tx
        .select()
        .from(ssoProviders)
        .where(eq(ssoProviders.providerId, input.providerId))
        .for('share');
      if (
        !provider?.domainVerified ||
        !input.expectedSamlSha256 ||
        ssoConfigurationSha256(provider) !== input.expectedSamlSha256
      )
        return false;
    }
    const [session] = await tx
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
    const [account] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.id, input.accountId),
          eq(accounts.userId, input.userId),
          eq(accounts.providerId, input.providerId),
          eq(accounts.accountId, input.subject),
        ),
      )
      .for('share');
    if (!session || !account) return false;
    if (input.consumeBridge) {
      const consumed = await tx
        .delete(verifications)
        .where(
          and(
            eq(verifications.id, input.consumeBridge.id),
            eq(verifications.value, input.consumeBridge.value),
            gt(verifications.expiresAt, now),
          ),
        )
        .returning({ id: verifications.id });
      if (consumed.length !== 1) return false;
    }
    if (input.receipt) await tx.insert(verifications).values(input.receipt).onConflictDoNothing();
    return true;
  });
}

/** Promote a challenge that the real native hook just issued. Both native identifiers retain
 * their original values, expiry and counters. An IdP prefix can never degrade into password-only
 * authentication when its separate, auth-only primary bridge is missing. */
export async function promoteIdpChallenge(
  db: EnsemusDrizzle,
  input: {
    oldIdentifier: string;
    newIdentifier: string;
    userId: string;
    providerId: string;
    accountId: string;
    subject: string;
    expectedSamlSha256?: string;
    bridge: { id: string; identifier: string; value: string };
  },
  now = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (input.expectedSamlSha256) {
      const [provider] = await tx
        .select()
        .from(ssoProviders)
        .where(eq(ssoProviders.providerId, input.providerId))
        .for('share');
      if (
        !provider?.domainVerified ||
        ssoConfigurationSha256(provider) !== input.expectedSamlSha256
      )
        return false;
    }
    const [account] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.id, input.accountId),
          eq(accounts.userId, input.userId),
          eq(accounts.providerId, input.providerId),
          eq(accounts.accountId, input.subject),
        ),
      )
      .for('share');
    if (!account) return false;
    const challenges = await tx
      .select()
      .from(verifications)
      .where(
        and(eq(verifications.identifier, input.oldIdentifier), gt(verifications.expiresAt, now)),
      )
      .limit(2)
      .for('update');
    const attempts = await tx
      .select()
      .from(verifications)
      .where(
        and(
          eq(verifications.identifier, `2fa-attempts-${input.oldIdentifier}`),
          gt(verifications.expiresAt, now),
        ),
      )
      .limit(2)
      .for('update');
    if (
      challenges.length !== 1 ||
      challenges[0]!.value !== input.userId ||
      attempts.length !== 1 ||
      attempts[0]!.value !== '0'
    )
      return false;
    await tx
      .update(verifications)
      .set({ identifier: input.newIdentifier })
      .where(eq(verifications.id, challenges[0]!.id));
    await tx
      .update(verifications)
      .set({ identifier: `2fa-attempts-${input.newIdentifier}` })
      .where(eq(verifications.id, attempts[0]!.id));
    await tx
      .insert(verifications)
      .values({ ...input.bridge, createdAt: now, expiresAt: challenges[0]!.expiresAt });
    return true;
  });
}
