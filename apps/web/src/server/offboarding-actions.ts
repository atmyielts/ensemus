'use server';
import {
  AppError,
  auditRefusal,
  canonicalId,
  isAuditedRefusal,
  refusalCode,
  refusalFromDatabase,
} from '@ensemus/application';
import { cancelOffboarding, requestOffboarding } from '@ensemus/application/saas/offboarding';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { getRuntime } from './runtime';
import { requireAccountTenant } from './tenant';
import { getOffboardingAgents } from './offboarding-bindings';
import type { OffboardingFormState } from '@/app/o/[organizationId]/account/leave/request-form';
const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, key: string) => canonicalId(text(form, key));
async function codeFor(error: unknown, tenant: Awaited<ReturnType<typeof requireAccountTenant>>) {
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
    getRuntime().log.error('offboarding.action_failed', { errorCode: errorCode(error) });
  return code;
}
export async function requestOffboardingFormAction(
  _previous: OffboardingFormState,
  form: FormData,
): Promise<OffboardingFormState> {
  const organizationId = idOf(form, 'organizationId'),
    tenant = await requireAccountTenant(organizationId),
    values = { confirmName: text(form, 'confirmName') };
  try {
    if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
    await requestOffboarding(tenant.database, tenant.context, values, getOffboardingAgents());
    revalidatePath(`/o/${organizationId}/account/leave`);
    return { values, requested: true };
  } catch (error) {
    return { values, code: await codeFor(error, tenant) };
  }
}
export async function cancelOffboardingAction(form: FormData): Promise<never> {
  const organizationId = idOf(form, 'organizationId'),
    tenant = await requireAccountTenant(organizationId),
    back = `/o/${organizationId}/account/leave`;
  let target = back;
  try {
    if (text(form, 'confirm') !== 'yes' || !/^[1-9]\d*$/.test(text(form, 'version')))
      throw new AppError('INVALID_INPUT');
    await cancelOffboarding(
      tenant.database,
      tenant.context,
      { reasonCode: text(form, 'reasonCode'), expectedVersion: Number(text(form, 'version')) },
      getOffboardingAgents(),
    );
    revalidatePath(back);
  } catch (error) {
    target += `?error=${await codeFor(error, tenant)}`;
  }
  redirect(target);
}
