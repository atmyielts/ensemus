// Owned by the pulse slice (WORK-09). See docs/06-delivery/m7-slices.md and ADR-031 D4.
import {
  agentRuns,
  approvals,
  externalActions,
  memberships,
  withTenantTx,
  workUnits,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { processRuns, pulseSignalStates } from '@ensemus/database/product';
import {
  deriveSignals,
  parsePulseSignalKey,
  personalStateOf,
  snoozeEndIsAllowed,
  type PulseFacts,
  type PulseSignal,
} from '@ensemus/domain/pulse';
import { isOverdue, isTerminal, type WorkState } from '@ensemus/domain/work-unit';
import { and, asc, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { auditAction, loadReadable, visibleTo } from '../work';
import {
  PULSE_METADATA_LIMIT,
  type PulseMetadataPage,
  type PulseMetadataReaders,
} from './pulse-metadata';

export const PULSE_WORK_LIMIT = 200;
export const PULSE_RELATED_LIMIT = 200;
export type PulsePartial =
  'work' | 'approvals' | 'external_actions' | 'agent_runs' | 'process_runs';

export type PulseSignalView = PulseSignal & {
  personalState: 'open' | 'snoozed' | 'dismissed';
  snoozedUntil: Date | null;
  /** Enriched only after the same fresh viewer's Work authorization. No person label is included. */
  work: { id: string; title: string };
};

export type CompanyPulse = {
  generatedAt: Date;
  signals: readonly PulseSignalView[];
  /** Counts of what a viewer can read. No per-person number exists anywhere on this page. */
  summary: { openWork: number; overdue: number; waitingOnApproval: number; needsDecision: number };
  /** Parts that could not be read, so the page says so rather than showing false calm. */
  partial: readonly PulsePartial[];
};

function assertPerson(context: TenantContext) {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
}
async function freshPerson(tx: Tx, context: TenantContext): Promise<TenantContext> {
  const [member] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.id, context.membershipId),
        eq(memberships.userId, context.userId),
        eq(memberships.status, 'active'),
      ),
    )
    .for('share');
  if (!member) throw new AppError('FORBIDDEN');
  return { ...context, role: member.role };
}
type Target = NonNullable<ReturnType<typeof parsePulseSignalKey>>;
const isWorkKind = (kind: Target['kind']) => kind.startsWith('work_');

async function workForTarget(tx: Tx, context: TenantContext, target: Target): Promise<string> {
  if (isWorkKind(target.kind)) {
    await loadReadable(tx, context, target.id);
    return target.id;
  }
  const table = target.kind.startsWith('approval_')
    ? approvals
    : target.kind.startsWith('external_action_')
      ? externalActions
      : target.kind === 'process_run_failed'
        ? processRuns
        : agentRuns;
  // Fixed branches, not a user-supplied table/column name.
  const linkedWork =
    table === processRuns
      ? processRuns.rootWorkUnitId
      : table === approvals
        ? approvals.workUnitId
        : table === externalActions
          ? externalActions.workUnitId
          : agentRuns.workUnitId;
  let row: { workId: string } | undefined;
  try {
    [row] = await tx
      .select({ workId: workUnits.id })
      .from(table)
      .innerJoin(
        workUnits,
        and(eq(workUnits.organizationId, table.organizationId), eq(workUnits.id, linkedWork)),
      )
      .where(
        and(
          eq(table.id, target.id),
          visibleTo(context),
          sql`knowledge.can_read_work(${workUnits.id},${context.membershipId}::uuid)`,
        ),
      )
      .limit(1);
  } catch (error) {
    if (
      pgCode(error) === '42P01' &&
      (target.kind === 'agent_run_stopped' || target.kind === 'process_run_failed')
    )
      throw new AppError('CAPABILITY_UNAVAILABLE');
    throw error;
  }
  if (!row) throw new AppError('NOT_FOUND');
  return row.workId;
}

async function optionalMetadata<Row>(
  tx: Tx,
  partial: Set<PulsePartial>,
  part: PulsePartial,
  read: (savepoint: Tx) => Promise<PulseMetadataPage<Row>>,
): Promise<readonly Row[]> {
  try {
    const page = await tx.transaction((savepoint) => read(savepoint));
    if (page.hasMore) partial.add(part);
    return page.items;
  } catch (error) {
    if (
      (error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE') ||
      pgCode(error) === '42P01'
    ) {
      partial.add(part);
      return [];
    }
    throw error;
  }
}

async function readProjection(
  tx: Tx,
  context: TenantContext,
  readers: PulseMetadataReaders,
  target?: { signal: Target; workId: string },
) {
  const partial = new Set<PulsePartial>();
  const rows = await tx
    .select({
      id: workUnits.id,
      title: workUnits.title,
      status: workUnits.status,
      dueAt: workUnits.dueAt,
      updatedAt: workUnits.updatedAt,
      projectId: sql<
        string | null
      >`case when knowledge.structured_record_readable('project',${workUnits.projectId},${context.membershipId}::uuid) then ${workUnits.projectId} else null end`,
      clientId: sql<
        string | null
      >`(select case when knowledge.structured_record_readable('project',p.id,${context.membershipId}::uuid)
      and knowledge.structured_record_readable('client',p.client_id,${context.membershipId}::uuid) then p.client_id else null end
      from work.projects p where p.organization_id=${workUnits.organizationId} and p.id=${workUnits.projectId})`,
      ownerDisabled: sql<boolean>`exists(select 1 from org.memberships owner where owner.organization_id=${workUnits.organizationId}
      and owner.id=${workUnits.ownerMembershipId} and owner.status='disabled')`,
      blockedByPrerequisite: sql<boolean>`exists(select 1 from work.work_dependencies d join work.work_units prerequisite
      on prerequisite.organization_id=d.organization_id and prerequisite.id=d.prerequisite_id
      where d.organization_id=${workUnits.organizationId} and d.dependent_id=${workUnits.id}
        and prerequisite.status<>'completed' and knowledge.can_read_work(prerequisite.id,${context.membershipId}::uuid))`,
    })
    .from(workUnits)
    .where(
      and(
        visibleTo(context),
        sql`knowledge.can_read_work(${workUnits.id},${context.membershipId}::uuid)`,
        target
          ? eq(workUnits.id, target.workId)
          : or(
              notInArray(workUnits.status, ['completed', 'cancelled']),
              sql`exists(select 1 from integrations.external_actions a where a.organization_id=${workUnits.organizationId} and a.work_unit_id=${workUnits.id} and a.status='unknown')`,
            ),
      ),
    )
    .orderBy(sql`${workUnits.dueAt} asc nulls last`, asc(workUnits.id))
    .limit(PULSE_WORK_LIMIT + 1)
    .for('share');
  if (rows.length > PULSE_WORK_LIMIT) partial.add('work');
  const selected = rows.slice(0, PULSE_WORK_LIMIT),
    ids = selected.map((item) => item.id);
  const openIds = selected
    .filter((item) => !isTerminal(item.status as WorkState))
    .map((item) => item.id);
  const want = (kind: string) => !target || target.signal.kind.startsWith(kind);
  const approvalRows =
    openIds.length && want('approval_')
      ? await tx
          .select({
            id: approvals.id,
            workUnitId: approvals.workUnitId,
            expiresAt: approvals.expiresAt,
            createdAt: approvals.createdAt,
          })
          .from(approvals)
          .where(
            and(
              inArray(approvals.workUnitId, openIds),
              eq(approvals.status, 'pending'),
              sql`${approvals.expiresAt}>clock_timestamp()`,
              target ? eq(approvals.id, target.signal.id) : undefined,
            ),
          )
          .orderBy(asc(approvals.expiresAt), asc(approvals.id))
          .limit(PULSE_RELATED_LIMIT + 1)
      : [];
  if (approvalRows.length > PULSE_RELATED_LIMIT) partial.add('approvals');
  const actionRows =
    ids.length && want('external_action_')
      ? await tx
          .select({
            id: externalActions.id,
            workUnitId: externalActions.workUnitId,
            status: externalActions.status,
            updatedAt: externalActions.updatedAt,
          })
          .from(externalActions)
          .where(
            and(
              inArray(externalActions.workUnitId, ids),
              or(
                eq(externalActions.status, 'unknown'),
                and(
                  eq(externalActions.status, 'failed'),
                  inArray(externalActions.workUnitId, openIds),
                ),
              ),
              target ? eq(externalActions.id, target.signal.id) : undefined,
            ),
          )
          .orderBy(asc(externalActions.updatedAt), asc(externalActions.id))
          .limit(PULSE_RELATED_LIMIT + 1)
      : [];
  if (actionRows.length > PULSE_RELATED_LIMIT) partial.add('external_actions');
  const metadataInput = {
    workIds: openIds,
    limit: PULSE_METADATA_LIMIT,
    ...(target ? { recordId: target.signal.id } : {}),
  };
  const agents = want('agent_run_')
    ? await optionalMetadata(tx, partial, 'agent_runs', (savepoint) =>
        readers.stoppedAgentRuns(savepoint, context, metadataInput),
      )
    : [];
  const processes = want('process_run_')
    ? await optionalMetadata(tx, partial, 'process_runs', (savepoint) =>
        readers.failedProcessRuns(savepoint, context, metadataInput),
      )
    : [];
  const time = await tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  const rawNow = time.rows[0]?.now;
  const now = rawNow instanceof Date ? new Date(rawNow.getTime()) : new Date(rawNow ?? NaN);
  if (!Number.isFinite(now.getTime())) throw new Error('PULSE_CLOCK_UNAVAILABLE');
  const pending = approvalRows.slice(0, PULSE_RELATED_LIMIT).filter((item) => item.expiresAt > now);
  const facts: PulseFacts = {
    now,
    work: selected,
    approvals: pending,
    externalActions: actionRows
      .slice(0, PULSE_RELATED_LIMIT)
      .map((item) => ({ ...item, status: item.status as 'unknown' | 'failed' })),
    agentRuns: agents,
    processRuns: processes,
  };
  return { facts, work: selected, partial };
}

/**
 * A read projection, computed on each read from what the viewer may see. Nothing is stored but a person's
 * own dismissals. Each read is bounded. A port that is unavailable makes that part `partial`, never empty.
 */
export async function getCompanyPulse(
  database: AppDatabase,
  context: TenantContext,
  readers: PulseMetadataReaders,
  input: { includeDismissed?: boolean } = {},
): Promise<CompanyPulse> {
  assertPerson(context);
  return withTenantTx(database, context, async (tx) => {
    const actor = await freshPerson(tx, context);
    const projection = await readProjection(tx, actor, readers);
    const derived = deriveSignals(projection.facts);
    const states = derived.length
      ? await tx
          .select()
          .from(pulseSignalStates)
          .where(
            and(
              eq(pulseSignalStates.membershipId, actor.membershipId),
              inArray(
                pulseSignalStates.signalKey,
                derived.map((signal) => signal.key),
              ),
            ),
          )
      : [];
    const stateByKey = new Map(states.map((row) => [row.signalKey, row]));
    const workById = new Map(projection.work.map((item) => [item.id, item]));
    const signals: PulseSignalView[] = derived
      .map((signal) => {
        const linked = signal.evidence.find((item) => item.kind === 'work_unit');
        const work = linked ? workById.get(linked.id) : undefined;
        if (!work) throw new Error('PULSE_WORK_EVIDENCE_MISSING');
        return {
          ...signal,
          ...personalStateOf(stateByKey.get(signal.key), projection.facts.now),
          work: { id: work.id, title: work.title },
        };
      })
      .filter((signal) => input.includeDismissed || signal.personalState !== 'dismissed');
    const openWork = projection.work.filter((item) => !isTerminal(item.status as WorkState));
    return {
      generatedAt: projection.facts.now,
      signals,
      summary: {
        openWork: openWork.length,
        overdue: openWork.filter((item) => isOverdue(item.dueAt, projection.facts.now)).length,
        waitingOnApproval: projection.facts.approvals.length,
        needsDecision: signals.filter(
          (item) => item.personalState === 'open' && item.severity === 'attention',
        ).length,
      },
      partial: [...projection.partial].sort(),
    };
  });
}

/** Focused fresh evidence read, independent of the bounded overview's position. No hidden/latest winner. */
export async function getPulseSignal(
  database: AppDatabase,
  context: TenantContext,
  readers: PulseMetadataReaders,
  rawKey: string,
): Promise<PulseSignalView> {
  assertPerson(context);
  const parsed = parsePulseSignalKey(rawKey);
  if (!parsed) throw new AppError('NOT_FOUND');
  return withTenantTx(database, context, async (tx) => {
    const actor = await freshPerson(tx, context);
    const workId = await workForTarget(tx, actor, parsed);
    const projection = await readProjection(tx, actor, readers, { signal: parsed, workId });
    if (projection.partial.has('agent_runs') || projection.partial.has('process_runs'))
      throw new AppError('CAPABILITY_UNAVAILABLE');
    const key = `${parsed.kind}:${parsed.id}`;
    const signal = deriveSignals(projection.facts).find((candidate) => candidate.key === key);
    const work = projection.work.find((candidate) => candidate.id === workId);
    if (!signal || !work) throw new AppError('NOT_FOUND');
    const [state] = await tx
      .select()
      .from(pulseSignalStates)
      .where(
        and(
          eq(pulseSignalStates.membershipId, actor.membershipId),
          eq(pulseSignalStates.signalKey, key),
        ),
      );
    return {
      ...signal,
      ...personalStateOf(state, projection.facts.now),
      work: { id: work.id, title: work.title },
    };
  });
}

/** The viewer's own, and nobody else's. The signal's key has to be one they can currently see. */
export async function setPulseSignalState(
  database: AppDatabase,
  context: TenantContext,
  readers: PulseMetadataReaders,
  input: { signalKey: string; state: 'dismissed' | 'snoozed' | 'open'; until?: Date },
): Promise<void> {
  assertPerson(context);
  const parsed = parsePulseSignalKey(input.signalKey);
  if (!parsed) throw new AppError('NOT_FOUND');
  if (
    !['open', 'dismissed', 'snoozed'].includes(input.state) ||
    (input.state === 'snoozed') !== (input.until !== undefined)
  )
    throw new AppError('INVALID_INPUT');
  const key = `${parsed.kind}:${parsed.id}`;
  await withTenantTx(database, context, async (tx) => {
    const actor = await freshPerson(tx, context);
    const workId = await workForTarget(tx, actor, parsed);
    await loadReadable(tx, actor, workId, true);
    const projection = await readProjection(tx, actor, readers, { signal: parsed, workId });
    if (projection.partial.has('agent_runs') || projection.partial.has('process_runs'))
      throw new AppError('CAPABILITY_UNAVAILABLE');
    if (!deriveSignals(projection.facts).some((signal) => signal.key === key))
      throw new AppError('NOT_FOUND');
    if (
      input.state === 'snoozed' &&
      (!input.until || !snoozeEndIsAllowed(input.until, projection.facts.now))
    )
      throw new AppError('INVALID_INPUT');
    const [current] = await tx
      .select()
      .from(pulseSignalStates)
      .where(
        and(
          eq(pulseSignalStates.membershipId, actor.membershipId),
          eq(pulseSignalStates.signalKey, key),
        ),
      )
      .for('update');
    if (input.state === 'open') {
      if (!current) return;
      await tx
        .delete(pulseSignalStates)
        .where(
          and(
            eq(pulseSignalStates.membershipId, actor.membershipId),
            eq(pulseSignalStates.signalKey, key),
          ),
        );
    } else {
      const until = input.state === 'snoozed' ? input.until! : null;
      if (current?.state === input.state && current.until?.getTime() === until?.getTime()) return;
      await tx
        .insert(pulseSignalStates)
        .values({
          organizationId: actor.organizationId,
          membershipId: actor.membershipId,
          signalKey: key,
          state: input.state,
          until,
        })
        .onConflictDoUpdate({
          target: [
            pulseSignalStates.organizationId,
            pulseSignalStates.membershipId,
            pulseSignalStates.signalKey,
          ],
          set: { state: input.state, until, updatedAt: projection.facts.now },
        });
    }
    await auditAction(tx, actor, 'pulse_signal.state_changed', `pulse_signal:${key}`);
  });
}
