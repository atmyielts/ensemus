'use server';
import {
  AppError,
  auditRefusal,
  canonicalId,
  isAuditedRefusal,
  refusalCode,
} from '@ensemus/application';
import { setPulseSignalState } from '@ensemus/application/pulse';
import { createPulseMetadataReaders } from '@ensemus/application/pulse-metadata';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireTenant } from './tenant';
import { getRuntime } from './runtime';

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

export async function setPulseSignalStateAction(form: FormData): Promise<never> {
  const organizationId = canonicalId(text(form, 'organizationId'));
  const tenant = await requireTenant(organizationId);
  const back = `/o/${organizationId}/pulse`;
  let destination = back;
  try {
    const state = text(form, 'state');
    if (state !== 'open' && state !== 'dismissed' && state !== 'snoozed')
      throw new AppError('INVALID_INPUT');
    const days = text(form, 'days');
    if (state === 'snoozed' && !['1', '7', '30'].includes(days))
      throw new AppError('INVALID_INPUT');
    await setPulseSignalState(tenant.database, tenant.context, createPulseMetadataReaders(), {
      signalKey: text(form, 'signalKey'),
      state,
      ...(state === 'snoozed' ? { until: new Date(Date.now() + Number(days) * 86_400_000) } : {}),
    });
    revalidatePath(back);
  } catch (error) {
    if (isAuditedRefusal(error))
      await auditRefusal(tenant.database, tenant.context, {
        code: refusalCode(error),
        surface: 'web',
      }).catch((failure: unknown) =>
        getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
      );
    if (error instanceof AppError && error.code === 'RESTORE_PENDING') destination = '/restoring';
    else if (error instanceof AppError) destination = `${back}?error=${error.code}`;
    else {
      getRuntime().log.error('pulse.action_failed', { errorCode: errorCode(error) });
      destination = `${back}?error=UNEXPECTED`;
    }
  }
  redirect(destination);
}
