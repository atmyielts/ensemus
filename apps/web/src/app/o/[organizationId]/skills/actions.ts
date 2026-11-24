'use server';

import { AppError, createSkillPackage, idSchema, updateSkillPackage } from '@ensemus/application';
import { createSkillPackageSchema, updateSkillPackageSchema } from '@ensemus/contracts/skills';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { stepUpPath } from '@/lib/step-up';
import { redirectForSsoRefusal } from '@/server/interactive-refusal';
import { getRuntime } from '@/server/runtime';
import { getSkillFeatureGate } from '@/server/skill-runtime';
import { requireTenant } from '@/server/tenant';

type FormValues = { name: string; displayName: string; classification: string; state: string };
export type PackageFormState = { code?: string; values?: FormValues; stepUp?: string };

function text(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? value : undefined;
}

export async function saveSkillPackageAction(
  _previous: PackageFormState,
  form: FormData,
): Promise<PackageFormState> {
  const organization = idSchema.safeParse(text(form, 'organizationId'));
  if (!organization.success) notFound();
  const organizationId = organization.data;
  const { database, context } = await requireTenant(organizationId);
  const packageId = text(form, 'packageId');
  const base = `/o/${organizationId}/skills`;
  const parsedId = packageId === undefined ? undefined : idSchema.safeParse(packageId);
  if (parsedId && !parsedId.success) notFound();
  const id = parsedId?.data;
  const values: FormValues = {
    name: (text(form, 'name') ?? '').slice(0, 64),
    displayName: (text(form, 'displayName') ?? '').slice(0, 120),
    classification: (text(form, 'classification') ?? '').slice(0, 16),
    state: (text(form, 'state') ?? '').slice(0, 16),
  };
  let destination;
  try {
    if (id) {
      const patch = updateSkillPackageSchema.safeParse({
        display_name: text(form, 'displayName'),
        state: text(form, 'state'),
        content_classification: text(form, 'classification'),
      });
      if (!patch.success) throw new AppError('INVALID_INPUT');
      const body = patch.data;
      await updateSkillPackage(database, context, {
        packageId: id,
        expectedVersion: Number(text(form, 'version')),
        ...(body.display_name === undefined ? {} : { displayName: body.display_name }),
        ...(body.state === undefined ? {} : { state: body.state }),
        ...(body.content_classification === undefined
          ? {}
          : { contentClassification: body.content_classification }),
      });
      destination = `${base}/${id}`;
    } else {
      const creation = createSkillPackageSchema.safeParse({
        name: text(form, 'name'),
        display_name: text(form, 'displayName'),
        content_classification: text(form, 'classification'),
      });
      if (!creation.success) throw new AppError('INVALID_INPUT');
      const pkg = await createSkillPackage(database, context, getSkillFeatureGate(), {
        name: creation.data.name,
        displayName: creation.data.display_name,
        contentClassification: creation.data.content_classification ?? 'internal',
      });
      destination = `${base}/${pkg.id}`;
    }
  } catch (error) {
    redirectForSsoRefusal(error);
    if (error instanceof AppError) {
      if (error.code === 'NOT_FOUND') notFound();
      if (error.code === 'RESTORE_PENDING') redirect('/restoring');
      if (error.code === 'MFA_REQUIRED')
        return {
          code: error.code,
          values,
          stepUp: stepUpPath(organizationId, id ? `${base}/${id}` : `${base}/new`),
        };
      return { code: error.code, values };
    }
    getRuntime().log.error('skill_package.save_failed', { errorCode: errorCode(error) });
    return { code: 'UNEXPECTED', values };
  }
  revalidatePath(base);
  revalidatePath(destination);
  redirect(destination);
}
