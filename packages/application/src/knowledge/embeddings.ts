// Owned by the egress slice (MODEL-05). See docs/06-delivery/m5-slices.md and ADR-029 D5, D6. Deny comes
// before any text leaves, and is recorded. Runs only in the process that can reach a model.
import { createHash, randomUUID } from 'node:crypto';
import {
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeEmbeddings,
  knowledgeEmbeddingSpaces,
  knowledgeModelCalls,
  knowledgeSources,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import type { EmbeddingState, KnowledgeCode } from '@ensemus/domain/knowledge';
import {
  KNOWLEDGE_CODES,
  MAX_CHUNKS_PER_DOCUMENT,
  strongestClass,
} from '@ensemus/domain/knowledge';
import type { Classification } from '@ensemus/domain/policy';
import {
  ModelCallFailed,
  type KnowledgeModelPort,
  type ModelPurpose,
  type ModelRoute,
} from '@ensemus/knowledge/ports';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { idSchema } from '../ids';
import { requireSearchPerson, searchQuery } from './retrieval';

export type EmbeddingDeps = { model: KnowledgeModelPort; batchSize?: number };

export type EmbedStep = { state: EmbeddingState; code: KnowledgeCode | null; embedded: number };

export type EmbeddingSpace = {
  id: string;
  modelId: string;
  dimension: number;
  vectorSpaceVersion: string;
};

export type ModelCallEntry = {
  purpose: ModelPurpose;
  dataClass: Classification;
  decision: 'allow' | 'deny';
  reasonCode: string;
  policyVersion: string;
  /** SHA-256 of what would go, so a call can be matched without keeping the text. */
  requestSha256: string;
  route?: ModelRoute | null;
  documentId?: string | null;
  answerId?: string | null;
  inputCount?: number;
};

/** Appends one row. A denied call writes this too: it is how an admin sees what was stopped. */
export async function recordModelCall(
  tx: Tx,
  context: TenantContext,
  entry: ModelCallEntry,
): Promise<void> {
  if (
    !['embed', 'rerank', 'answer'].includes(entry.purpose) ||
    !validClass(entry.dataClass) ||
    !['allow', 'deny'].includes(entry.decision) ||
    !/^[0-9a-f]{64}$/.test(entry.requestSha256) ||
    !Number.isSafeInteger(entry.inputCount ?? 0) ||
    (entry.inputCount ?? 0) < 0
  )
    throw new AppError('INVALID_INPUT');
  if (entry.decision === 'allow' && !entry.route) throw new AppError('INVALID_INPUT');
  if (entry.route) validateRoute(entry.route);
  await tx.insert(knowledgeModelCalls).values({
    organizationId: context.organizationId,
    purpose: entry.purpose,
    dataClass: entry.dataClass,
    decision: entry.decision,
    reasonCode: safeCode(entry.reasonCode, 'EGRESS_DENIED'),
    policyVersion: safeCode(entry.policyVersion, 'unavailable'),
    requestSha256: entry.requestSha256,
    modelProfileRef: entry.route?.modelProfileRef ?? null,
    modelProfileVersion: entry.route?.modelProfileVersion ?? null,
    providerKind: entry.route?.providerKind ?? null,
    destinationHost: entry.route?.destinationHost ?? null,
    documentId: entry.documentId ? id(entry.documentId) : null,
    answerId: entry.answerId ? id(entry.answerId) : null,
    inputCount: entry.inputCount ?? 0,
  });
}

/**
 * One document's chunks into the active space. Asks `route` with the document's class first: a deny writes
 * a `model_calls` row, sets `embedding_state = 'denied'` with the code, and contacts nothing (QA-011). It
 * rechecks the source before each batch, sends no text after it closes, and a repeat skips what is done.
 * A vector of the wrong length is refused by the database, and ends `failed` with `SPACE_MISMATCH`.
 */
export async function embedDocument(
  database: AppDatabase,
  context: TenantContext,
  deps: EmbeddingDeps,
  input: { documentId: string; signal: AbortSignal },
): Promise<EmbedStep> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const documentId = id(input.documentId),
    batchSize = deps.batchSize ?? 32;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 128)
    throw new AppError('INVALID_INPUT');
  let embedded = 0;
  const end = async (
    state: 'embedded' | 'denied' | 'failed',
    code: KnowledgeCode | null,
  ): Promise<EmbedStep> => {
    await withTenantTx(database, context, (tx) =>
      tx
        .update(knowledgeDocuments)
        .set({
          embeddingState: state,
          embeddingReason: code,
          version: sql`${knowledgeDocuments.version}+1`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.state, 'searchable')),
        ),
    );
    return { state, code, embedded };
  };
  try {
    const initial = await documentClass(database, context, documentId);
    if (!initial) return { state: 'failed', code: 'SOURCE_CLOSED', embedded };
    const initialDecision = await deps.model.route({
      organizationId: context.organizationId,
      purpose: 'embed',
      classification: initial,
    });
    if (initialDecision.decision === 'deny') {
      const code = denialCode(initialDecision.reasonCode);
      const requestSha256 = await documentTextHash(database, context, documentId);
      await withTenantTx(database, context, (tx) =>
        recordModelCall(tx, context, {
          purpose: 'embed',
          dataClass: initial,
          decision: 'deny',
          reasonCode: code,
          policyVersion: initialDecision.policyVersion,
          requestSha256,
          documentId,
          inputCount: 0,
        }),
      );
      return end('denied', code);
    }
    let route = initialDecision.route,
      routeClass = initial;
    validateRoute(route);
    const space = await ensureEmbeddingSpace(database, context, route);
    await withTenantTx(database, context, (tx) =>
      tx
        .update(knowledgeDocuments)
        .set({
          embeddingState: 'embedding',
          embeddingReason: null,
          version: sql`${knowledgeDocuments.version}+1`,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeDocuments.id, documentId)),
    );
    for (let batchNo = 0; batchNo <= MAX_CHUNKS_PER_DOCUMENT; batchNo++) {
      if (input.signal.aborted) return end('failed', 'MODEL_UNAVAILABLE');
      const classification = await documentClass(database, context, documentId);
      if (!classification) return end('failed', 'SOURCE_CLOSED');
      if (batchNo > 0 || classification !== routeClass) {
        const decision = await deps.model.route({
          organizationId: context.organizationId,
          purpose: 'embed',
          classification,
          spaceHint: space,
        });
        if (decision.decision === 'deny') {
          const code = denialCode(decision.reasonCode);
          const requestSha256 = await documentTextHash(database, context, documentId);
          await withTenantTx(database, context, (tx) =>
            recordModelCall(tx, context, {
              purpose: 'embed',
              dataClass: classification,
              decision: 'deny',
              reasonCode: code,
              policyVersion: decision.policyVersion,
              requestSha256,
              documentId,
              inputCount: 0,
            }),
          );
          return end('denied', code);
        }
        route = decision.route;
        validateRoute(route);
        routeClass = classification;
        if (!matchesSpace(route, space)) return end('failed', 'SPACE_MISMATCH');
      }
      const chunks = await withTenantTx(database, context, (tx) =>
        tx
          .select()
          .from(knowledgeChunks)
          .where(
            and(
              eq(knowledgeChunks.documentId, documentId),
              sql`not exists(select 1 from knowledge.embeddings e where e.organization_id=${knowledgeChunks.organizationId} and e.chunk_id=${knowledgeChunks.id} and e.space_id=${space.id}::uuid and e.content_sha256=${knowledgeChunks.contentSha256})`,
            ),
          )
          .orderBy(asc(knowledgeChunks.ordinal))
          .limit(batchSize),
      );
      if (!chunks.length) {
        const refusal = await batchRefusal(database, context, documentId, space.id, routeClass);
        if (refusal) return end(refusal === 'EGRESS_DENIED' ? 'denied' : 'failed', refusal);
        return end('embedded', null);
      }
      const texts = chunks.map((chunk) => chunk.textBody);
      const prepared = await withTenantTx(database, context, async (tx) => {
        const refusal = await batchRefusalTx(tx, documentId, space.id, routeClass);
        if (refusal) return refusal;
        await recordModelCall(tx, context, {
          purpose: 'embed',
          dataClass: routeClass,
          decision: 'allow',
          reasonCode: 'ALLOW',
          policyVersion: route.policyVersion,
          route,
          requestSha256: digest(texts),
          documentId,
          inputCount: texts.length,
        });
        return null;
      });
      if (prepared) return end(prepared === 'EGRESS_DENIED' ? 'denied' : 'failed', prepared);
      const result = await deps.model.embed(context.organizationId, route, texts, input.signal);
      if (
        result.vectors.length !== chunks.length ||
        result.vectors.some((vector) => !validVector(vector, space.dimension))
      )
        return end('failed', 'SPACE_MISMATCH');
      const stored = await withTenantTx(database, context, async (tx) => {
        const refusal = await batchRefusalTx(tx, documentId, space.id, routeClass);
        if (refusal) return { refusal, rows: [] };
        const rows = await tx
          .insert(knowledgeEmbeddings)
          .values(
            chunks.map((chunk, index) => ({
              organizationId: context.organizationId,
              chunkId: chunk.id,
              sourceId: chunk.sourceId,
              spaceId: space.id,
              dimension: space.dimension,
              embedding: [...result.vectors[index]!],
              contentSha256: chunk.contentSha256,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: knowledgeEmbeddings.chunkId });
        return { refusal: null, rows };
      });
      if (stored.refusal)
        return end(stored.refusal === 'EGRESS_DENIED' ? 'denied' : 'failed', stored.refusal);
      if (!stored.rows.length) return end('failed', 'SPACE_MISMATCH');
      embedded += stored.rows.length;
    }
    return end('failed', 'TOO_LARGE');
  } catch (error) {
    return end('failed', pgCode(error) === 'EN103' ? 'SOURCE_CLOSED' : modelCode(error));
  }
}

/**
 * A question's vector, in the active space, or why not. The question's class is the caller's, because a
 * question can quote anything. A route into a different space answers `SPACE_MISMATCH`, with no call.
 */
export async function embedQuery(
  database: AppDatabase,
  context: TenantContext,
  deps: EmbeddingDeps,
  input: { query: string; classification: Classification; signal: AbortSignal },
): Promise<
  | { ok: true; spaceId: string; vector: readonly number[]; route: ModelRoute }
  | { ok: false; code: KnowledgeCode }
> {
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  const query = searchQuery(input.query);
  if (!query || !validClass(input.classification)) throw new AppError('INVALID_INPUT');
  try {
    const space = await activeEmbeddingSpace(database, context);
    if (!space) return { ok: false, code: 'NO_APPROVED_MODEL' };
    const decision = await deps.model.route({
      organizationId: context.organizationId,
      purpose: 'embed',
      classification: input.classification,
      spaceHint: space,
    });
    if (decision.decision === 'deny') {
      const code = denialCode(decision.reasonCode);
      await withTenantTx(database, context, (tx) =>
        recordModelCall(tx, context, {
          purpose: 'embed',
          dataClass: input.classification,
          decision: 'deny',
          reasonCode: code,
          policyVersion: decision.policyVersion,
          requestSha256: digest([query]),
          inputCount: 1,
        }),
      );
      return { ok: false, code };
    }
    validateRoute(decision.route);
    if (!matchesSpace(decision.route, space)) {
      await withTenantTx(database, context, (tx) =>
        recordModelCall(tx, context, {
          purpose: 'embed',
          dataClass: input.classification,
          decision: 'deny',
          reasonCode: 'SPACE_MISMATCH',
          policyVersion: decision.route.policyVersion,
          requestSha256: digest([query]),
          inputCount: 1,
        }),
      );
      return { ok: false, code: 'SPACE_MISMATCH' };
    }
    if (input.signal.aborted) return { ok: false, code: 'MODEL_UNAVAILABLE' };
    const current = await activeEmbeddingSpace(database, context);
    if (current?.id !== space.id) return { ok: false, code: 'SPACE_MISMATCH' };
    await withTenantTx(database, context, async (tx) => {
      await requireSearchPerson(tx, context);
      await recordModelCall(tx, context, {
        purpose: 'embed',
        dataClass: input.classification,
        decision: 'allow',
        reasonCode: 'ALLOW',
        policyVersion: decision.route.policyVersion,
        route: decision.route,
        requestSha256: digest([query]),
        inputCount: 1,
      });
    });
    const result = await deps.model.embed(
      context.organizationId,
      decision.route,
      [query],
      input.signal,
    );
    if (result.vectors.length !== 1 || !validVector(result.vectors[0]!, space.dimension))
      return { ok: false, code: 'SPACE_MISMATCH' };
    if ((await activeEmbeddingSpace(database, context))?.id !== space.id)
      return { ok: false, code: 'SPACE_MISMATCH' };
    return { ok: true, spaceId: space.id, vector: result.vectors[0]!, route: decision.route };
  } catch (error) {
    return { ok: false, code: modelCode(error) };
  }
}

export async function activeEmbeddingSpace(
  database: AppDatabase,
  context: TenantContext,
): Promise<EmbeddingSpace | null> {
  return withTenantTx(database, context, async (tx) => {
    if (context.actorType !== 'service') await requireSearchPerson(tx, context);
    const [space] = await tx
      .select()
      .from(knowledgeEmbeddingSpaces)
      .where(eq(knowledgeEmbeddingSpaces.state, 'active'));
    return space
      ? {
          id: space.id,
          modelId: space.modelId,
          dimension: space.dimension,
          vectorSpaceVersion: space.vectorSpaceVersion,
        }
      : null;
  });
}

/** Finds or creates the space a route names, as the only active one. Retires any other. */
export async function ensureEmbeddingSpace(
  database: AppDatabase,
  context: TenantContext,
  route: ModelRoute,
): Promise<EmbeddingSpace> {
  validateRoute(route);
  if (!route.embedding) throw new ModelCallFailed('SPACE_MISMATCH');
  return withTenantTx(database, context, async (tx) => {
    if (context.actorType !== 'service') await requireSearchPerson(tx, context);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-space:${context.organizationId}`},0))`,
    );
    const [existing] = await tx
      .select()
      .from(knowledgeEmbeddingSpaces)
      .where(
        and(
          eq(knowledgeEmbeddingSpaces.modelId, route.modelId),
          eq(knowledgeEmbeddingSpaces.dimension, route.embedding!.dimension),
          eq(knowledgeEmbeddingSpaces.vectorSpaceVersion, route.embedding!.vectorSpaceVersion),
        ),
      )
      .for('update');
    const spaceId = existing?.id ?? randomUUID();
    await tx
      .update(knowledgeEmbeddingSpaces)
      .set({ state: 'retired', retiredAt: new Date() })
      .where(
        and(eq(knowledgeEmbeddingSpaces.state, 'active'), ne(knowledgeEmbeddingSpaces.id, spaceId)),
      );
    if (existing)
      await tx
        .update(knowledgeEmbeddingSpaces)
        .set({ state: 'active', retiredAt: null })
        .where(eq(knowledgeEmbeddingSpaces.id, spaceId));
    else
      await tx.insert(knowledgeEmbeddingSpaces).values({
        organizationId: context.organizationId,
        id: spaceId,
        modelProfileRef: id(route.modelProfileRef),
        modelProfileVersion: route.modelProfileVersion,
        modelId: route.modelId,
        dimension: route.embedding!.dimension,
        vectorSpaceVersion: route.embedding!.vectorSpaceVersion,
      });
    return {
      id: spaceId,
      modelId: route.modelId,
      dimension: route.embedding!.dimension,
      vectorSpaceVersion: route.embedding!.vectorSpaceVersion,
    };
  });
}

async function documentClass(
  database: AppDatabase,
  context: TenantContext,
  documentId: string,
): Promise<Classification | null> {
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .select({
        document: knowledgeDocuments.classification,
        source: knowledgeSources.classification,
      })
      .from(knowledgeDocuments)
      .innerJoin(
        knowledgeSources,
        and(
          eq(knowledgeSources.organizationId, knowledgeDocuments.organizationId),
          eq(knowledgeSources.id, knowledgeDocuments.sourceId),
        ),
      )
      .where(
        and(
          eq(knowledgeDocuments.id, documentId),
          eq(knowledgeDocuments.state, 'searchable'),
          sql`${knowledgeDocuments.supersededAt} is null`,
          eq(knowledgeSources.state, 'active'),
        ),
      );
    return row
      ? strongestClass([row.document as Classification, row.source as Classification])
      : null;
  });
}
async function documentTextHash(
  database: AppDatabase,
  context: TenantContext,
  documentId: string,
): Promise<string> {
  const hash = createHash('sha256');
  hash.update('[');
  let ordinal = -1,
    count = 0;
  // Bounded pages keep even a denied large document out of a single temporary string or ledger row.
  for (;;) {
    const chunks = await withTenantTx(database, context, (tx) =>
      tx
        .select({ text: knowledgeChunks.textBody, ordinal: knowledgeChunks.ordinal })
        .from(knowledgeChunks)
        .where(
          and(
            eq(knowledgeChunks.documentId, documentId),
            sql`${knowledgeChunks.ordinal}>${ordinal}`,
          ),
        )
        .orderBy(asc(knowledgeChunks.ordinal))
        .limit(256),
    );
    if (!chunks.length) break;
    for (const chunk of chunks) {
      if (count >= MAX_CHUNKS_PER_DOCUMENT) throw new ModelCallFailed('TOO_LARGE');
      if (count++) hash.update(',');
      hash.update(JSON.stringify(chunk.text));
      ordinal = chunk.ordinal;
    }
  }
  hash.update(']');
  return hash.digest('hex');
}

/** Repair/reindex work is discovered by the existing bounded sweep; no plaintext crosses Temporal. */
export async function listDocumentsNeedingEmbedding(
  database: AppDatabase,
  context: TenantContext,
  input: { limit: number },
): Promise<readonly { documentId: string }[]> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 50);
  if (!Number.isFinite(limit)) throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    const result = await tx.execute<{
      documentId: string;
    }>(sql`select d.id as "documentId" from knowledge.documents d join knowledge.sources s on s.organization_id=d.organization_id and s.id=d.source_id
      where d.state='searchable' and d.superseded_at is null and s.state='active'
        and exists(select 1 from knowledge.chunks c where c.organization_id=d.organization_id and c.document_id=d.id)
        and ((d.embedding_state='embedded' and exists(select 1 from knowledge.embedding_spaces sp where sp.organization_id=d.organization_id and sp.state='active'
          and exists(select 1 from knowledge.chunks c where c.organization_id=d.organization_id and c.document_id=d.id
            and not exists(select 1 from knowledge.embeddings e where e.organization_id=c.organization_id and e.chunk_id=c.id and e.space_id=sp.id and e.content_sha256=c.content_sha256))))
          or (d.embedding_state in('pending','embedding','failed') and d.updated_at<now()-interval '10 minutes')
          or (d.embedding_state='denied' and d.updated_at<now()-interval '1 hour'))
      order by d.updated_at,d.id limit ${limit}`);
    return result.rows;
  });
}
async function batchRefusal(
  database: AppDatabase,
  context: TenantContext,
  documentId: string,
  spaceId: string,
  classification: Classification,
) {
  return withTenantTx(database, context, (tx) =>
    batchRefusalTx(tx, documentId, spaceId, classification),
  );
}
async function batchRefusalTx(
  tx: Tx,
  documentId: string,
  spaceId: string,
  classification: Classification,
): Promise<KnowledgeCode | null> {
  await tx.execute(
    sql`select s.id from knowledge.sources s join knowledge.documents d on d.organization_id=s.organization_id and d.source_id=s.id where d.id=${documentId}::uuid order by s.id for share of s`,
  );
  const result = await tx.execute<{
    state: string;
    documentState: string;
    supersededAt: Date | null;
    spaceState: string | null;
    classMatches: boolean;
  }>(sql`
    select s.state,d.state as "documentState",d.superseded_at as "supersededAt",sp.state as "spaceState",
      greatest(knowledge.class_rank(d.classification),knowledge.class_rank(s.classification))=knowledge.class_rank(${classification}) as "classMatches"
    from knowledge.documents d join knowledge.sources s on s.organization_id=d.organization_id and s.id=d.source_id
    left join knowledge.embedding_spaces sp on sp.organization_id=d.organization_id and sp.id=${spaceId}::uuid where d.id=${documentId}::uuid`);
  const row = result.rows[0];
  if (!row || row.state !== 'active' || row.documentState !== 'searchable' || row.supersededAt)
    return 'SOURCE_CLOSED';
  if (row.spaceState !== 'active') return 'SPACE_MISMATCH';
  return row.classMatches ? null : 'EGRESS_DENIED';
}
function matchesSpace(route: ModelRoute, space: EmbeddingSpace) {
  return (
    route.modelId === space.modelId &&
    route.embedding?.dimension === space.dimension &&
    route.embedding.vectorSpaceVersion === space.vectorSpaceVersion
  );
}
function validVector(vector: readonly number[], dimension: number) {
  return (
    vector.length === dimension &&
    vector.every(
      (value) =>
        typeof value === 'number' &&
        Number.isFinite(value) &&
        Math.abs(value) <= 3.4028234663852886e38,
    ) &&
    vector.some((value) => Math.fround(value) !== 0)
  );
}
function validClass(value: Classification) {
  return ['public', 'internal', 'confidential', 'restricted'].includes(value);
}
function validateRoute(route: ModelRoute) {
  id(route.modelProfileRef);
  if (
    !Number.isSafeInteger(route.modelProfileVersion) ||
    route.modelProfileVersion < 1 ||
    !route.modelId ||
    route.modelId.length > 256 ||
    !/^[-a-z0-9_.]+$/i.test(route.providerKind) ||
    !/^(?:[-a-z0-9.]+|\[[0-9a-f:]+\])$/i.test(route.destinationHost) ||
    route.destinationHost.length > 253 ||
    !route.policyVersion ||
    route.policyVersion.length > 128
  )
    throw new ModelCallFailed('NO_APPROVED_MODEL');
  if (
    route.embedding &&
    (!Number.isInteger(route.embedding.dimension) ||
      route.embedding.dimension < 1 ||
      route.embedding.dimension > 8192 ||
      !route.embedding.vectorSpaceVersion ||
      route.embedding.vectorSpaceVersion.length > 256)
  )
    throw new ModelCallFailed('SPACE_MISMATCH');
}
const digest = (input: readonly string[]) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');
const safeCode = (value: string, fallback: string) =>
  /^[a-z0-9_.:-]{1,128}$/i.test(value) ? value : fallback;
const denialCode = (code: string): KnowledgeCode =>
  code === 'NO_APPROVED_MODEL'
    ? 'NO_APPROVED_MODEL'
    : code === 'BUDGET_EXHAUSTED'
      ? 'BUDGET_EXHAUSTED'
      : 'EGRESS_DENIED';
const modelCode = (error: unknown): KnowledgeCode =>
  error instanceof ModelCallFailed && (KNOWLEDGE_CODES as readonly string[]).includes(error.code)
    ? error.code
    : 'MODEL_UNAVAILABLE';
function id(value: string) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}
