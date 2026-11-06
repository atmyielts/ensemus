import 'server-only';
import { AppError, auditTenantRefusal } from '@ensemus/application';
import { resolveTenantContext, TenantAccessDenied } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { requireActor } from './actor';
import { getRestoreGate, getRuntime } from './runtime';

/**
 * Who this request is, in this tenant. React's `cache` lasts for one request only, so a revoked
 * membership takes effect on the very next request. A tenant someone may not see looks missing.
 */
export const requireTenant = cache(async (organizationId: string) => {
  const actor = await requireActor();
  const { app } = getRuntime();
  try {
    const context = await resolveTenantContext(app, actor.userId, organizationId);
    // After the membership check, so nobody outside the tenant can learn it is being restored.
    await getRestoreGate().assertServing(context);
    return { actor, context, database: app };
  } catch (error) {
    if (error instanceof TenantAccessDenied) {
      await recordTenantRefusal(actor.userId, organizationId);
      notFound();
    }
    if (error instanceof AppError && error.code === 'RESTORE_PENDING') redirect('/restoring');
    throw error;
  }
});

/**
 * Someone named a tenant they are not in, through a page or a form. They get the same 404 whether or
 * not it exists, and whether or not this record could be written, which never stops the refusal.
 */
async function recordTenantRefusal(userId: string, organizationId: string) {
  const { app, log } = getRuntime();
  await auditTenantRefusal(app, { userId, organizationId, surface: 'web' }).catch(
    (error: unknown) => log.error('audit.refusal_failed', { errorCode: errorCode(error) }),
  );
}

/** Runs a page's read, turning "not found or not permitted" into a plain 404. */
export async function orNotFound<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }
}
