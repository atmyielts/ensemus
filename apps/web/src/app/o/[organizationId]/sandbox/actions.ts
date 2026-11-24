'use server';

import {
  AppError,
  cancelSandboxRun,
  idSchema,
  refusalFromDatabase,
  requestHash,
  requestSandboxRun,
  runIdempotent,
} from '@ensemus/application';
import { requestSandboxTestRunSchema } from '@ensemus/contracts/skills';
import { canonicalJson } from '@ensemus/domain/approval';
import { can } from '@ensemus/domain/policy';
import { SANDBOX_INPUT_MAX_BYTES } from '@ensemus/domain/sandbox';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { redirectForSsoRefusal } from '@/server/interactive-refusal';
import { getRuntime } from '@/server/runtime';
import { getSandboxCeilings, getSkillFeatureGate } from '@/server/skill-runtime';
import { requireTenant } from '@/server/tenant';

export type SandboxTrialFormState = {
  code?: string;
  invalidJson?: true;
  input?: string;
  classification?: 'public' | 'internal' | 'confidential';
};
export type SandboxCancelFormState = { code?: string; requested?: true };

function routeId(value: string) {
  const id = idSchema.safeParse(value);
  if (!id.success) notFound();
  return id.data;
}

function actionError(error: unknown): { code: string } {
  redirectForSsoRefusal(error);
  const failure = error instanceof AppError ? error : refusalFromDatabase(error);
  if (failure?.code === 'NOT_FOUND') notFound();
  if (failure?.code === 'RESTORE_PENDING') redirect('/restoring');
  if (failure) return { code: failure.code };
  getRuntime().log.error('sandbox.workspace_action_failed', { errorCode: errorCode(error) });
  return { code: 'UNEXPECTED' };
}

export async function startSandboxTrial(
  org: string,
  skillVersion: string,
  requestToken: string,
  _previous: SandboxTrialFormState,
  form: FormData,
): Promise<SandboxTrialFormState> {
  const organizationId = routeId(org);
  const skillVersionId = routeId(skillVersion);
  const { database, context } = await requireTenant(organizationId);
  if (context.actorType !== 'user' || !can(context.role, 'sandbox.run')) notFound();
  const key = idSchema.safeParse(requestToken);
  if (!key.success) return { code: 'INVALID_INPUT' };

  const raw = form.get('input');
  if (typeof raw !== 'string') return { invalidJson: true };
  if (Buffer.byteLength(raw, 'utf8') > SANDBOX_INPUT_MAX_BYTES)
    return { code: 'SANDBOX_INPUT_TOO_LARGE' };
  const classification = form.get('classification');
  const values: Pick<SandboxTrialFormState, 'input' | 'classification'> = { input: raw };
  if (
    classification === 'public' ||
    classification === 'internal' ||
    classification === 'confidential'
  )
    values.classification = classification;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ...values, invalidJson: true };
  }
  const body = requestSandboxTestRunSchema.safeParse({
    classification,
    input: json,
  });
  if (!body.success) return { ...values, code: 'INVALID_INPUT' };

  let runId: string;
  try {
    const gate = getSkillFeatureGate();
    if (!(await gate.isEnabled(context, 'sandbox'))) throw new AppError('FEATURE_NOT_ENABLED');
    const result = await runIdempotent(
      database,
      context,
      {
        key: key.data,
        requestHash: requestHash([
          'sandbox.operator_test.workspace',
          skillVersionId,
          canonicalJson(body.data),
        ]),
      },
      (db) =>
        requestSandboxRun(
          db,
          context,
          { gate, agentGuard: null },
          {
            ...body.data,
            purpose: 'operator_test',
            skillVersionId,
            ceilings: getSandboxCeilings(),
          },
        ),
      (run) => ({ status: 202, body: { id: run.id } }),
    );
    if (result.kind === 'conflict') return { ...values, code: 'IDEMPOTENCY_KEY_REUSED' };
    const queued = idSchema.safeParse((result.body as { id?: unknown } | null)?.id);
    if (!queued.success) throw new AppError('INVALID_STATE');
    runId = queued.data;
  } catch (error) {
    return { ...values, ...actionError(error) };
  }
  redirect(`/o/${organizationId}/sandbox/runs/${runId}`);
}

export async function stopSandboxTrial(
  org: string,
  sandboxRun: string,
  _previous: SandboxCancelFormState,
  _form: FormData,
): Promise<SandboxCancelFormState> {
  const organizationId = routeId(org);
  const sandboxRunId = routeId(sandboxRun);
  const { database, context } = await requireTenant(organizationId);
  if (context.actorType !== 'user' || !can(context.role, 'sandbox.run')) notFound();
  try {
    await cancelSandboxRun(database, context, sandboxRunId);
  } catch (error) {
    return actionError(error);
  }
  revalidatePath(`/o/${organizationId}/sandbox/runs/${sandboxRunId}`);
  return { requested: true };
}
