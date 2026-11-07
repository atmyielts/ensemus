'use server';

// Every action is a public endpoint. Each one resolves the person and tenant again from the session, and
// the services re-check permission. None captures a value in a closure, and none returns one, so a key
// sent to `attachKeyAction` goes no further than the sealing call.
import {
  AppError,
  auditRefusal,
  canonicalId,
  isAuditedRefusal,
  refusalCode,
} from '@ensemus/application';
import {
  addRateCard,
  createModelProfile,
  disableModelProfile,
  requestModelProbe,
  updateModelProfile,
} from '@ensemus/application/ai-model-profiles';
import { loadModelEgressSettings } from '@ensemus/config';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { stepUpPath } from '@/lib/step-up';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';
import { captureModelKey } from './capture';
import { createInputFromForm, updateInputFromForm, usdPerMtokToMicros } from './model-form';

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, name: string) => canonicalId(text(form, name));
const orgOf = (form: FormData) => idOf(form, 'organizationId');
const profileOf = (form: FormData) => idOf(form, 'profileId');
const versionOf = (form: FormData) => Number.parseInt(text(form, 'version'), 10);
const listPath = (org: string) => `/o/${org}/settings/models`;
const profilePath = (org: string, profileId: string) => `${listPath(org)}/${profileId}`;

type Tenant = { context: TenantContext; database: AppDatabase };

/** Sends people back to where they were, with a known error code and never a raw message. */
async function run(
  tenant: Tenant,
  back: string,
  action: () => Promise<string | void>,
): Promise<never> {
  let target = back;
  try {
    const next = await action();
    revalidatePath(next ?? back);
    if (next) target = next;
  } catch (error) {
    if (isAuditedRefusal(error)) {
      await auditRefusal(tenant.database, tenant.context, {
        code: refusalCode(error),
        surface: 'web',
      }).catch((failure: unknown) =>
        getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
      );
    }
    if (error instanceof AppError && error.code === 'RESTORE_PENDING') {
      target = '/restoring';
    } else if (error instanceof AppError && error.code === 'MFA_REQUIRED') {
      target = stepUpPath(tenant.context.organizationId, back);
    } else if (error instanceof AppError) {
      target = `${back}?error=${error.code}`;
    } else {
      getRuntime().log.error('action.failed', { errorCode: errorCode(error) });
      target = `${back}?error=UNEXPECTED`;
    }
  }
  redirect(target);
}

export async function createProfileAction(form: FormData) {
  const org = orgOf(form);
  const tenant = await requireTenant(org);
  await run(tenant, listPath(org), async () => {
    const { privateEndpoints } = loadModelEgressSettings();
    const profile = await createModelProfile(
      tenant.database,
      tenant.context,
      createInputFromForm(form),
      { privateEndpoints },
    );
    return profilePath(org, profile.id);
  });
}

export async function updateProfileAction(form: FormData) {
  const org = orgOf(form);
  const profileId = profileOf(form);
  const tenant = await requireTenant(org);
  await run(tenant, profilePath(org, profileId), async () => {
    const { privateEndpoints } = loadModelEgressSettings();
    await updateModelProfile(
      tenant.database,
      tenant.context,
      { profileId, patch: updateInputFromForm(form) },
      { privateEndpoints },
    );
  });
}

export async function attachKeyAction(form: FormData) {
  const org = orgOf(form);
  const profileId = profileOf(form);
  const tenant = await requireTenant(org);
  await run(tenant, profilePath(org, profileId), async () => {
    await captureModelKey(tenant.database, tenant.context, {
      profileId,
      expectedVersion: versionOf(form),
      key: text(form, 'key'),
    });
  });
}

export async function requestProbeAction(form: FormData) {
  const org = orgOf(form);
  const profileId = profileOf(form);
  const tenant = await requireTenant(org);
  await run(tenant, profilePath(org, profileId), async () => {
    await requestModelProbe(tenant.database, tenant.context, {
      profileId,
      expectedVersion: versionOf(form),
    });
  });
}

export async function disableProfileAction(form: FormData) {
  const org = orgOf(form);
  const profileId = profileOf(form);
  const tenant = await requireTenant(org);
  await run(tenant, profilePath(org, profileId), async () => {
    // Browsers check the box, and so does this: turning a model off stops what is using it.
    if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
    await disableModelProfile(tenant.database, tenant.context, {
      profileId,
      expectedVersion: versionOf(form),
    });
  });
}

export async function addRateCardAction(form: FormData) {
  const org = orgOf(form);
  const profileId = profileOf(form);
  const tenant = await requireTenant(org);
  await run(tenant, profilePath(org, profileId), async () => {
    const inputMicrosPerMtok = usdPerMtokToMicros(text(form, 'inputUsd'));
    const outputMicrosPerMtok = usdPerMtokToMicros(text(form, 'outputUsd'));
    if (inputMicrosPerMtok === null || outputMicrosPerMtok === null) {
      throw new AppError('INVALID_INPUT');
    }
    await addRateCard(tenant.database, tenant.context, {
      profileId,
      inputMicrosPerMtok,
      outputMicrosPerMtok,
    });
  });
}
