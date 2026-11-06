// AGENT-12. Decisions and classified text live in PostgreSQL; Temporal carries IDs and progress only.
// M4 creates a real run in this transaction; M3 creates the exact approved email intent in it. Neither
// port may call a provider here. Every completion still goes through the ordinary work kernel.
import { createHash, randomUUID } from 'node:crypto';
import {
  appendAudit,
  artifactAclCatalog,
  artifactWorkLinks,
  clientOnboardings,
  clients,
  connections,
  externalActions,
  externalActionReceipts,
  knowledgeArtifactVerifications,
  memberships,
  projects,
  withTenantTx,
  workArtifacts,
  workAssignments,
  workDependencies,
  workUnits,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { createDelegatedContext } from '@ensemus/database/service';
import {
  AGGREGATE_CLIENT_ONBOARDING,
  CLIENT_ONBOARDING_REQUESTED,
} from '@ensemus/domain/knowledge-events';
import {
  EMAIL_CONNECTOR_TYPE,
  EMAIL_SEND_TOOL,
  EMAIL_SEND_VERSION,
} from '@ensemus/domain/external-action';
import type { OnboardingState } from '@ensemus/domain/knowledge';
import { can } from '@ensemus/domain/policy';
import { startClientOnboardingSchema } from '@ensemus/contracts/knowledge';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { emit } from '../events';
import { idSchema } from '../ids';
import { idFromRequest } from '../request-id';
import { proposeExternalActionInTx } from '../external-actions';
import { applyTransition, createWorkUnitInTx, loadReadable, type WorkRow } from '../work';
import type { AgentRuns } from './ports';

export type StartOnboardingInput = {
  dealRef: string;
  clientName: string;
  projectName: string;
  ownerMembershipId: string;
  reviewerMembershipId: string;
  emailConnectionId: string;
  contactEmail: string;
};
type Row = typeof clientOnboardings.$inferSelect;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const id = (raw: string) => {
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
};
const terminal = (state: string) => ['completed', 'failed', 'unknown'].includes(state);
class OnboardingFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
async function person(tx: Tx, context: TenantContext) {
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  const [member] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, context.membershipId), eq(memberships.status, 'active')))
    .for('share');
  if (!member) throw new AppError('FORBIDDEN');
  return { ...context, role: member.role };
}
function parse(raw: StartOnboardingInput) {
  const parsed = startClientOnboardingSchema.safeParse({
    deal_ref: raw.dealRef,
    client_name: raw.clientName,
    project_name: raw.projectName,
    owner_membership_id: raw.ownerMembershipId,
    reviewer_membership_id: raw.reviewerMembershipId,
    email_connection_id: raw.emailConnectionId,
    contact_email: raw.contactEmail,
  });
  if (
    !parsed.success ||
    [raw.dealRef, raw.clientName, raw.projectName, raw.contactEmail].some(
      (value) =>
        typeof value !== 'string' || [...value].some((character) => character.charCodeAt(0) < 32),
    )
  )
    throw new AppError('INVALID_INPUT');
  return {
    ...raw,
    dealRef: parsed.data.deal_ref,
    clientName: parsed.data.client_name,
    projectName: parsed.data.project_name,
    ownerMembershipId: id(parsed.data.owner_membership_id),
    reviewerMembershipId: id(parsed.data.reviewer_membership_id),
    emailConnectionId: id(parsed.data.email_connection_id),
    contactEmail: parsed.data.contact_email,
  };
}
async function activePeople(tx: Tx, ids: readonly string[]) {
  const unique = [...new Set(ids)].sort();
  const people = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(inArray(memberships.id, unique), eq(memberships.status, 'active')))
    .orderBy(asc(memberships.id))
    .for('share');
  if (people.length !== unique.length) throw new AppError('NOT_FOUND');
}

export async function startClientOnboarding(
  database: AppDatabase,
  context: TenantContext,
  raw: StartOnboardingInput,
): Promise<{ onboardingId: string; workUnitId: string }> {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  const input = parse(raw);
  if (
    input.reviewerMembershipId === input.ownerMembershipId ||
    input.reviewerMembershipId === context.membershipId
  )
    throw new AppError('APPROVAL_SELF_APPROVAL');
  try {
    return await withTenantTx(database, context, async (tx) => {
      const actor = await person(tx, context);
      if (!can(actor.role, 'client_onboarding.start')) throw new AppError('FORBIDDEN');
      await activePeople(tx, [
        input.ownerMembershipId,
        input.reviewerMembershipId,
        actor.membershipId,
      ]);
      const [existing] = await tx
        .select({ id: clientOnboardings.id })
        .from(clientOnboardings)
        .where(eq(clientOnboardings.dealRef, input.dealRef));
      if (existing) throw new AppError('CLIENT_ONBOARDING_EXISTS');
      const [connection] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, input.emailConnectionId))
        .for('share');
      if (!connection) throw new AppError('NOT_FOUND');
      if (connection.state !== 'active') throw new AppError('CONNECTION_NOT_ACTIVE');
      if (connection.connectorType !== EMAIL_CONNECTOR_TYPE) throw new AppError('INVALID_INPUT');
      const onboardingId = randomUUID(),
        clientId = randomUUID(),
        projectId = randomUUID();
      await tx.insert(clients).values({
        organizationId: actor.organizationId,
        id: clientId,
        displayName: input.clientName,
        classification: 'internal',
      });
      await tx.insert(projects).values({
        organizationId: actor.organizationId,
        id: projectId,
        clientId,
        name: input.projectName,
      });
      // Goals describe outcomes; names/contact text stay on their own classified records and approval.
      const objectives = {
        parent:
          'Complete onboarding for the linked client and project with an accepted cited brief and one approved welcome message confirmed by its delivery receipt.',
        brief:
          'Prepare a client brief for the linked client and project. Cite evidence for factual claims, distinguish uncertainty, and produce one plain-text brief for the named human reviewer.',
        review:
          'Review the generated client brief against its cited sources and the brief objective. Accept the exact bytes only when their evidence supports the intended outcome.',
        send: 'Deliver the approved welcome message to the configured client contact exactly once and preserve its verified receipt.',
      };
      const create = (
        part: keyof typeof objectives,
        title: string,
        owner: string,
        criteria: { kind: 'artifact_exists' | 'external_receipt' }[],
      ) =>
        createWorkUnitInTx(tx, actor, {
          title,
          objective: objectives[part],
          projectId,
          ownerMembershipId: owner,
          classification: 'internal',
          completionCriteria: criteria,
          requestKey: idFromRequest('onboarding-work', actor.membershipId, onboardingId, [part]),
        });
      const parent = await create('parent', 'Client onboarding', input.ownerMembershipId, [
        { kind: 'artifact_exists' },
      ]);
      const brief = await create('brief', 'Prepare the client brief', input.reviewerMembershipId, [
        { kind: 'artifact_exists' },
      ]);
      const review = await create('review', 'Review the client brief', input.reviewerMembershipId, [
        { kind: 'artifact_exists' },
      ]);
      const send = await create('send', 'Send the welcome message', input.ownerMembershipId, [
        { kind: 'external_receipt' },
      ]);
      await tx
        .update(workUnits)
        .set({ parentId: parent.id })
        .where(inArray(workUnits.id, [brief.id, review.id, send.id]));
      await tx.insert(workDependencies).values([
        { organizationId: actor.organizationId, prerequisiteId: brief.id, dependentId: review.id },
        { organizationId: actor.organizationId, prerequisiteId: review.id, dependentId: send.id },
      ]);
      for (const work of [brief, review])
        await tx
          .insert(workAssignments)
          .values({
            organizationId: actor.organizationId,
            workUnitId: work.id,
            membershipId: input.reviewerMembershipId,
            responsibility: 'reviewer',
            actorType: 'human',
          })
          .onConflictDoNothing();
      await tx.insert(clientOnboardings).values({
        organizationId: actor.organizationId,
        id: onboardingId,
        dealRef: input.dealRef,
        clientId,
        projectId,
        workUnitId: parent.id,
        ownerMembershipId: input.ownerMembershipId,
        reviewerMembershipId: input.reviewerMembershipId,
        emailConnectionId: connection.id,
        contactEmail: input.contactEmail,
        briefWorkUnitId: brief.id,
        reviewWorkUnitId: review.id,
        sendWorkUnitId: send.id,
        parentObjectiveSha256: hash(objectives.parent),
        briefObjectiveSha256: hash(objectives.brief),
        reviewObjectiveSha256: hash(objectives.review),
        sendObjectiveSha256: hash(objectives.send),
        requestedByMembershipId: actor.membershipId,
      });
      await emit(tx, actor, {
        eventType: CLIENT_ONBOARDING_REQUESTED,
        aggregateType: AGGREGATE_CLIENT_ONBOARDING,
        aggregateId: onboardingId,
        aggregateVersion: 1,
        classification: 'internal',
        payload: { onboarding_id: onboardingId, work_unit_id: parent.id },
      });
      await appendAudit(tx, {
        organizationId: actor.organizationId,
        actorType: 'user',
        actorId: actor.membershipId,
        action: 'client_onboarding.started',
        targetRef: `client_onboarding:${onboardingId}`,
        decision: 'allow',
      });
      return { onboardingId, workUnitId: parent.id };
    });
  } catch (error) {
    if (pgCode(error) === '23505') throw new AppError('CLIENT_ONBOARDING_EXISTS');
    if (pgCode(error) === '23503') throw new AppError('NOT_FOUND');
    throw error;
  }
}

export type OnboardingView = {
  id: string;
  dealRef: string;
  state: OnboardingState;
  stateCode: string | null;
  clientId: string;
  projectId: string;
  workUnitId: string;
  briefWorkUnitId: string | null;
  reviewWorkUnitId: string | null;
  sendWorkUnitId: string | null;
  briefArtifactId: string | null;
  reviewerMembershipId: string | null;
  costMicros: number | null;
  receipt: { status: string; externalId: string | null; basis: string } | null;
  version: number;
  createdAt: Date;
  finishedAt: Date | null;
};
export async function getClientOnboarding(
  database: AppDatabase,
  context: TenantContext,
  rawId: string,
): Promise<OnboardingView> {
  const onboardingId = id(rawId);
  return withTenantTx(database, context, async (tx) => {
    const actor = await person(tx, context);
    const [row] = await tx
      .select()
      .from(clientOnboardings)
      .where(eq(clientOnboardings.id, onboardingId));
    if (!row) throw new AppError('NOT_FOUND');
    await loadReadable(tx, actor, row.workUnitId);
    const [receipt] = row.emailExternalActionId
      ? await tx
          .select()
          .from(externalActionReceipts)
          .where(eq(externalActionReceipts.externalActionId, row.emailExternalActionId))
          .orderBy(desc(externalActionReceipts.recordedAt), desc(externalActionReceipts.id))
          .limit(1)
      : [];
    return {
      id: row.id,
      dealRef: row.dealRef,
      state: row.state as OnboardingState,
      stateCode: row.stateCode,
      clientId: row.clientId,
      projectId: row.projectId,
      workUnitId: row.workUnitId,
      briefWorkUnitId: row.briefWorkUnitId,
      reviewWorkUnitId: row.reviewWorkUnitId,
      sendWorkUnitId: row.sendWorkUnitId,
      briefArtifactId: row.briefArtifactId,
      reviewerMembershipId: row.reviewerMembershipId,
      costMicros: row.costMicros,
      receipt: receipt
        ? { status: receipt.outcome, externalId: receipt.externalId, basis: receipt.basis }
        : null,
      version: row.version,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    };
  });
}

export type OnboardingStep = {
  state: OnboardingState;
  waitFor: 'nothing' | 'agent_run' | 'person' | 'external_action';
};
const step = (state: OnboardingState): OnboardingStep => ({
  state,
  waitFor: terminal(state)
    ? 'nothing'
    : state === 'waiting_for_send'
      ? 'external_action'
      : state === 'waiting_for_acceptance'
        ? 'person'
        : 'agent_run',
});
async function move(
  tx: Tx,
  context: TenantContext,
  row: Row,
  state: OnboardingState,
  patch: Partial<typeof clientOnboardings.$inferInsert> = {},
) {
  const [updated] = await tx
    .update(clientOnboardings)
    .set({
      ...patch,
      state,
      version: row.version + 1,
      ...(terminal(state) ? { finishedAt: new Date() } : {}),
    })
    .where(and(eq(clientOnboardings.id, row.id), eq(clientOnboardings.version, row.version)))
    .returning();
  if (!updated) throw new AppError('VERSION_CONFLICT');
  await appendAudit(tx, {
    organizationId: context.organizationId,
    actorType: context.actorType === 'service' ? 'system' : 'user',
    ...(context.actorType === 'service' ? {} : { actorId: context.membershipId }),
    action: 'client_onboarding.advanced',
    targetRef: `client_onboarding:${row.id}`,
    decision: 'allow',
    safeReason: state.toUpperCase(),
  });
  return updated;
}
async function locked(tx: Tx, onboardingId: string) {
  const [row] = await tx
    .select()
    .from(clientOnboardings)
    .where(eq(clientOnboardings.id, onboardingId))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}
async function fail(
  database: AppDatabase,
  context: TenantContext,
  onboardingId: string,
  code: string,
) {
  return withTenantTx(database, context, async (tx) => {
    const row = await locked(tx, onboardingId);
    if (terminal(row.state)) return step(row.state as OnboardingState);
    if (row.sendWorkUnitId) {
      const [send] = await tx
        .select()
        .from(workUnits)
        .where(eq(workUnits.id, row.sendWorkUnitId))
        .for('update');
      if (
        send &&
        ['queued', 'ready', 'running', 'blocked', 'awaiting_approval'].includes(send.status)
      )
        await applyTransition(tx, context, send, 'cancelled', {
          reason: 'Onboarding no longer has its required verified inputs.',
        });
    }
    return step(
      (await move(tx, context, row, 'failed', { stateCode: code })).state as OnboardingState,
    );
  });
}
async function work(tx: Tx, context: TenantContext, workId: string) {
  return loadReadable(tx, context, workId, true);
}
async function startWork(tx: Tx, context: TenantContext, row: WorkRow) {
  let current = row;
  if (current.status === 'queued') current = await applyTransition(tx, context, current, 'ready');
  if (current.status === 'ready') current = await applyTransition(tx, context, current, 'running');
  return current;
}
async function completeWork(tx: Tx, context: TenantContext, row: WorkRow) {
  if (row.status === 'completed') return row;
  let current = await startWork(tx, context, row);
  if (current.status === 'running')
    current = await applyTransition(tx, context, current, 'verifying');
  if (current.status !== 'verifying') throw new OnboardingFailure('WORK_CHANGED');
  return applyTransition(tx, context, current, 'completed');
}
function identity(run: NonNullable<Awaited<ReturnType<AgentRuns['statusOf']>>>, row: Row) {
  if (
    run.workUnitId !== row.briefWorkUnitId ||
    run.initiatorMembershipId !== row.requestedByMembershipId ||
    (run.costMicros !== null && (!Number.isSafeInteger(run.costMicros) || run.costMicros < 0))
  )
    throw new OnboardingFailure('RUN_IDENTITY_UNCONFIRMED');
}
async function inputSources(tx: Tx, context: TenantContext, artifactId: string) {
  const ids = await tx.execute<{ id: string }>(
    sql`select id from knowledge.artifact_required_sources(${artifactId}::uuid) as required(id) order by id`,
  );
  if (ids.rows.length)
    await tx.execute(
      sql`select s.id from knowledge.sources s where s.organization_id=${context.organizationId}::uuid and s.id in(select knowledge.artifact_required_sources(${artifactId}::uuid)) order by s.id for share`,
    );
  return new Set(ids.rows.map((row) => row.id));
}
async function stableSources(tx: Tx, artifactId: string, lockedIds: ReadonlySet<string>) {
  const current = await tx.execute<{ id: string }>(
    sql`select id from knowledge.artifact_required_sources(${artifactId}::uuid) as required(id)`,
  );
  if (current.rows.some((row) => !lockedIds.has(row.id))) throw new AppError('VERSION_CONFLICT');
}

export async function advanceClientOnboarding(
  database: AppDatabase,
  context: TenantContext,
  deps: { agentRuns: AgentRuns },
  input: { onboardingId: string },
): Promise<OnboardingStep> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const onboardingId = id(input.onboardingId);
  const [snapshot] = await withTenantTx(database, context, (tx) =>
    tx.select().from(clientOnboardings).where(eq(clientOnboardings.id, onboardingId)),
  );
  if (!snapshot) throw new AppError('NOT_FOUND');
  if (terminal(snapshot.state)) return step(snapshot.state as OnboardingState);
  let actor: TenantContext;
  try {
    actor = await createDelegatedContext(
      database,
      context.organizationId,
      snapshot.requestedByMembershipId,
    );
  } catch {
    return fail(database, context, onboardingId, 'INITIATOR_UNAVAILABLE');
  }
  try {
    let candidate = snapshot.briefArtifactId;
    if (!candidate && snapshot.agentRunId) {
      const status = await withTenantTx(database, actor, (tx) =>
        deps.agentRuns.statusOf(tx, actor, snapshot.agentRunId!),
      );
      if (!status) throw new OnboardingFailure('AGENT_RUN_MISSING');
      identity(status, snapshot);
      if (status.status === 'completed') {
        if (!status.artifactIds || status.artifactIds.length !== 1)
          throw new OnboardingFailure('BRIEF_MISSING');
        candidate = id(status.artifactIds[0]!);
      }
    }
    return await withTenantTx(database, actor, async (tx) => {
      actor = await person(tx, actor);
      const sourceIds = candidate ? await inputSources(tx, actor, candidate) : new Set<string>();
      let row = await locked(tx, onboardingId);
      if (terminal(row.state)) return step(row.state as OnboardingState);
      if (
        !row.ownerMembershipId ||
        !row.reviewerMembershipId ||
        !row.emailConnectionId ||
        !row.contactEmail ||
        !row.briefWorkUnitId ||
        !row.reviewWorkUnitId ||
        !row.sendWorkUnitId ||
        !row.parentObjectiveSha256 ||
        !row.briefObjectiveSha256 ||
        !row.reviewObjectiveSha256 ||
        !row.sendObjectiveSha256
      )
        throw new OnboardingFailure('LEGACY_STATE_UNAVAILABLE');
      try {
        await activePeople(tx, [
          row.ownerMembershipId,
          row.reviewerMembershipId,
          row.requestedByMembershipId,
        ]);
      } catch (error) {
        if (error instanceof AppError && error.code === 'NOT_FOUND')
          throw new OnboardingFailure('PARTICIPANT_UNAVAILABLE');
        throw error;
      }
      if (
        row.reviewerMembershipId === row.ownerMembershipId ||
        row.reviewerMembershipId === row.requestedByMembershipId
      )
        throw new OnboardingFailure('REVIEWER_UNAVAILABLE');
      const lockedWork = new Map<string, WorkRow>();
      for (const workId of [
        row.workUnitId,
        row.briefWorkUnitId,
        row.reviewWorkUnitId,
        row.sendWorkUnitId,
      ].sort())
        lockedWork.set(workId, await work(tx, actor, workId));
      const parent = lockedWork.get(row.workUnitId)!,
        brief = lockedWork.get(row.briefWorkUnitId)!,
        review = lockedWork.get(row.reviewWorkUnitId)!,
        send = lockedWork.get(row.sendWorkUnitId)!;
      if (candidate) {
        await tx.execute(sql`select knowledge.lock_artifact_catalog(${candidate}::uuid)`);
        await stableSources(tx, candidate, sourceIds);
      }
      if (parent.status === 'completed') throw new OnboardingFailure('WORK_CHANGED');
      for (const [item, pin] of [
        [parent, row.parentObjectiveSha256],
        [brief, row.briefObjectiveSha256],
        [review, row.reviewObjectiveSha256],
        [send, row.sendObjectiveSha256],
      ] as const)
        if (hash(item.objective ?? '') !== pin || ['cancelled', 'failed'].includes(item.status))
          throw new OnboardingFailure('WORK_CHANGED');
      if (
        brief.ownerMembershipId !== row.reviewerMembershipId ||
        review.ownerMembershipId !== row.reviewerMembershipId ||
        parent.ownerMembershipId !== row.ownerMembershipId ||
        send.ownerMembershipId !== row.ownerMembershipId
      )
        throw new OnboardingFailure('WORK_CHANGED');
      if (row.state === 'started') {
        await startWork(tx, actor, parent);
        if (brief.status === 'queued') await applyTransition(tx, actor, brief, 'ready');
        let requested;
        try {
          requested = await deps.agentRuns.requestRun(tx, actor, {
            workUnitId: brief.id,
            agentKey: 'client-brief',
            requestKey: row.id,
          });
        } catch {
          throw new OnboardingFailure('AGENT_UNAVAILABLE');
        }
        return step(
          (
            await move(tx, actor, row, 'waiting_for_brief', {
              agentRunId: id(requested.agentRunId),
            })
          ).state as OnboardingState,
        );
      }
      if (row.state === 'waiting_for_brief') {
        if (!row.agentRunId) throw new OnboardingFailure('AGENT_RUN_MISSING');
        const status = await deps.agentRuns.statusOf(tx, actor, row.agentRunId);
        if (!status) throw new OnboardingFailure('AGENT_RUN_MISSING');
        identity(status, row);
        if (status.status !== 'completed') {
          if (
            [
              'failed',
              'cancelled',
              'budget_exhausted',
              'policy_denied',
              'timed_out',
              'outcome_unverified',
            ].includes(status.status)
          )
            throw new OnboardingFailure('AGENT_FAILED');
          if (status.costMicros !== row.costMicros)
            await move(tx, actor, row, 'waiting_for_brief', {
              costMicros: status.costMicros,
            });
          return step('waiting_for_brief');
        }
        if (
          !candidate ||
          !status.artifactIds ||
          status.artifactIds.length !== 1 ||
          id(status.artifactIds[0]!) !== candidate
        )
          throw new AppError('VERSION_CONFLICT');
        const [file] = await tx
          .select({ file: artifactAclCatalog })
          .from(artifactWorkLinks)
          .innerJoin(
            artifactAclCatalog,
            eq(artifactAclCatalog.artifactId, artifactWorkLinks.artifactId),
          )
          .where(
            and(
              eq(artifactWorkLinks.workUnitId, brief.id),
              eq(artifactWorkLinks.artifactId, candidate),
              eq(artifactAclCatalog.alive, true),
            ),
          )
          .for('share', { of: [artifactAclCatalog] });
        if (!file) throw new OnboardingFailure('BRIEF_UNAVAILABLE');
        await stableSources(tx, candidate, sourceIds);
        for (const target of [parent.id, review.id])
          await tx
            .insert(workArtifacts)
            .values({
              organizationId: actor.organizationId,
              workUnitId: target,
              artifactId: candidate,
            })
            .onConflictDoNothing();
        return step(
          (
            await move(tx, actor, row, 'waiting_for_acceptance', {
              briefArtifactId: candidate,
              costMicros: status.costMicros,
            })
          ).state as OnboardingState,
        );
      }
      if (row.state === 'waiting_for_acceptance') {
        if (!candidate || candidate !== row.briefArtifactId) throw new AppError('VERSION_CONFLICT');
        await stableSources(tx, candidate, sourceIds);
        const proof = await tx.execute<{ id: string | null }>(
          sql`select knowledge.artifact_acceptance_id(${candidate}::uuid,${brief.id}::uuid) as id`,
        );
        if (!proof.rows[0]?.id) return step('waiting_for_acceptance');
        const [accepted] = await tx
          .select()
          .from(knowledgeArtifactVerifications)
          .where(eq(knowledgeArtifactVerifications.id, proof.rows[0].id));
        if (!accepted || accepted.decidedByMembershipId !== row.reviewerMembershipId)
          return step('waiting_for_acceptance');
        row = await move(tx, actor, row, 'waiting_for_acceptance', {
          acceptedVerificationId: accepted.id,
        });
        await completeWork(tx, actor, await work(tx, actor, brief.id));
        await completeWork(tx, actor, await work(tx, actor, review.id));
        await startWork(tx, actor, await work(tx, actor, send.id));
        const [client] = await tx
          .select()
          .from(clients)
          .where(eq(clients.id, row.clientId))
          .for('share');
        const [project] = await tx
          .select()
          .from(projects)
          .where(eq(projects.id, row.projectId))
          .for('share');
        if (!client || !project) throw new OnboardingFailure('CLIENT_UNAVAILABLE');
        if (
          !['public', 'internal'].includes(client.classification) ||
          send.classification === 'restricted'
        )
          throw new OnboardingFailure('CLIENT_CLASSIFICATION_CHANGED');
        const proposed = await proposeExternalActionInTx(tx, actor, {
          workUnitId: send.id,
          connectionId: row.emailConnectionId!,
          toolName: EMAIL_SEND_TOOL,
          toolVersion: EMAIL_SEND_VERSION,
          approverMembershipId: row.reviewerMembershipId!,
          payload: {
            to: [row.contactEmail!],
            subject: 'Welcome to your project',
            text_body: `Welcome to ${project.name}.\n\nYour onboarding for ${client.displayName} has a reviewed client brief. We are ready to begin the agreed work.\n`,
          },
        });
        return step(
          (
            await move(tx, actor, row, 'waiting_for_send', {
              emailExternalActionId: proposed.externalActionId,
              emailApprovalId: proposed.approvalId,
            })
          ).state as OnboardingState,
        );
      }
      if (!row.emailExternalActionId) throw new OnboardingFailure('EMAIL_INTENT_MISSING');
      const [action] = await tx
        .select()
        .from(externalActions)
        .where(eq(externalActions.id, row.emailExternalActionId))
        .for('share');
      if (
        !action ||
        action.workUnitId !== send.id ||
        action.connectionId !== row.emailConnectionId ||
        action.approvalId !== row.emailApprovalId
      )
        throw new OnboardingFailure('EMAIL_INTENT_INVALID');
      if (action.status === 'unknown')
        return step(
          (await move(tx, actor, row, 'unknown', { stateCode: 'EMAIL_OUTCOME_UNKNOWN' }))
            .state as OnboardingState,
        );
      if (!candidate || !row.acceptedVerificationId)
        throw new OnboardingFailure('BRIEF_ACCEPTANCE_CHANGED');
      await stableSources(tx, candidate, sourceIds);
      const freshAcceptance = await tx.execute<{ id: string | null }>(
        sql`select knowledge.artifact_acceptance_id(${candidate}::uuid,${brief.id}::uuid) as id`,
      );
      if (freshAcceptance.rows[0]?.id !== row.acceptedVerificationId)
        throw new OnboardingFailure('BRIEF_ACCEPTANCE_CHANGED');
      if (['failed', 'cancelled'].includes(action.status))
        throw new OnboardingFailure('EMAIL_FAILED');
      if (action.status !== 'sent') return step('waiting_for_send');
      const [receipt] = await tx
        .select()
        .from(externalActionReceipts)
        .where(
          and(
            eq(externalActionReceipts.externalActionId, action.id),
            eq(externalActionReceipts.outcome, 'sent'),
            eq(externalActionReceipts.requestHash, action.requestHash),
            inArray(externalActionReceipts.basis, ['provider', 'reconciliation']),
          ),
        )
        .limit(1);
      if (!receipt)
        return step(
          (await move(tx, actor, row, 'unknown', { stateCode: 'EMAIL_OUTCOME_UNVERIFIED' }))
            .state as OnboardingState,
        );
      await completeWork(tx, actor, await work(tx, actor, send.id));
      await completeWork(tx, actor, await work(tx, actor, parent.id));
      return step(
        (await move(tx, actor, row, 'completed', { stateCode: null })).state as OnboardingState,
      );
    });
  } catch (error) {
    if (error instanceof OnboardingFailure)
      return fail(database, context, onboardingId, error.code);
    throw error;
  }
}
