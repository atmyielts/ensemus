'use server';
import {
  addMeetingParticipant,
  AppError,
  auditRefusal,
  createMeeting,
  isAuditedRefusal,
  recordMeetingConsent,
  refusalCode,
  removeMeetingParticipant,
  updateMeetingSettings,
  idSchema,
} from '@ensemus/application';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { errorCode } from '@ensemus/telemetry';
import { requireTenant } from '@/server/tenant';
import { getRuntime } from '@/server/runtime';
import { redirectForSsoRefusal } from '@/server/interactive-refusal';
import { studioOnce } from '@/server/studio-api';
import { importNotesOnce } from '@/server/meeting-api';
import type { MeetingFormState } from './form-state';
const text = (form: FormData, key: string) =>
  typeof form.get(key) === 'string' ? (form.get(key) as string) : '';
const uuid = (value: string) => {
  const p = idSchema.safeParse(value);
  if (!p.success) throw new AppError('INVALID_INPUT');
  return p.data;
};
const idOf = (form: FormData, name: string) => uuid(text(form, name));
async function fail(t: Awaited<ReturnType<typeof requireTenant>>, error: unknown) {
  redirectForSsoRefusal(error);
  if (isAuditedRefusal(error))
    await auditRefusal(t.database, t.context, { surface: 'web', code: refusalCode(error) }).catch(
      (e) => getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(e) }),
    );
  if (error instanceof AppError) return error.code;
  getRuntime().log.error('meeting.action_failed', { errorCode: errorCode(error) });
  return 'UNEXPECTED';
}
export async function saveMeetingAction(
  previous: MeetingFormState,
  form: FormData,
): Promise<MeetingFormState> {
  const org = idOf(form, 'organizationId'),
    t = await requireTenant(org),
    kind = text(form, 'kind');
  let destination: string | null = null;
  const values = Object.fromEntries(
    [
      'title',
      'occurredAt',
      'classification',
      'noticeRef',
      'enabled',
      'participantKind',
      'membershipId',
      'label',
      'text',
    ].map((k) => [k, text(form, k).slice(0, k === 'text' ? 524288 : 1000)]),
  );
  try {
    if (kind === 'settings')
      await updateMeetingSettings(t.database, t.context, {
        expectedVersion: Number(text(form, 'version')),
        enabled: text(form, 'enabled') === 'yes',
        noticeRef: text(form, 'noticeRef').trim() || null,
      });
    else if (kind === 'create') {
      const parsed = z
        .enum(['public', 'internal', 'confidential', 'restricted'])
        .safeParse(text(form, 'classification'));
      if (!parsed.success) throw new AppError('INVALID_INPUT');
      const input = {
        title: text(form, 'title'),
        occurred_at: text(form, 'occurredAt') + ':00Z',
        classification: parsed.data,
      };
      const id = await studioOnce(
        t.database,
        t.context,
        text(form, 'requestKey'),
        'meeting.create',
        input,
        (db) =>
          createMeeting(db, t.context, {
            title: input.title,
            occurredAt: new Date(input.occurred_at),
            classification: input.classification,
          }),
      );
      destination = `/o/${org}/meetings/${id}`;
    } else if (kind === 'participant') {
      const participantKind = z
        .enum(['member', 'external'])
        .safeParse(text(form, 'participantKind'));
      if (!participantKind.success) throw new AppError('INVALID_INPUT');
      const member = participantKind.data === 'member';
      await addMeetingParticipant(t.database, t.context, {
        meetingId: idOf(form, 'meetingId'),
        expectedVersion: Number(text(form, 'version')),
        participant: member
          ? { kind: 'member', membershipId: idOf(form, 'membershipId') }
          : { kind: 'external', label: text(form, 'label') },
      });
    } else if (kind === 'notes')
      await importNotesOnce(
        t.database,
        t.context,
        idOf(form, 'meetingId'),
        text(form, 'text'),
        text(form, 'requestKey'),
      );
    else throw new AppError('INVALID_INPUT');
    revalidatePath(`/o/${org}/meetings`, 'layout');
  } catch (error) {
    const code = await fail(t, error);
    return {
      code,
      revision: (previous.revision ?? 0) + 1,
      ...(['NOT_FOUND', 'FORBIDDEN', 'MEETING_PURGED'].includes(code) ? {} : { values }),
    };
  }
  if (destination) redirect(destination);
  return { saved: true, revision: (previous.revision ?? 0) + 1 };
}
export async function consentAction(form: FormData): Promise<void> {
  const org = idOf(form, 'organizationId'),
    meetingId = idOf(form, 'meetingId'),
    t = await requireTenant(org);
  let code: string | null = null;
  try {
    const decision = z.enum(['granted', 'declined', 'withdrawn']).safeParse(text(form, 'decision'));
    if (!decision.success) throw new AppError('INVALID_INPUT');
    if (decision.data === 'withdrawn' && text(form, 'confirm') !== 'yes')
      throw new AppError('INVALID_INPUT');
    await recordMeetingConsent(t.database, t.context, {
      meetingId,
      participantId: idOf(form, 'participantId'),
      decision: decision.data,
      noticeRef: text(form, 'noticeRef'),
    });
    revalidatePath(`/o/${org}/meetings`, 'layout');
  } catch (error) {
    code = await fail(t, error);
  }
  redirect(`/o/${org}/meetings/${meetingId}${code ? '?error=' + encodeURIComponent(code) : ''}`);
}
export async function removeParticipantAction(form: FormData): Promise<void> {
  const org = idOf(form, 'organizationId'),
    meetingId = idOf(form, 'meetingId'),
    t = await requireTenant(org);
  let code: string | null = null;
  try {
    await removeMeetingParticipant(t.database, t.context, {
      meetingId,
      participantId: idOf(form, 'participantId'),
      expectedVersion: Number(text(form, 'version')),
    });
    revalidatePath(`/o/${org}/meetings`, 'layout');
  } catch (error) {
    code = await fail(t, error);
  }
  redirect(`/o/${org}/meetings/${meetingId}${code ? '?error=' + encodeURIComponent(code) : ''}`);
}
