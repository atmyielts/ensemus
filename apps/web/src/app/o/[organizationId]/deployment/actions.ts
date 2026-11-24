'use server';

import { AppError, idSchema, setResidencyRequirement } from '@ensemus/application';
import { setResidencyRequirementSchema } from '@ensemus/contracts/tenancy';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';
import { redirectForSsoRefusal } from '@/server/interactive-refusal';

export async function updateResidencyRequirement(organizationId: string, form: FormData) {
  const org = idSchema.safeParse(organizationId);
  if (!org.success) throw new AppError('INVALID_INPUT');
  const { context, database } = await requireTenant(org.data);
  const selection = form.get('selection');
  const [scope, version, extra] = typeof selection === 'string' ? selection.split(':') : [];
  const operation = form.get('operation');
  const input = setResidencyRequirementSchema.safeParse({
    scope,
    region: operation === 'remove' ? null : (form.get('region') ?? undefined),
    expected_version: version && /^\d+$/.test(version) ? Number(version) : undefined,
  });
  const path = `/o/${org.data}/deployment`;
  let result = '?residencySaved=1';
  try {
    if (
      !input.success ||
      extra !== undefined ||
      (operation !== 'set' && operation !== 'remove') ||
      (operation === 'remove' && form.get('confirm') !== 'yes')
    )
      throw new AppError('INVALID_INPUT');
    await setResidencyRequirement(database, context, {
      scope: input.data.scope,
      region: input.data.region,
      expectedVersion: input.data.expected_version,
    });
    revalidatePath(path);
  } catch (error) {
    redirectForSsoRefusal(error);
    if (!(error instanceof AppError))
      getRuntime().log.error('residency.requirement_write_failed', { errorCode: errorCode(error) });
    result =
      '?residencyError=' +
      encodeURIComponent(error instanceof AppError ? error.code : 'UNEXPECTED');
  }
  redirect(path + result + '#residency-requirements');
}
