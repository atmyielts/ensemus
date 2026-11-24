'use server';

import { AppError } from '@ensemus/application';
import { requestDerivationSchema } from '@ensemus/contracts/meetings';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requestDerivationOnce } from '@/server/meeting-api';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';

export async function requestMeetingProcessing(
  target: { organizationId: string; meetingId: string; notesId: string },
  form: FormData,
) {
  const { organizationId, meetingId, notesId } = target;
  const { context, database } = await requireTenant(organizationId);
  const path = `/o/${organizationId}/meetings/${meetingId}`;
  const choice = form.get('processingChoice');
  const key = form.get('requestKey');
  const [purpose, approvalId, extra] = typeof choice === 'string' ? choice.split(':') : [];
  const parsed = requestDerivationSchema.safeParse({ purpose, provider_approval_id: approvalId });
  let query: string;
  try {
    if (!parsed.success || extra !== undefined || typeof key !== 'string')
      throw new AppError('INVALID_INPUT');
    const run = await requestDerivationOnce(
      database,
      context,
      key,
      meetingId,
      parsed.data,
      notesId,
    );
    query = '?processing=' + run.id;
  } catch (error) {
    let code = 'UNEXPECTED';
    if (error instanceof AppError) code = error.code;
    else
      getRuntime().log.error('meeting.processing_request_failed', { errorCode: errorCode(error) });
    query = '?processingError=' + encodeURIComponent(code);
  }
  revalidatePath(path);
  redirect(path + query + '#meeting-processing');
}
