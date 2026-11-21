'use server';
import { errorCode } from '@ensemus/telemetry';
import { getRuntime } from './runtime';
import {
  AppError,
  createBusinessRecordProposal,
  idSchema,
  requestHash,
  runIdempotent,
  auditRefusal,
  isAuditedRefusal,
  refusalCode,
} from '@ensemus/application';
import { canonicalJson } from '@ensemus/domain/approval';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { BusinessProposalFormState } from '@/lib/business-proposal-form';
import { requireTenantForAction } from './tenant';
import { assertConnectorsEnabled } from './api';
const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
export async function requestBusinessRecordReview(
  state: BusinessProposalFormState,
  form: FormData,
): Promise<BusinessProposalFormState> {
  const names = [
    'organizationId',
    'recordId',
    'requestKey',
    'title',
    'reviewer',
    'kind',
    'field',
    'value',
    'sourceVersion',
    'clearValue',
    'body',
    'customer',
    'currency',
    'description',
    'quantity',
    'unitPrice',
    'memo',
  ];
  const values = Object.fromEntries(names.map((name) => [name, text(form, name)]));
  const org = idSchema.safeParse(values.organizationId),
    record = idSchema.safeParse(values.recordId);
  if (!org.success || !record.success)
    return { code: 'INVALID_INPUT', values, revision: (state.revision ?? 0) + 1 };
  const { database, context } = await requireTenantForAction(org.data);
  let approvalId: string;
  try {
    assertConnectorsEnabled();
    const common = {
      recordId: record.data,
      title: values.title!,
      approverMembershipId: values.reviewer!,
    };
    let input: Parameters<typeof createBusinessRecordProposal>[2];
    if (values.kind === 'update') {
      let version: unknown;
      try {
        version = JSON.parse(values.sourceVersion!);
      } catch {
        throw new AppError('INVALID_INPUT');
      }
      if (version !== null && typeof version !== 'string') throw new AppError('INVALID_INPUT');
      input = {
        ...common,
        kind: 'update',
        expectedVersion: version,
        changes: { [values.field!]: values.clearValue === 'on' ? null : values.value! },
      };
    } else if (values.kind === 'note') input = { ...common, kind: 'note', body: values.body! };
    else if (values.kind === 'invoice')
      input = {
        ...common,
        kind: 'invoice',
        invoice: {
          customer_ref: values.customer,
          currency: values.currency,
          lines: [
            {
              description: values.description,
              quantity: values.quantity,
              unit_price: values.unitPrice,
            },
          ],
          ...(values.memo ? { memo: values.memo } : {}),
        },
      };
    else throw new AppError('INVALID_INPUT');
    const result = await runIdempotent(
      database,
      context,
      {
        key: values.requestKey!,
        requestHash: requestHash(['WEB business proposal', canonicalJson(input)]),
      },
      (joined) => createBusinessRecordProposal(joined, context, input),
      (row) => ({ status: 201, body: { approvalId: row.approvalId } }),
    );
    if (result.kind === 'conflict') throw new AppError('IDEMPOTENCY_KEY_REUSED');
    const body = result.body as { approvalId: string };
    if (!idSchema.safeParse(body.approvalId).success) throw new AppError('INVALID_STATE');
    approvalId = body.approvalId;
  } catch (error) {
    if (isAuditedRefusal(error))
      await auditRefusal(database, context, { surface: 'web', code: refusalCode(error) }).catch(
        (failure) =>
          getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
      );
    if (!(error instanceof AppError)) throw error;
    return { code: error.code, values, revision: (state.revision ?? 0) + 1 };
  }
  revalidatePath(`/o/${org.data}/work`);
  revalidatePath(`/o/${org.data}/approvals`);
  redirect(`/o/${org.data}/approvals/${approvalId}`);
}
