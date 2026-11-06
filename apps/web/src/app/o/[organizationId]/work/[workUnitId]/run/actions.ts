'use server';

// Every action is a public endpoint. Each one resolves the person and tenant again from the session, and
// its service re-checks permission. A form can name anything in its hidden fields, so a refusal leaves an
// audit record, as it does for every other form (NEXT-01).
import {
  AppError,
  auditRefusal,
  canonicalId,
  idSchema,
  isAuditedRefusal,
  refusalCode,
  requestHash,
  runIdempotent,
} from '@ensemus/application';
import { controlAgentRun, startAgentRun } from '@ensemus/application/ai-run-control';
import { runControlSchema } from '@ensemus/contracts/ai';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, name: string) => canonicalId(text(form, name));

const place = z.object({ organizationId: idSchema, workUnitId: idSchema });

/** Both IDs go into the address this sends someone back to, so they have to be IDs and nothing else. */
function placeOf(form: FormData) {
  const parsed = place.safeParse({
    organizationId: idOf(form, 'organizationId'),
    workUnitId: idOf(form, 'workUnitId'),
  });
  if (!parsed.success) notFound();
  return parsed.data;
}

/** Failing to write this record never changes what the person is told. */
async function recordRefusal(
  tenant: { context: TenantContext; database: AppDatabase },
  error: unknown,
) {
  if (!isAuditedRefusal(error)) return;
  await auditRefusal(tenant.database, tenant.context, {
    code: refusalCode(error),
    surface: 'web',
  }).catch((failure: unknown) =>
    getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
  );
}

/** Sends people back to the run page, with a known error code and never a raw message. */
async function runThenReturn(
  tenant: { context: TenantContext; database: AppDatabase },
  back: string,
  action: () => Promise<void>,
): Promise<never> {
  let target = back;
  try {
    await action();
    revalidatePath(back);
  } catch (error) {
    await recordRefusal(tenant, error);
    if (error instanceof AppError && error.code === 'RESTORE_PENDING') {
      target = '/restoring';
    } else if (error instanceof AppError) {
      target = `${back}?error=${error.code}`;
    } else {
      getRuntime().log.error('action.failed', { errorCode: errorCode(error) });
      target = `${back}?error=UNEXPECTED`;
    }
  }
  redirect(target);
}

/**
 * Starts a run. One rendered form starts one run, however many times it is sent, so a double click or a
 * resent page gets the first run back and spends nothing more.
 */
export async function startRunAction(form: FormData) {
  const { organizationId, workUnitId } = placeOf(form);
  const { context, database } = await requireTenant(organizationId);
  await runThenReturn(
    { context, database },
    `/o/${organizationId}/work/${workUnitId}/run`,
    async () => {
      const agentVersionId = idOf(form, 'agentVersionId');
      const outcome = await runIdempotent(
        database,
        context,
        {
          key: text(form, 'requestKey'),
          requestHash: requestHash(['startRunAction', workUnitId, agentVersionId]),
        },
        (joined) =>
          startAgentRun(joined, context, {
            work_unit_id: workUnitId,
            agent_version_id: agentVersionId,
          }),
        (run) => ({ status: 202, body: { id: run.id } }),
      );
      if (outcome.kind === 'conflict') throw new AppError('INVALID_INPUT');
    },
  );
}

/** A stop, a pause or a resume. Stopping takes one press: a mistaken stop costs a new run, and that is all. */
export async function controlRunAction(form: FormData) {
  const { organizationId, workUnitId } = placeOf(form);
  const { context, database } = await requireTenant(organizationId);
  const back = `/o/${organizationId}/work/${workUnitId}/run`;
  await runThenReturn({ context, database }, back, async () => {
    const control = runControlSchema.safeParse({ kind: text(form, 'kind') });
    if (!control.success) throw new AppError('INVALID_INPUT');
    await controlAgentRun(database, context, {
      agentRunId: idOf(form, 'agentRunId'),
      kind: control.data.kind,
    });
  });
}
