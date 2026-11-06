'use server';

// The forms on the license and data pages (ADR-030). Every action is a public endpoint: each resolves the
// person and tenant again from the session, and the service checks permission again, so a hidden field names
// nothing it is trusted about. No Temporal, no key and no private key pass through here.
import {
  AppError,
  auditRefusal,
  canonicalId,
  idSchema,
  installSignedDocument,
  isAuditedRefusal,
  linkImportedPerson,
  refusalCode,
  requestOrganizationExport,
  requestOrganizationImport,
} from '@ensemus/application';
import { installSignedDocumentSchema, MAX_SIGNED_DOCUMENT_BYTES } from '@ensemus/contracts/sovereign';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getRuntime } from './runtime';
import { readRecipientKeyField } from './sovereign-dto';
import { getSovereignRuntime } from './sovereign-runtime';
import { requireTenant } from './tenant';

export type InstallDocumentState = {
  code?: string;
  installed?: {
    type: 'license' | 'maintenance' | 'advisory' | 'support_policy';
    created: boolean;
    testKey: boolean;
  };
};

export type RequestExportState = {
  code?: string;
  /** Someone pasted the private half. It is said in words, and what they pasted is not kept or repeated. */
  privateKeyRefused?: boolean;
  requested?: boolean;
};

type Tenant = { context: TenantContext; database: AppDatabase };

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const orgOf = (form: FormData) => canonicalId(text(form, 'organizationId'));

/** Leaves the record a refused request should leave. Failing to write it changes nothing the person hears. */
async function recordRefusal({ context, database }: Tenant, error: unknown) {
  if (!isAuditedRefusal(error)) return;
  await auditRefusal(database, context, { code: refusalCode(error), surface: 'web' }).catch(
    (failure: unknown) =>
      getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
  );
}

/** Reduces any failure to a code a form can show. Nothing else about it reaches the person. */
async function codeOf(tenant: Tenant, error: unknown): Promise<string> {
  await recordRefusal(tenant, error);
  if (error instanceof AppError) return error.code;
  getRuntime().log.error('action.failed', { errorCode: errorCode(error) });
  return 'UNEXPECTED';
}

/** Sends people back to the page, with a known error code and never a raw message. */
async function runAndReturn(tenant: Tenant, back: string, action: () => Promise<void>) {
  let target = back;
  try {
    await action();
    revalidatePath(back);
  } catch (error) {
    if (error instanceof AppError && error.code === 'RESTORE_PENDING') target = '/restoring';
    else target = `${back}?error=${await codeOf(tenant, error)}`;
  }
  redirect(target);
}

/** The file if one was chosen, otherwise what was pasted. Refuses a file too large before reading it. */
async function readEnvelope(form: FormData): Promise<string> {
  const file = form.get('file');
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_SIGNED_DOCUMENT_BYTES) throw new AppError('INVALID_INPUT');
    return file.text();
  }
  return text(form, 'envelope');
}

export async function installSignedDocumentAction(
  _previous: InstallDocumentState,
  form: FormData,
): Promise<InstallDocumentState> {
  const org = orgOf(form);
  const tenant = await requireTenant(org);
  const { context, database } = tenant;
  try {
    // Only ever handled as text from here on: the verifier reads it, and nothing reformats it.
    const body = installSignedDocumentSchema.safeParse({ envelope: await readEnvelope(form) });
    if (!body.success) throw new AppError('INVALID_INPUT');
    const { trustRoot } = getSovereignRuntime();
    const installed = await installSignedDocument(database, context, body.data, { trustRoot });
    revalidatePath(`/o/${org}/license`);
    return {
      installed: {
        type: installed.type,
        created: installed.created,
        testKey: installed.testKey,
      },
    };
  } catch (error) {
    return { code: await codeOf(tenant, error) };
  }
}

export async function requestExportAction(
  _previous: RequestExportState,
  form: FormData,
): Promise<RequestExportState> {
  const org = orgOf(form);
  const tenant = await requireTenant(org);
  const { context, database } = tenant;
  const field = readRecipientKeyField(text(form, 'recipientPublicKey'));
  if (!field.ok) {
    return field.reason === 'private_key' ? { privateKeyRefused: true } : { code: 'INVALID_INPUT' };
  }
  try {
    await requestOrganizationExport(database, context, {
      recipientPublicKey: field.key,
      sourceRelease: getSovereignRuntime().sourceRelease,
    });
    revalidatePath(`/o/${org}/data`);
    return { requested: true };
  } catch (error) {
    return { code: await codeOf(tenant, error) };
  }
}

export async function requestImportAction(form: FormData) {
  const org = orgOf(form);
  const tenant = await requireTenant(org);
  await runAndReturn(tenant, `/o/${org}/data`, async () => {
    // Taking an archive cannot be undone here, so it has to be meant. Browsers check the box, and so does this.
    if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
    await requestOrganizationImport(tenant.database, tenant.context);
  });
}

export async function linkImportedPersonAction(form: FormData) {
  const org = orgOf(form);
  const tenant = await requireTenant(org);
  await runAndReturn(tenant, `/o/${org}/data`, async () => {
    const sourceMembershipId = idSchema.safeParse(text(form, 'sourceMembershipId'));
    const membershipId = idSchema.safeParse(text(form, 'membershipId'));
    if (!sourceMembershipId.success || !membershipId.success) throw new AppError('INVALID_INPUT');
    await linkImportedPerson(tenant.database, tenant.context, {
      sourceMembershipId: sourceMembershipId.data,
      membershipId: membershipId.data,
    });
  });
}
