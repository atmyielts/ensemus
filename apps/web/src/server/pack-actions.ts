'use server';

// Every action is a public endpoint. Each one resolves the person and tenant again from the session and the
// service checks permission itself. The session for a recent-MFA check comes from the verified cookie, and
// nothing from a form can name one. There is no accept-all here on purpose: one form decides one capability.
import {
  AppError,
  auditRefusal,
  canonicalId,
  isAuditedRefusal,
  refusalCode,
} from '@ensemus/application';
import { createPackService } from '@ensemus/application/packs';
import { decidePackCapabilitySchema, requestPackInstallSchema } from '@ensemus/contracts/packs';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { stepUpPath } from '@/lib/step-up';
import { webProductPorts } from './product-ports';
import { getRuntime } from './runtime';
import { requireTenant } from './tenant';

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, name: string) => canonicalId(text(form, name));
const int = (form: FormData, name: string) => Number.parseInt(text(form, name), 10);

const service = () => createPackService({ toolCatalog: webProductPorts().toolCatalog });

const installationPath = (organizationId: string, installationId: string) =>
  `/o/${organizationId}/packs/installations/${installationId}`;

type Tenant = { context: TenantContext; database: AppDatabase };

async function recordRefusal(tenant: Tenant, error: unknown) {
  if (!isAuditedRefusal(error)) return;
  await auditRefusal(tenant.database, tenant.context, {
    code: refusalCode(error),
    surface: 'web',
  }).catch((failure: unknown) =>
    getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
  );
}

/** Sends people back to where they were, with a known code and never a raw message. */
async function run(
  tenant: Tenant,
  organizationId: string,
  back: string,
  action: () => Promise<string | void>,
): Promise<never> {
  let target = back;
  try {
    const next = await action();
    if (next) target = next;
    revalidatePath(`/o/${organizationId}/packs`);
  } catch (error) {
    await recordRefusal(tenant, error);
    if (error instanceof AppError && error.code === 'RESTORE_PENDING') {
      target = '/restoring';
    } else if (error instanceof AppError && error.code === 'MFA_REQUIRED') {
      target = stepUpPath(organizationId, back);
    } else if (error instanceof AppError) {
      target = `${back}?error=${error.code}`;
    } else {
      getRuntime().log.error('action.failed', { errorCode: errorCode(error) });
      target = `${back}?error=UNEXPECTED`;
    }
  }
  redirect(target);
}

/** Something that changes what a tenant holds has to be meant. Browsers check the box, and so does this. */
function assertConfirmed(form: FormData) {
  if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
}

export async function requestPackInstallAction(form: FormData) {
  const organizationId = idOf(form, 'organizationId');
  const tenant = await requireTenant(organizationId);
  const back = `/o/${organizationId}/packs`;
  await run(tenant, organizationId, back, async () => {
    const body = requestPackInstallSchema.safeParse({ version: text(form, 'version') });
    if (!body.success) throw new AppError('INVALID_INPUT');
    const installation = await service().requestPackInstall(tenant.database, tenant.context, {
      packKey: text(form, 'packKey'),
      version: body.data.version,
    });
    return installationPath(organizationId, installation.id);
  });
}

export async function decidePackCapabilityAction(form: FormData) {
  const organizationId = idOf(form, 'organizationId');
  const installationId = idOf(form, 'installationId');
  const tenant = await requireTenant(organizationId);
  await run(tenant, organizationId, installationPath(organizationId, installationId), async () => {
    const body = decidePackCapabilitySchema.safeParse({
      capability_key: text(form, 'capabilityKey'),
      decision: text(form, 'decision'),
    });
    if (!body.success) throw new AppError('INVALID_INPUT');
    await service().decidePackCapability(tenant.database, tenant.context, {
      installationId,
      capabilityKey: body.data.capability_key,
      decision: body.data.decision,
    });
  });
}

export async function activatePackAction(form: FormData) {
  const organizationId = idOf(form, 'organizationId');
  const installationId = idOf(form, 'installationId');
  const tenant = await requireTenant(organizationId);
  await run(tenant, organizationId, installationPath(organizationId, installationId), async () => {
    assertConfirmed(form);
    await service().activatePack(
      tenant.database,
      tenant.context,
      { sessionId: tenant.actor.sessionId },
      { installationId, expectedVersion: int(form, 'expectedVersion') },
    );
  });
}

export async function rollbackPackAction(form: FormData) {
  const organizationId = idOf(form, 'organizationId');
  const installationId = idOf(form, 'installationId');
  const tenant = await requireTenant(organizationId);
  await run(tenant, organizationId, installationPath(organizationId, installationId), async () => {
    assertConfirmed(form);
    await service().rollbackPack(
      tenant.database,
      tenant.context,
      { sessionId: tenant.actor.sessionId },
      { installationId, expectedVersion: int(form, 'expectedVersion') },
    );
  });
}
