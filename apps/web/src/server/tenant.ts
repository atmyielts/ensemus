import 'server-only';
import { AppError, auditTenantRefusal } from '@ensemus/application';
import { assertTenantSignIn } from '@ensemus/application/sso';
import { resolveInteractiveTenantContext, TenantAccessDenied,isRestoreAdmissionDenied } from '@ensemus/database';
import { assertServing, type AccountSurface } from '@ensemus/application/saas/standing';
import { errorCode } from '@ensemus/telemetry';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { requireActor } from './actor';
import { getRestoreGate, getRuntime } from './runtime';

/**
 * Who this request is, in this tenant. React's `cache` lasts for one request only, so a revoked
 * membership takes effect on the very next request. A tenant someone may not see looks missing.
 */
const resolveFor = async (
  organizationId: string,
  surface: AccountSurface,
  sso: 'redirect' | 'throw' = 'redirect',
) => {
  const actor = await requireActor();
  const { app } = getRuntime();
  try {
    const context = await resolveInteractiveTenantContext(
      app,
      actor.interactiveIdentity,
      organizationId,
    );
    // After the membership check, so nobody outside the tenant can learn it is being restored.
    await getRestoreGate().assertServing(context);
    await assertTenantSignIn(app, context, { sessionId: actor.sessionId });
    assertServing(context, surface);
    return { actor, context, database: app };
  } catch (error) {
    if(isRestoreAdmissionDenied(error))redirect('/restoring');
    if (error instanceof TenantAccessDenied) {
      await recordTenantRefusal(actor.userId, organizationId);
      notFound();
    }
    if (error instanceof AppError && error.code === 'RESTORE_PENDING') redirect('/restoring');
    if (error instanceof AppError && error.code === 'SSO_REQUIRED' && sso === 'redirect')
      redirect('/sign-in/sso');
    // Someone suspended still has a way to see why, pay, export and ask for help (ADR-032 D5).
    if (error instanceof AppError && error.code === 'TENANT_SUSPENDED') {
      redirect(`/o/${organizationId}/account`);
    }
    throw error;
  }
};

export const requireTenant = cache((organizationId: string) => resolveFor(organizationId, 'core'));

/** For billing, support, export and leaving, and the layout around them, which work in any standing. */
export const requireAccountTenant = cache((organizationId: string) =>
  resolveFor(organizationId, 'account'),
);

/** Same admission, with a typed SSO refusal for submitted-only editor recovery. No context is
 * returned on refusal. The joined core-standing assertion remains before the successful return. */
export const requireTenantForAction = cache((organizationId: string) =>
  resolveFor(organizationId, 'core', 'throw'),
);

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
