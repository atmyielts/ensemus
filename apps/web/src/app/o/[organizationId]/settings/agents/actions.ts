'use server';

// Every action is a public endpoint. This one resolves the person and tenant again from the session, and
// the service checks permission itself, so nothing in the form decides who is publishing.
import { redirectForSsoRefusal } from '@/server/interactive-refusal';
import {
  AppError,
  auditRefusal,
  canonicalId,
  isAuditedRefusal,
  refusalCode,
  type RefusalCode,
} from '@ensemus/application';
import {
  AgentSpecRefused,
  getAgentPolicyVersion,
  isPublishGateRefusal,
  publishAgentVersion,
} from '@ensemus/application/ai-agents';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { stepUpPath } from '@/lib/step-up';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';
import type { PublishFormState } from './form-state';

/** The same as the API takes for a whole request. A manifest is a page of settings and no more. */
const MAX_PASTED_CHARS = 256 * 1024;

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, name: string) => canonicalId(text(form, name));

/** What cannot be read as JSON reaches the service as nothing, which it refuses with its own code. */
function pasted(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Failing to write this never changes what the person is told. */
async function record(database: AppDatabase, context: TenantContext, code: RefusalCode) {
  await auditRefusal(database, context, { code, surface: 'web' }).catch((failure: unknown) =>
    getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
  );
}

export async function publishAgentVersionAction(
  _previous: PublishFormState,
  form: FormData,
): Promise<PublishFormState> {
  const org = idOf(form, 'organizationId');
  const { context, database } = await requireTenant(org);
  const values = { manifest: text(form, 'manifest'), report: text(form, 'report') };
  if (values.manifest.length > MAX_PASTED_CHARS || values.report.length > MAX_PASTED_CHARS) {
    return { code: 'INVALID_INPUT' };
  }
  try {
    const version = await publishAgentVersion(database, context, {
      spec: pasted(values.manifest),
      evaluationReport: pasted(values.report),
      policyVersion: await getAgentPolicyVersion(database, context),
    });
    revalidatePath(`/o/${org}/settings/agents`);
    return { published: { versionNumber: version.version_number } };
  } catch (error) {
    if (isPublishGateRefusal(error)) await record(database, context, error.code);
    else if (isAuditedRefusal(error)) await record(database, context, refusalCode(error));
    redirectForSsoRefusal(error);
    if (error instanceof AppError && error.code === 'MFA_REQUIRED')
      redirect(stepUpPath(org, `/o/${org}/settings/agents`));
    if (error instanceof AgentSpecRefused) {
      return { code: error.code, lintCodes: error.lintCodes, fields: error.fields, values };
    }
    if (error instanceof AppError) return { code: error.code, values };
    getRuntime().log.error('action.failed', { errorCode: errorCode(error) });
    return { code: 'UNEXPECTED', values };
  }
}
