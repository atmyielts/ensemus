import { memberships, type AppDatabase, type TenantContext, type Tx } from '@ensemus/database';
import { can } from '@ensemus/domain/policy';
import { canProduct } from '@ensemus/domain/product-policy';
import { and, eq, sql } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { withPrivilegeTx } from './privileged';

export async function withExperienceTx<T>(
  database: AppDatabase,
  context: TenantContext,
  fn: (tx: Tx) => Promise<T>,
  changed: 'OUTCOME_CHANGED' | 'INVALID_STATE' = 'OUTCOME_CHANGED',
): Promise<T> {
  try {
    return await withPrivilegeTx(database, context, fn);
  } catch (error) {
    if (pgCode(error) === 'EN413') throw new AppError(changed);
    if (pgCode(error) === 'EN410') throw new AppError('SSO_REQUIRED');
    throw error;
  }
}
/** People own their drafts; only current company administrators manage setup. No native MFA is added. */
export async function experiencePerson(
  tx: Tx,
  context: TenantContext,
  manage = false,
): Promise<TenantContext> {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('interactive_policy:'||${context.organizationId}::text,0))`,
  );
  const [member] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, context.organizationId),
        eq(memberships.id, context.membershipId),
        eq(memberships.userId, context.userId),
        eq(memberships.status, 'active'),
      ),
    )
    .for('share');
  if (
    !member ||
    !(manage ? canProduct(member.role, 'onboarding.manage') : can(member.role, 'work.create'))
  )
    throw new AppError('FORBIDDEN');
  const native = await tx.execute<{ allowed: boolean }>(
    sql`select experience.native_person_allowed(${manage}) as allowed`,
  );
  if (native.rows[0]?.allowed !== true) throw new AppError('FORBIDDEN');
  return { ...context, role: member.role };
}
