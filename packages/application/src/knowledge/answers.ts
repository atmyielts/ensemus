// Owned by the compile slice (UX-18's service). See docs/06-delivery/m5-slices.md and ADR-029 D5. The web
// tier has no model path, so asking writes a row and an event, and a worker does the rest under the
// asker's own membership. A read rechecks every source through row-level security.
import { createHash, randomUUID } from 'node:crypto';
import {
  knowledgeAnswers,
  knowledgeAnswerSources,
  knowledgeAnswerCitations,
  modelJobs,
  notifications,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import type { AnswerState, KnowledgeCode } from '@ensemus/domain/knowledge';
import { KNOWLEDGE_CODES, MAX_EVIDENCE_TOKENS, strongestClass } from '@ensemus/domain/knowledge';
import {
  AGGREGATE_KNOWLEDGE_ANSWER,
  KNOWLEDGE_ANSWER_REQUESTED,
  KNOWLEDGE_ANSWER_FINISHED,
  NOTIFY_KNOWLEDGE_ANSWER_READY,
  knowledgeAnswerTargetRef,
} from '@ensemus/domain/knowledge-events';
import type { Classification } from '@ensemus/domain/policy';
import { checkCitations } from '@ensemus/knowledge/citations';
import { buildAnswerMessages } from '@ensemus/knowledge/prompt';
import { ModelCallFailed, type ModelUsage } from '@ensemus/knowledge/ports';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { emit } from '../events';
import { idSchema } from '../ids';
import { idFromRequest } from '../request-id';
import {
  compileEvidence,
  refreshEvidence,
  sameEvidence,
  verifiedFactsCurrent,
  type CompileDeps,
} from './compiler';
import { requireSearchPerson, searchQuery } from './retrieval';
import { recordModelCall } from './embeddings';
import { operationKey } from '@ensemus/knowledge/model-operations';
import type { ModelJobBounds } from '@ensemus/domain/knowledge-models';
import type { ModelResultConsumer } from '../ai/knowledge-ports';
import { modelRequestHash, requestKnowledgeModelJobInTx } from './model-jobs';

export type AnswerCitationView = {
  ordinal: number;
  answerStart: number;
  answerEnd: number;
  chunkId: string;
  documentId: string;
  sourceId: string;
  title: string;
  excerpt: string;
  sourceVersion: string | null;
  sourceUrl: string | null;
  sourceModifiedAt: Date | null;
  /** `current`, or `superseded` when a newer version of the source has arrived since. */
  freshness: 'current' | 'superseded';
};

export type AnswerView = {
  id: string;
  state: AnswerState;
  question: string;
  questionClassification: Classification;
  answerText: string | null;
  refusalCode: KnowledgeCode | null;
  citations: readonly AnswerCitationView[];
  strongestClassification: Classification | null;
  /** Micro-USD. Shown as an estimate. Null when the model's profile has no rate card. */
  costMicros: number | null;
  version: number;
  createdAt: Date;
  finishedAt: Date | null;
};

/** Refuses a service context. Writes the row and `knowledge.answer_requested` in one transaction. */
export async function askQuestion(
  database: AppDatabase,
  context: TenantContext,
  input: {
    question: string;
    classification?: Classification;
    requestKey?: string;
    model?: { approvalId: string; bounds: ModelJobBounds };
  },
): Promise<{ answerId: string }> {
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  const question = searchQuery(input.question);
  const classification = input.classification ?? 'restricted';
  if (!question || !['public', 'internal', 'confidential', 'restricted'].includes(classification))
    throw new AppError('INVALID_INPUT');
  const answerId = input.requestKey
    ? idFromRequest('knowledge-answer', context.membershipId, id(input.requestKey), [
        question,
        classification,
      ])
    : randomUUID();
  const modelRequest = input.model
    ? {
        kind: 'answer' as const,
        answerId,
        query: question,
        classification,
        approvalId: input.model.approvalId,
        bounds: input.model.bounds,
        requestKey: idFromRequest('answer-model-job', context.membershipId, answerId, [
          question,
          classification,
        ]),
      }
    : null;
  await withTenantTx(database, context, async (tx) => {
    await requireSearchPerson(tx, context);
    const [inserted] = await tx
      .insert(knowledgeAnswers)
      .values({
        organizationId: context.organizationId,
        id: answerId,
        requesterMembershipId: context.membershipId,
        question,
        questionClassification: classification,
      })
      .onConflictDoNothing()
      .returning({ id: knowledgeAnswers.id });
    if (!inserted) {
      const [existing] = await tx
        .select({ id: knowledgeAnswers.id })
        .from(knowledgeAnswers)
        .where(eq(knowledgeAnswers.id, answerId));
      if (!existing) throw new AppError('NOT_FOUND');
      const [existingJob] = await tx
        .select({ requestHash: modelJobs.requestHash })
        .from(modelJobs)
        .where(eq(modelJobs.answerId, answerId));
      if (
        (modelRequest === null) !== (existingJob === undefined) ||
        (modelRequest && existingJob?.requestHash !== modelRequestHash(modelRequest))
      )
        throw new AppError('INVALID_INPUT');
      return;
    }
    if (modelRequest) await requestKnowledgeModelJobInTx(tx, context, modelRequest);
    await emit(tx, context, {
      eventType: KNOWLEDGE_ANSWER_REQUESTED,
      aggregateType: AGGREGATE_KNOWLEDGE_ANSWER,
      aggregateId: answerId,
      aggregateVersion: 1,
      classification,
      payload: { answer_id: answerId },
    });
  });
  return { answerId };
}

/**
 * Row-level security hides an answer from anyone but its asker, and from them once any source that went
 * in is out of their reach, so this answers NOT_FOUND then, with no sign of why.
 */
export async function getAnswer(
  database: AppDatabase,
  context: TenantContext,
  answerId: string,
): Promise<AnswerView> {
  const key = id(answerId);
  return withTenantTx(database, context, async (tx) => {
    await requireSearchPerson(tx, context);
    const [row] = await tx
      .select()
      .from(knowledgeAnswers)
      .where(and(eq(knowledgeAnswers.id, key), answerVisible(context)));
    if (!row) throw new AppError('NOT_FOUND');
    const view = (await answerViews(tx, [row]))[0];
    if (!view) throw new AppError('NOT_FOUND');
    return view;
  });
}

export async function listMyAnswers(
  database: AppDatabase,
  context: TenantContext,
  input: { after?: string; limit?: number },
): Promise<{ items: readonly AnswerView[]; next: string | null }> {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AppError('INVALID_INPUT');
  let after: { at: string; id: string } | null = null;
  if (input.after) {
    if (input.after.length > 512) throw new AppError('INVALID_INPUT');
    try {
      const value = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8')) as {
        at: string;
        id: string;
      };
      if (
        typeof value.at !== 'string' ||
        value.at.length > 64 ||
        !Number.isFinite(new Date(value.at).getTime())
      )
        throw new Error('INVALID_CURSOR');
      after = { at: value.at, id: id(value.id) };
    } catch {
      throw new AppError('INVALID_INPUT');
    }
  }
  return withTenantTx(database, context, async (tx) => {
    await requireSearchPerson(tx, context);
    const rows = await tx
      .select({ answer: knowledgeAnswers, at: sql<string>`${knowledgeAnswers.createdAt}::text` })
      .from(knowledgeAnswers)
      .where(
        and(
          answerVisible(context),
          after
            ? sql`(${knowledgeAnswers.createdAt},${knowledgeAnswers.id}) < (${after.at}::timestamptz,${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(knowledgeAnswers.createdAt), desc(knowledgeAnswers.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit),
      last = page.at(-1);
    return {
      items: await answerViews(
        tx,
        page.map((row) => row.answer),
      ),
      next:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ at: last.at, id: last.answer.id })).toString('base64url')
          : null,
    };
  });
}

export type AnswerStep = {
  outcome: 'answered' | 'no_evidence' | 'refused' | 'failed' | 'already_done';
  code: KnowledgeCode | null;
};

/**
 * The worker's half. `service` reads and writes the row. `asker` is the asker's delegated context
 * (`createDelegatedContext`), and all retrieval uses that, so a person who lost access mid-question gets
 * no evidence. No evidence means no model call and `no_evidence`, and an answer failing the citation check
 * is stored as `refused`, with its text discarded. Safe to run again.
 */
export async function runAnswer(
  database: AppDatabase,
  contexts: { service: TenantContext; asker: TenantContext },
  deps: CompileDeps,
  input: { answerId: string; signal: AbortSignal },
): Promise<AnswerStep> {
  const { service, asker } = contexts;
  if (
    service.actorType !== 'service' ||
    asker.actorType === 'service' ||
    service.organizationId !== asker.organizationId
  )
    throw new AppError('FORBIDDEN');
  const answerId = id(input.answerId);
  await withTenantTx(database, asker, (tx) => requireSearchPerson(tx, asker));
  const row = await withTenantTx(database, service, async (tx) => {
    const [current] = await tx
      .select()
      .from(knowledgeAnswers)
      .where(eq(knowledgeAnswers.id, answerId))
      .for('update');
    if (!current) return null;
    if (current.requesterMembershipId !== asker.membershipId) throw new AppError('FORBIDDEN');
    if (current.state !== 'queued') return null;
    await tx
      .update(knowledgeAnswers)
      .set({ state: 'running', version: current.version + 1 })
      .where(eq(knowledgeAnswers.id, answerId));
    return { ...current, version: current.version + 1 };
  });
  if (!row) return { outcome: 'already_done', code: null };
  let expectedSourceClasses: readonly { sourceId: string; classification: Classification }[] = [];
  let modelReceipt: ModelUsage | undefined;
  const finish = (
    state: 'answered' | 'no_evidence' | 'refused' | 'failed',
    code: KnowledgeCode | null,
    extra: Partial<typeof knowledgeAnswers.$inferInsert> = {},
    citations: readonly {
      chunkId: string;
      documentId: string;
      sourceId: string;
      answerStart: number;
      answerEnd: number;
    }[] = [],
  ) =>
    finishAnswer(
      database,
      service,
      answerId,
      row.version,
      state,
      code,
      extra,
      citations,
      expectedSourceClasses,
      deps.acceptResultInTx,
      modelReceipt,
    );
  try {
    const compiled = await compileEvidence(database, asker, deps, {
      purpose: 'answer',
      question: row.question,
      queryClassification: row.questionClassification as Classification,
      budgetTokens: MAX_EVIDENCE_TOKENS,
      signal: input.signal,
    });
    if (!compiled.ok)
      return finish(compiled.code === 'MODEL_UNAVAILABLE' ? 'failed' : 'refused', compiled.code);
    expectedSourceClasses = compiled.items.map((item) => ({
      sourceId: item.sourceId,
      classification: item.classification,
    }));
    const metadata = {
      packageId: compiled.packageId,
      strongestClassification: compiled.strongestClassification,
    };
    if (!compiled.items.length) return finish('no_evidence', 'NO_AUTHORIZED_EVIDENCE', metadata);
    if (!compiled.route) return finish('refused', 'NO_APPROVED_MODEL', metadata);
    if (input.signal.aborted) return finish('failed', 'MODEL_UNAVAILABLE', metadata);
    const fresh = await refreshEvidence(database, asker, compiled.items);
    if (!sameEvidence(compiled.items, fresh)) return finish('refused', 'EGRESS_DENIED', metadata);
    if (
      !(await verifiedFactsCurrent(
        database,
        asker,
        compiled.verifiedFacts.map((fact) => fact.factId),
      ))
    )
      return finish('refused', 'EGRESS_DENIED', metadata);
    const messages = buildAnswerMessages(row.question, compiled.items, {
      queryClassification: row.questionClassification as Classification,
      verifiedFacts: compiled.verifiedFacts,
      factsClassification: compiled.strongestClassification,
    });
    // Persist every input source before contacting the model, not merely the sources it later cites.
    // A revoke now hides this row immediately and the purge finds even an in-flight answer.
    const prepared = await withTenantTx(database, service, async (tx) => {
      const sourceIds = [...new Set(compiled.items.map((item) => item.sourceId))].sort();
      await tx.execute(sql`select s.id from knowledge.sources s where s.organization_id=${service.organizationId}::uuid
        and s.id in (${sql.join(
          sourceIds.map((value) => sql`${value}::uuid`),
          sql`, `,
        )})
        order by s.id for share`);
      const [current] = await tx
        .select()
        .from(knowledgeAnswers)
        .where(eq(knowledgeAnswers.id, answerId))
        .for('update');
      if (!current || current.state !== 'running' || current.version !== row.version) return false;
      const live = await tx.execute<{
        id: string;
      }>(sql`select s.id from knowledge.sources s where s.organization_id=${service.organizationId}::uuid
        and s.id in (${sql.join(
          sourceIds.map((value) => sql`${value}::uuid`),
          sql`, `,
        )})
        and s.id in (select knowledge.readable_source_ids(${asker.membershipId}::uuid)) and s.state='active'
        and (s.id,s.classification) in (${sql.join(
          sourceIds.map(
            (value) =>
              sql`(${value}::uuid,${compiled.items.find((item) => item.sourceId === value)!.classification})`,
          ),
          sql`, `,
        )})`);
      if (live.rows.length !== sourceIds.length) return false;
      if (!(await packageFactsStillVerified(tx, compiled.packageId))) return false;
      await tx
        .insert(knowledgeAnswerSources)
        .values(
          sourceIds.map((sourceId) => ({
            organizationId: service.organizationId,
            answerId,
            sourceId,
          })),
        )
        .onConflictDoNothing();
      await tx.update(knowledgeAnswers).set(metadata).where(eq(knowledgeAnswers.id, answerId));
      if (!deps.model.recordsCalls)
        await recordModelCall(tx, service, {
          purpose: 'answer',
          dataClass: compiled.strongestClassification,
          decision: 'allow',
          reasonCode: 'ALLOW',
          policyVersion: compiled.route!.policyVersion,
          route: compiled.route,
          requestSha256: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
          answerId,
          inputCount: messages.length,
        });
      return true;
    });
    if (!prepared) return finish('refused', 'EGRESS_DENIED', metadata);
    const result = await deps.model.answer(
      service.organizationId,
      compiled.route,
      messages,
      input.signal,
      {
        operationKey: operationKey({ kind: 'answer', answerId, packageId: compiled.packageId }),
        inputs: [
          ...compiled.recordInputs,
          ...compiled.items.map((item) => ({
            kind: 'chunk' as const,
            id: item.chunkId,
            sourceId: item.sourceId,
            sha256: item.contentSha256,
            classification: item.classification,
          })),
        ],
      },
    );
    modelReceipt = result.usage;
    metadata.strongestClassification = strongestClass([
      metadata.strongestClassification,
      result.usage.classification ?? metadata.strongestClassification,
    ]);
    if (!validUsage(result.usage)) return finish('failed', 'MODEL_UNAVAILABLE', metadata);
    const usage = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costMicros: result.usage.costMicros,
      modelProfileRef: compiled.route.modelProfileRef,
    };
    const checked = checkCitations(
      result.text,
      new Set(compiled.items.map((item) => item.citationKey)),
    );
    if (!checked.ok) return finish('refused', checked.code, { ...metadata, ...usage });
    const after = await refreshEvidence(database, asker, compiled.items);
    if (
      !sameEvidence(compiled.items, after) ||
      !(await verifiedFactsCurrent(
        database,
        asker,
        compiled.verifiedFacts.map((fact) => fact.factId),
      ))
    )
      return finish('refused', 'EGRESS_DENIED', { ...metadata, ...usage });
    const evidence = new Map(compiled.items.map((item) => [item.citationKey, item]));
    return finish(
      'answered',
      null,
      { ...metadata, ...usage, answerText: checked.text },
      checked.citations.map((citation) => {
        const item = evidence.get(citation.citationKey)!;
        return {
          chunkId: item.chunkId,
          documentId: item.documentId,
          sourceId: item.sourceId,
          answerStart: citation.start,
          answerEnd: citation.end,
        };
      }),
    );
  } catch (error) {
    const code =
      error instanceof ModelCallFailed &&
      (KNOWLEDGE_CODES as readonly string[]).includes(error.code)
        ? error.code
        : 'MODEL_UNAVAILABLE';
    return finish('failed', code);
  }
}

/** Also used by the no-model-worker Activity. Fixed codes only; a running call is never retried. */
export async function failKnowledgeAnswer(
  database: AppDatabase,
  service: TenantContext,
  answerId: string,
  code: 'MODEL_UNAVAILABLE' | 'NO_APPROVED_MODEL' = 'MODEL_UNAVAILABLE',
): Promise<void> {
  if (service.actorType !== 'service') throw new AppError('FORBIDDEN');
  const row = await withTenantTx(database, service, async (tx) => {
    const [current] = await tx
      .select()
      .from(knowledgeAnswers)
      .where(eq(knowledgeAnswers.id, id(answerId)));
    return current;
  });
  if (row && (row.state === 'queued' || row.state === 'running'))
    await finishAnswer(
      database,
      service,
      row.id,
      row.version,
      code === 'NO_APPROVED_MODEL' ? 'refused' : 'failed',
      code,
    );
}

type AnswerRow = typeof knowledgeAnswers.$inferSelect;
function answerVisible(context: TenantContext) {
  return sql`${knowledgeAnswers.requesterMembershipId}=${context.membershipId}::uuid and not exists (
    select 1 from knowledge.answer_sources x where x.organization_id=${knowledgeAnswers.organizationId} and x.answer_id=${knowledgeAnswers.id}
      and x.source_id not in (select knowledge.readable_source_ids(app.current_membership_id())))`;
}

async function answerViews(tx: Tx, rows: readonly AnswerRow[]): Promise<readonly AnswerView[]> {
  if (!rows.length) return [];
  const ids = sql.join(
    rows.map((row) => sql`${row.id}::uuid`),
    sql`, `,
  );
  const citations = await tx.execute<AnswerCitationView & { answerId: string }>(sql`
    select a.answer_id as "answerId", a.ordinal, a.answer_start as "answerStart", a.answer_end as "answerEnd",
           a.chunk_id as "chunkId", a.document_id as "documentId", a.source_id as "sourceId", d.title,
           left(c.text_body, 1000) as excerpt, d.source_version as "sourceVersion", d.source_url as "sourceUrl",
           d.source_modified_at as "sourceModifiedAt", case when d.superseded_at is null then 'current' else 'superseded' end as freshness
      from knowledge.answer_citations a join knowledge.chunks c on c.organization_id=a.organization_id and c.id=a.chunk_id and c.source_id=a.source_id
      join knowledge.documents d on d.organization_id=a.organization_id and d.id=a.document_id
     where a.answer_id in (${ids}) and a.source_id in (select knowledge.readable_source_ids(app.current_membership_id()))
     order by a.answer_id,a.ordinal`);
  // The citation read is another statement. Recheck after it, so a revoke between the two cannot
  // return the already-loaded answer with an empty set of citations. No cached words bypass this.
  const live = await tx.execute<{ id: string; classification: Classification | null }>(sql`
    select a.id, case greatest(knowledge.class_rank(a.strongest_classification),knowledge.class_rank(a.question_classification),
      coalesce((select max(knowledge.class_rank(s.classification)) from knowledge.answer_sources x join knowledge.sources s on s.organization_id=x.organization_id and s.id=x.source_id where x.organization_id=a.organization_id and x.answer_id=a.id),0))
      when 4 then 'restricted' when 3 then 'confidential' when 2 then 'internal' when 1 then 'public' else null end as classification
    from knowledge.answers a where a.id in (${ids}) and a.requester_membership_id=app.current_membership_id()
      and exists(select 1 from org.memberships m where m.organization_id=a.organization_id and m.id=app.current_membership_id() and m.status='active')
      and not exists(select 1 from knowledge.answer_sources x where x.organization_id=a.organization_id and x.answer_id=a.id and x.source_id not in(select knowledge.readable_source_ids(app.current_membership_id())))`);
  const liveById = new Map(live.rows.map((row) => [row.id, row.classification]));
  return rows
    .filter((row) => liveById.has(row.id))
    .map((row) => ({
      id: row.id,
      state: row.state as AnswerState,
      question: row.question,
      questionClassification: row.questionClassification as Classification,
      answerText: row.answerText,
      refusalCode: row.refusalCode as KnowledgeCode | null,
      citations: citations.rows
        .filter((citation) => citation.answerId === row.id)
        .map(({ answerId: _answerId, ...citation }) => citation),
      strongestClassification: liveById.get(row.id) ?? null,
      costMicros: row.costMicros,
      version: row.version,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    }));
}

async function finishAnswer(
  database: AppDatabase,
  service: TenantContext,
  answerId: string,
  version: number,
  state: 'answered' | 'no_evidence' | 'refused' | 'failed',
  code: KnowledgeCode | null,
  extra: Partial<typeof knowledgeAnswers.$inferInsert> = {},
  citations: readonly {
    chunkId: string;
    documentId: string;
    sourceId: string;
    answerStart: number;
    answerEnd: number;
  }[] = [],
  expectedSourceClasses: readonly { sourceId: string; classification: Classification }[] = [],
  acceptResultInTx?: ModelResultConsumer,
  modelReceipt?: ModelUsage,
): Promise<AnswerStep> {
  return withTenantTx(database, service, async (tx) => {
    // Source before answer matches purge's lock order. Grant changes bump the same source row.
    await tx.execute(sql`select s.id from knowledge.sources s join knowledge.answer_sources x on x.organization_id=s.organization_id and x.source_id=s.id
      where x.organization_id=${service.organizationId}::uuid and x.answer_id=${answerId}::uuid order by s.id for share of s`);
    const [current] = await tx
      .select()
      .from(knowledgeAnswers)
      .where(eq(knowledgeAnswers.id, answerId))
      .for('update');
    if (
      !current ||
      current.version !== version ||
      (current.state !== 'running' && current.state !== 'queued')
    )
      return { outcome: 'already_done', code: null };
    let finalState = state,
      finalCode = code;
    if (state === 'answered') {
      const denied =
        await tx.execute(sql`select 1 from knowledge.answer_sources x join knowledge.sources s on s.organization_id=x.organization_id and s.id=x.source_id
        where x.organization_id=${service.organizationId}::uuid and x.answer_id=${answerId}::uuid
          and (x.source_id not in(select knowledge.readable_source_ids(${current.requesterMembershipId}::uuid)) or knowledge.class_rank(s.classification)>knowledge.class_rank(${extra.strongestClassification ?? current.questionClassification})) limit 1`);
      if (denied.rows.length) {
        finalState = 'refused';
        finalCode = 'EGRESS_DENIED';
      }
      if (!expectedSourceClasses.length) {
        finalState = 'refused';
        finalCode = 'EGRESS_DENIED';
      } else {
        const changed =
          await tx.execute(sql`select 1 from knowledge.answer_sources x join knowledge.sources s on s.organization_id=x.organization_id and s.id=x.source_id
          where x.organization_id=${service.organizationId}::uuid and x.answer_id=${answerId}::uuid
            and s.id in (${sql.join(
              expectedSourceClasses.map((item) => sql`${item.sourceId}::uuid`),
              sql`, `,
            )})
            and (s.id,s.classification) not in (${sql.join(
              expectedSourceClasses.map(
                (item) => sql`(${item.sourceId}::uuid,${item.classification})`,
              ),
              sql`, `,
            )}) limit 1`);
        if (
          changed.rows.length ||
          !(current.packageId && (await packageFactsStillVerified(tx, current.packageId)))
        ) {
          finalState = 'refused';
          finalCode = 'EGRESS_DENIED';
        }
      }
    }
    if (finalState === 'answered' && citations.length)
      await tx.insert(knowledgeAnswerCitations).values(
        citations.map((citation, index) => ({
          organizationId: service.organizationId,
          answerId,
          ordinal: index + 1,
          ...citation,
        })),
      );
    await tx
      .update(knowledgeAnswers)
      .set({
        ...extra,
        state: finalState,
        refusalCode: finalCode,
        answerText: finalState === 'answered' ? (extra.answerText ?? null) : null,
        version: version + 1,
        finishedAt: new Date(),
      })
      .where(eq(knowledgeAnswers.id, answerId));
    if (finalState === 'answered' && modelReceipt?.callId) {
      if (!acceptResultInTx) throw new ModelCallFailed('MODEL_UNAVAILABLE');
      await acceptResultInTx(tx, modelReceipt, { kind: 'answer', id: answerId });
    }
    await emit(tx, service, {
      eventType: KNOWLEDGE_ANSWER_FINISHED,
      aggregateType: AGGREGATE_KNOWLEDGE_ANSWER,
      aggregateId: answerId,
      aggregateVersion: version + 1,
      classification: extra.strongestClassification ?? current.questionClassification,
      payload: { answer_id: answerId, outcome: finalState, code: finalCode },
    });
    await tx.insert(notifications).values({
      organizationId: service.organizationId,
      recipientMembershipId: current.requesterMembershipId,
      kind: NOTIFY_KNOWLEDGE_ANSWER_READY,
      targetRef: knowledgeAnswerTargetRef(answerId),
    });
    return { outcome: finalState, code: finalCode };
  });
}
async function packageFactsStillVerified(tx: Tx, packageId: string): Promise<boolean> {
  const result = await tx.execute<{ valid: boolean }>(sql`
    select not exists(select 1 from unnest(p.verified_fact_ids) fact_id
      left join knowledge.facts f on f.organization_id=p.organization_id and f.id=fact_id
      where f.id is null or f.trust_state<>'verified' or (f.valid_from is not null and f.valid_from>now()) or (f.valid_until is not null and f.valid_until<=now())) as valid
    from knowledge.evidence_packages p where p.id=${packageId}::uuid`);
  return result.rows[0]?.valid === true;
}
function id(value: string) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}
function validUsage(usage: ModelUsage) {
  return (
    Number.isSafeInteger(usage.inputTokens) &&
    usage.inputTokens >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    usage.outputTokens >= 0 &&
    (usage.costMicros === null || (Number.isSafeInteger(usage.costMicros) && usage.costMicros >= 0))
  );
}
