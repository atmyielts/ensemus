'use server';
import {
  AppError,
  auditRefusal,
  canonicalId,
  isAuditedRefusal,
  refusalCode,
  refusalFromDatabase,
} from '@ensemus/application';
import { requestTopUp } from '@ensemus/application/saas/top-ups';
import { loadSaasConfig } from '@ensemus/config';
import { errorCode } from '@ensemus/telemetry';
import { notFound, redirect } from 'next/navigation';
import { requireAccountTenant } from './tenant';
import { getRuntime } from './runtime';

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, key: string) => canonicalId(text(form, key));
export async function requestTopUpAction(form: FormData): Promise<never> {
  const organizationId = idOf(form, 'organizationId');
  const tenant = await requireAccountTenant(organizationId);
  let target = `/o/${organizationId}/account/credits`;
  try {
    if (!loadSaasConfig().billingEnabled) throw new AppError('BILLING_NOT_ENABLED');
    if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
    const result = await requestTopUp(tenant.database, tenant.context, {
      offerId: idOf(form, 'offerId'),
      quoteHash: text(form, 'quoteHash'),
      requestKey: text(form, 'requestKey'),
    });
    target = `/o/${organizationId}/account/invoices/${result.invoiceId}`;
  } catch (error) {
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
      getRuntime().log.error('credits.action_failed', { errorCode: errorCode(error) });
    target += `?error=${code}`;
  }
  redirect(target);
}
