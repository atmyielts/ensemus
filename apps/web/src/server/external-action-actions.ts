'use server';

// Every action is a public endpoint. Each one resolves the person and tenant again from the session and
// re-checks permission in its service, and none trusts a hidden field for identity. A credential or a
// signing secret never goes in a URL or a log, and a credential is never echoed back into a form.
import {
  AppError,
  auditRefusal,
  isAuditedRefusal,
  refusalCode,
  resolveUnknownExternalAction,
  revokeConnection,
} from '@ensemus/application';
import {
  createConnectionSchema,
  proposeEmailActionSchema,
  reviseEmailActionSchema,
} from '@ensemus/contracts/external-actions';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  addConnection,
  addWebhookEndpoint,
  askAgain,
  assertManagesConnections,
  proposeEmail,
  reviseEmail,
} from './api';
import { getRuntime } from './runtime';
import { requireTenant } from './tenant';

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const orgOf = (form: FormData) => text(form, 'organizationId');

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

/** Reduces any failure to a code a form can show. Nothing else about it reaches the person. */
async function codeOf(tenant: Tenant, error: unknown): Promise<string> {
  await recordRefusal(tenant, error);
  if (error instanceof AppError) {
    if (error.code === 'RESTORE_PENDING') redirect('/restoring');
    return error.code;
  }
  getRuntime().log.error('action.failed', { errorCode: errorCode(error) });
  return 'UNEXPECTED';
}

/** Sends people back to where they were, with a known error code and never a raw message. */
async function run(tenant: Tenant, back: string, action: () => Promise<string | void>) {
  let target = back;
  try {
    const next = await action();
    if (next) target = next;
  } catch (error) {
    target = `${back}${back.includes('?') ? '&' : '?'}error=${await codeOf(tenant, error)}`;
  }
  redirect(target);
}

export type EmailDraft = {
  connectionId: string;
  approverMembershipId: string;
  to: string;
  cc: string;
  bcc: string;
  replyTo: string;
  subject: string;
  textBody: string;
};

export type EmailFormState = {
  code?: string;
  field?: keyof EmailDraft;
  values?: EmailDraft;
};

const addressesIn = (value: string) => value.split(/[\s,;]+/).filter(Boolean);

function draftOf(form: FormData): EmailDraft {
  return {
    connectionId: text(form, 'connectionId'),
    approverMembershipId: text(form, 'approverMembershipId'),
    to: text(form, 'to'),
    cc: text(form, 'cc'),
    bcc: text(form, 'bcc'),
    replyTo: text(form, 'replyTo'),
    subject: text(form, 'subject'),
    textBody: text(form, 'textBody'),
  };
}

function emailOf(draft: EmailDraft) {
  const cc = addressesIn(draft.cc);
  const bcc = addressesIn(draft.bcc);
  return {
    to: addressesIn(draft.to),
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    ...(draft.replyTo.trim() ? { reply_to: draft.replyTo.trim() } : {}),
    subject: draft.subject,
    text_body: draft.textBody,
  };
}

const FIELD_FOR_ISSUE: Readonly<Record<string, keyof EmailDraft>> = {
  connection_id: 'connectionId',
  approver_membership_id: 'approverMembershipId',
  to: 'to',
  cc: 'cc',
  bcc: 'bcc',
  reply_to: 'replyTo',
  subject: 'subject',
  text_body: 'textBody',
};

/** Which field to name, from our own schema's path, so the person hears what to fix. */
function refusedField(issues: ReadonlyArray<{ path: readonly PropertyKey[] }>) {
  const path = issues[0]?.path ?? [];
  const name = path[0] === 'email' ? path[1] : path[0];
  return typeof name === 'string' ? FIELD_FOR_ISSUE[name] : undefined;
}

const refused = (
  issues: ReadonlyArray<{ path: readonly PropertyKey[] }>,
  values: EmailDraft,
): EmailFormState => {
  const field = refusedField(issues);
  return { code: 'INVALID_INPUT', ...(field ? { field } : {}), values };
};

const actionPage = (org: string, id: string) => `/o/${org}/external-actions/${id}`;

export async function proposeEmailFormAction(
  _previous: EmailFormState,
  form: FormData,
): Promise<EmailFormState> {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  const values = draftOf(form);
  const parsed = proposeEmailActionSchema.safeParse({
    connection_id: values.connectionId,
    approver_membership_id: values.approverMembershipId,
    email: emailOf(values),
  });
  if (!parsed.success) return refused(parsed.error.issues, values);
  let id: string;
  try {
    const workUnitId = z.uuid().safeParse(text(form, 'workUnitId'));
    if (!workUnitId.success) throw new AppError('NOT_FOUND');
    // One rendered form makes one action, however many times it is sent.
    const outcome = await proposeEmail(
      database,
      context,
      workUnitId.data,
      parsed.data,
      text(form, 'requestKey'),
    );
    if (outcome.kind === 'conflict') return { code: 'INVALID_INPUT', values };
    id = (outcome.body as { id: string }).id;
  } catch (error) {
    return { code: await codeOf({ context, database }, error), values };
  }
  redirect(actionPage(org, id));
}

export async function reviseEmailFormAction(
  _previous: EmailFormState,
  form: FormData,
): Promise<EmailFormState> {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  const values = draftOf(form);
  const parsed = reviseEmailActionSchema.safeParse({
    approver_membership_id: values.approverMembershipId,
    email: emailOf(values),
  });
  if (!parsed.success) return refused(parsed.error.issues, values);
  let id: string;
  try {
    const revised = await reviseEmail(
      database,
      context,
      text(form, 'id'),
      Number.parseInt(text(form, 'version'), 10),
      parsed.data,
    );
    id = revised.externalActionId;
  } catch (error) {
    return { code: await codeOf({ context, database }, error), values };
  }
  redirect(actionPage(org, id));
}

export async function resolveExternalActionAction(form: FormData) {
  const org = orgOf(form);
  const id = text(form, 'id');
  const { context, database } = await requireTenant(org);
  const resolution = text(form, 'resolution');
  await run({ context, database }, actionPage(org, id), async () => {
    if (resolution !== 'confirmed_sent' && resolution !== 'confirmed_not_sent') {
      throw new AppError('INVALID_INPUT');
    }
    await resolveUnknownExternalAction(database, context, {
      externalActionId: id,
      expectedVersion: Number.parseInt(text(form, 'version'), 10),
      resolution,
      reason: text(form, 'reason'),
    });
  });
}

export async function retryExternalActionAction(form: FormData) {
  const org = orgOf(form);
  const id = text(form, 'id');
  const { context, database } = await requireTenant(org);
  await run({ context, database }, actionPage(org, id), async () => {
    if (!z.uuid().safeParse(id).success) throw new AppError('NOT_FOUND');
    const approver = z.uuid().safeParse(text(form, 'approverMembershipId'));
    if (!approver.success) throw new AppError('INVALID_INPUT');
    const proposed = await askAgain(database, context, id, approver.data);
    return actionPage(org, proposed.externalActionId);
  });
}

// --- Connections

export type ConnectionDraft = {
  connectorType: string;
  displayName: string;
  fromAddress: string;
  fromName: string;
  tlsServerName: string;
};

export type ConnectionFormState = {
  code?: string;
  /** Only ever a credential's absence: what was typed into that box never comes back. */
  values?: ConnectionDraft;
  created?: boolean;
};

const settingsFrom = (draft: ConnectionDraft) =>
  draft.connectorType === 'email_smtp'
    ? {
        fromAddress: draft.fromAddress.trim(),
        ...(draft.fromName.trim() ? { fromName: draft.fromName.trim() } : {}),
        ...(draft.tlsServerName.trim() ? { tlsServerName: draft.tlsServerName.trim() } : {}),
      }
    : {};

export async function createConnectionFormAction(
  _previous: ConnectionFormState,
  form: FormData,
): Promise<ConnectionFormState> {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  const values: ConnectionDraft = {
    connectorType: text(form, 'connectorType'),
    displayName: text(form, 'displayName'),
    fromAddress: text(form, 'fromAddress'),
    fromName: text(form, 'fromName'),
    tlsServerName: text(form, 'tlsServerName'),
  };
  const credential = text(form, 'credential');
  try {
    assertManagesConnections(context);
    const body = createConnectionSchema.safeParse({
      connector_type: values.connectorType,
      display_name: values.displayName,
      config: settingsFrom(values),
      ...(credential ? { credential } : {}),
    });
    if (!body.success) return { code: 'INVALID_INPUT', values };
    const outcome = await addConnection(database, context, body.data, text(form, 'requestKey'));
    if (outcome.kind === 'conflict') return { code: 'INVALID_INPUT', values };
  } catch (error) {
    return { code: await codeOf({ context, database }, error), values };
  }
  revalidatePath(`/o/${org}/connections`);
  return { created: true };
}

export async function revokeConnectionAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/connections`, async () => {
    if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
    assertManagesConnections(context);
    const connectionId = z.uuid().safeParse(text(form, 'connectionId'));
    if (!connectionId.success) throw new AppError('NOT_FOUND');
    await revokeConnection(database, context, {
      connectionId: connectionId.data,
      expectedVersion: Number.parseInt(text(form, 'version'), 10),
    });
  });
}

export type WebhookFormState = {
  code?: string;
  /** Goes back in this one response and nowhere else, so it is never in a URL or a log. */
  created?: { url: string; signingSecret: string; scheme: string };
};

export async function createWebhookEndpointFormAction(
  _previous: WebhookFormState,
  form: FormData,
): Promise<WebhookFormState> {
  const { context, database } = await requireTenant(orgOf(form));
  try {
    const connectionId = z.uuid().safeParse(text(form, 'connectionId'));
    if (!connectionId.success) throw new AppError('NOT_FOUND');
    const created = await addWebhookEndpoint(database, context, connectionId.data);
    return {
      created: {
        url: created.url,
        signingSecret: created.signing_secret,
        scheme: created.signature_scheme,
      },
    };
  } catch (error) {
    return { code: await codeOf({ context, database }, error) };
  }
}
