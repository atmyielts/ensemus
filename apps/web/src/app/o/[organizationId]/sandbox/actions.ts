'use server';

import { AppError, cancelSandboxRun, idSchema, refusalFromDatabase } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { redirectForSsoRefusal } from '@/server/interactive-refusal';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';
import { queueSandboxTrial, trialDraft, type SandboxTrialFormState } from './trial-submission';

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
  const result = await queueSandboxTrial(
    database,
    context,
    skillVersionId,
    requestToken,
    form,
  ).catch((error: unknown) => ({ state: { ...trialDraft(form), ...actionError(error) } }));
  if ('state' in result) return result.state;
  redirect(`/o/${organizationId}/sandbox/runs/${result.runId}`);
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
