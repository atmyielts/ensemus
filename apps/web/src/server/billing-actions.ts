'use server';

import {
  AppError,
  auditRefusal,
  isAuditedRefusal,
  refusalCode,
  refusalFromDatabase,
} from '@ensemus/application';
import {
  changePlan,
  requestCancellation,
  saveBillingAccount,
  startSubscriptionOnce,
  withdrawCancellation,
} from '@ensemus/application/saas/subscriptions';
import { loadSaasConfig } from '@ensemus/config';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import type { BillingAccountFormState } from '@/components/billing-account-form';
import { requireAccountTenant } from './tenant';
import { getRuntime } from './runtime';

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
};
const nullable = (form: FormData, key: string) => text(form, key).trim() || null;
const version = (form: FormData) => {
  const wire = text(form, 'version');
  if (!/^[1-9]\d{0,9}$/.test(wire)) throw new AppError('INVALID_INPUT');
  return Number(wire);
};
type AccountTenant = Awaited<ReturnType<typeof requireAccountTenant>>;
async function codeFor(error: unknown, tenant: AccountTenant) {
  if (isAuditedRefusal(error))
    await auditRefusal(tenant.database, tenant.context, {
      code: refusalCode(error),
      surface: 'web',
    }).catch((failure: unknown) =>
      getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
    );
  if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
  if (error instanceof AppError) return error.code;
  const refused = refusalFromDatabase(error);
  if (refused) return refused.code;
  getRuntime().log.error('billing.action_failed', { errorCode: errorCode(error) });
  return 'UNEXPECTED';
}

export async function saveBillingAccountFormAction(
  _previous: BillingAccountFormState,
  form: FormData,
): Promise<BillingAccountFormState> {
  const organizationId = text(form, 'organizationId');
  const tenant = await requireAccountTenant(organizationId);
  const values = {
    billingName: text(form, 'billingName'),
    billingEmail: text(form, 'billingEmail'),
    countryCode: text(form, 'countryCode'),
    regionCode: text(form, 'regionCode'),
    postalCode: nullable(form, 'postalCode'),
    taxId: nullable(form, 'taxId'),
  };
  const wireVersion = text(form, 'version');
  try {
    const result = await saveBillingAccount(tenant.database, tenant.context, {
      ...values,
      expectedVersion: wireVersion ? version(form) : null,
    });
    revalidatePath(`/o/${organizationId}/account/billing`);
    return { values, version: result.version, saved: true };
  } catch (error) {
    return {
      values,
      version: /^[1-9]\d*$/.test(wireVersion) ? Number(wireVersion) : null,
      code: await codeFor(error, tenant),
    };
  }
}

async function subscriptionForm(
  form: FormData,
  kind: 'start' | 'change' | 'cancel' | 'withdraw',
): Promise<never> {
  const organizationId = text(form, 'organizationId');
  const tenant = await requireAccountTenant(organizationId);
  const back = `/o/${organizationId}/account/billing`;
  let next = back;
  try {
    if (!loadSaasConfig().billingEnabled) throw new AppError('BILLING_NOT_ENABLED');
    if (kind === 'start') {
      const result = await startSubscriptionOnce(tenant.database, tenant.context, {
        planVersionId: text(form, 'planVersionId'),
        requestKey: text(form, 'requestKey'),
      });
      if (result.kind === 'conflict') throw new AppError('VERSION_CONFLICT');
    } else if (kind === 'change') {
      const result = await changePlan(tenant.database, tenant.context, {
        toPlanVersionId: text(form, 'planVersionId'),
        expectedVersion: version(form),
      });
      next = `${back}?changed=${result.effective}`;
    } else {
      if (kind === 'cancel' && text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
      await (kind === 'cancel' ? requestCancellation : withdrawCancellation)(
        tenant.database,
        tenant.context,
        { expectedVersion: version(form) },
      );
    }
    revalidatePath(back);
  } catch (error) {
    next = `${back}?error=${await codeFor(error, tenant)}`;
  }
  redirect(next);
}
export async function startSubscriptionAction(form: FormData) {
  return subscriptionForm(form, 'start');
}
export async function changePlanAction(form: FormData) {
  return subscriptionForm(form, 'change');
}
export async function requestCancellationAction(form: FormData) {
  return subscriptionForm(form, 'cancel');
}
export async function withdrawCancellationAction(form: FormData) {
  return subscriptionForm(form, 'withdraw');
}
