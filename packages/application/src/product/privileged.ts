// Recent MFA for privileged actions (ID-05, ADR-031 D8). Every privileged service calls this in the same
// transaction as its effect, so there is no window between the check and the write. The proof comes from a
// table the application role can read and never write.
import {
  interactiveSessionOf,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { type PrivilegedAction } from '@ensemus/domain/product-policy';
import { sql } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';

/** A trigger can refuse again after waiting for a target lock. Keep that refusal typed and fixed. */
export async function withPrivilegeTx<T>(
  database: AppDatabase,
  context: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await withTenantTx(database, context, fn);
  } catch (error) {
    if (pgCode(error) === 'EN405') throw new AppError('MFA_REQUIRED');
    if (pgCode(error) === 'EN410') throw new AppError('SSO_REQUIRED');
    throw error;
  }
}

/**
 * Which session is asking. The web tier takes it from the verified session and from nowhere else: it is
 * never read from a form, a header or a body, and a session that belongs to someone else finds no row.
 */
export type SessionProof = { sessionId: string };

/** Administrative changes lock the policy before people; privileged effects keep that order. */
export async function lockInteractivePolicy(tx: Tx, context: TenantContext): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    'interactive_policy:'||${context.organizationId}::text,0))`);
}

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
  _now: Date = new Date(),
): Promise<void> {
  if (context.actorType !== 'user') throw new AppError('MFA_REQUIRED');
  const identity = interactiveSessionOf(context);
  if (proof && (!identity || proof.sessionId !== identity.sessionId))
    throw new AppError('MFA_REQUIRED');
  // SQL owns the clock, row locks, fresh policy/person and auth-only proof. A caller's Date or a
  // copied session UUID cannot make a stale or foreign native session current.
  let result;
  try {
    result = await tx.execute<{ allowed: boolean }>(sql`select
    app.current_organization_id()=${context.organizationId}::uuid
    and app.current_user_id()=${context.userId}::uuid
    and app.current_membership_id()=${context.membershipId}::uuid
    and app.interactive_privilege_allowed(${action},${proof?.sessionId ?? null}::uuid) as allowed`);
  } catch (error) {
    if (pgCode(error) === 'EN410') throw new AppError('SSO_REQUIRED');
    throw error;
  }
  if (result.rows[0]?.allowed !== true) throw new AppError('MFA_REQUIRED');
}

/** Existing privileged DAL effects derive their proof from the native-only context, never a DTO. */
export function assertInteractivePrivilege(
  tx: Tx,
  context: TenantContext,
  action: PrivilegedAction,
): Promise<void> {
  const identity = interactiveSessionOf(context);
  return assertRecentMfa(tx, context, action, identity ? { sessionId: identity.sessionId } : null);
}

/** The same check on its own, for a page deciding whether to ask for a code before showing a form. */
export function hasRecentMfa(
  database: AppDatabase,
  context: TenantContext,
  action: PrivilegedAction,
  proof: SessionProof | null,
): Promise<boolean> {
  return withPrivilegeTx(database, context, async (tx) => {
    try {
      await assertRecentMfa(tx, context, action, proof);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'MFA_REQUIRED') return false;
      throw error;
    }
  });
}
