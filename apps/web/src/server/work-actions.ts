'use server';

// Every action is a public endpoint. Each one resolves the person and tenant again from the session
// and re-checks permission in its service, and none trusts a hidden field for identity.
import {
  acceptInvitation,
  addArtifact,
  addDependency,
  addTeamMember,
  AppError,
  assignContributor,
  auditRefusal,
  canonicalId,
  confirmInvitation,
  createClient,
  createInvitation,
  createProject,
  createTeam,
  createWorkUnit,
  decideApproval,
  deleteArtifact,
  disableMember,
  getApproval,
  getWorkUnit,
  idSchema,
  isAuditedRefusal,
  markRead,
  recoverWorkOwner,
  refusalCode,
  removeDependency,
  removeStoppedHiddenPrerequisites,
  removeTeamMember,
  requestExecution,
  requestWorkReview,
  revokeInvitation,
  setMemberRole,
  setOwner,
  setTeamParent,
  setClientReaders,
  transitionWorkUnit,
  unassign,
  updateWorkUnit,
} from '@ensemus/application';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { WORK_STATES, type WorkState } from '@ensemus/domain/work-unit';
import { errorCode } from '@ensemus/telemetry';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { InviteFormState, NewWorkFormState, WorkFormState } from '@/lib/form-state';
import { requireActor } from './actor';
import { getRestoreGate, getRuntime, getStore } from './runtime';
import { requireTenant } from './tenant';

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const idOf = (form: FormData, name: string) => canonicalId(text(form, name));
const int = (form: FormData, name: string) => Number.parseInt(text(form, name), 10);
const orgOf = (form: FormData) => idOf(form, 'organizationId');
const orUndefined = (value: string) => (value.trim() ? value : undefined);
/**
 * One rendered form makes one row, however many times it is sent. Only ever hashed into an ID, so
 * something that is not a key just gets no protection from repeats.
 */
const requestKeyOf = (form: FormData) => {
  const key = idSchema.safeParse(text(form, 'requestKey'));
  return key.success ? { requestKey: key.data } : {};
};

type Tenant = { context: TenantContext; database: AppDatabase };

/**
 * Leaves a record when a form asks for something its role or the work's state does not allow. A form
 * can name anything in its hidden fields. Failing to write this never changes what the person is told.
 */
async function recordRefusal(tenant: Tenant | null, error: unknown) {
  if (!tenant || !isAuditedRefusal(error)) return;
  await auditRefusal(tenant.database, tenant.context, {
    code: refusalCode(error),
    surface: 'web',
  }).catch((failure: unknown) =>
    getRuntime().log.error('audit.refusal_failed', { errorCode: errorCode(failure) }),
  );
}

/** Sends people back to where they were, with a known error code and never a raw message. */
async function run(
  tenant: Tenant | null,
  back: string,
  action: () => Promise<string | void>,
): Promise<never> {
  let target = back;
  try {
    const next = await action();
    if (next) target = next;
  } catch (error) {
    await recordRefusal(tenant, error);
    if (error instanceof AppError && error.code === 'RESTORE_PENDING') {
      target = '/restoring';
    } else if (error instanceof AppError) {
      target = `${back}${back.includes('?') ? '&' : '?'}error=${error.code}`;
    } else {
      getRuntime().log.error('action.failed', { errorCode: errorCode(error) });
      target = `${back}${back.includes('?') ? '&' : '?'}error=UNEXPECTED`;
    }
  }
  redirect(target);
}

/** Something that cannot be undone has to be meant. Browsers check the box, and so does this. */
function assertConfirmed(form: FormData) {
  if (text(form, 'confirm') !== 'yes') throw new AppError('INVALID_INPUT');
}

/** Reduces any failure to a code a form can show. Nothing else about it reaches the person. */
async function codeOf(tenant: Tenant, error: unknown): Promise<string> {
  await recordRefusal(tenant, error);
  if (error instanceof AppError) return error.code;
  getRuntime().log.error('action.failed', { errorCode: errorCode(error) });
  return 'UNEXPECTED';
}

const validDate = (value: string) => !Number.isNaN(new Date(value).getTime());

// --- Work
export async function createWorkFormAction(
  _previous: NewWorkFormState,
  form: FormData,
): Promise<NewWorkFormState> {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  const criteria = form.getAll('criteria').filter((c): c is string => typeof c === 'string');
  const plan = text(form, 'executionPlan');
  const values = {
    title: text(form, 'title'),
    objective: text(form, 'objective'),
    dueAt: text(form, 'dueAt'),
    projectId: idOf(form, 'projectId'),
    classification: text(form, 'classification'),
    criteria,
    executionPlan: plan === 'checklist',
  };
  // Named here so the person hears which field it is, with everything they typed still in place.
  if (!values.title.trim()) return { code: 'INVALID_INPUT', field: 'title', values };
  if (values.dueAt && !validDate(values.dueAt)) {
    return { code: 'INVALID_INPUT', field: 'dueAt', values };
  }
  let id: string;
  try {
    const work = await createWorkUnit(database, context, {
      title: values.title,
      classification: values.classification as 'internal',
      completionCriteria: criteria.map((kind) => ({ kind })) as Array<{ kind: 'artifact_exists' }>,
      ...(orUndefined(values.objective) ? { objective: values.objective } : {}),
      ...(values.dueAt ? { dueAt: new Date(values.dueAt) } : {}),
      ...(orUndefined(values.projectId) ? { projectId: values.projectId } : {}),
      ...(values.executionPlan ? { executionPlan: 'checklist' as const } : {}),
      ...requestKeyOf(form),
    });
    id = work.id;
  } catch (error) {
    return { code: await codeOf({ context, database }, error), values };
  }
  redirect(`/o/${org}/work/${id}`);
}

export async function updateWorkFormAction(
  _previous: WorkFormState,
  form: FormData,
): Promise<WorkFormState> {
  const org = orgOf(form);
  const id = idOf(form, 'id');
  const { context, database } = await requireTenant(org);
  const values = {
    title: text(form, 'title'),
    objective: text(form, 'objective'),
    dueAt: text(form, 'dueAt'),
  };
  if (!values.title.trim()) return { code: 'INVALID_INPUT', field: 'title', values };
  if (values.dueAt && !validDate(values.dueAt)) {
    return { code: 'INVALID_INPUT', field: 'dueAt', values };
  }
  try {
    await updateWorkUnit(database, context, id, int(form, 'version'), {
      title: values.title,
      objective: values.objective,
      dueAt: values.dueAt ? new Date(values.dueAt) : null,
    });
  } catch (error) {
    const code = await codeOf({ context, database }, error);
    if (code !== 'VERSION_CONFLICT') return { code, values };
    // Hands back what changed, so the person can compare it with their draft and decide.
    const latest = await getWorkUnit(database, context, id);
    return {
      code,
      values,
      latest: {
        version: latest.version,
        title: latest.title,
        objective: latest.objective ?? '',
        dueAt: latest.dueAt ? latest.dueAt.toISOString().slice(0, 10) : '',
      },
    };
  }
  redirect(`/o/${org}/work/${id}`);
}

export async function transitionWorkAction(form: FormData) {
  const org = orgOf(form);
  const id = idOf(form, 'id');
  const { context, database } = await requireTenant(org);
  const to = text(form, 'to') as WorkState;
  const reason = orUndefined(text(form, 'reason'));
  await run({ context, database }, `/o/${org}/work/${id}`, async () => {
    if (!WORK_STATES.includes(to)) throw new AppError('INVALID_INPUT');
    if (to === 'cancelled') {
      assertConfirmed(form);
      if (!reason) throw new AppError('REASON_REQUIRED');
    }
    await transitionWorkUnit(database, context, {
      id,
      expectedVersion: int(form, 'version'),
      to,
      ...(reason ? { reason } : {}),
    });
  });
}

export async function runPlanAction(form: FormData) {
  const org = orgOf(form);
  const id = idOf(form, 'id');
  const { context, database } = await requireTenant(org);
  const reviewerMembershipId = orUndefined(idOf(form, 'reviewerMembershipId'));
  await run({ context, database }, `/o/${org}/work/${id}`, async () => {
    await requestExecution(database, context, id, {
      ...(reviewerMembershipId ? { reviewerMembershipId } : {}),
    });
  });
}

export async function addDependencyAction(form: FormData) {
  const org = orgOf(form);
  const id = idOf(form, 'id');
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/work/${id}`, async () => {
    await addDependency(database, context, {
      dependentId: id,
      prerequisiteId: idOf(form, 'prerequisiteId'),
    });
  });
}

export async function removeDependencyAction(form: FormData) {
  const org = orgOf(form);
  const id = idOf(form, 'id');
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/work/${id}`, async () => {
    await removeDependency(database, context, {
      dependentId: id,
      prerequisiteId: idOf(form, 'prerequisiteId'),
    });
  });
}

export async function removeStoppedHiddenPrerequisitesAction(form: FormData) {
  const org = orgOf(form);
  const id = idOf(form, 'id');
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/work/${id}`, async () => {
    await removeStoppedHiddenPrerequisites(database, context, { dependentId: id });
  });
}

export async function setOwnerAction(form: FormData) {
  const org = orgOf(form);
  const id = idOf(form, 'id');
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/work/${id}`, async () => {
    await setOwner(database, context, {
      id,
      expectedVersion: int(form, 'version'),
      ownerMembershipId: idOf(form, 'membershipId'),
    });
  });
}

export async function assignAction(form: FormData) {
  const org = orgOf(form);
  const id = idOf(form, 'id');
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/work/${id}`, async () => {
    await assignContributor(database, context, {
      id,
      membershipId: idOf(form, 'membershipId'),
    });
  });
}

export async function unassignAction(form: FormData) {
  const org = orgOf(form);
  const id = idOf(form, 'id');
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/work/${id}`, async () => {
    await unassign(database, context, { id, membershipId: idOf(form, 'membershipId') });
  });
}

export async function uploadArtifactAction(form: FormData) {
  const org = orgOf(form);
  const id = idOf(form, 'id');
  const { context, database } = await requireTenant(org);
  const file = form.get('file');
  await run({ context, database }, `/o/${org}/work/${id}`, async () => {
    if (!(file instanceof File) || file.size === 0) throw new AppError('INVALID_INPUT');
    await addArtifact(database, getStore(), context, {
      workUnitId: id,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      body: Buffer.from(await file.arrayBuffer()),
      ...requestKeyOf(form),
    });
  });
}

export async function deleteArtifactAction(form: FormData) {
  const org = orgOf(form);
  const id = idOf(form, 'id');
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/work/${id}`, async () => {
    assertConfirmed(form);
    await deleteArtifact(database, getStore(), context, {
      workUnitId: id,
      artifactId: idOf(form, 'artifactId'),
    });
  });
}

// --- Approvals
export async function requestReviewAction(form: FormData) {
  const org = orgOf(form);
  const id = idOf(form, 'id');
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/work/${id}`, async () => {
    // What the review covers is read by the service. The form only says who should give it.
    await requestWorkReview(database, context, {
      workUnitId: id,
      expectedVersion: int(form, 'version'),
      approverMembershipId: idOf(form, 'approverMembershipId'),
    });
  });
}

export async function decideApprovalAction(form: FormData) {
  const org = orgOf(form);
  const approvalId = idOf(form, 'approvalId');
  const { context, database } = await requireTenant(org);
  const decision = text(form, 'decision') === 'approve' ? 'approve' : 'deny';
  const reason = orUndefined(text(form, 'reason'));
  await run({ context, database }, `/o/${org}/approvals/${approvalId}`, async () => {
    if (decision === 'deny') {
      // Denying a review that holds the work stops the work for good, so it has to be meant.
      // The reason it also needs is checked by the service, for the API as well.
      const { approval, work } = await getApproval(database, context, approvalId);
      if (approval.holdsWork && work.status === 'awaiting_approval') assertConfirmed(form);
    }
    await decideApproval(database, context, {
      approvalId,
      decision,
      // The hash of what this page showed. If the action has changed since, this is refused.
      shownHash: text(form, 'shownHash'),
      ...(reason ? { reason: reason.slice(0, 2000) } : {}),
    });
  });
}

// --- People
/**
 * The link goes back in this one response and nowhere else. A URL would keep a working credential in
 * browser history, in the Referer of the next click and in any proxy's logs, so none is ever used.
 */
export async function inviteAction(
  _previous: InviteFormState,
  form: FormData,
): Promise<InviteFormState> {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  const role = text(form, 'role') === 'admin' ? 'admin' : 'member';
  const email = text(form, 'email');
  try {
    const { token } = await createInvitation(database, context, { email, role });
    revalidatePath(`/o/${org}/people`);
    return { link: `${getRuntime().config.publicUrl}/invite/${encodeURIComponent(token)}` };
  } catch (error) {
    return { code: await codeOf({ context, database }, error), values: { email, role } };
  }
}

export async function revokeInvitationAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/people`, async () => {
    await revokeInvitation(database, context, { invitationId: idOf(form, 'invitationId') });
  });
}

export async function confirmInvitationAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/people`, async () => {
    assertConfirmed(form);
    await confirmInvitation(database, context, { invitationId: idOf(form, 'invitationId') });
  });
}

export async function acceptInvitationAction(form: FormData) {
  const actor = await requireActor();
  const token = text(form, 'token');
  const here = `/invite/${encodeURIComponent(token)}`;
  await run(null, here, async () => {
    const outcome = await acceptInvitation(getRuntime().app, {
      token,
      userId: actor.userId,
      email: actor.email,
      emailVerified: actor.emailVerified,
      // Asked here, because this person has no tenant yet for requireTenant to check.
      assertServing: (organizationId, userId) =>
        getRestoreGate().assertServingInvited(organizationId, userId),
    });
    return outcome.status === 'joined' ? `/o/${outcome.organizationId}` : `${here}?state=waiting`;
  });
}

export async function setRoleAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/people`, async () => {
    await setMemberRole(database, context, {
      membershipId: idOf(form, 'membershipId'),
      role: text(form, 'role') as 'member',
    });
  });
}

export async function disableMemberAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/people`, async () => {
    assertConfirmed(form);
    await disableMember(database, context, { membershipId: idOf(form, 'membershipId') });
  });
}

/** Names a new owner for work whose owner was disabled, which only an organization owner can do. */
export async function recoverWorkOwnerAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/people`, async () => {
    assertConfirmed(form);
    await recoverWorkOwner(database, context, {
      id: idOf(form, 'id'),
      expectedVersion: int(form, 'version'),
      ownerMembershipId: idOf(form, 'membershipId'),
    });
  });
}

export async function createTeamAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  const parentId = orUndefined(idOf(form, 'parentId'));
  await run({ context, database }, `/o/${org}/people`, async () => {
    await createTeam(database, context, {
      name: text(form, 'name'),
      ...(parentId ? { parentId } : {}),
      ...requestKeyOf(form),
    });
  });
}

export async function addTeamMemberAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/people`, async () => {
    await addTeamMember(database, context, {
      teamId: idOf(form, 'teamId'),
      membershipId: idOf(form, 'membershipId'),
    });
  });
}

export async function removeTeamMemberAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/people`, async () => {
    await removeTeamMember(database, context, {
      teamId: idOf(form, 'teamId'),
      membershipId: idOf(form, 'membershipId'),
    });
  });
}

export async function setTeamParentAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/people`, async () => {
    await setTeamParent(database, context, {
      teamId: idOf(form, 'teamId'),
      parentId: orUndefined(idOf(form, 'parentId')) ?? null,
    });
  });
}

// --- Clients and projects
export async function createClientAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/clients`, async () => {
    await createClient(database, context, {
      displayName: text(form, 'displayName'),
      classification: text(form, 'classification') || 'internal',
      ...requestKeyOf(form),
    });
  });
}

export async function setClientReadersAction(form: FormData) {
  const org = orgOf(form);
  const clientId = idOf(form, 'clientId');
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/clients/${clientId}/access`, async () => {
    await setClientReaders(database, context, {
      clientId,
      expectedVersion: Number(text(form, 'expectedVersion')),
      readerMembershipIds: form
        .getAll('readerMembershipId')
        .filter((value): value is string => typeof value === 'string'),
    });
  });
}

export async function createProjectAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  const clientId = orUndefined(idOf(form, 'clientId'));
  await run({ context, database }, `/o/${org}/clients`, async () => {
    await createProject(database, context, {
      name: text(form, 'name'),
      ...(clientId ? { clientId } : {}),
      ...requestKeyOf(form),
    });
  });
}

// --- Inbox
export async function openNotificationAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run({ context, database }, `/o/${org}/inbox`, async () => {
    await markRead(database, context, idOf(form, 'id'));
    const target = text(form, 'target');
    // Only ever a path inside this organization, built by our own page.
    return target.startsWith(`/o/${org}/`) ? target : `/o/${org}/inbox`;
  });
}
