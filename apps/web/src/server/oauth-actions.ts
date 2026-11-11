'use server';

// The connections page's "Connect Google Workspace" and "Connect Microsoft 365" forms. Like every action,
// this is a public endpoint: it resolves the person and tenant from the session, and the service checks
// permission again. A customer's client secret is sealed at once and never comes back into the form.
import {
  AppError,
  auditRefusal,
  canonicalId,
  isAuditedRefusal,
  refusalCode,
} from '@ensemus/application';
import { startOAuthAuthorizationSchema } from '@ensemus/contracts/workspace-suites';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { stepUpPath } from '@/lib/step-up';
import { assertManagesConnections } from './api';
import { redirectForSsoRefusal } from './interactive-refusal';
import { OAUTH_BROWSER_COOKIE } from '@ensemus/domain/workspace-suites';
import { beginAuthorization, OAUTH_BROWSER_COOKIE_OPTIONS } from './oauth';
import { getRuntime } from './runtime';
import { requireTenant } from './tenant';

const idOf = (form: FormData, name: string) => canonicalId(text(form, name));
const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/** What the form gives back after a refusal. Never the client secret. */
export type SuiteConnectDraft = {
  connectorType: string;
  displayName: string;
  capabilities: string[];
  driveIds: string;
  clientKind: string;
  clientId: string;
  tenant: string;
};

export type SuiteConnectFormState = { code?: string; values?: SuiteConnectDraft };

const driveIdsOf = (value: string) => [...new Set(value.split(/[\s,;]+/).filter(Boolean))];

async function codeOf(tenant: { context: TenantContext; database: AppDatabase }, error: unknown) {
  if (isAuditedRefusal(error)) {
    await auditRefusal(tenant.database, tenant.context, {
      code: refusalCode(error),
      surface: 'web',
    }).catch((failure: unknown) =>
      getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
    );
  }
  redirectForSsoRefusal(error);
  const organizationId = tenant.context.organizationId;
  if (error instanceof AppError) {
    if (error.code === 'RESTORE_PENDING') redirect('/restoring');
    if (error.code === 'MFA_REQUIRED') {
      redirect(stepUpPath(organizationId, `/o/${organizationId}/connections`));
    }
    return error.code;
  }
  getRuntime().log.error('action.failed', { errorCode: errorCode(error) });
  return 'UNEXPECTED';
}

/** Starts a consent and sends the browser to the provider's own page. */
export async function startSuiteConnectionAction(
  _previous: SuiteConnectFormState,
  form: FormData,
): Promise<SuiteConnectFormState> {
  const { context, database } = await requireTenant(idOf(form, 'organizationId'));
  const values: SuiteConnectDraft = {
    connectorType: text(form, 'connectorType'),
    displayName: text(form, 'displayName'),
    capabilities: form.getAll('capability').filter((value) => typeof value === 'string'),
    driveIds: text(form, 'driveIds'),
    clientKind: text(form, 'clientKind'),
    clientId: text(form, 'oauthClient'),
    tenant: text(form, 'tenant').trim(),
  };
  let target: string;
  try {
    assertManagesConnections(context);
    const body = startOAuthAuthorizationSchema.safeParse({
      connector_type: values.connectorType,
      display_name: values.displayName,
      config: { drive_ids: driveIdsOf(values.driveIds) },
      capabilities: values.capabilities,
      client:
        values.clientKind === 'customer'
          ? {
              kind: 'customer',
              client_id: values.clientId,
              client_secret: text(form, 'clientSecret'),
              ...(values.tenant ? { tenant: values.tenant } : {}),
            }
          : { kind: 'platform' },
    });
    if (!body.success) return { code: 'INVALID_INPUT', values };
    const { started, browserBinding } = await beginAuthorization(database, context, body.data);
    // The callback answers only in the browser holding this (ADR-038 D1).
    (await cookies()).set(OAUTH_BROWSER_COOKIE, browserBinding, OAUTH_BROWSER_COOKIE_OPTIONS);
    target = started.authorize_url;
  } catch (error) {
    return { code: await codeOf({ context, database }, error), values };
  }
  // The provider's own page, built on the server from fixed hosts. Nothing from the form chose it.
  redirect(target);
}
