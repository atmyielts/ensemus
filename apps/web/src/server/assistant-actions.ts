'use server';

// Every action is a public endpoint. This one resolves the person and tenant again from the session, and
// whether they may stop this run is M4's answer, through the port. It says nothing about what the run did:
// it goes back to the run's page, which reads the run again.
import { redirectForSsoRefusal } from './interactive-refusal';
import {
  AppError,
  auditRefusal,
  canonicalId,
  idSchema,
  isAuditedRefusal,
  refusalCode,
} from '@ensemus/application';
import { errorCode } from '@ensemus/telemetry';
import { redirect } from 'next/navigation';
import { afterStopPath } from '@/components/assistants/present';
import { attemptStop } from '@/components/assistants/read';
import { stepUpPath } from '@/lib/step-up';
import { webProductPorts } from './product-ports';
import { getRuntime } from './runtime';
import { requireTenant } from './tenant';

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, name: string) => canonicalId(text(form, name));

export async function stopDelegatedRunAction(form: FormData): Promise<void> {
  const organizationId = idOf(form, 'organizationId');
  const { context, database } = await requireTenant(organizationId);
  const base = `/o/${organizationId}`;

  // A form can name anything. Something that is not an ID never reaches the port or the next address.
  const runId = idSchema.safeParse(idOf(form, 'runId'));
  if (!runId.success) redirect(`${base}/assistants?error=NOT_FOUND`);

  const attempt = await attemptStop(
    context,
    webProductPorts(),
    runId.data,
    text(form, 'confirm') === 'yes',
  );

  if (!attempt.ok) {
    const { failure } = attempt;
    if (isAuditedRefusal(failure)) {
      // Failing to write this never changes what the person is told.
      await auditRefusal(database, context, { code: refusalCode(failure), surface: 'web' }).catch(
        (problem: unknown) =>
          getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(problem) }),
      );
    }
    if (attempt.code === 'UNEXPECTED') {
      getRuntime().log.error('action.failed', { errorCode: errorCode(failure) });
    }
    redirectForSsoRefusal(failure);
    if (failure instanceof AppError && failure.code === 'RESTORE_PENDING') redirect('/restoring');
    if (failure instanceof AppError && failure.code === 'MFA_REQUIRED') {
      redirect(stepUpPath(organizationId, `${base}/assistants/${runId.data}`));
    }
  }
  redirect(afterStopPath(base, runId.data, attempt));
}
