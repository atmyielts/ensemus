// A preview is private data. Confirming it creates Work; it never starts execution.
import { createHash } from 'node:crypto';
import { memberships, type AppDatabase, type TenantContext, type Tx } from '@ensemus/database';
import { outcomeDrafts } from '@ensemus/database/product';
import { composeOutcomeSchema, outcomePreviewSchema } from '@ensemus/contracts/experience';
import { canonicalJson } from '@ensemus/domain/approval';
import {
  isComposerDate,
  parseObjective,
  objectiveDataAccess,
  type OutcomePreview,
} from '@ensemus/domain/outcome-composer';
import { AGGREGATE_OUTCOME_DRAFT, OUTCOME_AUTHORIZED } from '@ensemus/domain/product-events';
import { BUNDLED_WORKFLOWS } from '@ensemus/packs/bundled';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { canonicalId, idSchema } from '../ids';
import { emit } from '../events';
import { addDependency, auditAction, createWorkUnitInTx, loadReadable } from '../work';
import { databaseInTransaction } from '../transaction-database';
import { experiencePerson, withExperienceTx } from './experience-authority';

type Row = typeof outcomeDrafts.$inferSelect;
export type OutcomeDraftView = {
  id: string;
  objective: string;
  preview: OutcomePreview;
  previewSha256: string;
  status: 'draft' | 'authorized' | 'discarded';
  workUnitId: string | null;
  version: number;
  updatedAt: Date;
};
const hash = (canonical: string) => createHash('sha256').update(canonical).digest('hex');
const identifier = (raw: string) => {
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
};
const version = (actual: number, submitted: number) => {
  if (!Number.isSafeInteger(submitted) || submitted < 1) throw new AppError('INVALID_INPUT');
  if (actual !== submitted) throw new AppError('VERSION_CONFLICT');
};
const storable = (text: string) => !text.includes('\0') && !/\p{Cs}/u.test(text);
function bound(row: Row): OutcomePreview {
  const parsed = outcomePreviewSchema.safeParse(row.preview);
  if (
    !parsed.success ||
    !row.previewCanonical ||
    canonicalJson(parsed.data) !== row.previewCanonical ||
    hash(row.previewCanonical) !== row.previewSha256
  )
    throw new AppError('INVALID_STATE');
  return parsed.data;
}
const view = (row: Row): OutcomeDraftView => ({
  id: row.id,
  objective: row.objective,
  preview: bound(row),
  previewSha256: row.previewSha256,
  status: row.status as OutcomeDraftView['status'],
  workUnitId: row.workUnitId,
  version: row.version,
  updatedAt: row.updatedAt,
});
async function own(tx: Tx, context: TenantContext, draftId: string, lock = false) {
  const query = tx
    .select()
    .from(outcomeDrafts)
    .where(
      and(
        eq(outcomeDrafts.organizationId, context.organizationId),
        eq(outcomeDrafts.id, identifier(draftId)),
        eq(outcomeDrafts.createdByMembershipId, context.membershipId),
      ),
    );
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new AppError('NOT_FOUND');
  bound(row);
  return row;
}

/** Labels are explicit human checks; the kernel checks only the supported attachment/review predicates. */
export function outcomeWorkObjective(preview: OutcomePreview): string {
  return (
    preview.objective +
    (preview.successCriteria.length
      ? '\n\nSuccess requirements (checked by a person):\n' +
        preview.successCriteria
          .map(
            (c) =>
              '- ' +
              c.label +
              (c.kind === 'artifact_named'
                ? ' [File attached; a person checks the requested name and content]'
                : ''),
          )
          .join('\n')
      : '')
  );
}
function criteria(preview: OutcomePreview) {
  return [
    ...new Set(
      preview.successCriteria.flatMap((c) =>
        c.kind === 'artifact_named'
          ? ['artifact_exists' as const]
          : c.kind === 'reviewer_approved'
            ? ['reviewer_approved' as const]
            : [],
      ),
    ),
  ]
    .sort()
    .map((kind) => ({ kind }));
}
async function references(tx: Tx, context: TenantContext, preview: OutcomePreview) {
  const [owner] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, context.organizationId),
        eq(memberships.id, preview.ownerMembershipId),
        eq(memberships.status, 'active'),
      ),
    )
    .for('share');
  if (!owner) throw new AppError('NOT_FOUND');
  for (const workId of [...preview.dependencyWorkUnitIds].sort())
    await loadReadable(tx, context, workId);
}
function normalizedPreview(raw: OutcomePreview): OutcomePreview {
  const parsed = outcomePreviewSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const p = parsed.data;
  if (
    !storable(p.title) ||
    !storable(p.objective) ||
    p.successCriteria.some((c) => !storable(c.label)) ||
    (p.dueAt !== null && !isComposerDate(p.dueAt))
  )
    throw new AppError('INVALID_INPUT');
  const bundle =
    p.suggestedProcessKey === null
      ? undefined
      : BUNDLED_WORKFLOWS.find((b) => b.key === p.suggestedProcessKey);
  if (p.suggestedProcessKey !== null && !bundle) throw new AppError('INVALID_INPUT');
  const suggested = objectiveDataAccess(p.objective);
  const usesAgent =
    suggested.usesAgent || !!bundle?.graph.nodes.some((n) => n.kind === 'agent_task');
  const reachesExternalService =
    suggested.reachesExternalService ||
    !!bundle?.graph.nodes.some((n) => n.kind === 'external_action');
  return {
    ...p,
    ownerMembershipId: canonicalId(p.ownerMembershipId),
    dependencyWorkUnitIds: [...new Set(p.dependencyWorkUnitIds.map(canonicalId))].sort(),
    dataAccess: {
      usesAgent,
      reachesExternalService,
      reasonCodes: [
        'NOT_STARTED',
        ...(usesAgent ? ['ASSISTANT_MENTIONED'] : []),
        ...(reachesExternalService ? ['EXTERNAL_ACTION_MENTIONED'] : []),
        ...(bundle ? ['CATALOG_WORKFLOW_SUGGESTED'] : []),
      ],
    },
    uncertainties: [
      ...(p.dueAt === null ? ['due_date_unclear' as const] : []),
      ...(p.successCriteria.every((c) => c.kind === 'none')
        ? ['no_success_criteria' as const]
        : []),
    ],
  };
}

export function composeOutcome(
  database: AppDatabase,
  context: TenantContext,
  input: { objective: string; today: string },
): Promise<OutcomeDraftView> {
  const parsed = composeOutcomeSchema.safeParse(input);
  if (!parsed.success || !storable(parsed.data.objective) || !isComposerDate(parsed.data.today))
    return Promise.reject(new AppError('INVALID_INPUT'));
  return withExperienceTx(database, context, async (tx) => {
    const actor = await experiencePerson(tx, context);
    const initial = parseObjective(parsed.data.objective, {
      now: new Date(),
      today: parsed.data.today,
      defaultOwnerMembershipId: actor.membershipId,
      catalog: BUNDLED_WORKFLOWS.map((b) => ({ processKey: b.key, keywords: b.keywords })),
    });
    const preview = { ...normalizedPreview(initial), uncertainties: initial.uncertainties },
      canonical = canonicalJson(preview);
    const [row] = await tx
      .insert(outcomeDrafts)
      .values({
        organizationId: actor.organizationId,
        objective: parsed.data.objective,
        preview,
        previewCanonical: canonical,
        previewSha256: hash(canonical),
        createdByMembershipId: actor.membershipId,
      })
      .returning();
    if (!row) throw new AppError('INVALID_STATE');
    await auditAction(tx, actor, 'outcome.composed', `outcome_draft:${row.id}`);
    return view(row);
  });
}
export function getOutcomeDraft(
  database: AppDatabase,
  context: TenantContext,
  draftId: string,
): Promise<OutcomeDraftView> {
  return withExperienceTx(database, context, async (tx) => {
    const actor = await experiencePerson(tx, context);
    return view(await own(tx, actor, draftId));
  });
}
export function listMyOutcomeDrafts(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly OutcomeDraftView[]> {
  return withExperienceTx(database, context, async (tx) => {
    const actor = await experiencePerson(tx, context);
    return (
      await tx
        .select()
        .from(outcomeDrafts)
        .where(
          and(
            eq(outcomeDrafts.organizationId, actor.organizationId),
            eq(outcomeDrafts.createdByMembershipId, actor.membershipId),
          ),
        )
        .orderBy(desc(outcomeDrafts.updatedAt), desc(outcomeDrafts.id))
        .limit(100)
    ).map(view);
  });
}
export function reviseOutcomeDraft(
  database: AppDatabase,
  context: TenantContext,
  input: { draftId: string; expectedVersion: number; preview: OutcomePreview },
): Promise<OutcomeDraftView> {
  return withExperienceTx(database, context, async (tx) => {
    const actor = await experiencePerson(tx, context),
      row = await own(tx, actor, input.draftId, true);
    if (row.status !== 'draft') throw new AppError('INVALID_STATE');
    version(row.version, input.expectedVersion);
    const preview = normalizedPreview(input.preview);
    await references(tx, actor, preview);
    const canonical = canonicalJson(preview);
    if (canonical === row.previewCanonical) return view(row);
    const [saved] = await tx
      .update(outcomeDrafts)
      .set({
        preview,
        previewCanonical: canonical,
        previewSha256: hash(canonical),
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(outcomeDrafts.id, row.id))
      .returning();
    if (!saved) throw new AppError('VERSION_CONFLICT');
    await auditAction(tx, actor, 'outcome.revised', `outcome_draft:${row.id}`);
    return view(saved);
  });
}
export function authorizeOutcome(
  database: AppDatabase,
  context: TenantContext,
  input: { draftId: string; expectedVersion: number; previewSha256: string },
): Promise<{ workUnitId: string }> {
  if (
    !/^[0-9a-f]{64}$/.test(input.previewSha256) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  )
    return Promise.reject(new AppError('INVALID_INPUT'));
  return withExperienceTx(database, context, async (tx) => {
    const actor = await experiencePerson(tx, context),
      row = await own(tx, actor, input.draftId, true);
    if (row.previewSha256 !== input.previewSha256) throw new AppError('OUTCOME_CHANGED');
    if (row.status === 'authorized' && row.workUnitId) {
      if (![row.version, row.version - 1].includes(input.expectedVersion))
        throw new AppError('VERSION_CONFLICT');
      await loadReadable(tx, actor, row.workUnitId);
      return { workUnitId: row.workUnitId };
    }
    if (row.status !== 'draft') throw new AppError('INVALID_STATE');
    version(row.version, input.expectedVersion);
    const preview = bound(row);
    await references(tx, actor, preview);
    const previous = await tx.execute<{ scope: string | null }>(
      sql`select current_setting('app.outcome_draft_id',true) as scope`,
    );
    await tx.execute(sql`select set_config('app.outcome_draft_id',${row.id},true)`);
    let work: Awaited<ReturnType<typeof createWorkUnitInTx>>;
    try {
      work = await createWorkUnitInTx(tx, actor, {
        title: preview.title,
        objective: outcomeWorkObjective(preview),
        ownerMembershipId: preview.ownerMembershipId,
        classification: preview.classification,
        ...(preview.dueAt ? { dueAt: new Date(preview.dueAt + 'T00:00:00.000Z') } : {}),
        completionCriteria: criteria(preview),
        requestKey: row.id,
      });
    } catch (error) {
      await tx
        .execute(
          sql`select set_config('app.outcome_draft_id',${previous.rows[0]?.scope ?? ''},true)`,
        )
        .catch(() => undefined);
      throw error;
    }
    await tx.execute(
      sql`select set_config('app.outcome_draft_id',${previous.rows[0]?.scope ?? ''},true)`,
    );
    const joined = databaseInTransaction(tx);
    for (const prerequisiteId of preview.dependencyWorkUnitIds)
      await addDependency(joined, actor, { dependentId: work.id, prerequisiteId });
    const actual = await loadReadable(tx, actor, work.id);
    await tx
      .update(outcomeDrafts)
      .set({
        status: 'authorized',
        workUnitId: work.id,
        authorizedWorkVersion: actual.version,
        authorizedByMembershipId: actor.membershipId,
        authorizedAt: new Date(),
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(outcomeDrafts.id, row.id));
    await emit(tx, actor, {
      eventType: OUTCOME_AUTHORIZED,
      aggregateType: AGGREGATE_OUTCOME_DRAFT,
      aggregateId: row.id,
      aggregateVersion: row.version + 1,
      classification: preview.classification,
      payload: { draft_id: row.id, work_unit_id: work.id },
    });
    await auditAction(tx, actor, 'outcome.authorized', `outcome_draft:${row.id}`);
    return { workUnitId: work.id };
  });
}
export function discardOutcome(
  database: AppDatabase,
  context: TenantContext,
  input: { draftId: string; expectedVersion: number },
): Promise<void> {
  return withExperienceTx(database, context, async (tx) => {
    const actor = await experiencePerson(tx, context),
      row = await own(tx, actor, input.draftId, true);
    if (
      row.status === 'discarded' &&
      [row.version, row.version - 1].includes(input.expectedVersion)
    )
      return;
    if (row.status !== 'draft') throw new AppError('INVALID_STATE');
    version(row.version, input.expectedVersion);
    await tx
      .update(outcomeDrafts)
      .set({ status: 'discarded', version: row.version + 1, updatedAt: new Date() })
      .where(eq(outcomeDrafts.id, row.id));
    await auditAction(tx, actor, 'outcome.discarded', `outcome_draft:${row.id}`);
  });
}
