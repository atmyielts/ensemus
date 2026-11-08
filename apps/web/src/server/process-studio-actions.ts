'use server';
import { AppError, listDirectory } from '@ensemus/application';
import {
  createProcessDraft,
  getProcessDraft,
  updateProcessDraft,
  loadProcessCatalog,
} from '@ensemus/application/process-specs';
import { listAgentRegistry } from '@ensemus/application/ai-agents';
import { requestSimulation, getSimulation } from '@ensemus/application/simulations';
import { requestPublishReview, getPublishReview } from '@ensemus/application/publish-reviews';
import { createProcessDraftSchema } from '@ensemus/contracts/studio';
import { canProduct, canReadRecord } from '@ensemus/domain/product-policy';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { stepUpPath } from '@/lib/step-up';
import {
  workflowText,
  workflowIdentifier,
  workflowVersion,
  workflowPointId,
  readWorkflowPoint,
  applyWorkflowPoint,
  removeWorkflowPoint,
  workflowFormValues,
  type WorkflowFormState,
} from '@/lib/process-studio-input';
import { workflowChoiceData, workflowNeedsIndependentReview } from '@/lib/process-studio-present';
import { requireStudio } from './studio-pages';
import { webProductPorts } from './product-ports';
import { studioOnce } from './studio-api';
import { getRuntime } from './runtime';

type Tenant = Awaited<ReturnType<typeof requireStudio>>;
async function failure(error: unknown, org: string, path: string) {
  if (error instanceof AppError && error.code === 'SSO_REQUIRED') redirect('/sign-in/sso');
  if (error instanceof AppError && error.code === 'MFA_REQUIRED') redirect(stepUpPath(org, path));
  if (error instanceof AppError) return error.code;
  getRuntime().log.error('process_studio.action_failed', { errorCode: errorCode(error) });
  throw error;
}
async function edit(
  state: WorkflowFormState,
  form: FormData,
  perform: (tenant: Tenant, org: string) => Promise<string>,
): Promise<WorkflowFormState> {
  const org = workflowIdentifier(form, 'organizationId'),
    tenant = await requireStudio(org);
  let path: string;
  try {
    path = await perform(tenant, org);
    revalidatePath(`/o/${org}/studio/workflows`, 'layout');
  } catch (error) {
    const raw = workflowText(form, 'draftId'),
      back = raw
        ? `/o/${org}/studio/workflows/${workflowIdentifier(form, 'draftId')}/edit`
        : `/o/${org}/studio/workflows/new`;
    return {
      code: await failure(error, org, back),
      values: workflowFormValues(form),
      revision: (state.revision ?? 0) + 1,
    };
  }
  redirect(path);
}
export async function saveWorkflowDetailsAction(state: WorkflowFormState, form: FormData) {
  return edit(state, form, async ({ database, context }, org) => {
    const parsed = createProcessDraftSchema.safeParse({
      name: workflowText(form, 'name'),
      classification: workflowText(form, 'classification'),
    });
    if (!parsed.success) throw new AppError('INVALID_INPUT');
    const existing = workflowText(form, 'draftId'),
      key = workflowIdentifier(form, 'requestKey');
    const input = existing
      ? {
          ...parsed.data,
          draftId: workflowIdentifier(form, 'draftId'),
          expectedVersion: workflowVersion(form),
        }
      : parsed.data;
    const id = await studioOnce(
      database,
      context,
      key,
      existing ? 'workflow.details.update' : 'workflow.create',
      input,
      (db) =>
        existing
          ? updateProcessDraft(db, context, webProductPorts(), {
              ...parsed.data,
              draftId: workflowIdentifier(form, 'draftId'),
              expectedVersion: workflowVersion(form),
            })
          : createProcessDraft(db, context, parsed.data),
      existing ? 200 : 201,
    );
    await getProcessDraft(database, context, webProductPorts(), id);
    return `/o/${org}/studio/workflows/${id}${existing ? '' : '/edit'}`;
  });
}
export async function saveWorkflowPointAction(state: WorkflowFormState, form: FormData) {
  return edit(state, form, async ({ database, context }, org) => {
    const draftId = workflowIdentifier(form, 'draftId'),
      expectedVersion = workflowVersion(form),
      key = workflowIdentifier(form, 'requestKey'),
      mode = workflowText(form, 'mode');
    if (mode !== 'add' && mode !== 'update') throw new AppError('INVALID_INPUT');
    const change = readWorkflowPoint(form);
    if (mode === 'add' && change.node.id !== workflowPointId(key))
      throw new AppError('INVALID_INPUT');
    const input = { draftId, expectedVersion, mode, change };
    const id = await studioOnce(
      database,
      context,
      key,
      'workflow.point.save',
      input,
      async (db) => {
        // This authorized read is outside the effect transaction. The actual kernel locks and checks the
        // submitted version, so another edit can only cause a refusal, never a lost update.
        const current = await getProcessDraft(database, context, webProductPorts(), draftId);
        const graph = applyWorkflowPoint(current.graph, change, mode);
        return updateProcessDraft(db, context, webProductPorts(), {
          draftId,
          expectedVersion,
          graph,
        });
      },
      200,
    );
    await getProcessDraft(database, context, webProductPorts(), id);
    return `/o/${org}/studio/workflows/${id}/edit?saved=1`;
  });
}
export async function removeWorkflowPointAction(form: FormData) {
  const org = workflowIdentifier(form, 'organizationId'),
    tenant = await requireStudio(org),
    draftId = workflowIdentifier(form, 'draftId');
  const back = `/o/${org}/studio/workflows/${draftId}/edit`;
  let code: string | undefined;
  try {
    if (workflowText(form, 'confirmed') !== 'yes') throw new AppError('INVALID_INPUT');
    const nodeId = workflowText(form, 'nodeId'),
      expectedVersion = workflowVersion(form),
      key = workflowIdentifier(form, 'requestKey');
    await studioOnce(
      tenant.database,
      tenant.context,
      key,
      'workflow.point.remove',
      { draftId, nodeId, expectedVersion },
      async (db) => {
        const current = await getProcessDraft(
          tenant.database,
          tenant.context,
          webProductPorts(),
          draftId,
        );
        return updateProcessDraft(db, tenant.context, webProductPorts(), {
          draftId,
          expectedVersion,
          graph: removeWorkflowPoint(current.graph, nodeId),
        });
      },
      200,
    );
    await getProcessDraft(tenant.database, tenant.context, webProductPorts(), draftId);
    revalidatePath(`/o/${org}/studio/workflows`, 'layout');
  } catch (error) {
    code = await failure(error, org, back);
  }
  redirect(code ? `${back}?error=${encodeURIComponent(code)}` : `${back}?saved=1`);
}
async function request(
  form: FormData,
  perform: (tenant: Tenant, draftId: string, key: string) => Promise<string>,
) {
  const org = workflowIdentifier(form, 'organizationId'),
    tenant = await requireStudio(org),
    draftId = workflowIdentifier(form, 'draftId'),
    key = workflowIdentifier(form, 'requestKey'),
    back = `/o/${org}/studio/workflows/${draftId}`;
  let path: string;
  try {
    path = await perform(tenant, draftId, key);
    revalidatePath(`/o/${org}/studio/workflows`, 'layout');
  } catch (error) {
    const code = await failure(error, org, back);
    redirect(`${back}?error=${encodeURIComponent(code)}`);
  }
  redirect(`/o/${org}/studio/${path}`);
}
export async function rehearseWorkflowAction(form: FormData) {
  return request(form, async ({ database, context }, draftId, key) => {
    const input = {
      subject: { kind: 'process_draft' as const, draftId },
      scenarioKey: 'standard.process',
    };
    const id = await studioOnce(
      database,
      context,
      key,
      'workflow.simulation.request',
      input,
      (db) => requestSimulation(db, context, input),
      202,
    );
    await getSimulation(database, context, id);
    return `simulations/${id}`;
  });
}
export async function reviewWorkflowAction(form: FormData) {
  return request(form, async ({ database, context }, draftId, key) => {
    const simulationRunId = workflowIdentifier(form, 'simulationId'),
      reviewerMembershipId = workflowIdentifier(form, 'reviewerMembershipId');
    const input = {
      subjectKind: 'process_draft' as const,
      subjectId: draftId,
      simulationRunId,
      reviewerMembershipId,
    };
    const id = await studioOnce(
      database,
      context,
      key,
      'workflow.review.request',
      input,
      async (db) => {
        const current = await getProcessDraft(database, context, webProductPorts(), draftId),
          people = await listDirectory(database, context);
        const reviewer = people.find((person) => person.membershipId === reviewerMembershipId);
        if (
          !reviewer ||
          reviewer.status !== 'active' ||
          !canProduct(reviewer.role, 'studio.review') ||
          !canReadRecord(current, { membershipId: reviewer.membershipId, role: reviewer.role })
        )
          throw new AppError('FORBIDDEN');
        if (
          workflowNeedsIndependentReview(current.graph, current.classification) &&
          reviewer.membershipId === context.membershipId
        )
          throw new AppError('REVIEW_SELF_DECISION');
        if (
          !people.some(
            (person) =>
              person.membershipId === current.ownerMembershipId && person.status === 'active',
          )
        )
          throw new AppError('INVALID_STATE');
        if (
          current.graph.nodes.some(
            (node) => node.kind === 'human_approval' && node.approverRole === 'starter_manager',
          )
        )
          throw new AppError('CAPABILITY_UNAVAILABLE');
        const catalog = await loadProcessCatalog(context, webProductPorts()),
          choices = workflowChoiceData(
            catalog,
            catalog.agents === null ? [] : await listAgentRegistry(database, context),
          );
        if (
          current.graph.nodes.some(
            (node) =>
              (node.kind === 'agent_task' &&
                !choices.agents?.some((agent) => agent.id === node.agentDefinitionId)) ||
              (node.kind === 'external_action' &&
                !choices.tools?.some((tool) => tool.id === node.toolId)),
          )
        )
          throw new AppError('CAPABILITY_UNAVAILABLE');
        return requestPublishReview(db, context, input);
      },
    );
    await getPublishReview(database, context, id);
    return `reviews/${id}`;
  });
}
