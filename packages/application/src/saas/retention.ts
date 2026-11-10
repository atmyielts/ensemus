// Owned by the retention slice (LIFE-02). Rules apply per data class. Numbers come from legal sign-off, and
// there is not one in this code (docs/04-security/05-data-lifecycle.md §4). See ADR-032 D6.
import {
  artifacts,
  organizations,
  retentionCursors,
  retentionRules,
  retentionRuns,
  workArtifacts,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import {
  CATEGORIES_NOT_SWEPT,
  DATA_CATEGORIES,
  retentionCutoff,
  type DataCategory,
} from '@ensemus/saas/lifecycle';
import { RETENTION_RULE_SET } from '@ensemus/saas/events';
import { setRetentionRuleSchema } from '@ensemus/contracts/saas';
import { can } from '@ensemus/domain/policy';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, refusalFromDatabase } from '../errors';
import { idSchema } from '../ids';
import { auditAction } from '../work';
import { emit } from '../events';
import { deleteArtifactInTx } from '../artifacts';
import { isHeldInTx } from './legal-holds';
import { artifactRetentionAuthorityInTx } from './retention-authority';
import type { RetentionSource } from './ports';

const classifications = ['public', 'internal', 'confidential', 'restricted'] as const;
const manager = (context: TenantContext) => {
  if (context.actorType !== 'user' || !can(context.role, 'retention.manage'))
    throw new AppError('NOT_FOUND');
};
async function lockTenant(tx: Tx, context: TenantContext) {
  const [org] = await tx
    .select({ id: organizations.id, lifecycle: organizations.lifecycle })
    .from(organizations)
    .where(eq(organizations.id, context.organizationId))
    .for('no key update');
  if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
}

export type RetentionRuleView = {
  id: string;
  dataCategory: string;
  classification: string;
  retainDays: number | null;
  basisRef: string;
  setByMembershipId: string;
  createdAt: Date;
};

/** `retention.manage`. Current rules only, unless `history` asks for superseded ones as well. */
export async function listRetentionRules(
  database: AppDatabase,
  context: TenantContext,
  input: { history?: boolean },
): Promise<readonly RetentionRuleView[]> {
  manager(context);
  return withAccountTx(database, context, (tx) =>
    tx
      .select()
      .from(retentionRules)
      .where(input.history ? undefined : isNull(retentionRules.supersededAt))
      .orderBy(desc(retentionRules.createdAt), desc(retentionRules.id)),
  );
}

/**
 * `retention.manage`. `basisRef` is required, since a number with no sign-off is invented. Supersedes what was
 * there and writes the new rule in one transaction. Audited and emits RETENTION_RULE_SET. Refuses a category
 * in CATEGORIES_NOT_SWEPT if it names a number, because those are kept another way.
 */
export async function setRetentionRule(
  database: AppDatabase,
  context: TenantContext,
  input: {
    dataCategory: DataCategory;
    classification: string;
    retainDays: number | null;
    basisRef: string;
  },
): Promise<{ ruleId: string }> {
  manager(context);
  if (typeof input.basisRef !== 'string' || !input.basisRef.trim())
    throw new AppError('RETENTION_BASIS_REQUIRED');
  const parsed = setRetentionRuleSchema.safeParse({
    data_category: input.dataCategory,
    classification: input.classification,
    retain_days: input.retainDays,
    basis_ref: input.basisRef,
  });
  if (
    !parsed.success ||
    (CATEGORIES_NOT_SWEPT.includes(input.dataCategory) && input.retainDays !== null)
  )
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    await lockTenant(tx, context);
    await tx
      .update(retentionRules)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(retentionRules.dataCategory, parsed.data.data_category),
          eq(retentionRules.classification, parsed.data.classification),
          isNull(retentionRules.supersededAt),
        ),
      );
    const [rule] = await tx
      .insert(retentionRules)
      .values({
        organizationId: context.organizationId,
        dataCategory: parsed.data.data_category,
        classification: parsed.data.classification,
        retainDays: parsed.data.retain_days,
        basisRef: parsed.data.basis_ref,
        setByMembershipId: context.membershipId,
      })
      .returning();
    // The immutable rule ID is its version. A changed rule invalidates every class in this category.
    await tx
      .delete(retentionCursors)
      .where(eq(retentionCursors.dataCategory, parsed.data.data_category));
    await auditAction(tx, context, 'retention.rule_set', `retention_rule:${rule!.id}`);
    await emit(tx, context, {
      eventType: RETENTION_RULE_SET,
      aggregateType: 'retention_rule',
      aggregateId: rule!.id,
      aggregateVersion: 1,
      classification: 'internal',
      payload: { retention_rule_id: rule!.id, data_category: rule!.dataCategory },
    });
    return { ruleId: rule!.id };
  });
}

export type RetentionSweep = {
  category: string;
  examined: number;
  removed: number;
  held: number;
  more: boolean;
  outcomeCode?: string;
};

/**
 * Service only, one bounded page per category per call. A record under a hold stays, counted as `held` when the
 * database refuses it with LEGAL_HOLD_ACTIVE, and one refusal never stops the rest. Writes a run row each time.
 * A category with no rule is not touched.
 */
export async function sweepRetention(
  database: AppDatabase,
  context: TenantContext,
  sources: readonly RetentionSource[],
  input: { limit: number; now: Date },
): Promise<readonly RetentionSweep[]> {
  if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 1000 ||
    !Number.isFinite(input.now.getTime()) ||
    new Set(sources.map((source) => source.category)).size !== sources.length
  )
    throw new AppError('INVALID_INPUT');
  return withAccountTx(database, context, async (tx) => {
    await lockTenant(tx, context);
    const rules = await tx.select().from(retentionRules).where(isNull(retentionRules.supersededAt));
    const results: RetentionSweep[] = [];
    for (const category of DATA_CATEGORIES) {
      const current = rules.filter((rule) => rule.dataCategory === category);
      if (!current.length) continue;
      const result: RetentionSweep = { category, examined: 0, removed: 0, held: 0, more: false };
      const [run] = await tx
        .insert(retentionRuns)
        .values({ organizationId: context.organizationId, dataCategory: category })
        .returning({ id: retentionRuns.id });
      const source = sources.find((value) => value.category === category);
      let code: string | null = CATEGORIES_NOT_SWEPT.includes(category)
        ? 'RETAINED_BY_OTHER_MECHANISM'
        : !current.some((rule) => rule.retainDays !== null)
          ? 'RETAINED_INDEFINITELY'
          : !source
            ? 'RETENTION_SOURCE_NOT_WIRED'
            : !source.findExpiredPage
              ? 'RETENTION_SOURCE_NOT_PAGED'
              : null;
      if (!code && source?.findExpiredPage) {
        let remaining = input.limit,
          stopped = false,
          unavailable = false;
        const positions: (typeof retentionCursors.$inferSelect)[] = [];
        for (const classification of classifications) {
          const rule =
            current.find((value) => value.classification === classification) ??
            current.find((value) => value.classification === '*');
          const cutoff = retentionCutoff(current, category, classification, input.now);
          if (!rule || !cutoff) continue;
          let [position] = await tx
            .select()
            .from(retentionCursors)
            .where(
              and(
                eq(retentionCursors.dataCategory, category),
                eq(retentionCursors.classification, classification),
              ),
            )
            .for('update');
          if (position && position.ruleId !== rule.id) {
            await tx
              .delete(retentionCursors)
              .where(
                and(
                  eq(retentionCursors.dataCategory, category),
                  eq(retentionCursors.classification, classification),
                ),
              );
            position = undefined;
          }
          if (!position) {
            const inserted = await tx
              .insert(retentionCursors)
              .values({
                organizationId: context.organizationId,
                dataCategory: category,
                classification,
                ruleId: rule.id,
                cutoffAt: cutoff,
              })
              .returning();
            position = inserted[0]!;
          }
          if (!position.completed && remaining > 0 && !stopped) {
            let page: Awaited<ReturnType<NonNullable<RetentionSource['findExpiredPage']>>>;
            try {
              page = await tx.transaction((save) =>
                source.findExpiredPage!(save, context, {
                  before: position!.cutoffAt,
                  classification,
                  ruleId: rule.id,
                  limit: remaining,
                  after: position!.after,
                }),
              );
              if (
                page.records.length > remaining ||
                (page.more && page.records.length === 0) ||
                new Set(page.records.map((row) => row.id)).size !== page.records.length ||
                page.records.some(
                  (row) =>
                    !idSchema.safeParse(row.id).success ||
                    typeof row.cursor !== 'string' ||
                    !row.cursor ||
                    row.cursor.length > 4096 ||
                    row.cursor === position!.after,
                )
              )
                throw new AppError('INVALID_STATE');
            } catch {
              code = 'RETENTION_SOURCE_FAILED';
              stopped = true;
              unavailable = true;
              positions.push(position);
              continue;
            }
            let after = position.after,
              completed = page.records.length === 0 && !page.more;
            for (let index = 0; index < page.records.length; index++) {
              const record = page.records[index]!;
              result.examined += 1;
              remaining -= 1;
              try {
                await tx.transaction((save) =>
                  source.remove(save, context, idSchema.parse(record.id)),
                );
                result.removed += 1;
              } catch (error) {
                if (
                  (error instanceof AppError && error.code === 'LEGAL_HOLD_ACTIVE') ||
                  refusalFromDatabase(error)?.code === 'LEGAL_HOLD_ACTIVE'
                )
                  result.held += 1;
                else {
                  code = 'RETENTION_SOURCE_FAILED';
                  stopped = true;
                }
              }
              // Only examined records advance. A failed row is retried when this finite cycle ends.
              after = record.cursor;
              completed = index === page.records.length - 1 && !page.more;
              if (stopped) break;
            }
            const updated = await tx
              .update(retentionCursors)
              .set({ after, completed, version: position.version + 1, updatedAt: input.now })
              .where(
                and(
                  eq(retentionCursors.dataCategory, category),
                  eq(retentionCursors.classification, classification),
                  eq(retentionCursors.version, position.version),
                ),
              )
              .returning();
            if (!updated.length) throw new AppError('VERSION_CONFLICT');
            position = updated[0]!;
          }
          positions.push(position);
        }
        const complete = positions.every((position) => position.completed);
        if (complete)
          await tx.delete(retentionCursors).where(eq(retentionCursors.dataCategory, category));
        result.more = !complete && !unavailable;
      }
      code ??= result.held ? 'RETENTION_HELD' : 'RETENTION_COMPLETED';
      result.outcomeCode = code;
      await tx
        .update(retentionRuns)
        .set({
          examined: result.examined,
          removed: result.removed,
          held: result.held,
          outcomeCode: code,
          finishedAt: new Date(),
        })
        .where(eq(retentionRuns.id, run!.id));
      results.push(result);
    }
    return results;
  });
}

/**
 * The source for `raw_files`, the one category M8 itself can sweep today, over the existing tombstone and
 * ledger path (LIFE-01). Other milestones add theirs at the final merge.
 */
export function createRawFilesRetentionSource(_store: unknown): RetentionSource {
  const cursorSchema = z.strictObject({
    v: z.literal(1),
    organizationId: idSchema,
    classification: z.enum(classifications),
    ruleId: idSchema,
    before: z.iso.datetime({ offset: true }),
    at: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/),
    id: idSchema,
  });
  const source: RetentionSource = {
    category: 'raw_files',
    async findExpired(tx, context, input) {
      return (
        await source.findExpiredPage!(tx, context, {
          ...input,
          ruleId: context.organizationId,
          after: null,
        })
      ).records.map((row) => row.id);
    },
    async findExpiredPage(tx, context, input) {
      let after: z.infer<typeof cursorSchema> | null = null;
      if (input.after) {
        try {
          if (input.after.length > 4096) throw new Error('INVALID_CURSOR');
          after = cursorSchema.parse(
            JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8')),
          );
          if (
            after.organizationId !== context.organizationId ||
            after.classification !== input.classification ||
            after.ruleId !== input.ruleId ||
            after.before !== input.before.toISOString()
          )
            throw new Error('INVALID_CURSOR');
        } catch (error) {
          const refusal = new AppError('INVALID_INPUT');
          refusal.cause = error;
          throw refusal;
        }
      }
      const result = await tx.execute(
        sql`select a.id,to_char(a.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from work.artifacts a where a.organization_id=${context.organizationId}::uuid and a.classification=${input.classification} and a.created_at<${input.before.toISOString()}::timestamptz and not exists(select 1 from platform.tombstones t where t.organization_id=a.organization_id and t.target_type='artifact' and t.target_id=a.id) ${after ? sql`and (a.created_at,a.id)>(${after.at}::timestamptz,${after.id}::uuid)` : sql``} order by a.created_at,a.id limit ${input.limit + 1}`,
      );
      const rows = result.rows as { id: string; at: string }[];
      return {
        records: rows.slice(0, input.limit).map((row) => ({
          id: row.id,
          cursor: Buffer.from(
            JSON.stringify({
              v: 1,
              organizationId: context.organizationId,
              classification: input.classification,
              ruleId: input.ruleId,
              before: input.before.toISOString(),
              at: row.at,
              id: row.id,
            }),
          ).toString('base64url'),
        })),
        more: rows.length > input.limit,
      };
    },
    async remove(tx, context, id) {
      if (context.actorType !== 'service') throw new AppError('NOT_FOUND');
      if (await isHeldInTx(tx, context, { type: 'artifact', id }))
        throw new AppError('LEGAL_HOLD_ACTIVE');
      const [link] = await tx
        .select({ workUnitId: workArtifacts.workUnitId })
        .from(workArtifacts)
        .innerJoin(artifacts, eq(artifacts.id, workArtifacts.artifactId))
        .where(and(eq(artifacts.organizationId, context.organizationId), eq(artifacts.id, id)))
        .orderBy(asc(workArtifacts.workUnitId))
        .limit(1);
      if (!link) throw new AppError('NOT_FOUND');
      const [position] = await tx
        .select({ ruleId: retentionCursors.ruleId, cutoff: retentionCursors.cutoffAt })
        .from(retentionCursors)
        .innerJoin(
          artifacts,
          and(
            eq(artifacts.organizationId, retentionCursors.organizationId),
            eq(artifacts.classification, retentionCursors.classification),
          ),
        )
        .where(and(eq(retentionCursors.dataCategory, 'raw_files'), eq(artifacts.id, id)));
      if (!position) throw new AppError('INVALID_STATE');
      const retention = artifactRetentionAuthorityInTx(tx, context, {
        artifactId: id,
        ruleId: position.ruleId,
        cutoff: position.cutoff,
      });
      await deleteArtifactInTx(tx, context, {
        workUnitId: link.workUnitId,
        artifactId: id,
        retention,
      });
    },
  };
  return source;
}

/** Counts and safe codes let an administrator distinguish a completed sweep from a missing binding. */
export async function listRetentionRuns(database: AppDatabase, context: TenantContext) {
  manager(context);
  return withAccountTx(database, context, (tx) =>
    tx
      .select({
        id: retentionRuns.id,
        dataCategory: retentionRuns.dataCategory,
        examined: retentionRuns.examined,
        removed: retentionRuns.removed,
        held: retentionRuns.held,
        outcomeCode: retentionRuns.outcomeCode,
        finishedAt: retentionRuns.finishedAt,
      })
      .from(retentionRuns)
      .orderBy(desc(retentionRuns.startedAt), desc(retentionRuns.id))
      .limit(20),
  );
}
