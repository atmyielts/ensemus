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
  requestInvoicePaymentOnce,
  resolveUnknownPayment,
} from '@ensemus/application/saas/payments';
import { loadSaasConfig } from '@ensemus/config';
import { can } from '@ensemus/domain/policy';
import { errorCode } from '@ensemus/telemetry';
import { notFound, redirect } from 'next/navigation';
import { requireAccountTenant } from './tenant';
import { getRuntime } from './runtime';

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, key: string) => canonicalId(text(form, key));
async function paymentAction(form: FormData, kind: 'request' | 'resolve'): Promise<never> {
  const organizationId = idOf(form, 'organizationId'),
    invoiceId = idOf(form, 'invoiceId');
  const tenant = await requireAccountTenant(organizationId);
  let target = `/o/${organizationId}/account/invoices/${invoiceId}/pay`;
  try {
    if (!can(tenant.context.role, 'billing.manage')) throw new AppError('NOT_FOUND');
    if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
    if (kind === 'request') {
      const config = loadSaasConfig();
      if (!config.billingEnabled) throw new AppError('BILLING_NOT_ENABLED');
      if (!config.paymentProcessor) throw new AppError('PAYMENT_PROCESSOR_NOT_CONFIGURED');
      const result = await requestInvoicePaymentOnce(tenant.database, tenant.context, {
        invoiceId,
        processor: config.paymentProcessor,
        requestKey: text(form, 'requestKey'),
      });
      if (result.kind === 'conflict') throw new AppError('VERSION_CONFLICT');
    } else {
      const expectedVersion = Number(text(form, 'expectedVersion'));
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
        throw new AppError('INVALID_INPUT');
      await resolveUnknownPayment(tenant.database, tenant.context, {
        paymentId: idOf(form, 'paymentId'),
        expectedVersion,
        resolution: 'confirmed_not_charged',
      });
    }
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
      getRuntime().log.error('payments.action_failed', { errorCode: errorCode(error) });
    target += `?error=${code}`;
  }
  redirect(target);
}
export async function requestPaymentAction(form: FormData): Promise<never> {
  return paymentAction(form, 'request');
}
export async function resolvePaymentAction(form: FormData): Promise<never> {
  return paymentAction(form, 'resolve');
}
