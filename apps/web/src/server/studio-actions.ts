'use server';
import { AppError, idSchema } from '@ensemus/application';
import { createAgentDraft, updateAgentDraft } from '@ensemus/application/agent-drafts';
import { requestSimulation } from '@ensemus/application/simulations';
import {
  requestPublishReview,
  decidePublishReview,
  publishApproved,
  cancelPublishReview,
} from '@ensemus/application/publish-reviews';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  agentFormAnswers,
  studioText,
  studioFormValues,
  type StudioFormState,
} from '@/lib/studio-input';
import { stepUpPath } from '@/lib/step-up';
import { requireTenant } from './tenant';
import { webProductPorts } from './product-ports';
import { studioOnce } from './studio-api';
import { getRuntime } from './runtime';
const idOf = (form: FormData, key: string) => {
  const parsed = idSchema.safeParse(studioText(form, key));
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
};
const version = (form: FormData) => {
  const raw = studioText(form, 'version');
  if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > 2147483647) throw new AppError('INVALID_INPUT');
  return Number(raw);
};
type Tenant = Awaited<ReturnType<typeof requireTenant>>;
async function failure(error: unknown, org: string, path: string) {
  if (error instanceof AppError && error.code === 'SSO_REQUIRED') redirect('/sign-in/sso');
  if (error instanceof AppError && error.code === 'MFA_REQUIRED') redirect(stepUpPath(org, path));
  if (error instanceof AppError) return error.code;
  getRuntime().log.error('studio.action_failed', { errorCode: errorCode(error) });
  throw error;
}
export async function saveAgentDraftAction(
  state: StudioFormState,
  form: FormData,
): Promise<StudioFormState> {
  const org = idOf(form, 'organizationId'),
    tenant = await requireTenant(org),
    raw = studioText(form, 'draftId');
  let path: string;
  try {
    const input = { name: studioText(form, 'name'), answers: agentFormAnswers(form) },
      id = raw
        ? (
            await updateAgentDraft(tenant.database, tenant.context, webProductPorts(), {
              ...input,
              draftId: idOf(form, 'draftId'),
              expectedVersion: version(form),
            })
          ).id
        : await studioOnce(
            tenant.database,
            tenant.context,
            idOf(form, 'requestKey'),
            'agent-draft.create',
            input,
            (db) => createAgentDraft(db, tenant.context, webProductPorts(), input),
          );
    path = `/o/${org}/studio/agents/${id}`;
    revalidatePath(`/o/${org}/studio`, 'layout');
  } catch (error) {
    return {
      code: await failure(error, org, `/o/${org}/studio`),
      values: studioFormValues(form),
      revision: (state.revision ?? 0) + 1,
    };
  }
  redirect(path);
}
async function native(form: FormData, work: (tenant: Tenant, org: string) => Promise<string>) {
  const org = idOf(form, 'organizationId'),
    tenant = await requireTenant(org),
    draft = studioText(form, 'draftId'),
    review = studioText(form, 'reviewId');
  let path: string;
  try {
    path = await work(tenant, org);
    revalidatePath(`/o/${org}/studio`, 'layout');
  } catch (error) {
    const back =
      review && idSchema.safeParse(review).success
        ? `/o/${org}/studio/reviews/${idOf(form, 'reviewId')}`
        : draft && idSchema.safeParse(draft).success
          ? `/o/${org}/studio/agents/${idOf(form, 'draftId')}`
          : `/o/${org}/studio`;
    const code = await failure(error, org, back);
    redirect(`${back}?error=${encodeURIComponent(code)}`);
  }
  redirect(path);
}
export async function simulateAgentAction(form: FormData) {
  return native(form, async ({ database, context }, org) => {
    const input = {
      subject: { kind: 'agent_draft' as const, draftId: idOf(form, 'draftId') },
      scenarioKey: studioText(form, 'scenarioKey'),
    };
    const id = await studioOnce(
      database,
      context,
      idOf(form, 'requestKey'),
      'simulation.request',
      input,
      (db) => requestSimulation(db, context, input),
      202,
    );
    return `/o/${org}/studio/simulations/${id}`;
  });
}
export async function requestStudioReviewAction(form: FormData) {
  return native(form, async ({ database, context }, org) => {
    const reviewer = studioText(form, 'reviewerMembershipId'),
      input = {
        subjectKind: 'agent_draft' as const,
        subjectId: idOf(form, 'draftId'),
        simulationRunId: idOf(form, 'simulationId'),
        ...(reviewer ? { reviewerMembershipId: idOf(form, 'reviewerMembershipId') } : {}),
      },
      id = await studioOnce(
        database,
        context,
        idOf(form, 'requestKey'),
        'publish-review.request',
        input,
        (db) => requestPublishReview(db, context, input),
      );
    return `/o/${org}/studio/reviews/${id}`;
  });
}
export async function decideStudioReviewAction(form: FormData) {
  return native(form, async ({ database, context, actor }, org) => {
    const decision = studioText(form, 'decision');
    if (decision !== 'approved' && decision !== 'rejected') throw new AppError('INVALID_INPUT');
    const reason = studioText(form, 'reason').trim();
    const input: Parameters<typeof decidePublishReview>[3] = {
      reviewId: idOf(form, 'reviewId'),
      expectedVersion: version(form),
      decision,
      ...(reason ? { reason } : {}),
    };
    await studioOnce(
      database,
      context,
      idOf(form, 'requestKey'),
      'publish-review.decide',
      input,
      (db) => decidePublishReview(db, context, { sessionId: actor.sessionId }, input),
      200,
    );
    return `/o/${org}/studio/reviews/${input.reviewId}`;
  });
}
export async function publishStudioReviewAction(form: FormData) {
  return native(form, async ({ database, context, actor }, org) => {
    const input = { reviewId: idOf(form, 'reviewId'), expectedVersion: version(form) };
    await studioOnce(
      database,
      context,
      idOf(form, 'requestKey'),
      'publish-review.publish',
      input,
      async (db) => {
        await publishApproved(
          db,
          context,
          webProductPorts(),
          { sessionId: actor.sessionId },
          input,
        );
        return { id: input.reviewId };
      },
      200,
    );
    return `/o/${org}/studio/reviews/${input.reviewId}`;
  });
}
export async function cancelStudioReviewAction(form: FormData) {
  return native(form, async ({ database, context }, org) => {
    const input = { reviewId: idOf(form, 'reviewId'), expectedVersion: version(form) };
    await cancelPublishReview(database, context, input);
    return `/o/${org}/studio/reviews/${input.reviewId}`;
  });
}
