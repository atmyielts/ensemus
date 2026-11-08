// ADR-032 D5: the customer can retrieve data while service is paused. This is an export-only
// adapter, never a web-visible context that can write arbitrary core/import data in any standing.
import {
  interactiveSessionOf,
  memberships,
  organizations,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { accountContextOf } from '@ensemus/database/account';
import { can } from '@ensemus/domain/policy';
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import type { ObjectStore } from '../artifacts';
import {
  getOrganizationExport,
  listOrganizationExports,
  openExportArchive,
  requestOrganizationExport,
} from '../portability-export';
import { lockInteractivePolicy } from '../product/privileged';

/** Existing0412 native-session proof has no added MFA requirement. Owner recovery from required
 * SSO is the existing sign-in policy; a demoted/non-owner never passes this fresh owner predicate. */
async function currentOwner(tx: Tx, context: TenantContext): Promise<void> {
  const identity = interactiveSessionOf(context);
  if (context.actorType !== 'user' || !identity) throw new AppError('FORBIDDEN');
  await lockInteractivePolicy(tx, context);
  const [member] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, context.organizationId),
        eq(memberships.id, context.membershipId),
        eq(memberships.userId, context.userId),
        eq(memberships.status, 'active'),
        eq(memberships.role, 'owner'),
      ),
    )
    .for('share');
  if (!member) throw new AppError('FORBIDDEN');
  const proof = await tx.execute<{ allowed: boolean }>(
    sql`select identity.lock_studio_session(${context.userId}::uuid,${identity.sessionId}::uuid) as allowed`,
  );
  if (proof.rows[0]?.allowed !== true) throw new AppError('FORBIDDEN');
  const [organization] = await tx
    .select({ lifecycle: organizations.lifecycle })
    .from(organizations)
    .where(eq(organizations.id, context.organizationId));
  if (!organization || organization.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
}
/** Every M6 transaction, including the stream's existing pre/post-storage checkpoints, gets fresh
 * same-user/session/owner authority. The facade has no transaction alive while storage is awaited. */
function scopedExport(database: AppDatabase, context: TenantContext) {
  if (
    context.actorType !== 'user' ||
    !interactiveSessionOf(context) ||
    !can(context.role, 'organization.export')
  )
    throw new AppError('FORBIDDEN');
  const scoped = accountContextOf(context);
  const transaction = <T>(
    bindings: Record<string, string>,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> => {
    for (const [name, value] of Object.entries({
      'app.organization_id': scoped.organizationId,
      'app.user_id': scoped.userId,
      'app.membership_id': scoped.membershipId,
      'app.actor_type': 'user',
      'app.interactive_session_id': interactiveSessionOf(scoped)!.sessionId,
    }))
      if (bindings[name] !== value) throw new AppError('FORBIDDEN');
    return database.transaction(bindings, async (tx) => {
      await currentOwner(tx, scoped);
      return fn(tx);
    });
  };
  // AppDatabase's public facade only, as with databaseInTransaction. It is private to these four
  // M6 calls; neither the full-serving context nor a general writer escapes the adapter.
  const guarded = {
    transaction,
    run: <T>(fn: (tx: Tx) => Promise<T>) => transaction({}, fn),
  } as AppDatabase;
  return { database: guarded, context: scoped };
}
export async function requestAccountExport(
  database: AppDatabase,
  context: TenantContext,
  input: Parameters<typeof requestOrganizationExport>[2],
) {
  const scope = scopedExport(database, context);
  return requestOrganizationExport(scope.database, scope.context, input);
}
export async function listAccountExports(database: AppDatabase, context: TenantContext) {
  const scope = scopedExport(database, context);
  return listOrganizationExports(scope.database, scope.context);
}
export async function getAccountExport(
  database: AppDatabase,
  context: TenantContext,
  exportId: string,
) {
  const scope = scopedExport(database, context);
  return getOrganizationExport(scope.database, scope.context, exportId);
}
export async function openAccountExportArchive(
  database: AppDatabase,
  store: Pick<ObjectStore, 'get'>,
  context: TenantContext,
  exportId: string,
) {
  const scope = scopedExport(database, context);
  return openExportArchive(scope.database, store, scope.context, exportId);
}
