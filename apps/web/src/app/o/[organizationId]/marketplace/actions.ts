'use server';

import {
  AppError,
  createPublisher,
  idSchema,
  refusalFromDatabase,
  removeInstallation,
  requestDelisting,
  requestInstallation,
  submitToMarketplace,
  withdrawSubmission,
} from '@ensemus/application';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { stepUpPath } from '@/lib/step-up';
import { redirectForSsoRefusal } from '@/server/interactive-refusal';
import { requireMarketplace } from '@/server/marketplace-api';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';

export type MarketplaceOperation =
  'register' | 'submit' | 'withdraw' | 'delist' | 'install' | 'remove';
export type MarketplaceFormState = { code?: string; stepUp?: string; displayName?: string };

export async function marketplaceAction(
  operation: MarketplaceOperation,
  _previous: MarketplaceFormState,
  form: FormData,
): Promise<MarketplaceFormState> {
  const organization = idSchema.safeParse(form.get('organizationId'));
  if (!organization.success) notFound();
  const organizationId = organization.data;
  const { database, context } = await requireTenant(organizationId);
  const root = `/o/${organizationId}`;
  const base = `${root}/marketplace`;
  let destination = `${base}/publishing`;
  let returnPath = destination;
  const rawName = form.get('displayName');
  const displayName = typeof rawName === 'string' ? rawName : '';
  try {
    const gate = await requireMarketplace(context);
    if (operation === 'register') {
      await createPublisher(database, context, gate, { displayName });
    } else {
      const id = idSchema.safeParse(form.get('targetId'));
      if (!id.success) throw new AppError('INVALID_INPUT');
      if (operation === 'submit') returnPath = `${root}/skills/versions/${id.data}`;
      if (operation === 'install') returnPath = `${base}/listings/${id.data}`;
      if (operation === 'remove') returnPath = `${base}/installations`;
      if (form.get('confirm') !== 'yes') throw new AppError('INVALID_INPUT');
      const expectedVersion = Number(form.get('version'));
      switch (operation) {
        case 'submit':
          await submitToMarketplace(database, context, gate, {
            skillVersionId: id.data,
            confirmShareWithOtherOrganizations: true,
          });
          break;
        case 'withdraw':
          await withdrawSubmission(database, context, { submissionId: id.data, expectedVersion });
          break;
        case 'delist':
          await requestDelisting(database, context, { submissionId: id.data, expectedVersion });
          break;
        case 'install':
          await requestInstallation(database, context, gate, { listingId: id.data });
          destination = `${base}/installations`;
          break;
        case 'remove':
          await removeInstallation(database, context, { installationId: id.data, expectedVersion });
          destination = returnPath;
          break;
        default:
          throw new AppError('INVALID_INPUT');
      }
    }
  } catch (error) {
    redirectForSsoRefusal(error);
    const failure = error instanceof AppError ? error : refusalFromDatabase(error);
    if (failure?.code === 'NOT_FOUND') notFound();
    if (failure?.code === 'RESTORE_PENDING') redirect('/restoring');
    const values = operation === 'register' ? { displayName: displayName.slice(0, 120) } : {};
    if (failure?.code === 'MFA_REQUIRED')
      return { ...values, code: failure.code, stepUp: stepUpPath(organizationId, returnPath) };
    if (failure) return { ...values, code: failure.code };
    getRuntime().log.error('marketplace.change_failed', { errorCode: errorCode(error) });
    return { ...values, code: 'UNEXPECTED' };
  }
  revalidatePath(base, 'layout');
  if (operation === 'remove') revalidatePath(`${root}/skills`, 'layout');
  redirect(destination);
}
