'use server';

import {
  AppError,
  createSkillPackage,
  idSchema,
  publishSkillVersion,
  refusalFromDatabase,
  updateSkillPackage,
  uploadSkillBundle,
  yankSkillVersion,
} from '@ensemus/application';
import {
  createSkillPackageSchema,
  updateSkillPackageSchema,
  yankSkillVersionSchema,
} from '@ensemus/contracts/skills';
import { SKILL_BUNDLE_MAX_BYTES } from '@ensemus/domain/skill';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { stepUpPath } from '@/lib/step-up';
import { redirectForSsoRefusal } from '@/server/interactive-refusal';
import { getRuntime, getStore } from '@/server/runtime';
import { getSkillFeatureGate } from '@/server/skill-runtime';
import { requireTenant } from '@/server/tenant';

type FormValues = { name: string; displayName: string; classification: string; state: string };
export type PackageFormState = { code?: string; values?: FormValues; stepUp?: string };
export type UploadFormState = { code?: string; stepUp?: string };
export type ReleaseFormState = UploadFormState & { operation?: 'publish' | 'yank' };

function text(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' ? value : undefined;
}

function idOf(form: FormData, name: string): string {
  const parsed = idSchema.safeParse(form.get(name));
  if (!parsed.success) notFound();
  return parsed.data;
}

export async function saveSkillPackageAction(
  _previous: PackageFormState,
  form: FormData,
): Promise<PackageFormState> {
  const organizationId = idOf(form, 'organizationId');
  const { database, context } = await requireTenant(organizationId);
  const id = form.has('packageId') ? idOf(form, 'packageId') : undefined;
  const base = `/o/${organizationId}/skills`;
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

export async function uploadSkillBundleAction(
  _previous: UploadFormState,
  form: FormData,
): Promise<UploadFormState> {
  const organizationId = idOf(form, 'organizationId');
  const packageId = idOf(form, 'packageId');
  const { database, context } = await requireTenant(organizationId);
  const base = `/o/${organizationId}/skills`;
  const path = `${base}/${packageId}`;
  const bundle = form.get('bundle');
  if (!(bundle instanceof File) || bundle.size === 0) return { code: 'INVALID_INPUT' };
  if (bundle.size > SKILL_BUNDLE_MAX_BYTES) return { code: 'SKILL_BUNDLE_TOO_LARGE' };
  let versionId: string;
  try {
    const version = await uploadSkillBundle(database, getStore(), context, getSkillFeatureGate(), {
      packageId: packageId,
      bytes: Buffer.from(await bundle.arrayBuffer()),
    });
    versionId = version.id;
  } catch (error) {
    redirectForSsoRefusal(error);
    const failure = error instanceof AppError ? error : refusalFromDatabase(error);
    if (failure?.code === 'NOT_FOUND') notFound();
    if (failure?.code === 'RESTORE_PENDING') redirect('/restoring');
    if (failure?.code === 'MFA_REQUIRED')
      return { code: failure.code, stepUp: stepUpPath(organizationId, path) };
    if (failure) return { code: failure.code };
    getRuntime().log.error('skill_version.upload_failed', { errorCode: errorCode(error) });
    return { code: 'UNEXPECTED' };
  }
  revalidatePath(path);
  redirect(`${base}/versions/${versionId}`);
}

export async function changeSkillReleaseAction(
  _previous: ReleaseFormState,
  form: FormData,
): Promise<ReleaseFormState> {
  const organizationId = idOf(form, 'organizationId');
  const id = idOf(form, 'skillVersionId');
  const { database, context } = await requireTenant(organizationId);
  const operation = text(form, 'operation');
  if (operation !== 'publish' && operation !== 'yank') return { code: 'INVALID_INPUT' };
  const path = `/o/${organizationId}/skills/versions/${id}`;
  const input = { skillVersionId: id, expectedVersion: Number(text(form, 'version')) };
  let packageId: string;
  try {
    if (operation === 'publish') {
      packageId = (await publishSkillVersion(database, context, getSkillFeatureGate(), input))
        .packageId;
    } else {
      const body = yankSkillVersionSchema.safeParse({ code: text(form, 'code') });
      if (!body.success || text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
      packageId = (await yankSkillVersion(database, context, { ...input, code: body.data.code }))
        .packageId;
    }
  } catch (error) {
    redirectForSsoRefusal(error);
    const failure = error instanceof AppError ? error : refusalFromDatabase(error);
    if (failure?.code === 'NOT_FOUND') notFound();
    if (failure?.code === 'RESTORE_PENDING') redirect('/restoring');
    if (failure?.code === 'MFA_REQUIRED')
      return { code: failure.code, operation, stepUp: stepUpPath(organizationId, path) };
    if (failure) return { code: failure.code, operation };
    getRuntime().log.error('skill_version.release_failed', { errorCode: errorCode(error) });
    return { code: 'UNEXPECTED', operation };
  }
  revalidatePath(`/o/${organizationId}/skills/${packageId}`);
  revalidatePath(path);
  redirect(path);
}
