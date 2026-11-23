'use server';

import { acceptProposedDecision, AppError, rejectProposedItem } from '@ensemus/application';
import { acceptProposedWorkSchema } from '@ensemus/contracts/meetings';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { acceptProposedWorkOnce } from '@/server/meeting-api';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';

type Draft = { title: string; objective: string; owner: string; due: string };
type WorkState = { code?: string; draft?: Draft; revision?: number };
type ProposalTarget = {
  organizationId: string;
  meetingId: string;
  itemId: string;
  version: number;
};

const meetingPath = (target: ProposalTarget) =>
  '/o/' + target.organizationId + '/meetings/' + target.meetingId;
const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

function refusal(error: unknown) {
  if (error instanceof AppError) return error.code;
  getRuntime().log.error('meeting.proposal_write_failed', { errorCode: errorCode(error) });
  return 'UNEXPECTED';
}

export async function createWorkFromProposal(
  target: ProposalTarget,
  state: WorkState,
  form: FormData,
): Promise<WorkState> {
  const { context, database } = await requireTenant(target.organizationId);
  const title = text(form, 'title');
  const objective = text(form, 'objective');
  const owner = text(form, 'owner');
  const due = text(form, 'due');
  const parsed = acceptProposedWorkSchema.safeParse({
    title,
    objective,
    owner_membership_id: owner,
    due_at: due === '' ? null : due + ':00Z',
  });
  let workId: string;
  try {
    if (!parsed.success) throw new AppError('INVALID_INPUT');
    const work = await acceptProposedWorkOnce(
      database,
      context,
      text(form, 'requestKey'),
      target.itemId,
      target.version,
      parsed.data,
    );
    workId = work.work_unit_id;
  } catch (error) {
    const code = refusal(error);
    const blocked = ['NOT_FOUND', 'FORBIDDEN', 'MEETING_PURGED'].includes(code);
    return {
      code,
      revision: (state.revision ?? 0) + 1,
      ...(!blocked
        ? {
            draft: {
              title: title.slice(0, 300),
              objective: objective.slice(0, 10000),
              owner: owner.slice(0, 36),
              due: due.slice(0, 16),
            },
          }
        : {}),
    };
  }
  revalidatePath(meetingPath(target));
  redirect('/o/' + target.organizationId + '/work/' + workId);
}

export async function decideMeetingProposal(
  target: ProposalTarget,
  decision: 'accept' | 'reject',
  form: FormData,
) {
  const { context, database } = await requireTenant(target.organizationId);
  const path = meetingPath(target);
  let query = '?proposal=' + (decision === 'accept' ? 'accepted' : 'rejected');
  try {
    if (decision === 'reject' && text(form, 'confirm') !== 'yes')
      throw new AppError('INVALID_INPUT');
    const settle = decision === 'accept' ? acceptProposedDecision : rejectProposedItem;
    await settle(database, context, { itemId: target.itemId, expectedVersion: target.version });
  } catch (error) {
    query = '?error=' + encodeURIComponent(refusal(error));
  }
  revalidatePath(path);
  redirect(path + query + '#meeting-suggestions');
}
