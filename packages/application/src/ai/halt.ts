// The kill switch (SEC-06, ADR-028 FD-15, incident doc section 5). Two halves: the check that runs in the
// same transaction as whatever it guards, and the services a person with `ai.halt` uses. A global or
// provider stop has no tenant, so only the operator's command writes one (`@ensemus/database/halt-operator`).
// Everything here is read in PostgreSQL at the moment it matters: a stop that was committed and whose
// wake-up never arrived still stops the next effect. Only people touch a switch, never an agent.
import { engageKillSwitchSchema, type EngageKillSwitch } from '@ensemus/contracts/ai';
import {
  agentDefinitions,
  agentRuns,
  agentVersions,
  appendAudit,
  killSwitches,
  modelProfiles,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { KILL_SWITCH_SCOPES, type KillSwitchScope } from '@ensemus/domain/ai';
import { KILL_SWITCH_ENGAGED, KILL_SWITCH_RELEASED } from '@ensemus/domain/ai-events';
import { can } from '@ensemus/domain/policy';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { AppError, foreignReference } from '../errors';
import { emit } from '../events';
import { canonicalId, idSchema } from '../ids';
import type { HaltCheck } from './ports';

const AGGREGATE_KILL_SWITCH = 'kill_switch';

/** A switch still in force. `scope` stays text, because a row may hold one this code has never met. */
export type LiveSwitch = {
  organizationId: string | null;
  scope: string;
  targetRef: string | null;
};

/** What is about to act. Whatever is unknown yet is left out: a run has no provider until its first turn. */
export type SwitchTarget = {
  agentVersionId?: string;
  providerKind?: string;
};

/** The error a stop is reported with. It says nothing of why, so it is safe anywhere. */
export const haltedError = () => new AppError('AI_HALTED');

const isKnownScope = (scope: string): scope is KillSwitchScope =>
  (KILL_SWITCH_SCOPES as readonly string[]).includes(scope);

/**
 * Whether a switch stops this. Pure, so the watcher and the check agree. Anything it cannot make sense of
 * counts as covering, because a mistake here should stop an agent rather than let one carry on. `target_ref`
 * is text, so it is compared in one spelling and a capital letter cannot walk around a stop.
 */
export function switchCovers(
  row: LiveSwitch,
  organizationId: string,
  target: SwitchTarget,
): boolean {
  if (!isKnownScope(row.scope)) return true;
  const mine =
    row.organizationId !== null && canonicalId(row.organizationId) === canonicalId(organizationId);
  switch (row.scope) {
    case 'global':
      return true;
    case 'organization':
      return mine;
    case 'provider':
      return row.targetRef === null || row.targetRef === target.providerKind;
    case 'agent_version':
      if (!mine) return false;
      if (row.targetRef === null) return true;
      return (
        target.agentVersionId !== undefined &&
        canonicalId(row.targetRef) === canonicalId(target.agentVersionId)
      );
  }
}

/**
 * The switches this transaction can see: every operator's row and its own tenant's, by RLS. For a worker
 * that binds a tenant itself and wants the rows, like the watcher. A failure here reaches the caller, and
 * the caller must treat it as halted.
 */
export function readLiveSwitches(tx: Tx): Promise<readonly LiveSwitch[]> {
  return tx
    .select({
      organizationId: killSwitches.organizationId,
      scope: killSwitches.scope,
      targetRef: killSwitches.targetRef,
    })
    .from(killSwitches)
    .where(isNull(killSwitches.releasedAt));
}

/**
 * With no tenant bound, RLS hides this tenant's rows and the read would come back looking clear. So a
 * transaction bound to anything else is not a clear answer, it is no answer.
 */
async function assertBoundTo(tx: Tx, organizationId: string) {
  const { rows } = await tx.execute<{ organization_id: string | null }>(
    sql`select app.current_organization_id()::text as organization_id`,
  );
  const bound = rows[0]?.organization_id;
  if (!bound || canonicalId(bound) !== canonicalId(organizationId)) {
    throw new Error('Tenant not bound');
  }
}

/**
 * What an agent's own run says about it. A caller that forgets the agent version must still be stopped,
 * and a tool never names a provider, yet a stopped provider has to stop a run pinned to it.
 */
async function targetOfOwnRun(tx: Tx, context: TenantContext): Promise<SwitchTarget | null> {
  if (context.actorType !== 'agent') return null;
  if (!context.agentRunId) throw new Error('Agent context with no run');
  const [run] = await tx
    .select({
      agentVersionId: agentRuns.agentVersionId,
      providerKind: modelProfiles.providerKind,
    })
    .from(agentRuns)
    .leftJoin(
      modelProfiles,
      and(
        eq(modelProfiles.organizationId, agentRuns.organizationId),
        eq(modelProfiles.id, agentRuns.boundProfileId),
      ),
    )
    .where(eq(agentRuns.id, context.agentRunId));
  if (!run) throw new Error('Run not found');
  return {
    agentVersionId: run.agentVersionId,
    ...(run.providerKind ? { providerKind: run.providerKind } : {}),
  };
}

/**
 * The check before every model call and tool effect, and when claiming a queued run. It runs in the
 * caller's transaction, so what it reads and what it guards commit together. Any failure to read is
 * reported as a stop, and with no cause attached, since a driver's error can quote the query.
 */
export function createHaltCheck(): HaltCheck {
  return {
    async assertRunning(tx, context, target) {
      let covered: boolean;
      try {
        await assertBoundTo(tx, context.organizationId);
        const own = await targetOfOwnRun(tx, context);
        const targets: readonly SwitchTarget[] = own ? [target, own] : [target];
        const live = await readLiveSwitches(tx);
        covered = live.some((row) =>
          targets.some((each) => switchCovers(row, context.organizationId, each)),
        );
      } catch {
        throw haltedError();
      }
      if (covered) throw haltedError();
    },
  };
}

/**
 * Only a person, and only one who holds the capability. An agent carries its initiator's role, so without
 * the first check a model working for an owner could lift a stop placed on it.
 */
function requireHaltAuthority(context: TenantContext) {
  if (context.actorType !== 'user' || !can(context.role, 'ai.halt')) {
    throw new AppError('FORBIDDEN');
  }
}

function parseEngage(raw: unknown): EngageKillSwitch {
  const parsed = engageKillSwitchSchema.safeParse(raw);
  if (!parsed.success) {
    // A form never offers these. Someone wrote this request, so it is refused as a refusal, on the record.
    const scope = (raw as { scope?: unknown } | null)?.scope;
    if (scope === 'global' || scope === 'provider') throw new AppError('FORBIDDEN');
    throw new AppError('INVALID_INPUT');
  }
  if ((parsed.data.scope === 'agent_version') !== (parsed.data.target_ref !== null)) {
    throw new AppError('INVALID_INPUT');
  }
  return parsed.data;
}

/** Stops every agent in this tenant, or one agent version. Takes effect for the next check anywhere. */
export async function engageKillSwitch(
  database: AppDatabase,
  context: TenantContext,
  input: EngageKillSwitch,
): Promise<{ switchId: string }> {
  requireHaltAuthority(context);
  const { scope, target_ref: askedTarget, reason_code: reasonCode } = parseEngage(input);
  return withTenantTx(database, context, async (tx) => {
    let targetRef: string | null = null;
    if (askedTarget !== null) {
      // The row's own ID, in its own spelling: the trigger on attempts compares this as text.
      const [version] = await tx
        .select({ id: agentVersions.id })
        .from(agentVersions)
        .where(eq(agentVersions.id, canonicalId(askedTarget)));
      if (!version) throw foreignReference();
      targetRef = version.id;
    }
    const [row] = await tx
      .insert(killSwitches)
      .values({
        organizationId: context.organizationId,
        scope,
        targetRef,
        reasonCode,
        engagedByMembershipId: context.membershipId,
      })
      .returning({ id: killSwitches.id });
    if (!row) throw new Error('Insert returned nothing');
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: KILL_SWITCH_ENGAGED,
      targetRef: `kill_switch:${row.id}`,
      decision: 'allow',
      safeReason: reasonCode,
    });
    await emit(tx, context, {
      eventType: KILL_SWITCH_ENGAGED,
      aggregateType: AGGREGATE_KILL_SWITCH,
      aggregateId: row.id,
      aggregateVersion: 1,
      classification: 'internal',
      payload: { scope, targetRef, reasonCode },
    });
    return { switchId: row.id };
  });
}

/**
 * Lifts this tenant's own stop. An operator's stop can be seen and not lifted: trying is refused here with
 * its own words, and on the record, and RLS would refuse the write anyway. Pressing it twice is harmless.
 */
export async function releaseKillSwitch(
  database: AppDatabase,
  context: TenantContext,
  input: { switchId: string },
): Promise<void> {
  requireHaltAuthority(context);
  const parsed = idSchema.safeParse(input.switchId);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const switchId = parsed.data;
  const outcome = await withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .select({
        organizationId: killSwitches.organizationId,
        scope: killSwitches.scope,
        reasonCode: killSwitches.reasonCode,
      })
      .from(killSwitches)
      .where(eq(killSwitches.id, switchId));
    if (!row) return 'not_found' as const;
    if (row.organizationId === null) {
      await appendAudit(tx, {
        organizationId: context.organizationId,
        actorType: 'user',
        actorId: context.membershipId,
        action: 'kill_switch.release',
        targetRef: `kill_switch:${switchId}`,
        decision: 'deny',
        safeReason: 'KILL_SWITCH_NOT_YOURS',
      });
      return 'operator' as const;
    }
    // A row already released is left as it is. The trigger refuses taking back a release.
    const released = await tx
      .update(killSwitches)
      .set({ releasedAt: new Date(), releasedByMembershipId: context.membershipId })
      .where(and(eq(killSwitches.id, switchId), isNull(killSwitches.releasedAt)))
      .returning({ id: killSwitches.id });
    if (released.length > 0) {
      await appendAudit(tx, {
        organizationId: context.organizationId,
        actorType: 'user',
        actorId: context.membershipId,
        action: KILL_SWITCH_RELEASED,
        targetRef: `kill_switch:${switchId}`,
        decision: 'allow',
      });
      await emit(tx, context, {
        eventType: KILL_SWITCH_RELEASED,
        aggregateType: AGGREGATE_KILL_SWITCH,
        aggregateId: switchId,
        aggregateVersion: 2,
        classification: 'internal',
        payload: { scope: row.scope, reasonCode: row.reasonCode },
      });
    }
    return 'done' as const;
  });
  // After the transaction, so the record of the refusal above has committed.
  if (outcome === 'not_found') throw new AppError('NOT_FOUND');
  if (outcome === 'operator') throw new AppError('KILL_SWITCH_NOT_YOURS');
}

export type KillSwitchView = {
  id: string;
  scope: string;
  targetRef: string | null;
  reasonCode: string;
  engagedAt: Date;
  /** An operator's switch: this tenant can see it, and cannot release it. */
  operator: boolean;
};

/** The stops in force here: this tenant's own and the operator's. Another tenant's are not visible. */
export async function listKillSwitches(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly KillSwitchView[]> {
  requireHaltAuthority(context);
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: killSwitches.id,
        organizationId: killSwitches.organizationId,
        scope: killSwitches.scope,
        targetRef: killSwitches.targetRef,
        reasonCode: killSwitches.reasonCode,
        engagedAt: killSwitches.engagedAt,
      })
      .from(killSwitches)
      .where(isNull(killSwitches.releasedAt))
      .orderBy(desc(killSwitches.engagedAt)),
  );
  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    targetRef: row.targetRef ?? null,
    reasonCode: row.reasonCode,
    engagedAt: row.engagedAt,
    operator: row.organizationId === null,
  }));
}

export type HaltableAgentVersion = { id: string; name: string; versionNumber: number };

/** The versions a person can stop on their own, for the safety page's list. */
export async function listHaltableAgentVersions(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly HaltableAgentVersion[]> {
  requireHaltAuthority(context);
  return withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: agentVersions.id,
        name: agentDefinitions.name,
        versionNumber: agentVersions.versionNumber,
      })
      .from(agentVersions)
      .innerJoin(
        agentDefinitions,
        and(
          eq(agentDefinitions.organizationId, agentVersions.organizationId),
          eq(agentDefinitions.id, agentVersions.definitionId),
        ),
      )
      .orderBy(agentDefinitions.name, desc(agentVersions.versionNumber)),
  );
}
