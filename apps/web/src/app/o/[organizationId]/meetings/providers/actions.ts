'use server';
import { AppError, revokeMeetingProvider } from '@ensemus/application';
import { approveProviderSchema } from '@ensemus/contracts/meetings';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { approveMeetingProviderOnce } from '@/server/meeting-api';
import { redirectForSsoRefusal } from '@/server/interactive-refusal';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';

type Draft = {
  target: string;
  maxClass: string;
  terms: string;
  expiry: string;
  purposes: string[];
};
type State = { code?: string; draft?: Draft; revision?: number };

function text(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function refusal(error: unknown) {
  redirectForSsoRefusal(error);
  const code = errorCode(error);
  if (error instanceof AppError) return error.code;
  getRuntime().log.error('meeting.provider_write_failed', { errorCode: code });
  return 'UNEXPECTED';
}

export async function saveProvider(
  organizationId: string,
  kind: 'model' | 'source',
  state: State,
  form: FormData,
): Promise<State> {
  const { database, context } = await requireTenant(organizationId);
  const draft: Draft = {
    target: text(form, 'target').slice(0, 36),
    maxClass: text(form, 'maxClass').slice(0, 12),
    terms: text(form, 'terms').slice(0, 200),
    expiry: text(form, 'expiry').slice(0, 16),
    purposes: form
      .getAll('purpose')
      .filter((value): value is string => value === 'summarize' || value === 'extract_items'),
  };
  const common = {
    max_classification: text(form, 'maxClass'),
    terms_ref: text(form, 'terms'),
    expires_at: text(form, 'expiry') + ':00Z',
  };
  const body = approveProviderSchema.safeParse(
    kind === 'model'
      ? { ...common, kind, model_profile_id: text(form, 'target'), purposes: draft.purposes }
      : { ...common, kind, connection_id: text(form, 'target') },
  );
  try {
    if (!body.success) throw new AppError('INVALID_INPUT');
    await approveMeetingProviderOnce(database, context, text(form, 'requestKey'), body.data);
  } catch (error) {
    return { code: refusal(error), draft, revision: (state.revision ?? 0) + 1 };
  }
  const path = '/o/' + organizationId + '/meetings/providers';
  revalidatePath(path);
  redirect(path + '?notice=approved');
}

export async function revokeProvider(organizationId: string, id: string, form: FormData) {
  const { database, context } = await requireTenant(organizationId);
  const path = '/o/' + organizationId + '/meetings/providers';
  let code: string | undefined;
  try {
    if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
    await revokeMeetingProvider(database, context, { providerApprovalId: id });
  } catch (error) {
    code = refusal(error);
  }
  revalidatePath(path);
  redirect(path + (code ? '?error=' + encodeURIComponent(code) : '?notice=revoked'));
}
