'use server';

// A member's own connections (ADR-038 D5), and the admin's choice of what members may connect. Every
// action is a public endpoint: each resolves the person and tenant again from the session, and the
// service checks again who may do what, so nothing here trusts a hidden field for who is asking.
import {
  AppError,
  auditRefusal,
  canonicalId,
  isAuditedRefusal,
  refusalCode,
} from '@ensemus/application';
import { revokeMyConnection, setMemberCapabilities } from '@ensemus/application/suite-settings';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { OAUTH_BROWSER_COOKIE } from '@ensemus/domain/workspace-suites';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { stepUpPath } from '@/lib/step-up';
import { assertManagesConnections } from '@/server/api';
import { redirectForSsoRefusal } from '@/server/interactive-refusal';
import { OAUTH_BROWSER_COOKIE_OPTIONS } from '@/server/oauth';
import {
  beginMyConnection,
  memberConnectionCapabilitiesSchema,
  startMyConnectionSchema,
} from '@/server/personal-connections';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, name: string) => canonicalId(text(form, name));

type Tenant = { context: TenantContext; database: AppDatabase };

const minePage = (organizationId: string) => `/o/${organizationId}/settings/connections`;
const adminPage = (organizationId: string) => `/o/${organizationId}/connections`;

/** Reduces any failure to a code the page can show, and leaves a record of a refusal. */
async function codeOf(tenant: Tenant, error: unknown, back: string): Promise<string> {
  if (isAuditedRefusal(error)) {
    await auditRefusal(tenant.database, tenant.context, {
      code: refusalCode(error),
      surface: 'web',
    }).catch((failure: unknown) =>
      getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
    );
  }
  redirectForSsoRefusal(error);
  if (error instanceof AppError) {
    if (error.code === 'RESTORE_PENDING') redirect('/restoring');
    if (error.code === 'MFA_REQUIRED') redirect(stepUpPath(tenant.context.organizationId, back));
    return error.code;
  }
  getRuntime().log.error('action.failed', { errorCode: errorCode(error) });
  return 'UNEXPECTED';
}

/** Goes back to the page, with a known code and never a raw message. */
async function act(tenant: Tenant, back: string, action: () => Promise<void>): Promise<never> {
  let target = back;
  try {
    await action();
    revalidatePath(back);
  } catch (error) {
    target = `${back}?error=${await codeOf(tenant, error, back)}`;
  }
  redirect(target);
}

/** What the form gives back after a refusal, so the member need not choose again. */
export type MyConnectionDraft = {
  connectorType: string;
  displayName: string;
  capabilities: string[];
};

export type MyConnectionFormState = { code?: string; values?: MyConnectionDraft };

/** Starts the member's own consent and sends the browser to the provider's own page. */
export async function startMyConnectionAction(
  _previous: MyConnectionFormState,
  form: FormData,
): Promise<MyConnectionFormState> {
  const tenant = await requireTenant(idOf(form, 'organizationId'));
  const values: MyConnectionDraft = {
    connectorType: text(form, 'connectorType'),
    displayName: text(form, 'displayName'),
    capabilities: form.getAll('capability').filter((value) => typeof value === 'string'),
  };
  let target: string;
  try {
    const body = startMyConnectionSchema.safeParse({
      connector_type: values.connectorType,
      display_name: values.displayName,
      capabilities: values.capabilities,
    });
    if (!body.success) return { code: 'INVALID_INPUT', values };
    const { started, browserBinding } = await beginMyConnection(
      tenant.database,
      tenant.context,
      body.data,
    );
    // The callback answers only in the browser holding this (ADR-038 D1).
    (await cookies()).set(OAUTH_BROWSER_COOKIE, browserBinding, OAUTH_BROWSER_COOKIE_OPTIONS);
    target = started.authorize_url;
  } catch (error) {
    return {
      code: await codeOf(tenant, error, minePage(tenant.context.organizationId)),
      values,
    };
  }
  // The provider's own page, built on the server from fixed hosts. Nothing from the form chose it.
  redirect(target);
}

/**
 * Revokes a member's own connection. From the member's page it is theirs; from the connections page it is
 * an admin's revoke, which the service checks for connection.manage and a recent second factor.
 */
export async function revokeMyConnectionAction(form: FormData) {
  const tenant = await requireTenant(idOf(form, 'organizationId'));
  const organizationId = tenant.context.organizationId;
  const back =
    text(form, 'from') === 'admin' ? adminPage(organizationId) : minePage(organizationId);
  await act(tenant, back, async () => {
    if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
    await revokeMyConnection(tenant.database, tenant.context, {
      connectionId: idOf(form, 'connectionId'),
    });
  });
}

/** The admin's choice of what members may connect with their own account. */
export async function setMemberCapabilitiesAction(form: FormData) {
  const tenant = await requireTenant(idOf(form, 'organizationId'));
  await act(tenant, adminPage(tenant.context.organizationId), async () => {
    assertManagesConnections(tenant.context);
    const body = memberConnectionCapabilitiesSchema.safeParse({
      capabilities: form.getAll('capability').filter((value) => typeof value === 'string'),
    });
    if (!body.success) throw new AppError('INVALID_INPUT');
    await setMemberCapabilities(tenant.database, tenant.context, body.data.capabilities);
  });
}
