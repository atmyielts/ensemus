// Owned by the facts slice (KNOW-04). See docs/06-delivery/m5-slices.md and ADR-029 D7. A model's output is
// a proposal, and a trigger holds that. Only a person can verify, on evidence they can read.
import { createHash, randomUUID } from 'node:crypto';
import {
  appendAudit,
  clients,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeFactEvidence,
  knowledgeFacts,
  knowledgeSources,
  memberships,
  projects,
  workUnits,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  FACT_ORIGINS,
  FACT_TRANSITIONS,
  strongestClass,
  type FactOrigin,
  type FactState,
} from '@ensemus/domain/knowledge';
import { KNOWLEDGE_FACT_PROPOSED, KNOWLEDGE_FACT_REVIEWED } from '@ensemus/domain/knowledge-events';
import { can, type Classification } from '@ensemus/domain/policy';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { emit } from '../events';
import { idSchema } from '../ids';
import { rowLockTarget } from '../row-lock';
import { factClaim, factPage, factReason, factSubject } from './fact-input';
import { workInputClassInTx, type ObservedInput } from '../ai/input-observations';
import { loadAgentReadScopeInTx } from '../ai/read-scope';

export type FactEvidenceInput = { chunkId: string; quoteStart: number; quoteEnd: number };
/** Internal trusted compiler seam. Called once, after all body locks and before this read commits. */
export type FactReadCapture = (tx: Tx, inputs: readonly ObservedInput[]) => Promise<void>;

export type FactView = {
  id: string;
  subjectRef: string;
  predicate: string;
  claim: unknown;
  trustState: FactState;
  origin: FactOrigin;
  classification: Classification;
  conflictRef: string | null;
  reviewedByMembershipId: string | null;
  reviewedAt: Date | null;
  evidence: readonly {
    chunkId: string;
    documentId: string;
    sourceId: string;
    title: string;
    excerpt: string;
    /** The document this quotes has been replaced. The fact may need another look. */
    stale: boolean;
  }[];
  version: number;
  createdAt: Date;
};

/**
 * Needs a membership, and evidence the proposer can read: the class is the strongest of its sources, and
 * cannot be set lower. `origin` is `model` when a run proposes, in a delegated or agent context. Checks
 * the subject's authoritative record in the same transaction, and a conflict lands as `disputed` with
 * `conflictRef` set, not `proposed` (QA-016).
 */
export async function proposeFact(
  database: AppDatabase,
  context: TenantContext,
  input: {
    subjectRef: string;
    predicate: string;
    claim: unknown;
    origin: FactOrigin;
    evidence: readonly FactEvidenceInput[];
    runId?: string;
    validFrom?: Date;
    validUntil?: Date;
  },
): Promise<{ factId: string; trustState: FactState }> {
  const subject = factSubject(input.subjectRef);
  if (
    typeof input.predicate !== 'string' ||
    !/^[a-z][a-z0-9_.]{0,63}$/.test(input.predicate) ||
    !(FACT_ORIGINS as readonly string[]).includes(input.origin) ||
    !Array.isArray(input.evidence) ||
    input.evidence.length === 0 ||
    input.evidence.length > 50
  )
    throw new AppError('INVALID_INPUT');
  const claim = factClaim(input.claim);
  const runId = input.runId === undefined ? null : identifier(input.runId);
  if (
    runId &&
    (context.actorType === 'user' ||
      input.origin !== 'model' ||
      !('agentRunId' in context) ||
      context.agentRunId !== runId)
  )
    throw new AppError('FORBIDDEN');
  if (context.actorType !== 'user' && (input.origin !== 'model' || !runId))
    throw new AppError('FORBIDDEN');
  for (const at of [input.validFrom, input.validUntil])
    if (at !== undefined && (!(at instanceof Date) || !Number.isFinite(at.getTime())))
      throw new AppError('INVALID_INPUT');
  if (input.validFrom && input.validUntil && input.validUntil <= input.validFrom)
    throw new AppError('INVALID_INPUT');
  const evidence = input.evidence.map((item) => {
    if (
      !Number.isSafeInteger(item.quoteStart) ||
      !Number.isSafeInteger(item.quoteEnd) ||
      item.quoteStart < 0 ||
      item.quoteEnd <= item.quoteStart
    )
      throw new AppError('INVALID_INPUT');
    return { ...item, chunkId: identifier(item.chunkId) };
  });
  if (new Set(evidence.map((item) => item.chunkId)).size !== evidence.length)
    throw new AppError('INVALID_INPUT');
  try {
    return await withTenantTx(database, context, async (tx) => {
      const member = await person(tx, context, 'add');
      if (runId) {
        // The run is authority, not an attribution string chosen by a tool. M4's worker binds its
        // actual agentRunId; a delegated query or a manually entered ID cannot impersonate that run.
        const run = await tx.execute<{ id: string }>(sql`select id from ai.agent_runs
          where organization_id = ${context.organizationId}::uuid and id = ${runId}::uuid
            and initiator_membership_id = ${context.membershipId}::uuid and status = 'running' and ended_at is null`);
        if (run.rows.length !== 1) throw new AppError('FORBIDDEN');
      }
      const record = await subjectRecord(tx, context, subject, member.role);
      const passages = await tx
        .select({
          id: knowledgeChunks.id,
          sourceId: knowledgeSources.id,
          text: knowledgeChunks.textBody,
          hash: knowledgeChunks.contentSha256,
          sourceClass: knowledgeSources.classification,
          documentClass: knowledgeDocuments.classification,
        })
        .from(knowledgeChunks)
        .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
        .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeChunks.sourceId))
        .where(
          and(
            inArray(
              knowledgeChunks.id,
              evidence.map((item) => item.chunkId),
            ),
            eq(knowledgeSources.state, 'active'),
            eq(knowledgeDocuments.state, 'searchable'),
          ),
        )
        .for('share', { of: [rowLockTarget(knowledgeSources), rowLockTarget(knowledgeDocuments)] });
      if (passages.length !== evidence.length) throw new AppError('KNOWLEDGE_FACT_NEEDS_EVIDENCE');
      const byId = new Map(passages.map((item) => [item.id, item]));
      for (const item of evidence)
        if (item.quoteEnd > (byId.get(item.chunkId)?.text.length ?? -1))
          throw new AppError('KNOWLEDGE_FACT_NEEDS_EVIDENCE');
      const classification = strongestClass([
        ...passages.flatMap((item) => [
          item.sourceClass as Classification,
          item.documentClass as Classification,
        ]),
        record.classification,
      ]);
      const factId = randomUUID();
      const conflict =
        input.predicate === 'name.is' && record.name !== null && claim !== record.name;
      await tx.insert(knowledgeFacts).values({
        organizationId: context.organizationId,
        id: factId,
        subjectRef: subject.ref,
        predicate: input.predicate,
        claim,
        origin: input.origin,
        classification,
        proposedByMembershipId: context.membershipId,
        proposedByRunId: runId,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
      });
      await tx.insert(knowledgeFactEvidence).values(
        evidence.map((item) => ({
          organizationId: context.organizationId,
          factId,
          chunkId: item.chunkId,
          sourceId: byId.get(item.chunkId)!.sourceId,
          contentSha256: byId.get(item.chunkId)!.hash,
          quoteStart: item.quoteStart,
          quoteEnd: item.quoteEnd,
        })),
      );
      const trustState: FactState = conflict ? 'disputed' : 'proposed';
      if (conflict) {
        const changedRows = await tx
          .update(knowledgeFacts)
          .set({
            trustState,
            conflictRef: subject.ref,
            version: 2,
            updatedAt: new Date(),
          })
          .where(eq(knowledgeFacts.id, factId))
          .returning({ id: knowledgeFacts.id });
        if (changedRows.length !== 1) throw new AppError('NOT_FOUND');
      }
      await changed(
        tx,
        context,
        factId,
        conflict ? 2 : 1,
        classification,
        KNOWLEDGE_FACT_PROPOSED,
        trustState,
      );
      return { factId, trustState };
    });
  } catch (error) {
    throw mapped(error);
  }
}

/**
 * Needs `knowledge.review_fact`, a user context and to be able to read the fact. A reason is required.
 * Verifying a `disputed` fact needs the reason to say why the record is wrong, and is audited as such. The
 * proposer cannot review their own. Maps the triggers' refusals to KNOWLEDGE_FACT_NEEDS_PERSON and
 * KNOWLEDGE_FACT_NEEDS_EVIDENCE.
 */
export async function reviewFact(
  database: AppDatabase,
  context: TenantContext,
  input: {
    factId: string;
    expectedVersion: number;
    decision: 'verify' | 'reject';
    reason: string;
  },
): Promise<{ trustState: FactState; version: number }> {
  const reason = factReason(input.reason);
  if (context.actorType !== 'user') throw new AppError('KNOWLEDGE_FACT_NEEDS_PERSON');
  if (!['verify', 'reject'].includes(input.decision)) throw new AppError('INVALID_INPUT');
  try {
    return await withTenantTx(database, context, async (tx) => {
      await person(tx, context, 'review');
      const fact = await lockedFact(tx, input.factId, input.expectedVersion);
      if (fact.proposedByMembershipId === context.membershipId)
        throw new AppError('KNOWLEDGE_FACT_NEEDS_PERSON');
      const trustState: FactState = input.decision === 'verify' ? 'verified' : 'rejected';
      transition(fact, trustState);
      const evidence = await views(tx, context, [fact]);
      if (!evidence[0]?.evidence.length) throw new AppError('KNOWLEDGE_FACT_NEEDS_EVIDENCE');
      const changedRows = await tx
        .update(knowledgeFacts)
        .set({
          trustState,
          reviewedByMembershipId: context.membershipId,
          reviewedAt: new Date(),
          reviewReason: reason,
          version: fact.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeFacts.id, fact.id))
        .returning({ id: knowledgeFacts.id });
      if (changedRows.length !== 1) throw new AppError('NOT_FOUND');
      await changed(
        tx,
        context,
        fact.id,
        fact.version + 1,
        fact.classification,
        KNOWLEDGE_FACT_REVIEWED,
        trustState,
      );
      return { trustState, version: fact.version + 1 };
    });
  } catch (error) {
    throw mapped(error);
  }
}

/** Marks a fact as disagreeing with a record, by a person or the consolidation sweep. */
export async function disputeFact(
  database: AppDatabase,
  context: TenantContext,
  input: { factId: string; expectedVersion: number; conflictRef: string },
): Promise<{ version: number }> {
  const conflict = factSubject(input.conflictRef);
  try {
    return await withTenantTx(database, context, async (tx) => {
      const member =
        context.actorType === 'service' ? { role: 'service' } : await person(tx, context, 'review');
      await subjectRecord(tx, context, conflict, member.role);
      const fact = await lockedFact(tx, input.factId, input.expectedVersion);
      transition(fact, 'disputed');
      const changedRows = await tx
        .update(knowledgeFacts)
        .set({
          trustState: 'disputed',
          conflictRef: conflict.ref,
          version: fact.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeFacts.id, fact.id))
        .returning({ id: knowledgeFacts.id });
      if (changedRows.length !== 1) throw new AppError('NOT_FOUND');
      await changed(
        tx,
        context,
        fact.id,
        fact.version + 1,
        fact.classification,
        KNOWLEDGE_FACT_REVIEWED,
        'disputed',
      );
      return { version: fact.version + 1 };
    });
  } catch (error) {
    throw mapped(error);
  }
}

/** Needs `knowledge.review_fact`. Both facts have to be readable, and the replacement `verified`. */
export async function supersedeFact(
  database: AppDatabase,
  context: TenantContext,
  input: { factId: string; expectedVersion: number; supersededById: string },
): Promise<{ version: number }> {
  const factId = identifier(input.factId),
    replacementId = identifier(input.supersededById);
  if (factId === replacementId) throw new AppError('INVALID_INPUT');
  try {
    return await withTenantTx(database, context, async (tx) => {
      await person(tx, context, 'review');
      // Stable lock order prevents two simultaneous replacements from taking each other's locks.
      const lockedSources = await lockFactSources(tx, [factId, replacementId]);
      const rows = await tx
        .select()
        .from(knowledgeFacts)
        .where(inArray(knowledgeFacts.id, [factId, replacementId]))
        .orderBy(asc(knowledgeFacts.id))
        .for('update');
      const fact = rows.find((row) => row.id === factId),
        replacement = rows.find((row) => row.id === replacementId);
      if (!fact || !replacement) throw new AppError('NOT_FOUND');
      await assertStableSources(tx, [factId, replacementId], lockedSources);
      version(fact, input.expectedVersion);
      transition(fact, 'superseded');
      if (
        replacement.trustState !== 'verified' ||
        replacement.subjectRef !== fact.subjectRef ||
        replacement.predicate !== fact.predicate ||
        (replacement.validUntil && replacement.validUntil <= new Date()) ||
        (replacement.validFrom && replacement.validFrom > new Date()) ||
        (await views(tx, context, [replacement])).length !== 1
      )
        throw new AppError('INVALID_STATE');
      const changedRows = await tx
        .update(knowledgeFacts)
        .set({
          trustState: 'superseded',
          supersededById: replacementId,
          version: fact.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeFacts.id, factId))
        .returning({ id: knowledgeFacts.id });
      if (changedRows.length !== 1) throw new AppError('NOT_FOUND');
      await changed(
        tx,
        context,
        factId,
        fact.version + 1,
        fact.classification,
        KNOWLEDGE_FACT_REVIEWED,
        'superseded',
      );
      return { version: fact.version + 1 };
    });
  } catch (error) {
    throw mapped(error);
  }
}

export function listFacts(
  database: AppDatabase,
  context: TenantContext,
  input: { subjectRef?: string; trustState?: FactState; after?: string; limit?: number },
): Promise<{ items: readonly FactView[]; next: string | null }> {
  const page = factPage(input);
  const filters: SQL[] = [];
  if (input.subjectRef !== undefined)
    filters.push(eq(knowledgeFacts.subjectRef, factSubject(input.subjectRef).ref));
  if (input.trustState !== undefined) filters.push(eq(knowledgeFacts.trustState, input.trustState));
  // JavaScript cursors retain milliseconds. Filter and order at that precision too, with the UUID tie-break.
  if (page.after)
    filters.push(
      sql`(date_trunc('milliseconds', ${knowledgeFacts.createdAt}), ${knowledgeFacts.id}) > (${page.after.at}::timestamptz, ${page.after.id}::uuid)`,
    );
  return withTenantTx(database, context, async (tx) => {
    await person(tx, context);
    const rows = await tx
      .select()
      .from(knowledgeFacts)
      .where(and(...filters))
      .orderBy(sql`date_trunc('milliseconds', ${knowledgeFacts.createdAt})`, asc(knowledgeFacts.id))
      .limit(page.limit + 1);
    const selected = rows.slice(0, page.limit);
    const last = selected.at(-1);
    return {
      items: await views(tx, context, selected),
      next:
        rows.length > page.limit && last
          ? Buffer.from(JSON.stringify([last.createdAt.toISOString(), last.id])).toString(
              'base64url',
            )
          : null,
    };
  });
}

export function getFact(
  database: AppDatabase,
  context: TenantContext,
  factId: string,
): Promise<FactView> {
  const id = identifier(factId);
  return withTenantTx(database, context, async (tx) => {
    await person(tx, context);
    const rows = await tx.select().from(knowledgeFacts).where(eq(knowledgeFacts.id, id));
    const [view] = await views(tx, context, rows);
    if (!view) throw new AppError('NOT_FOUND');
    return view;
  });
}

/** What the compiler may treat as trusted, under the viewer's own ACL. Unexpired, and `verified` only. */
export function verifiedFactsFor(
  database: AppDatabase,
  context: TenantContext,
  input: {
    subjectRefs: readonly string[];
    limit?: number;
    captureReadsInTx?: FactReadCapture;
    sourceIds?: readonly string[];
    maxClassification?: Classification;
  },
): Promise<readonly FactView[]> {
  if (!Array.isArray(input.subjectRefs) || input.subjectRefs.length > 100)
    throw new AppError('INVALID_INPUT');
  const subjects = [...new Set(input.subjectRefs.map((value) => factSubject(value).ref))];
  const requestedSources = input.sourceIds?.map(identifier);
  if (requestedSources && requestedSources.length > 200) throw new AppError('INVALID_INPUT');
  if (
    input.maxClassification !== undefined &&
    !['public', 'internal', 'confidential', 'restricted'].includes(input.maxClassification)
  )
    throw new AppError('INVALID_INPUT');
  const { limit } = factPage({ limit: input.limit ?? 25 });
  return withTenantTx(database, context, async (tx) => {
    await person(tx, context);
    let sourceIds = requestedSources,
      maxClassification = input.maxClassification;
    if (context.actorType === 'agent') {
      if (!context.agentRunId) throw new AppError('FORBIDDEN');
      const scope = await loadAgentReadScopeInTx(tx, {
        ...context,
        actorType: 'agent',
        agentRunId: context.agentRunId,
      });
      sourceIds = sourceIds
        ? sourceIds.filter((id) => scope.sourceIds.includes(id))
        : [...scope.sourceIds];
      const rank = (value: Classification) =>
        ['public', 'internal', 'confidential', 'restricted'].indexOf(value);
      if (scope.ceiling && (!maxClassification || rank(scope.ceiling) < rank(maxClassification)))
        maxClassification = scope.ceiling;
    }
    if (!subjects.length || sourceIds?.length === 0) return [];
    // A fact is indivisible: every evidence row and its current subject floor must fit BEFORE a
    // body read or LIMIT. A fact grounded partly in an unselected source is not read then dropped.
    const scoped = sourceIds !== undefined || maxClassification !== undefined;
    const subjectClass = sql`case when split_part(${knowledgeFacts.subjectRef},':',1) in('work_unit','project','client') then knowledge.structured_record_class(split_part(${knowledgeFacts.subjectRef},':',1),split_part(${knowledgeFacts.subjectRef},':',2)::uuid)
      when split_part(${knowledgeFacts.subjectRef},':',1)='knowledge_source' then(select s.classification from knowledge.sources s where s.organization_id=${knowledgeFacts.organizationId} and s.id=split_part(${knowledgeFacts.subjectRef},':',2)::uuid and s.state='active') else 'internal' end`;
    const condition = and(
      inArray(knowledgeFacts.subjectRef, subjects),
      eq(knowledgeFacts.trustState, 'verified'),
      sql`(${knowledgeFacts.validFrom} is null or ${knowledgeFacts.validFrom} <= now())`,
      sql`(${knowledgeFacts.validUntil} is null or ${knowledgeFacts.validUntil} > now())`,
      scoped
        ? sql`exists(select 1 from knowledge.fact_evidence e where e.organization_id=${knowledgeFacts.organizationId} and e.fact_id=${knowledgeFacts.id}) and not exists(
            select 1 from knowledge.fact_evidence e left join knowledge.chunks c on c.organization_id=e.organization_id and c.id=e.chunk_id
            left join knowledge.documents d on d.organization_id=c.organization_id and d.id=c.document_id
            left join knowledge.sources s on s.organization_id=e.organization_id and s.id=e.source_id
            where e.organization_id=${knowledgeFacts.organizationId} and e.fact_id=${knowledgeFacts.id} and (
              c.id is null or d.id is null or s.id is null or s.state<>'active' or d.state<>'searchable' or d.superseded_at is not null
              or c.content_sha256<>e.content_sha256 or e.source_id not in(select knowledge.readable_source_ids(${context.membershipId}::uuid))
              ${
                sourceIds
                  ? sql`or e.source_id not in(${sql.join(
                      sourceIds.map((id) => sql`${id}::uuid`),
                      sql`,`,
                    )})`
                  : sql``
              }
              ${maxClassification ? sql`or greatest(knowledge.class_rank(s.classification),knowledge.class_rank(d.classification))>knowledge.class_rank(${maxClassification})` : sql``}
            ))`
        : undefined,
      maxClassification
        ? sql`knowledge.class_rank(${knowledgeFacts.classification})<=knowledge.class_rank(${maxClassification}) and coalesce(knowledge.class_rank(${subjectClass}),4)<=knowledge.class_rank(${maxClassification})`
        : undefined,
      sourceIds
        ? sql`(split_part(${knowledgeFacts.subjectRef},':',1)<>'knowledge_source' or split_part(${knowledgeFacts.subjectRef},':',2)::uuid in(${sql.join(
            sourceIds.map((id) => sql`${id}::uuid`),
            sql`,`,
          )}))`
        : undefined,
    );
    let rows: FactRow[];
    if (scoped) {
      const metadata = await tx
        .select({ id: knowledgeFacts.id, subjectRef: knowledgeFacts.subjectRef })
        .from(knowledgeFacts)
        .where(condition)
        .orderBy(asc(knowledgeFacts.id))
        .limit(limit);
      if (!metadata.length) return [];
      const locked = await lockFactSources(
        tx,
        metadata.map((row) => row.id),
      );
      for (const ref of [...new Set(metadata.map((row) => row.subjectRef))].sort()) {
        const subject = factSubject(ref);
        if (['work_unit', 'project', 'client'].includes(subject.type)) {
          const proof = await tx.execute<{ locked: boolean }>(
            sql`select knowledge.lock_structured_record(${subject.type},${subject.id}::uuid) locked`,
          );
          if (!proof.rows[0]?.locked) throw new AppError('NOT_FOUND');
        }
      }
      await assertStableSources(
        tx,
        metadata.map((row) => row.id),
        locked,
      );
      rows = await tx
        .select()
        .from(knowledgeFacts)
        .where(
          and(
            inArray(
              knowledgeFacts.id,
              metadata.map((row) => row.id),
            ),
            condition,
          ),
        )
        .orderBy(asc(knowledgeFacts.id));
    } else
      rows = await tx
        .select()
        .from(knowledgeFacts)
        .where(condition)
        .orderBy(asc(knowledgeFacts.id))
        .limit(limit);
    return views(tx, context, rows, input.captureReadsInTx);
  });
}

type FactRow = typeof knowledgeFacts.$inferSelect;
const identifier = (raw: string) => {
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
};
async function person(tx: Tx, context: TenantContext, operation?: 'add' | 'review') {
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  if (operation === 'review' && context.actorType !== 'user')
    throw new AppError('KNOWLEDGE_FACT_NEEDS_PERSON');
  const [member] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, context.membershipId), eq(memberships.status, 'active')))
    .for('share');
  if (
    !member ||
    (operation &&
      !can(member.role, operation === 'add' ? 'knowledge.add' : 'knowledge.review_fact'))
  )
    throw new AppError('FORBIDDEN');
  return member;
}
function version(row: FactRow, expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 1) throw new AppError('INVALID_INPUT');
  if (row.version !== expected) throw new AppError('VERSION_CONFLICT');
}
function transition(row: FactRow, state: FactState) {
  if (!FACT_TRANSITIONS[row.trustState as FactState]?.includes(state))
    throw new AppError('INVALID_TRANSITION');
}
async function lockedFact(tx: Tx, factId: string, expected: number) {
  const id = identifier(factId);
  // Source closure takes sources before facts. Keep the same order for reviews and disputes.
  const lockedSources = await lockFactSources(tx, [id]);
  const [row] = await tx
    .select()
    .from(knowledgeFacts)
    .where(eq(knowledgeFacts.id, id))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND');
  await assertStableSources(tx, [id], lockedSources);
  version(row, expected);
  return row;
}
async function lockFactSources(tx: Tx, factIds: readonly string[]) {
  const evidence = await tx
    .select({ sourceId: knowledgeFactEvidence.sourceId })
    .from(knowledgeFactEvidence)
    .where(inArray(knowledgeFactEvidence.factId, [...factIds]));
  const ids = [...new Set(evidence.map((item) => item.sourceId))];
  if (ids.length)
    await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(inArray(knowledgeSources.id, ids))
      .orderBy(asc(knowledgeSources.id))
      .for('share');
  return new Set(ids);
}
async function assertStableSources(
  tx: Tx,
  factIds: readonly string[],
  locked: ReadonlySet<string>,
) {
  const current = await tx
    .select({ sourceId: knowledgeFactEvidence.sourceId })
    .from(knowledgeFactEvidence)
    .where(inArray(knowledgeFactEvidence.factId, [...factIds]));
  // A proposed fact may acquire evidence before its parent lock. Retry without locking that new
  // source while holding the parent, which would invert source closure's source-before-fact order.
  if (current.some((item) => !locked.has(item.sourceId))) throw new AppError('VERSION_CONFLICT');
}
async function subjectRecord(
  tx: Tx,
  context: TenantContext,
  subject: ReturnType<typeof factSubject>,
  role: string,
  observations?: ObservedInput[],
): Promise<{ name: string | null; classification: Classification }> {
  if (subject.type === 'client') {
    const [row] = await tx.select().from(clients).where(eq(clients.id, subject.id)).for('share');
    // 0209's central client RLS includes the creator and explicitly named readers, even for restricted.
    if (!row) throw new AppError('NOT_FOUND');
    observations?.push({
      kind: 'client',
      id: row.id,
      sha256: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
      classification: row.classification as Classification,
    });
    return { name: row.displayName, classification: row.classification as Classification };
  }
  if (subject.type === 'project') {
    const [row] = await tx.select().from(projects).where(eq(projects.id, subject.id)).for('share');
    if (!row) throw new AppError('NOT_FOUND');
    const parent = row.clientId
      ? await subjectRecord(
          tx,
          context,
          { type: 'client', id: row.clientId, ref: `client:${row.clientId}` },
          role,
          observations,
        )
      : null;
    const classification = parent?.classification ?? 'internal';
    observations?.push({
      kind: 'project',
      id: row.id,
      sha256: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
      classification,
    });
    return { name: row.name, classification };
  }
  if (subject.type === 'work_unit') {
    const allowed =
      role === 'service'
        ? sql`true`
        : sql`knowledge.can_read_work(${subject.id}::uuid, ${context.membershipId}::uuid)`;
    const [row] = await tx
      .select({ classification: workUnits.classification })
      .from(workUnits)
      .where(and(eq(workUnits.id, subject.id), allowed))
      .for('share');
    if (!row) throw new AppError('NOT_FOUND');
    const effectiveClass = await workInputClassInTx(
      tx,
      subject.id,
      row.classification as Classification,
    );
    observations?.push({
      kind: 'work_unit',
      id: subject.id,
      sha256: createHash('sha256')
        .update(JSON.stringify({ id: subject.id, classification: row.classification }))
        .digest('hex'),
      classification: effectiveClass,
    });
    return { name: null, classification: effectiveClass };
  }
  if (subject.type === 'knowledge_source') {
    const allowed =
      role === 'service'
        ? sql`true`
        : sql`${knowledgeSources.id} in (select knowledge.readable_source_ids(${context.membershipId}::uuid))`;
    const [row] = await tx
      .select()
      .from(knowledgeSources)
      .where(
        and(eq(knowledgeSources.id, subject.id), eq(knowledgeSources.state, 'active'), allowed),
      )
      .for('share');
    if (!row) throw new AppError('NOT_FOUND');
    return { name: null, classification: row.classification as Classification };
  }
  const extra =
    role === 'service'
      ? sql``
      : subject.type === 'work_unit'
        ? sql`and knowledge.can_read_work(${subject.id}::uuid, ${context.membershipId}::uuid)`
        : subject.type === 'knowledge_source'
          ? sql`and ${subject.id}::uuid in (select knowledge.readable_source_ids(${context.membershipId}::uuid))`
          : sql``;
  const result = await tx.execute<{ visible: boolean }>(
    sql`select knowledge.node_exists(${subject.type}, ${subject.id}::uuid) as visible where true ${extra}`,
  );
  if (!result.rows[0]?.visible) throw new AppError('NOT_FOUND');
  return { name: null, classification: 'internal' };
}
async function views(
  tx: Tx,
  context: TenantContext,
  facts: readonly FactRow[],
  captureReadsInTx?: FactReadCapture,
): Promise<FactView[]> {
  if (!facts.length) return [];
  const member = await person(tx, context);
  const all = await tx
    .select()
    .from(knowledgeFactEvidence)
    .where(
      inArray(
        knowledgeFactEvidence.factId,
        facts.map((fact) => fact.id),
      ),
    );
  const visible = await tx
    .select({
      evidence: knowledgeFactEvidence,
      chunk: knowledgeChunks,
      document: knowledgeDocuments,
      source: knowledgeSources,
    })
    .from(knowledgeFactEvidence)
    .innerJoin(knowledgeChunks, eq(knowledgeChunks.id, knowledgeFactEvidence.chunkId))
    .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
    .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeFactEvidence.sourceId))
    .where(
      and(
        inArray(
          knowledgeFactEvidence.factId,
          facts.map((fact) => fact.id),
        ),
        eq(knowledgeSources.state, 'active'),
        eq(knowledgeDocuments.state, 'searchable'),
      ),
    )
    .for('share', { of: [rowLockTarget(knowledgeSources), rowLockTarget(knowledgeDocuments)] });
  const result: FactView[] = [];
  const observations: ObservedInput[] = [];
  for (const fact of facts) {
    let subject: Awaited<ReturnType<typeof subjectRecord>>;
    try {
      subject = await subjectRecord(
        tx,
        context,
        factSubject(fact.subjectRef),
        member.role,
        captureReadsInTx ? observations : undefined,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') continue;
      throw error;
    }
    const expected = all.filter((item) => item.factId === fact.id);
    const evidence = visible.filter((item) => item.evidence.factId === fact.id);
    if (
      !expected.length ||
      evidence.length !== expected.length ||
      evidence.some(
        (item) =>
          item.evidence.contentSha256 !== item.chunk.contentSha256 ||
          item.evidence.quoteEnd > item.chunk.textBody.length,
      )
    )
      continue;
    result.push({
      id: fact.id,
      subjectRef: fact.subjectRef,
      predicate: fact.predicate,
      claim: fact.claim,
      trustState: fact.trustState as FactState,
      origin: fact.origin as FactOrigin,
      classification: strongestClass([
        fact.classification as Classification,
        subject.classification,
        ...evidence.flatMap((item) => [
          item.source.classification as Classification,
          item.document.classification as Classification,
        ]),
      ]),
      conflictRef: fact.conflictRef,
      reviewedByMembershipId: fact.reviewedByMembershipId,
      reviewedAt: fact.reviewedAt,
      version: fact.version,
      createdAt: fact.createdAt,
      evidence: evidence
        .sort((a, b) => a.evidence.chunkId.localeCompare(b.evidence.chunkId))
        .map((item) => ({
          chunkId: item.chunk.id,
          documentId: item.document.id,
          sourceId: item.source.id,
          title: item.document.title,
          excerpt: item.chunk.textBody.slice(item.evidence.quoteStart, item.evidence.quoteEnd),
          stale: item.document.supersededAt !== null,
        })),
    });
  }
  if (captureReadsInTx && observations.length) await captureReadsInTx(tx, observations);
  return result;
}
async function changed(
  tx: Tx,
  context: TenantContext,
  factId: string,
  factVersion: number,
  classification: string,
  eventType: string,
  trustState: FactState,
) {
  await emit(tx, context, {
    eventType,
    aggregateType: 'knowledge_fact',
    aggregateId: factId,
    aggregateVersion: factVersion,
    classification,
    payload: { trust_state: trustState },
  });
  await appendAudit(tx, {
    organizationId: context.organizationId,
    actorType:
      context.actorType === 'service' ? 'service' : context.actorType === 'user' ? 'user' : 'agent',
    ...(context.actorType === 'service' ? {} : { actorId: context.membershipId }),
    action: eventType,
    targetRef: `knowledge_fact:${factId}`,
    decision: 'allow',
    safeReason: trustState.toUpperCase(),
  });
}
function mapped(error: unknown): unknown {
  const code = pgCode(error);
  if (code === 'EN109') return new AppError('KNOWLEDGE_FACT_NEEDS_PERSON');
  if (code === 'EN110' || code === 'EN111') return new AppError('KNOWLEDGE_FACT_NEEDS_EVIDENCE');
  if (code === 'EN108') return new AppError('INVALID_TRANSITION');
  if (code === '23503' || code === '42501') return new AppError('NOT_FOUND');
  if (code === '23514') return new AppError('INVALID_INPUT');
  return error;
}
