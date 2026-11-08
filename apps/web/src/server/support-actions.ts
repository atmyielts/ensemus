'use server';
import {
  AppError,
  auditRefusal,
  canonicalId,
  isAuditedRefusal,
  refusalCode,
  refusalFromDatabase,
} from '@ensemus/application';
import { closeTicket, openTicket, replyToTicket } from '@ensemus/application/saas/support';
import { decideBreakGlass, revokeBreakGlass } from '@ensemus/application/saas/break-glass';
import { loadSaasConfig } from '@ensemus/config';
import { openTicketSchema } from '@ensemus/contracts/saas';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { getRuntime } from './runtime';
import { requireAccountTenant } from './tenant';
import type { SupportFormState } from '@/app/o/[organizationId]/account/support/message-form';
const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, key: string) => canonicalId(text(form, key));
function version(form: FormData) {
  const value = text(form, 'version');
  if (!/^[1-9]\d{0,9}$/.test(value)) throw new AppError('INVALID_INPUT');
  return Number(value);
}
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
    getRuntime().log.error('support.action_failed', { errorCode: errorCode(error) });
  return code;
}
export async function openTicketFormAction(
  _previous: SupportFormState,
  form: FormData,
): Promise<SupportFormState> {
  const organizationId = idOf(form, 'organizationId'),
    tenant = await requireAccountTenant(organizationId),
    values = {
      subject: text(form, 'subject'),
      category: text(form, 'category'),
      body: text(form, 'body'),
    };
  let ticketId: string;
  try {
    const parsed = openTicketSchema.safeParse(values);
    if (!parsed.success) throw new AppError('INVALID_INPUT');
    ticketId = (await openTicket(tenant.database, tenant.context, parsed.data)).ticketId;
  } catch (error) {
    return { values, code: await codeFor(error, tenant) };
  }
  redirect(`/o/${organizationId}/account/support/${ticketId}`);
}
export async function replyTicketFormAction(
  _previous: SupportFormState,
  form: FormData,
): Promise<SupportFormState> {
  const organizationId = idOf(form, 'organizationId'),
    tenant = await requireAccountTenant(organizationId),
    ticketId = idOf(form, 'ticketId'),
    values = { subject: '', category: 'other', body: text(form, 'body') };
  try {
    const result = await replyToTicket(tenant.database, tenant.context, {
      ticketId,
      body: values.body,
      expectedVersion: version(form),
    });
    revalidatePath(`/o/${organizationId}/account/support/${ticketId}`);
    return { values: { ...values, body: '' }, version: result.version, sent: true };
  } catch (error) {
    return { values, version: _previous.version, code: await codeFor(error, tenant) };
  }
}
export async function closeTicketAction(form: FormData): Promise<never> {
  const organizationId = idOf(form, 'organizationId'),
    tenant = await requireAccountTenant(organizationId),
    ticketId = idOf(form, 'ticketId'),
    back = `/o/${organizationId}/account/support/${ticketId}`;
  let target = back;
  try {
    if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
    await closeTicket(tenant.database, tenant.context, {
      ticketId,
      expectedVersion: version(form),
    });
    revalidatePath(back);
  } catch (error) {
    target += `?error=${await codeFor(error, tenant)}`;
  }
  redirect(target);
}
export async function decideBreakGlassAction(form: FormData): Promise<never> {
  const organizationId = idOf(form, 'organizationId'),
    tenant = await requireAccountTenant(organizationId),
    back = `/o/${organizationId}/account/break-glass`;
  let target = back;
  try {
    if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
    const requestId = idOf(form, 'requestId'),
      expectedVersion = version(form),
      decision = text(form, 'decision');
    if (decision === 'revoke')
      await revokeBreakGlass(tenant.database, tenant.context, { requestId, expectedVersion });
    else {
      if (decision !== 'authorize' && decision !== 'deny') throw new AppError('INVALID_INPUT');
      await decideBreakGlass(
        tenant.database,
        tenant.context,
        { requestId, expectedVersion, decision },
        loadSaasConfig().breakGlass,
      );
    }
    revalidatePath(back);
  } catch (error) {
    target += `?error=${await codeFor(error, tenant)}`;
  }
  redirect(target);
}
