'use server';
import {
  AppError,
  auditRefusal,
  canonicalId,
  isAuditedRefusal,
  refusalCode,
  refusalFromDatabase,
} from '@ensemus/application';
import { setRetentionRule } from '@ensemus/application/saas/retention';
import { placeLegalHold, releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import { placeLegalHoldSchema, setRetentionRuleSchema } from '@ensemus/contracts/saas';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { getRuntime } from './runtime';
import { requireAccountTenant } from './tenant';
import type { RetentionRuleFormState } from '@/app/o/[organizationId]/account/retention/rule-form';
import type { LegalHoldFormState } from '@/app/o/[organizationId]/account/legal-holds/hold-form';
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
    getRuntime().log.error('lifecycle.action_failed', { errorCode: errorCode(error) });
  return code;
}
export async function setRetentionRuleFormAction(
  _previous: RetentionRuleFormState,
  form: FormData,
): Promise<RetentionRuleFormState> {
  const organizationId = idOf(form, 'organizationId'),
    tenant = await requireAccountTenant(organizationId);
  const values = {
    dataCategory: text(form, 'dataCategory'),
    classification: text(form, 'classification'),
    retainDays: text(form, 'retainDays'),
    basisRef: text(form, 'basisRef'),
  };
  try {
    const parsed = setRetentionRuleSchema.safeParse({
      data_category: values.dataCategory,
      classification: values.classification,
      retain_days:
        values.retainDays.trim() === ''
          ? null
          : /^[1-9]\d*$/.test(values.retainDays)
            ? Number(values.retainDays)
            : NaN,
      basis_ref: values.basisRef,
    });
    if (!parsed.success)
      throw new AppError(values.basisRef.trim() ? 'INVALID_INPUT' : 'RETENTION_BASIS_REQUIRED');
    await setRetentionRule(tenant.database, tenant.context, {
      dataCategory: parsed.data.data_category,
      classification: parsed.data.classification,
      retainDays: parsed.data.retain_days,
      basisRef: parsed.data.basis_ref,
    });
    revalidatePath(`/o/${organizationId}/account/retention`);
    return { values, saved: true };
  } catch (error) {
    return { values, code: await codeFor(error, tenant) };
  }
}
export async function placeLegalHoldFormAction(
  _previous: LegalHoldFormState,
  form: FormData,
): Promise<LegalHoldFormState> {
  const organizationId = idOf(form, 'organizationId'),
    tenant = await requireAccountTenant(organizationId),
    values = {
      matterRef: text(form, 'matterRef'),
      scopeTokens: form
        .getAll('scopes')
        .filter((value): value is string => typeof value === 'string'),
    };
  try {
    const scopes = values.scopeTokens.map((token) => {
      const [type, id] = token.split(':');
      return { type, id: type === 'organization' ? null : id };
    });
    const parsed = placeLegalHoldSchema.safeParse({ matter_ref: values.matterRef, scopes });
    if (!parsed.success) throw new AppError('INVALID_INPUT');
    await placeLegalHold(tenant.database, tenant.context, {
      matterRef: parsed.data.matter_ref,
      scopes: parsed.data.scopes,
    });
    revalidatePath(`/o/${organizationId}/account/legal-holds`);
    return { values: { matterRef: '', scopeTokens: [] }, saved: true };
  } catch (error) {
    return { values, code: await codeFor(error, tenant) };
  }
}
export async function releaseLegalHoldAction(form: FormData): Promise<never> {
  const organizationId = idOf(form, 'organizationId'),
    tenant = await requireAccountTenant(organizationId),
    back = `/o/${organizationId}/account/legal-holds`;
  let target = back;
  try {
    if (text(form, 'confirm') !== 'yes' || !/^[1-9]\d*$/.test(text(form, 'version')))
      throw new AppError('INVALID_INPUT');
    await releaseLegalHold(tenant.database, tenant.context, {
      holdId: idOf(form, 'holdId'),
      reasonCode: text(form, 'reasonCode'),
      expectedVersion: Number(text(form, 'version')),
    });
    revalidatePath(back);
  } catch (error) {
    target += `?error=${await codeFor(error, tenant)}`;
  }
  redirect(target);
}
