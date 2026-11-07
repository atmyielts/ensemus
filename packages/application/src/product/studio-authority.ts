import { memberships, type AppDatabase, type TenantContext, type Tx } from '@ensemus/database';
import { canProduct, type ProductCapability } from '@ensemus/domain/product-policy';
import { and, eq, sql } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { withPrivilegeTx } from './privileged';

export async function withStudioTx<T>(
  database: AppDatabase,
  context: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await withPrivilegeTx(database, context, fn);
  } catch (error) {
    if (pgCode(error) === 'EN412') throw new AppError('FORBIDDEN');
    throw error;
  }
}

/** A saved author/admin role is not authority for a later Studio read or effect. */
export async function studioPerson(
  tx: Tx,
  context: TenantContext,
  capability: ProductCapability = 'studio.author',
): Promise<TenantContext> {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  // Administration takes this before the target membership lock. Keep the same order so disabling
  // an author cannot deadlock with their concurrent draft/review transaction.
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
  if (!member || !canProduct(member.role, capability)) throw new AppError('FORBIDDEN');
  return { ...context, role: member.role };
}
