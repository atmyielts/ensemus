import 'server-only';
import { AppError } from '@ensemus/application';
import { resolveTenantContext, TenantAccessDenied } from '@ensemus/database';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { requireActor } from './actor';
import { getRuntime } from './runtime';

/**
 * Who this request is, in this tenant. React's `cache` lasts for one request only, so a revoked
 * membership takes effect on the very next request. A tenant someone may not see looks missing.
 */
export const requireTenant = cache(async (organizationId: string) => {
  const actor = await requireActor();
  const { app } = getRuntime();
  try {
    const context = await resolveTenantContext(app, actor.userId, organizationId);
    return { actor, context, database: app };
  } catch (error) {
    if (error instanceof TenantAccessDenied) notFound();
    throw error;
  }
});

/** Runs a page's read, turning "not found or not permitted" into a plain 404. */
export async function orNotFound<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }
}
