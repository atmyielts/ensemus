import { memberships, type TenantContext, type Tx } from '@ensemus/database';
import { can } from '@ensemus/domain/policy';
import { and, eq } from 'drizzle-orm';
import { AppError } from './errors';
import { assertInteractivePrivilege, lockInteractivePolicy } from './product/privileged';

/** Reads current membership. Privileged changes keep policy and membership stable until commit. */
export async function requireSkillMember(tx: Tx, context: TenantContext, manage = false) {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  if (manage) await lockInteractivePolicy(tx, context);
  const query = tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, context.organizationId),
        eq(memberships.id, context.membershipId),
        eq(memberships.userId, context.userId),
        eq(memberships.status, 'active'),
      ),
    );
  const [member] = await (manage ? query.for('share') : query);
  if (!member || (manage && !can(member.role, 'skill.manage'))) throw new AppError('FORBIDDEN');
  if (manage) await assertInteractivePrivilege(tx, context, 'skill.manage');
  return member.role;
}
