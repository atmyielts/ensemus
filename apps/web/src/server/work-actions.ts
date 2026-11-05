'use server';

// Every action is a public endpoint. Each one resolves the person and tenant again from the session
// and re-checks permission in its service, and none trusts a hidden field for identity.
import {
  acceptInvitation,
  addArtifact,
  addDependency,
  AppError,
  assignContributor,
  createClient,
  createInvitation,
  createProject,
  createTeam,
  createWorkUnit,
  decideApproval,
  deleteArtifact,
  disableMember,
  markRead,
  removeDependency,
  requestApproval,
  requestExecution,
  revokeInvitation,
  setMemberRole,
  setOwner,
  transitionWorkUnit,
  unassign,
  updateWorkUnit,
} from '@ensemus/application';
import { WORK_STATES, type WorkState } from '@ensemus/domain/work-unit';
import { errorCode } from '@ensemus/telemetry';
import { redirect } from 'next/navigation';
import { requireActor } from './actor';
import { getRuntime, getStore } from './runtime';
import { requireTenant } from './tenant';

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};
const int = (form: FormData, name: string) => Number.parseInt(text(form, name), 10);
const orgOf = (form: FormData) => text(form, 'organizationId');
const orUndefined = (value: string) => (value.trim() ? value : undefined);

/** Sends people back to where they were, with a known error code and never a raw message. */
async function run(back: string, action: () => Promise<string | void>): Promise<never> {
  let target = back;
  try {
    const next = await action();
    if (next) target = next;
  } catch (error) {
    if (error instanceof AppError) {
      target = `${back}${back.includes('?') ? '&' : '?'}error=${error.code}`;
    } else {
      getRuntime().log.error('action.failed', { errorCode: errorCode(error) });
      target = `${back}${back.includes('?') ? '&' : '?'}error=UNEXPECTED`;
    }
  }
  redirect(target);
}

// --- Work
export async function createWorkAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  const criteria = form.getAll('criteria').filter((c) => typeof c === 'string');
  const dueAt = orUndefined(text(form, 'dueAt'));
  const projectId = orUndefined(text(form, 'projectId'));
  const objective = orUndefined(text(form, 'objective'));
  const plan = text(form, 'executionPlan');
  await run(`/o/${org}/work/new`, async () => {
    const work = await createWorkUnit(database, context, {
      title: text(form, 'title'),
      classification: text(form, 'classification') as 'internal',
      completionCriteria: criteria.map((kind) => ({ kind })) as Array<{ kind: 'artifact_exists' }>,
      ...(objective ? { objective } : {}),
      ...(dueAt ? { dueAt: new Date(dueAt) } : {}),
      ...(projectId ? { projectId } : {}),
      ...(plan === 'checklist' ? { executionPlan: 'checklist' as const } : {}),
    });
    return `/o/${org}/work/${work.id}`;
  });
}

export async function updateWorkAction(form: FormData) {
  const org = orgOf(form);
  const id = text(form, 'id');
  const { context, database } = await requireTenant(org);
  const dueAt = text(form, 'dueAt');
  await run(`/o/${org}/work/${id}`, async () => {
    await updateWorkUnit(database, context, id, int(form, 'version'), {
      title: text(form, 'title'),
      objective: text(form, 'objective'),
      dueAt: dueAt ? new Date(dueAt) : null,
    });
  });
}

export async function transitionWorkAction(form: FormData) {
  const org = orgOf(form);
  const id = text(form, 'id');
  const { context, database } = await requireTenant(org);
  const to = text(form, 'to') as WorkState;
  const reason = orUndefined(text(form, 'reason'));
  await run(`/o/${org}/work/${id}`, async () => {
    if (!WORK_STATES.includes(to)) throw new AppError('INVALID_INPUT');
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
  const id = text(form, 'id');
  const { context, database } = await requireTenant(org);
  await run(`/o/${org}/work/${id}`, async () => {
    await requestExecution(database, context, id);
  });
}

export async function addDependencyAction(form: FormData) {
  const org = orgOf(form);
  const id = text(form, 'id');
  const { context, database } = await requireTenant(org);
  await run(`/o/${org}/work/${id}`, async () => {
    await addDependency(database, context, {
      dependentId: id,
      prerequisiteId: text(form, 'prerequisiteId'),
    });
  });
}

export async function removeDependencyAction(form: FormData) {
  const org = orgOf(form);
  const id = text(form, 'id');
  const { context, database } = await requireTenant(org);
  await run(`/o/${org}/work/${id}`, async () => {
    await removeDependency(database, context, {
      dependentId: id,
      prerequisiteId: text(form, 'prerequisiteId'),
    });
  });
}

export async function setOwnerAction(form: FormData) {
  const org = orgOf(form);
  const id = text(form, 'id');
  const { context, database } = await requireTenant(org);
  await run(`/o/${org}/work/${id}`, async () => {
    await setOwner(database, context, {
      id,
      expectedVersion: int(form, 'version'),
      ownerMembershipId: text(form, 'membershipId'),
    });
  });
}

export async function assignAction(form: FormData) {
  const org = orgOf(form);
  const id = text(form, 'id');
  const { context, database } = await requireTenant(org);
  await run(`/o/${org}/work/${id}`, async () => {
    await assignContributor(database, context, {
      id,
      membershipId: text(form, 'membershipId'),
    });
  });
}

export async function unassignAction(form: FormData) {
  const org = orgOf(form);
  const id = text(form, 'id');
  const { context, database } = await requireTenant(org);
  await run(`/o/${org}/work/${id}`, async () => {
    await unassign(database, context, { id, membershipId: text(form, 'membershipId') });
  });
}

export async function uploadArtifactAction(form: FormData) {
  const org = orgOf(form);
  const id = text(form, 'id');
  const { context, database } = await requireTenant(org);
  const file = form.get('file');
  await run(`/o/${org}/work/${id}`, async () => {
    if (!(file instanceof File) || file.size === 0) throw new AppError('INVALID_INPUT');
    await addArtifact(database, getStore(), context, {
      workUnitId: id,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      body: Buffer.from(await file.arrayBuffer()),
    });
  });
}

export async function deleteArtifactAction(form: FormData) {
  const org = orgOf(form);
  const id = text(form, 'id');
  const { context, database } = await requireTenant(org);
  await run(`/o/${org}/work/${id}`, async () => {
    await deleteArtifact(database, getStore(), context, {
      workUnitId: id,
      artifactId: text(form, 'artifactId'),
    });
  });
}

// --- Approvals
const REVIEW_HOURS = 72;

export async function requestReviewAction(form: FormData) {
  const org = orgOf(form);
  const id = text(form, 'id');
  const { context, database } = await requireTenant(org);
  await run(`/o/${org}/work/${id}`, async () => {
    await requestApproval(database, context, {
      workUnitId: id,
      approverMembershipId: text(form, 'approverMembershipId'),
      expiresAt: new Date(Date.now() + REVIEW_HOURS * 60 * 60 * 1000),
      action: {
        toolName: 'work.review',
        toolVersion: '1',
        targetRef: `work_unit:${id}`,
        payload: { version: int(form, 'version') },
      },
    });
  });
}

export async function decideApprovalAction(form: FormData) {
  const org = orgOf(form);
  const approvalId = text(form, 'approvalId');
  const { context, database } = await requireTenant(org);
  const decision = text(form, 'decision') === 'approve' ? 'approve' : 'deny';
  const reason = orUndefined(text(form, 'reason'));
  await run(`/o/${org}/approvals/${approvalId}`, async () => {
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
export async function inviteAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  const role = text(form, 'role') === 'admin' ? 'admin' : 'member';
  await run(`/o/${org}/people`, async () => {
    const { token } = await createInvitation(database, context, {
      email: text(form, 'email'),
      role,
    });
    // The link appears once in the address bar, and only a hash of the token is stored.
    return `/o/${org}/people?invited=${encodeURIComponent(token)}`;
  });
}

export async function revokeInvitationAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run(`/o/${org}/people`, async () => {
    await revokeInvitation(database, context, { invitationId: text(form, 'invitationId') });
  });
}

export async function acceptInvitationAction(form: FormData) {
  const actor = await requireActor();
  const token = text(form, 'token');
  await run(`/invite/${encodeURIComponent(token)}`, async () => {
    const { organizationId } = await acceptInvitation(getRuntime().app, {
      token,
      userId: actor.userId,
      email: actor.email,
    });
    return `/o/${organizationId}`;
  });
}

export async function setRoleAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run(`/o/${org}/people`, async () => {
    await setMemberRole(database, context, {
      membershipId: text(form, 'membershipId'),
      role: text(form, 'role') as 'member',
    });
  });
}

export async function disableMemberAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run(`/o/${org}/people`, async () => {
    await disableMember(database, context, { membershipId: text(form, 'membershipId') });
  });
}

export async function createTeamAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  const parentId = orUndefined(text(form, 'parentId'));
  await run(`/o/${org}/people`, async () => {
    await createTeam(database, context, {
      name: text(form, 'name'),
      ...(parentId ? { parentId } : {}),
    });
  });
}

// --- Clients and projects
export async function createClientAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await run(`/o/${org}/clients`, async () => {
    await createClient(database, context, { displayName: text(form, 'displayName') });
  });
}

export async function createProjectAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  const clientId = orUndefined(text(form, 'clientId'));
  await run(`/o/${org}/clients`, async () => {
    await createProject(database, context, {
      name: text(form, 'name'),
      ...(clientId ? { clientId } : {}),
    });
  });
}

// --- Inbox
export async function openNotificationAction(form: FormData) {
  const org = orgOf(form);
  const { context, database } = await requireTenant(org);
  await markRead(database, context, text(form, 'id'));
  const target = text(form, 'target');
  // Only ever a path inside this organization, built by our own page.
  redirect(target.startsWith(`/o/${org}/`) ? target : `/o/${org}/inbox`);
}
