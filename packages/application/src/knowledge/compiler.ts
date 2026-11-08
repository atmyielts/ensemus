// Owned by the compile slice (KNOW-03). See docs/06-delivery/m5-slices.md and 05-context-compiler. Takes a
// context with a membership, never a service context, so what it can gather is what that person can read.
// M4's agent runtime calls this at the final merge, in place of its minimal compiler (M4 FD-17).
import { createHash, randomUUID } from 'node:crypto';
import {
  knowledgeEvidenceItems,
  knowledgeEvidencePackages,
  evidencePackageFacts,
  agentRuns,
  runInputCheckpoints,
  withTenantTx,
  type AppDatabase,
  type AgentContext,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import type { Classification } from '@ensemus/domain/policy';
import { MAX_EVIDENCE_TOKENS, strongestClass } from '@ensemus/domain/knowledge';
import {
  packageHash,
  selectEvidence,
  type EvidenceCandidate,
  type SelectedEvidence,
} from '@ensemus/knowledge/evidence';
import {
  ModelCallFailed,
  type KnowledgeModelPort,
  type ModelPurpose,
  type ModelRoute,
  type ModelUsage,
  type ModelInputRef,
} from '@ensemus/knowledge/ports';
import { operationKey } from '@ensemus/knowledge/model-operations';
import type { ModelResultConsumer } from '../ai/knowledge-ports';
import { ANSWER_PROMPT_VERSION } from '@ensemus/knowledge/prompt';
import { eq, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { embedQuery, recordModelCall } from './embeddings';
import { verifiedFactsFor } from './facts';
import { requireSearchPerson, retrieveHybrid, searchLexical, searchQuery } from './retrieval';
import {
  assertRunInputsReadable,
  recordRunInputs,
  workInputHash,
  workInputClassInTx,
  type ObservedInput,
} from '../ai/input-observations';
import { assertWithinAgentProtection, loadAgentReadScope } from '../ai/read-scope';

export type CompileDeps = {
  model: KnowledgeModelPort;
  acceptResultInTx?: ModelResultConsumer;
  /** The actual main-agent purpose/profile policy, distinct from Knowledge answer generation. */
  authorizeAgentContext?: (
    context: AgentContext,
    input: { classification: Classification },
  ) => Promise<boolean>;
};

export type CompileInput = {
  purpose: 'answer' | 'agent_turn' | 'query';
  /** What is being asked or worked on. Hashed for the record, and never stored here. */
  question: string;
  /** The question can quote a secret independently of all retrieved evidence. */
  queryClassification: Classification;
  workUnitId?: string;
  runId?: string;
  /** Capped by `MAX_EVIDENCE_TOKENS`. */
  budgetTokens: number;
  sourceIds?: readonly string[];
  maxClassification?: Classification;
  signal: AbortSignal;
};

export type CompiledEvidence =
  | {
      ok: true;
      packageId: string;
      packageSha256: string;
      policyVersion: string;
      items: readonly SelectedEvidence[];
      /** Only verified facts, marked as such. A model's unverified guess never appears here (Gate C). */
      verifiedFacts: readonly {
        factId: string;
        subjectRef: string;
        predicate: string;
        claim: unknown;
      }[];
      /** Actual structured parent reads, captured inside the same fact body-read transaction. */
      recordInputs: readonly ModelInputRef[];
      usedTokens: number;
      strongestClassification: Classification;
      /** A model every included class may reach, by `purpose`. Null only for an empty package. */
      route: ModelRoute | null;
    }
  | { ok: false; code: 'NO_APPROVED_MODEL' | 'EGRESS_DENIED' | 'MODEL_UNAVAILABLE' };

/**
 * Retrieve, rerank if allowed, dedupe, trim to budget, then check egress against every included class. If
 * the strongest class has no route, it drops to the classes that have one only when `purpose` is `answer`
 * and that leaves evidence, and otherwise stops. Writes one append-only package row with hashes and IDs.
 */
export async function compileEvidence(
  database: AppDatabase,
  context: TenantContext,
  deps: CompileDeps,
  input: CompileInput,
): Promise<CompiledEvidence> {
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  if (input.purpose === 'agent_turn' && context.actorType !== 'agent')
    throw new AppError('FORBIDDEN');
  const question = searchQuery(input.question);
  if (!question || !Number.isSafeInteger(input.budgetTokens) || input.budgetTokens < 1)
    throw new AppError('INVALID_INPUT');
  const budget = Math.min(input.budgetTokens, MAX_EVIDENCE_TOKENS);
  const queryClass = validClass(input.queryClassification ?? 'restricted');
  const workUnitId = input.workUnitId ? id(input.workUnitId) : null;
  const runId = input.runId ? id(input.runId) : null;
  const agentContext: AgentContext | null = (() => {
    if (context.actorType === 'agent') {
      if (
        !context.agentRunId ||
        !runId ||
        context.agentRunId !== runId ||
        !workUnitId ||
        input.purpose !== 'agent_turn'
      )
        throw new AppError('FORBIDDEN');
      return { ...context, actorType: 'agent', agentRunId: context.agentRunId };
    }
    if (runId) throw new AppError('FORBIDDEN');
    return null;
  })();
  let sourceIds = input.sourceIds?.map(id);
  let maxClassification = input.maxClassification;
  if (maxClassification !== undefined) validClass(maxClassification);
  if (agentContext) {
    const scope = await loadAgentReadScope(database, agentContext);
    if (!scope.sourceIds.length) return { ok: false, code: 'EGRESS_DENIED' };
    sourceIds = sourceIds
      ? sourceIds.filter((id) => scope.sourceIds.includes(id))
      : [...scope.sourceIds];
    if (
      scope.ceiling &&
      (!maxClassification || classRank(scope.ceiling) < classRank(maxClassification))
    )
      maxClassification = scope.ceiling;
    assertWithinAgentProtection({ ...scope, ceiling: maxClassification ?? null }, queryClass);
  }
  const classAllowed = (classification: Classification) =>
    !maxClassification || classRank(classification) <= classRank(maxClassification);
  const protectionAllowed = (classification: Classification) =>
    !maxClassification ||
    classRank(classification) <= Math.max(classRank(maxClassification), classRank('internal'));
  const recordInputs: ModelInputRef[] = [];
  const usedModelResults: ModelUsage[] = [];
  const state = await withTenantTx(database, context, async (tx) => {
    await requireSearchPerson(tx, context);
    if (!workUnitId) return { classification: queryClass, subjects: [] as string[] };
    const result = await tx.execute<{
      classification: Classification;
      projectId: string | null;
      clientId: string | null;
      title: string;
      objective: string | null;
    }>(sql`
      select w.classification,w.title,w.objective,w.project_id as "projectId", p.client_id as "clientId"
        from work.work_units w left join work.projects p on p.organization_id = w.organization_id and p.id = w.project_id
       where w.organization_id = ${context.organizationId}::uuid and w.id = ${workUnitId}::uuid
         and knowledge.can_read_work(w.id, app.current_membership_id())
         ${maxClassification ? sql`and knowledge.structured_record_class('work_unit',w.id) is not null and knowledge.class_rank(knowledge.structured_record_class('work_unit',w.id))<=knowledge.class_rank(${maxClassification})` : sql``} for share of w nowait`);
    const work = result.rows[0];
    if (!work) throw new AppError('NOT_FOUND');
    const lockedClass = await workInputClassInTx(tx, workUnitId, 'public');
    if (!classAllowed(lockedClass)) throw new AppError('POLICY_DENIED');
    const effectiveClass = strongestClass([lockedClass, work.classification]);
    recordInputs.push({
      kind: 'work_unit',
      id: workUnitId,
      sha256: workInputHash(work),
      classification: effectiveClass,
    });
    if (agentContext)
      await recordRunInputs(tx, agentContext, [
        {
          kind: 'work_unit',
          id: workUnitId,
          sha256: workInputHash(work),
          classification: effectiveClass,
        },
      ]);
    return {
      classification: strongestClass([queryClass, effectiveClass]),
      subjects: [
        `work_unit:${workUnitId}`,
        ...(work.projectId ? [`project:${work.projectId}`] : []),
        ...(work.clientId ? [`client:${work.clientId}`] : []),
      ],
    };
  });
  let derivedClassification = state.classification;
  const raiseDerived = (classification: Classification) => {
    derivedClassification = strongestClass([derivedClassification, classification]);
    state.classification = strongestClass([state.classification, derivedClassification]);
    if (!protectionAllowed(state.classification)) throw new AppError('POLICY_DENIED');
  };
  const refreshTaskClass = async () => {
    if (!workUnitId) return;
    const result = await withTenantTx(database, context, async (tx) => {
      await requireSearchPerson(tx, context);
      return tx.execute<{ classification: Classification }>(
        sql`select knowledge.structured_record_class('work_unit',w.id) classification from work.work_units w where w.organization_id=${context.organizationId}::uuid and w.id=${workUnitId}::uuid and knowledge.can_read_work(w.id,app.current_membership_id())`,
      );
    });
    if (!result.rows[0]) throw new AppError('NOT_FOUND');
    if (!classAllowed(result.rows[0].classification)) throw new AppError('POLICY_DENIED');
    state.classification = strongestClass([
      queryClass,
      result.rows[0].classification,
      derivedClassification,
    ]);
    if (!protectionAllowed(state.classification)) throw new AppError('POLICY_DENIED');
  };
  if (input.signal.aborted) return { ok: false, code: 'MODEL_UNAVAILABLE' };
  let candidates: readonly EvidenceCandidate[] = await searchLexical(database, context, {
    query: question,
    limit: 50,
    ...(sourceIds ? { sourceIds } : {}),
    ...(maxClassification ? { maxClassification } : {}),
  });
  let spaceId: string | null = null;
  // No question is embedded just because a hidden tenant-wide space exists. There must be a current
  // authorized vector to search, and embedQuery applies the question's own egress classification.
  const vectors = await withTenantTx(database, context, async (tx) => {
    await requireSearchPerson(tx, context);
    const scope = sourceIds
      ? sourceIds.length
        ? sql`and e.source_id in (${sql.join(
            sourceIds.map((value) => sql`${id(value)}::uuid`),
            sql`, `,
          )})`
        : sql`and false`
      : sql``;
    return tx.execute(sql`select 1 from knowledge.embeddings e
      join knowledge.embedding_spaces sp on sp.organization_id = e.organization_id and sp.id = e.space_id and sp.state = 'active'
      join knowledge.chunks c on c.organization_id = e.organization_id and c.id = e.chunk_id
      join knowledge.documents d on d.organization_id = c.organization_id and d.id = c.document_id
      where e.organization_id = ${context.organizationId}::uuid and d.state = 'searchable' and d.superseded_at is null
        and e.source_id in (select knowledge.readable_source_ids(app.current_membership_id())) ${scope}
        ${maxClassification ? sql`and greatest(knowledge.class_rank(d.classification),(select knowledge.class_rank(s.classification) from knowledge.sources s where s.organization_id=d.organization_id and s.id=d.source_id))<=knowledge.class_rank(${maxClassification})` : sql``} limit 1`);
  });
  if (vectors.rows.length) {
    try {
      await refreshTaskClass();
      const embedded = await embedQuery(database, context, deps, {
        query: question,
        classification: state.classification,
        signal: input.signal,
        recordInputs,
      });
      if (embedded.ok) {
        raiseDerived(embedded.usage.classification ?? state.classification);
        usedModelResults.push(embedded.usage);
        spaceId = embedded.spaceId;
        candidates = (
          await retrieveHybrid(database, context, {
            query: question,
            queryVector: embedded,
            limit: 50,
            ...(sourceIds ? { sourceIds } : {}),
            ...(maxClassification ? { maxClassification } : {}),
          })
        ).passages;
      }
    } catch {
      // An unavailable embedding provider never takes the lexical path away.
    }
  }
  candidates = await refreshEvidence(database, context, candidates, maxClassification);
  if (candidates.length && !input.signal.aborted) {
    await refreshTaskClass();
    const rerank = await routeForClasses(
      database,
      context,
      deps.model,
      'rerank',
      [state.classification, ...candidates.map((item) => item.classification)],
      digest(JSON.stringify([question, ...candidates.map((item) => item.text)])),
    );
    if (rerank.ok) {
      try {
        const fresh = await refreshEvidence(database, context, candidates, maxClassification);
        if (sameEvidence(candidates, fresh)) {
          if (!deps.model.recordsCalls)
            await withTenantTx(database, context, (tx) =>
              recordModelCall(tx, context, {
                purpose: 'rerank',
                dataClass: strongestClass([
                  state.classification,
                  ...fresh.map((item) => item.classification),
                ]),
                decision: 'allow',
                reasonCode: 'ALLOW',
                policyVersion: rerank.route.policyVersion,
                route: rerank.route,
                requestSha256: digest(
                  JSON.stringify([question, ...fresh.map((item) => item.text)]),
                ),
                inputCount: fresh.length,
              }),
            );
          const result = await deps.model.rerank(
            context.organizationId,
            rerank.route,
            question,
            fresh.map((item) => item.text),
            input.signal,
            {
              operationKey: operationKey({
                kind: 'rerank',
                query: question,
                qualificationId: rerank.route.qualificationId,
                chunks: fresh.map((item) => [item.chunkId, item.contentSha256]),
              }),
              inputs: [
                ...recordInputs,
                ...fresh.map((item) => ({
                  kind: 'chunk' as const,
                  id: item.chunkId,
                  sourceId: item.sourceId,
                  sha256: item.contentSha256,
                  classification: item.classification,
                })),
              ],
            },
          );
          const order = result.order;
          if (
            order.every(
              (position) =>
                Number.isSafeInteger(position) && position >= 0 && position < fresh.length,
            ) &&
            new Set(order).size === order.length
          ) {
            raiseDerived(
              result.usage.classification ??
                strongestClass([state.classification, ...fresh.map((item) => item.classification)]),
            );
            usedModelResults.push(result.usage);
            const positions = [
              ...order,
              ...fresh.map((_, index) => index).filter((index) => !order.includes(index)),
            ];
            candidates = positions.map((position, index) => ({
              ...fresh[position]!,
              score: fresh.length - index,
            }));
          }
        } else candidates = fresh;
      } catch {
        /* A failed optional reranker keeps the authorized retrieval order. */
      }
    }
  }
  candidates = await refreshEvidence(database, context, candidates, maxClassification);
  let selection = selectEvidence(candidates, budget);
  let facts = selection.items.length
    ? await verifiedFactsFor(database, context, {
        subjectRefs: [
          ...new Set([
            ...state.subjects,
            ...selection.items.map((item) => `knowledge_source:${item.sourceId}`),
          ]),
        ],
        limit: 20,
        ...(sourceIds ? { sourceIds } : {}),
        ...(maxClassification ? { maxClassification } : {}),
        captureReadsInTx: async (tx: Tx, inputs: readonly ObservedInput[]) => {
          recordInputs.push(
            ...inputs.filter(
              (value): value is ObservedInput & { kind: 'work_unit' | 'project' | 'client' } =>
                value.kind !== 'artifact',
            ),
          );
          if (agentContext) await recordRunInputs(tx, agentContext, inputs);
        },
      })
    : [];
  // A trusted claim is included only with all of its underlying passages, so it cannot smuggle an
  // uncited or revoked source into the package. Whole facts, like whole passages, must fit the budget.
  const selectedIds = new Set(selection.items.map((item) => item.chunkId));
  facts = facts.filter(
    (fact) =>
      fact.trustState === 'verified' &&
      fact.evidence.length &&
      fact.evidence.every((evidence) => selectedIds.has(evidence.chunkId)),
  );
  let factTokens = 0;
  facts = facts.filter((fact) => {
    const tokens = Math.ceil(
      JSON.stringify({
        factId: fact.id,
        subjectRef: fact.subjectRef,
        predicate: fact.predicate,
        claim: fact.claim,
      }).length / 4,
    );
    if (selection.usedTokens + factTokens + tokens > budget) return false;
    factTokens += tokens;
    return true;
  });
  let route: ModelRoute | null = null;
  await refreshTaskClass();
  const routedTaskClass = state.classification;
  if (selection.items.length && agentContext) {
    if (
      !deps.authorizeAgentContext ||
      !(await deps.authorizeAgentContext(agentContext, {
        classification: strongestClass([
          state.classification,
          ...selection.items.map((item) => item.classification),
          ...facts.map((fact) => fact.classification),
        ]),
      }))
    )
      return { ok: false, code: 'EGRESS_DENIED' };
  } else if (selection.items.length && input.purpose === 'answer') {
    let verdict = await routeForClasses(
      database,
      context,
      deps.model,
      'answer',
      [
        state.classification,
        ...selection.items.map((item) => item.classification),
        ...facts.map((fact) => fact.classification),
      ],
      digest(JSON.stringify([question, ...selection.items.map((item) => item.text)])),
    );
    if (!verdict.ok && input.purpose === 'answer') {
      // Only ordinary answers may shed evidence, and the question's class can never be shed with it.
      const retained: EvidenceCandidate[] = [];
      for (const candidate of candidates) {
        const allowed = await routeForClasses(
          database,
          context,
          deps.model,
          'answer',
          [state.classification, candidate.classification],
          digest(JSON.stringify([question, candidate.text])),
        );
        if (allowed.ok) retained.push(candidate);
      }
      selection = selectEvidence(retained, budget);
      facts = [];
      factTokens = 0;
      if (!selection.items.length) return { ok: false, code: verdict.code };
      verdict = await routeForClasses(
        database,
        context,
        deps.model,
        'answer',
        [state.classification, ...selection.items.map((item) => item.classification)],
        digest(JSON.stringify([question, ...selection.items.map((item) => item.text)])),
      );
    }
    if (!verdict.ok) return verdict;
    route = verdict.route;
  }
  const fresh = await refreshEvidence(database, context, selection.items, maxClassification);
  if (!sameEvidence(selection.items, fresh)) return { ok: false, code: 'EGRESS_DENIED' };
  await refreshTaskClass();
  if (
    state.classification !== routedTaskClass ||
    !(await verifiedFactsCurrent(
      database,
      context,
      facts.map((fact) => fact.id),
    ))
  )
    return { ok: false, code: 'EGRESS_DENIED' };
  if (input.signal.aborted) return { ok: false, code: 'MODEL_UNAVAILABLE' };
  const policyVersion = `knowledge-v1:prompt-${ANSWER_PROMPT_VERSION}:${route?.policyVersion ?? 'no-model'}`;
  const querySha256 = digest(question);
  const packageId = randomUUID();
  const classification = strongestClass([
    state.classification,
    ...selection.items.map((item) => item.classification),
    ...facts.map((fact) => fact.classification),
  ]);
  // Hash the actual in-memory claims read above, once. These exact hashes are both in the package
  // digest and the retained fact receipt; no later lookup reconstructs a historical claim read.
  const factReceipts = facts.map((fact) => ({
    factId: fact.id,
    contentSha256: digest(
      JSON.stringify({ subjectRef: fact.subjectRef, predicate: fact.predicate, claim: fact.claim }),
    ),
    classification: fact.classification,
  }));
  const evidenceHash = packageHash({
    querySha256,
    policyVersion,
    items: selection.items,
    facts: factReceipts,
  });
  const persisted = await withTenantTx(database, context, async (tx) => {
    await requireSearchPerson(tx, context);
    if (selection.items.length) {
      const sourceIds = [...new Set(selection.items.map((item) => item.sourceId))].sort();
      // Closing a source takes the same row lock. Its purge cannot finish, then discover that a
      // previously read passage published a new run provenance row after the source had closed.
      await tx.execute(
        sql`select s.id from knowledge.sources s where s.organization_id=${context.organizationId}::uuid and s.id in (${sql.join(
          sourceIds.map((value) => sql`${value}::uuid`),
          sql`, `,
        )}) order by s.id for share`,
      );
      const live = await tx.execute<{
        id: string;
      }>(sql`select c.id from knowledge.chunks c join knowledge.documents d on d.organization_id=c.organization_id and d.id=c.document_id
        join knowledge.sources s on s.organization_id=c.organization_id and s.id=c.source_id where c.organization_id=${context.organizationId}::uuid
          and s.state='active' and d.state='searchable' and d.superseded_at is null
          and c.source_id in(select knowledge.readable_source_ids(app.current_membership_id()))
          and (c.id,c.content_sha256,greatest(knowledge.class_rank(s.classification),knowledge.class_rank(d.classification))) in
            (${sql.join(
              selection.items.map(
                (item) =>
                  sql`(${item.chunkId}::uuid,${item.contentSha256},knowledge.class_rank(${item.classification}))`,
              ),
              sql`, `,
            )})`);
      if (live.rows.length !== selection.items.length) return false;
    }
    if (facts.length) {
      const valid = await tx.execute<{
        id: string;
      }>(sql`select f.id from knowledge.facts f where f.organization_id=${context.organizationId}::uuid
        and f.id in (${sql.join(
          facts.map((fact) => sql`${fact.id}::uuid`),
          sql`, `,
        )}) and f.trust_state='verified'
        and (f.valid_from is null or f.valid_from<=now()) and (f.valid_until is null or f.valid_until>now()) order by f.id for share`);
      if (valid.rows.length !== facts.length) return false;
      // A later addition/replacement is stale, not evidence that was read earlier. Pin the exact
      // already-read set, and require its hashes in the selected passages before publishing.
      const backing = await tx.execute<{
        fact_id: string;
        chunk_id: string;
        source_id: string;
        content_sha256: string;
      }>(sql`select e.fact_id,e.chunk_id,e.source_id,e.content_sha256 from knowledge.fact_evidence e
        where e.organization_id=${context.organizationId}::uuid and e.fact_id in(${sql.join(
          facts.map((fact) => sql`${fact.id}::uuid`),
          sql`,`,
        )}) order by e.fact_id,e.chunk_id`);
      for (const fact of facts) {
        const current = backing.rows.filter((row) => row.fact_id === fact.id);
        if (
          current.length !== fact.evidence.length ||
          fact.evidence.some(
            (evidence) =>
              !current.some(
                (row) =>
                  row.chunk_id === evidence.chunkId &&
                  row.source_id === evidence.sourceId &&
                  selection.items.some(
                    (item) =>
                      item.chunkId === row.chunk_id &&
                      item.sourceId === row.source_id &&
                      item.contentSha256 === row.content_sha256,
                  ),
              ),
          )
        )
          return false;
      }
    }
    if (workUnitId) {
      const work = await tx.execute<{ classification: Classification }>(
        sql`select knowledge.structured_record_class('work_unit',w.id) classification from work.work_units w where w.organization_id=${context.organizationId}::uuid and w.id=${workUnitId}::uuid and knowledge.can_read_work(w.id,app.current_membership_id()) for share`,
      );
      if (
        !work.rows[0] ||
        strongestClass([queryClass, work.rows[0].classification, derivedClassification]) !==
          state.classification
      )
        return false;
    }
    if (agentContext) {
      // Same order as actual observations and main dispatch: body/source locks, checkpoint, run.
      // A main snapshot either precedes this publication or includes it, never guesses by time.
      await tx
        .select({ id: runInputCheckpoints.runId })
        .from(runInputCheckpoints)
        .where(eq(runInputCheckpoints.runId, agentContext.agentRunId))
        .for('share');
      await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.id, agentContext.agentRunId))
        .for('update', { noWait: true });
      await assertRunInputsReadable(tx, agentContext);
    }
    await tx.insert(knowledgeEvidencePackages).values({
      organizationId: context.organizationId,
      id: packageId,
      purpose: input.purpose,
      workUnitId,
      runId,
      viewerMembershipId: context.membershipId,
      querySha256,
      policyVersion,
      spaceId,
      budgetTokens: budget,
      usedTokens: selection.usedTokens + factTokens,
      strongestClassification: classification,
      verifiedFactIds: facts.map((fact) => fact.id),
      packageSha256: evidenceHash,
    });
    if (selection.items.length)
      await tx.insert(knowledgeEvidenceItems).values(
        selection.items.map((item, index) => ({
          organizationId: context.organizationId,
          packageId,
          ordinal: index + 1,
          chunkId: item.chunkId,
          documentId: item.documentId,
          sourceId: item.sourceId,
          contentSha256: item.contentSha256,
          classification: item.classification,
          tokenEstimate: item.tokenEstimate,
          lexicalRank: item.lexicalRank,
          vectorRank: item.vectorRank,
        })),
      );
    if (factReceipts.length)
      await tx
        .insert(evidencePackageFacts)
        .values(
          factReceipts.map((fact) => ({
            organizationId: context.organizationId,
            packageId,
            ...fact,
          })),
        );
    for (const usage of usedModelResults) {
      if (usage.callId) {
        if (!deps.acceptResultInTx) throw new ModelCallFailed('MODEL_UNAVAILABLE');
        await deps.acceptResultInTx(tx, usage, { kind: 'evidence', id: packageId });
      }
    }
    return true;
  });
  if (!persisted) return { ok: false, code: 'EGRESS_DENIED' };
  if (agentContext)
    await withTenantTx(database, agentContext, (tx) => assertRunInputsReadable(tx, agentContext));
  return {
    ok: true,
    packageId,
    packageSha256: evidenceHash,
    policyVersion,
    items: selection.items,
    verifiedFacts: facts.map((fact) => ({
      factId: fact.id,
      subjectRef: fact.subjectRef,
      predicate: fact.predicate,
      claim: fact.claim,
    })),
    usedTokens: selection.usedTokens + factTokens,
    strongestClassification: classification,
    route,
    recordInputs,
  };
}

/** Rechecks words and their live class before each egress boundary, without holding a model call open. */
export async function refreshEvidence(
  database: AppDatabase,
  context: TenantContext,
  items: readonly EvidenceCandidate[],
  maxClassification?: Classification,
): Promise<readonly EvidenceCandidate[]> {
  return withTenantTx(database, context, async (tx) => {
    await requireSearchPerson(tx, context);
    if (!items.length) return [];
    const result = await tx.execute<{
      chunkId: string;
      text: string;
      contentSha256: string;
      classification: Classification;
      title: string;
      sourceVersion: string | null;
      sourceModifiedAt: Date | null;
    }>(sql`
      select c.id as "chunkId", c.text_body as text, c.content_sha256 as "contentSha256", d.title,
             d.source_version as "sourceVersion", d.source_modified_at as "sourceModifiedAt",
             case when knowledge.class_rank(s.classification) > knowledge.class_rank(d.classification) then s.classification else d.classification end as classification
        from knowledge.chunks c join knowledge.documents d on d.organization_id = c.organization_id and d.id = c.document_id
        join knowledge.sources s on s.organization_id = c.organization_id and s.id = c.source_id
       where c.organization_id = ${context.organizationId}::uuid and c.id in (${sql.join(
         items.map((item) => sql`${id(item.chunkId)}::uuid`),
         sql`, `,
       )})
         and s.state = 'active' and d.state = 'searchable' and d.superseded_at is null
         and c.source_id in (select knowledge.readable_source_ids(app.current_membership_id()))
         ${maxClassification ? sql`and greatest(knowledge.class_rank(s.classification),knowledge.class_rank(d.classification))<=knowledge.class_rank(${maxClassification})` : sql``}`);
    const previous = new Map(items.map((item) => [item.chunkId, item]));
    const live = new Map(result.rows.map((row) => [row.chunkId, row]));
    return items.flatMap((item) => {
      const row = live.get(item.chunkId);
      return row ? [{ ...previous.get(row.chunkId)!, ...row }] : [];
    });
  });
}

export function sameEvidence(
  before: readonly EvidenceCandidate[],
  after: readonly EvidenceCandidate[],
): boolean {
  const byId = new Map(after.map((item) => [item.chunkId, item]));
  return (
    before.length === after.length &&
    before.every((item) => {
      const current = byId.get(item.chunkId);
      return (
        current &&
        item.contentSha256 === current.contentSha256 &&
        item.classification === current.classification
      );
    })
  );
}

async function routeForClasses(
  database: AppDatabase,
  context: TenantContext,
  model: KnowledgeModelPort,
  purpose: ModelPurpose,
  classes: readonly Classification[],
  requestSha256: string,
): Promise<
  | { ok: true; route: ModelRoute }
  | { ok: false; code: 'NO_APPROVED_MODEL' | 'EGRESS_DENIED' | 'MODEL_UNAVAILABLE' }
> {
  const distinct = [...new Set(classes)].sort((a, b) => classRank(b) - classRank(a));
  let selected: ModelRoute | null = null;
  for (const classification of distinct) {
    try {
      const result = await model.route({
        organizationId: context.organizationId,
        purpose,
        classification,
      });
      if (result.decision === 'deny') {
        const code =
          result.reasonCode === 'NO_APPROVED_MODEL' ? 'NO_APPROVED_MODEL' : 'EGRESS_DENIED';
        await withTenantTx(database, context, (tx) =>
          recordModelCall(tx, context, {
            purpose,
            dataClass: classification,
            decision: 'deny',
            reasonCode: code,
            policyVersion: result.policyVersion,
            requestSha256,
            inputCount: 0,
          }),
        );
        return { ok: false, code };
      }
      if (
        selected &&
        (selected.modelProfileRef !== result.route.modelProfileRef ||
          selected.modelProfileVersion !== result.route.modelProfileVersion ||
          selected.modelId !== result.route.modelId ||
          selected.destinationHost !== result.route.destinationHost ||
          selected.policyVersion !== result.route.policyVersion)
      ) {
        await withTenantTx(database, context, (tx) =>
          recordModelCall(tx, context, {
            purpose,
            dataClass: classification,
            decision: 'deny',
            reasonCode: 'EGRESS_DENIED',
            policyVersion: result.route.policyVersion,
            requestSha256,
            inputCount: 0,
          }),
        );
        return { ok: false, code: 'EGRESS_DENIED' };
      }
      selected = result.route;
    } catch (error) {
      return {
        ok: false,
        code:
          error instanceof ModelCallFailed && error.code === 'NO_APPROVED_MODEL'
            ? 'NO_APPROVED_MODEL'
            : 'MODEL_UNAVAILABLE',
      };
    }
  }
  return selected ? { ok: true, route: selected } : { ok: false, code: 'NO_APPROVED_MODEL' };
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** A review can withdraw trust independently of the source ACL, including while a model is running. */
export async function verifiedFactsCurrent(
  database: AppDatabase,
  context: TenantContext,
  factIds: readonly string[],
): Promise<boolean> {
  if (!factIds.length) return true;
  return withTenantTx(database, context, async (tx) => {
    await requireSearchPerson(tx, context);
    const result = await tx.execute<{
      id: string;
    }>(sql`select f.id from knowledge.facts f where f.organization_id=${context.organizationId}::uuid
      and f.id in (${sql.join(
        factIds.map((value) => sql`${id(value)}::uuid`),
        sql`, `,
      )}) and f.trust_state='verified'
      and (f.valid_from is null or f.valid_from<=now()) and (f.valid_until is null or f.valid_until>now())
      and exists(select 1 from knowledge.fact_evidence e where e.organization_id=f.organization_id and e.fact_id=f.id)
      and not exists(select 1 from knowledge.fact_evidence e where e.organization_id=f.organization_id and e.fact_id=f.id and e.source_id not in(select knowledge.readable_source_ids(app.current_membership_id())))`);
    return result.rows.length === new Set(factIds).size;
  });
}
const classRank = (value: Classification) =>
  ['public', 'internal', 'confidential', 'restricted'].indexOf(value);
function validClass(value: Classification) {
  if (classRank(value) < 0) throw new AppError('INVALID_INPUT');
  return value;
}
function id(value: string) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}
