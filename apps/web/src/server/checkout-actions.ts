'use server';
import {
  AppError,
  auditRefusal,
  canonicalId,
  isAuditedRefusal,
  refusalCode,
  refusalFromDatabase,
} from '@ensemus/application';
import {
  closeCheckout,
  getCheckoutStatus,
  startCheckout,
} from '@ensemus/application/saas/checkout';
import { can } from '@ensemus/domain/policy';
import { errorCode } from '@ensemus/telemetry';
import { notFound, redirect } from 'next/navigation';
import { checkoutSettings } from './checkout-settings';
import { getRuntime } from './runtime';
import { requireAccountTenant } from './tenant';

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, key: string) => canonicalId(text(form, key));

async function refused(
  error: unknown,
  tenant: Awaited<ReturnType<typeof requireAccountTenant>>,
): Promise<string> {
  if (isAuditedRefusal(error))
    await auditRefusal(tenant.database, tenant.context, {
      code: refusalCode(error),
      surface: 'web',
    }).catch((failure: unknown) =>
      getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
    );
  if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
  const code =
    error instanceof AppError ? error.code : (refusalFromDatabase(error)?.code ?? 'UNEXPECTED');
  if (code === 'UNEXPECTED')
    getRuntime().log.error('checkout.action_failed', { errorCode: errorCode(error) });
  return code;
}

/** Starts the checkout the person chose, then sends them on: to Payme or Click, or to wait for Paddle. */
export async function startCheckoutAction(form: FormData): Promise<never> {
  const organizationId = idOf(form, 'organizationId'),
    invoiceId = idOf(form, 'invoiceId');
  const tenant = await requireAccountTenant(organizationId);
  const base = `/o/${organizationId}/account/invoices/${invoiceId}/checkout`;
  let target: string;
  try {
    if (!can(tenant.context.role, 'billing.manage')) throw new AppError('NOT_FOUND');
    const language = text(form, 'language');
    const { sessionId } = await startCheckout(
      tenant.database,
      tenant.context,
      {
        invoiceId,
        provider: text(form, 'provider'),
        language: language === 'uz' || language === 'en' ? language : 'ru',
      },
      checkoutSettings(),
    );
    const status = await getCheckoutStatus(tenant.database, tenant.context, {
      invoiceId,
      sessionId,
    });
    // Payme and Click have their link at once. Paddle's comes from the connector worker, so the status
    // page waits for it and offers it when it is ready.
    target = status.checkoutUrl ?? `${base}/${sessionId}`;
  } catch (error) {
    target = `${base}?error=${await refused(error, tenant)}`;
  }
  redirect(target);
}

/** Closes a checkout nothing can have been paid through, so the person can choose another way to pay. */
export async function closeCheckoutAction(form: FormData): Promise<never> {
  const organizationId = idOf(form, 'organizationId'),
    invoiceId = idOf(form, 'invoiceId'),
    sessionId = idOf(form, 'sessionId');
  const tenant = await requireAccountTenant(organizationId);
  let target = `/o/${organizationId}/account/invoices/${invoiceId}/checkout`;
  try {
    if (!can(tenant.context.role, 'billing.manage')) throw new AppError('NOT_FOUND');
    if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
    await closeCheckout(tenant.database, tenant.context, { invoiceId, sessionId });
  } catch (error) {
    target = `${target}/${sessionId}?error=${await refused(error, tenant)}`;
  }
  redirect(target);
}
