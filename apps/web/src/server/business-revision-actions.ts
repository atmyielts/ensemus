'use server';
import {
  AppError,
  canonicalId,
  getExternalActionDetail,
  reviseBusinessAction,
  requestHash,
  runIdempotent,
  idSchema,
  auditRefusal,
  isAuditedRefusal,
  refusalCode,
} from '@ensemus/application';
import { canonicalJson } from '@ensemus/domain/approval';
import { errorCode } from '@ensemus/telemetry';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { BusinessProposalFormState } from '@/lib/business-proposal-form';
import { businessRevisionFields, businessRevisionPayload } from '@/lib/business-revision-input';
import { requireTenantForAction } from './tenant';
import { assertConnectorsEnabled } from './api';
import { getRuntime } from './runtime';
const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, name: string) => canonicalId(text(form, name));
export async function reviseBusinessProposalAction(
  state: BusinessProposalFormState,
  form: FormData,
): Promise<BusinessProposalFormState> {
  const org = idSchema.safeParse(idOf(form, 'organizationId'));
  if (!org.success) return { code: 'INVALID_INPUT' };
  const { database, context } = await requireTenantForAction(org.data);
  const values: Record<string, string> = {};
  let approvalId: string;
  try {
    assertConnectorsEnabled();
    const actionId = idSchema.safeParse(idOf(form, 'externalActionId'));
    const rawVersion = text(form, 'version'),
      key = text(form, 'requestKey'),
      reviewer = text(form, 'reviewer');
    if (
      !actionId.success ||
      !/^\d{1,15}$/.test(rawVersion) ||
      !Number.isSafeInteger(Number(rawVersion)) ||
      Number(rawVersion) < 1
    )
      throw new AppError('INVALID_INPUT');
    const current = await getExternalActionDetail(database, context, actionId.data);
    const fields = businessRevisionFields(current.toolName, current.payload);
    if (!fields) throw new AppError('INVALID_INPUT');
    const allowed = new Set([
      'organizationId',
      'externalActionId',
      'version',
      'requestKey',
      'reviewer',
      ...fields.flatMap((field) => [
        field.name,
        ...(field.clearable ? ['clear.' + field.name] : []),
      ]),
    ]);
    for (const [name, input] of form) {
      if (name.startsWith('$ACTION_')) continue;
      if (!allowed.has(name) || form.getAll(name).length !== 1 || typeof input !== 'string')
        throw new AppError('INVALID_INPUT');
    }
    for (const field of fields) {
      values[field.name] = text(form, field.name).slice(0, field.maxLength + 1);
      if (field.clearable) values['clear.' + field.name] = text(form, 'clear.' + field.name);
    }
    values.reviewer = reviewer;
    const payload = businessRevisionPayload(current.toolName, current.payload, values);
    if (!payload) throw new AppError('INVALID_INPUT');
    const input = {
      externalActionId: actionId.data,
      expectedVersion: Number(rawVersion),
      payload,
      approverMembershipId: reviewer,
    };
    const result = await runIdempotent(
      database,
      context,
      { key, requestHash: requestHash(['WEB business revision', canonicalJson(input)]) },
      (joined) => reviseBusinessAction(joined, context, input),
      (row) => ({ status: 201, body: { approvalId: row.approvalId } }),
    );
    if (result.kind === 'conflict') throw new AppError('IDEMPOTENCY_KEY_REUSED');
    const parsed = idSchema.safeParse((result.body as { approvalId: string }).approvalId);
    if (!parsed.success) throw new AppError('INVALID_STATE');
    approvalId = parsed.data;
  } catch (error) {
    if (isAuditedRefusal(error))
      await auditRefusal(database, context, { surface: 'web', code: refusalCode(error) }).catch(
        (failure) =>
          getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
      );
    if (!(error instanceof AppError)) throw error;
    return { code: error.code, values, revision: (state.revision ?? 0) + 1 };
  }
  revalidatePath(`/o/${org.data}/external-actions`);
  revalidatePath(`/o/${org.data}/approvals`);
  redirect(`/o/${org.data}/approvals/${approvalId}`);
}
