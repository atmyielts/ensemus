'use server';
import { AppError } from '@ensemus/application';
import {
  getProcessRun,
  startProcessRun,
  requestStopProcessRun,
  installBundledWorkflow,
  proposeProcessStepAction,
} from '@ensemus/application/process-runs';
import { getProcessSpec } from '@ensemus/application/process-specs';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  runText,
  runId,
  runVersion,
  readRunStart,
  readRunEmail,
  runFormValues,
  type ProcessRunFormState,
} from '@/lib/process-run-input';
import { stepUpPath } from '@/lib/step-up';
import { requireStudio } from './studio-pages';
import { requireTenant } from './tenant';
import { studioOnce } from './studio-api';
import { webProductPorts } from './product-ports';
import { getRuntime } from './runtime';
async function failure(error: unknown, org: string, path: string) {
  if (error instanceof AppError && error.code === 'SSO_REQUIRED') redirect('/sign-in/sso');
  if (error instanceof AppError && error.code === 'MFA_REQUIRED') redirect(stepUpPath(org, path));
  if (error instanceof AppError) return error.code;
  getRuntime().log.error('process_run.action_failed', { errorCode: errorCode(error) });
  throw error;
}
export async function startWorkflowRunAction(
  state: ProcessRunFormState,
  form: FormData,
): Promise<ProcessRunFormState> {
  const org = runId(form, 'organizationId'),
    { database, context } = await requireStudio(org),
    back = `/o/${org}/studio/runs/new`;
  let id: string;
  try {
    const input = readRunStart(form),
      key = runId(form, 'requestKey');
    id = await studioOnce(
      database,
      context,
      key,
      'process-run.start',
      input,
      (db) =>
        startProcessRun(db, context, {
          specId: input.spec_id,
          title: input.title,
          ...(input.due_at ? { dueAt: new Date(input.due_at) } : {}),
          requestKey: key,
        }),
      202,
    );
    await getProcessRun(database, context, webProductPorts(), id);
    revalidatePath(`/o/${org}/studio/runs`);
  } catch (error) {
    return {
      code: await failure(error, org, back),
      values: runFormValues(form, 'start'),
      revision: (state.revision ?? 0) + 1,
    };
  }
  redirect(`/o/${org}/studio/runs/${id}`);
}
export async function stopWorkflowRunAction(form: FormData) {
  const org = runId(form, 'organizationId'),
    { database, context } = await requireTenant(org),
    id = runId(form, 'runId'),
    back = `/o/${org}/studio/runs/${id}`;
  let code: string | undefined;
  try {
    if (runText(form, 'confirmed') !== 'yes') throw new AppError('INVALID_INPUT');
    const input = { runId: id, expectedVersion: runVersion(form) };
    await studioOnce(
      database,
      context,
      runId(form, 'requestKey'),
      'process-run.stop',
      input,
      async (db) => {
        await requestStopProcessRun(db, context, input);
        return { id };
      },
      202,
    );
    await getProcessRun(database, context, webProductPorts(), id);
    revalidatePath(back);
  } catch (error) {
    code = await failure(error, org, back);
  }
  redirect(code ? `${back}?error=${encodeURIComponent(code)}` : `${back}?stop=requested`);
}
export async function installWorkflowCatalogAction(form: FormData) {
  const org = runId(form, 'organizationId'),
    { database, context } = await requireStudio(org),
    back = `/o/${org}/studio/runs/catalog`;
  let id: string;
  try {
    const processKey = runText(form, 'processKey', 100);
    id = await studioOnce(
      database,
      context,
      runId(form, 'requestKey'),
      'process-catalog.install',
      { processKey },
      async (db) => ({ id: (await installBundledWorkflow(db, context, { processKey })).specId }),
    );
    await getProcessSpec(database, context, id);
    revalidatePath(back);
  } catch (error) {
    const code = await failure(error, org, back);
    redirect(`${back}?error=${encodeURIComponent(code)}`);
  }
  redirect(`/o/${org}/studio/runs/new?spec=${encodeURIComponent(id)}&installed=1`);
}
export async function proposeWorkflowEmailAction(
  state: ProcessRunFormState,
  form: FormData,
): Promise<ProcessRunFormState> {
  const org = runId(form, 'organizationId'),
    { database, context } = await requireTenant(org),
    id = runId(form, 'runId'),
    back = `/o/${org}/studio/runs/${id}`;
  try {
    const input = { runId: id, stepKey: runText(form, 'stepKey', 64), ...readRunEmail(form) };
    await studioOnce(
      database,
      context,
      runId(form, 'requestKey'),
      'process-run.email.propose',
      input,
      async (db) => {
        await proposeProcessStepAction(db, context, input);
        return { id };
      },
      202,
    );
    await getProcessRun(database, context, webProductPorts(), id);
    revalidatePath(back);
  } catch (error) {
    return {
      code: await failure(error, org, back),
      values: runFormValues(form, 'email'),
      revision: (state.revision ?? 0) + 1,
    };
  }
  redirect(`${back}?proposal=saved`);
}
