// Recent MFA for privileged actions (ID-05, ADR-031 D8). Every privileged service calls this in the same
// transaction as its effect, so there is no window between the check and the write. The proof comes from a
// table the application role can read and never write.
import { withTenantTx, type AppDatabase, type TenantContext, type Tx } from '@ensemus/database';
import { securityPolicies, sessionAssurances } from '@ensemus/database/product';
import {
  DEFAULT_MFA_MAX_AGE_SECONDS,
  mfaDecision,
  type PrivilegedAction,
} from '@ensemus/domain/product-policy';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { AppError } from '../errors';

/**
 * Which session is asking. The web tier takes it from the verified session and from nowhere else: it is
 * never read from a form, a header or a body, and a session that belongs to someone else finds no row.
 */
export type SessionProof = { sessionId: string };

const SECOND_FACTORS = ['mfa_totp', 'mfa_backup_code'] as const;

/**
 * Throws MFA_REQUIRED unless this session proved a second factor recently enough. A service context never
 * passes, whatever is in the table. No proof at all, which is what a missing or forged session ID comes to,
 * is the same refusal as an old one.
 */
export async function assertRecentMfa(
  tx: Tx,
  context: TenantContext,
  action: PrivilegedAction,
  proof: SessionProof | null,
  now: Date = new Date(),
): Promise<void> {
  const [policy] = await tx
    .select({
      mfaForAdministration: securityPolicies.mfaForAdministration,
      mfaMaxAgeSeconds: securityPolicies.mfaMaxAgeSeconds,
    })
    .from(securityPolicies)
    .where(eq(securityPolicies.organizationId, context.organizationId));
  const [assurance] = proof
    ? await tx
        .select({ verifiedAt: sessionAssurances.verifiedAt })
        .from(sessionAssurances)
        .where(
          and(
            eq(sessionAssurances.sessionId, proof.sessionId),
            eq(sessionAssurances.userId, context.userId),
            inArray(sessionAssurances.kind, [...SECOND_FACTORS]),
          ),
        )
        .orderBy(desc(sessionAssurances.verifiedAt))
        .limit(1)
    : [];
  const decision = mfaDecision(
    action,
    {
      verifiedAt: assurance?.verifiedAt ?? null,
      maxAgeSeconds: policy?.mfaMaxAgeSeconds ?? DEFAULT_MFA_MAX_AGE_SECONDS,
      mfaForAdministration: policy?.mfaForAdministration ?? false,
      actorType: context.actorType,
    },
    now,
  );
  if (decision !== 'allow') throw new AppError('MFA_REQUIRED');
}

/** The same check on its own, for a page deciding whether to ask for a code before showing a form. */
export function hasRecentMfa(
  database: AppDatabase,
  context: TenantContext,
  action: PrivilegedAction,
  proof: SessionProof | null,
): Promise<boolean> {
  return withTenantTx(database, context, async (tx) => {
    try {
      await assertRecentMfa(tx, context, action, proof);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'MFA_REQUIRED') return false;
      throw error;
    }
  });
}
