// AGENT-07 / ADR-029 D12. Structural grounding does not prove semantic truth. A fresh person accepts
// exact bytes against the current objective and immutable citation batch. No transaction spans I/O.
import {
  appendAudit,
  artifactAclCatalog,
  artifactLineage,
  artifactWorkLinks,
  knowledgeArtifactCitations as citations,
  knowledgeArtifactVerifications as verifications,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeSources,
  memberships,
  tombstones,
  withTenantTx,
  workAssignments,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { createDelegatedContext } from '@ensemus/database/service';
import type { Classification } from '@ensemus/domain/policy';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { objectKey, type ObjectStore } from '../artifacts';
import { AppError, pgCode } from '../errors';
import { idSchema } from '../ids';
import { idFromRequest } from '../request-id';
import { loadReadable } from '../work';
import { assertStableArtifactSources, lockArtifactInputSources } from './artifact-provenance';
import {
  artifactCoverage,
  citationProofHash,
  verificationHash,
  type CitationProof,
} from './verification-proof';

export type ArtifactCitationInput = { chunkId: string; artifactStart: number; artifactEnd: number };
type Input = { artifactId: string; workUnitId: string };
type Citation = typeof citations.$inferSelect;
type Code = 'NOT_GROUNDED' | 'CITATION_INVALID' | 'SOURCE_CLOSED';
const rank: Record<Classification, number> = {
  public: 1,
  internal: 2,
  confidential: 3,
  restricted: 4,
};
const id = (raw: string) => {
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
};
const ids = (raw: Input): Input => ({
  artifactId: id(raw.artifactId),
  workUnitId: id(raw.workUnitId),
});
async function safe<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    const code = pgCode(error);
    if (code === 'EN113') throw new AppError('FORBIDDEN');
    if (code === 'EN114') throw new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED');
    if (code === '23503' || code === '42501') throw new AppError('NOT_FOUND');
    if (code === '23514') throw new AppError('INVALID_INPUT');
    throw error;
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
async function snapshot(
  tx: Tx,
  context: TenantContext,
  input: Input,
  manage: boolean | 'change' = false,
) {
  // Source locks precede work/catalog locks. A source added by a concurrent input/citation append
  // aborts rather than acquiring an unknown source in the opposite order.
  const lockedSources = await lockArtifactInputSources(tx, context, input);
  const fresh = context.actorType === 'service' ? context : await person(tx, context);
  const work = await loadReadable(tx, fresh, input.workUnitId, true);
  if (
    manage &&
    fresh.actorType !== 'service' &&
    work.ownerMembershipId !== fresh.membershipId &&
    !['owner', 'admin'].includes(fresh.role)
  ) {
    const assigned =
      manage === 'change'
        ? await tx
            .select({ id: workAssignments.membershipId })
            .from(workAssignments)
            .where(
              and(
                eq(workAssignments.workUnitId, work.id),
                eq(workAssignments.membershipId, fresh.membershipId),
              ),
            )
        : [];
    if (!assigned.length) throw new AppError('FORBIDDEN');
  }
  const dead = await tx
    .select({ id: tombstones.targetId })
    .from(tombstones)
    .where(and(eq(tombstones.targetType, 'artifact'), eq(tombstones.targetId, input.artifactId)));
  if (dead.length) throw new AppError('NOT_FOUND');
  await tx.execute(sql`select knowledge.lock_artifact_catalog(${input.artifactId}::uuid)`);
  await assertStableArtifactSources(tx, context, input, lockedSources);
  const [found] = await tx
    .select({ artifact: artifactAclCatalog })
    .from(artifactWorkLinks)
    .innerJoin(artifactAclCatalog, eq(artifactAclCatalog.artifactId, artifactWorkLinks.artifactId))
    .where(
      and(
        eq(artifactWorkLinks.workUnitId, input.workUnitId),
        eq(artifactWorkLinks.artifactId, input.artifactId),
        eq(artifactAclCatalog.alive, true),
      ),
    );
  if (!found) throw new AppError('NOT_FOUND');
  if (context.actorType !== 'service') {
    const access = await tx.execute<{ allowed: boolean }>(
      sql`select knowledge.artifact_readable(${input.artifactId}::uuid,${context.membershipId}::uuid) as allowed`,
    );
    if (!access.rows[0]?.allowed) throw new AppError('NOT_FOUND');
  }
  const [lineage] = await tx
    .select({ key: artifactLineage.objectKey })
    .from(artifactLineage)
    .where(eq(artifactLineage.artifactId, input.artifactId));
  const rows = await tx
    .select()
    .from(citations)
    .where(eq(citations.artifactId, input.artifactId))
    .orderBy(asc(citations.ordinal))
    .limit(51);
  return {
    work,
    artifact: {
      ...found.artifact,
      id: found.artifact.artifactId,
      objectKey: lineage?.key ?? objectKey(context.organizationId, input.artifactId),
    },
    citations: rows,
    objective: verificationHash(work.objective ?? ''),
    digest: citationProofHash(rows),
  };
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
function same(first: Snapshot, current: Snapshot) {
  if (
    first.artifact.sha256 !== current.artifact.sha256 ||
    first.artifact.objectKey !== current.artifact.objectKey ||
    first.artifact.sizeBytes !== current.artifact.sizeBytes ||
    first.objective !== current.objective ||
    first.digest !== current.digest
  )
    throw new AppError('VERSION_CONFLICT');
}
function recordedViewer(rows: readonly CitationProof[]): string | null {
  const viewer = rows[0]?.recordedByMembershipId;
  return viewer && rows.length <= 50 && rows.every((row) => row.recordedByMembershipId === viewer)
    ? viewer
    : null;
}
async function passages(tx: Tx, rows: readonly Citation[], viewer: string | null) {
  const recorder = recordedViewer(rows);
  if (!viewer || !recorder || !rows.length || rows.length > 50) return [];
  return tx
    .select({ chunk: knowledgeChunks, document: knowledgeDocuments, source: knowledgeSources })
    .from(knowledgeChunks)
    .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
    .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeChunks.sourceId))
    .where(
      and(
        inArray(
          knowledgeChunks.id,
          rows.map((row) => row.chunkId),
        ),
        eq(knowledgeSources.state, 'active'),
        eq(knowledgeDocuments.state, 'searchable'),
        sql`${knowledgeSources.id} in (select knowledge.readable_source_ids(${viewer}::uuid))`,
        sql`${knowledgeSources.id} in (select knowledge.readable_source_ids(${recorder}::uuid))`,
        sql`not exists (select 1 from platform.tombstones t where t.organization_id = ${knowledgeSources.organizationId} and t.target_type = 'knowledge_source' and t.target_id = ${knowledgeSources.id})`,
      ),
    )
    .for('share', { of: [knowledgeSources, knowledgeDocuments] });
}
async function live(tx: Tx, state: Snapshot, viewer: string | null) {
  let code: Code | null = null;
  if (!state.citations.length) code = 'NOT_GROUNDED';
  else if (!viewer || !recordedViewer(state.citations)) code = 'CITATION_INVALID';
  if (code) return { code, rows: [] as Awaited<ReturnType<typeof passages>> };
  const viewers = [...new Set([viewer!, recordedViewer(state.citations)!])];
  const active = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(inArray(memberships.id, viewers), eq(memberships.status, 'active')))
    .for('share');
  const allowed = await tx.execute<{
    allowed: boolean;
  }>(sql`select knowledge.can_read_work(${state.work.id}::uuid, ${viewer}::uuid)
    and knowledge.can_read_work(${state.work.id}::uuid, ${recordedViewer(state.citations)}::uuid)
    and knowledge.artifact_readable(${state.artifact.id}::uuid,${viewer}::uuid)
    and knowledge.artifact_readable(${state.artifact.id}::uuid,${recordedViewer(state.citations)}::uuid) as allowed`);
  if (active.length !== viewers.length || !allowed.rows[0]?.allowed)
    return { code: 'SOURCE_CLOSED' as const, rows: [] as Awaited<ReturnType<typeof passages>> };
  const rows = await passages(tx, state.citations, viewer);
  for (const citation of state.citations) {
    const found = rows.find((row) => row.chunk.id === citation.chunkId);
    if (!found) return { code: 'SOURCE_CLOSED' as const, rows };
    if (
      citation.documentId !== found.document.id ||
      citation.sourceId !== found.source.id ||
      citation.contentSha256 !== found.chunk.contentSha256 ||
      verificationHash(found.chunk.textBody) !== citation.contentSha256 ||
      found.document.supersededAt !== null ||
      rank[found.source.classification as Classification] >
        rank[state.work.classification as Classification] ||
      rank[found.source.classification as Classification] >
        rank[state.artifact.classification as Classification] ||
      rank[found.document.classification as Classification] >
        rank[state.work.classification as Classification] ||
      rank[found.document.classification as Classification] >
        rank[state.artifact.classification as Classification]
    )
      return { code: 'CITATION_INVALID' as const, rows };
  }
  return { code: null, rows };
}
function bytesCode(bytes: Buffer, state: Snapshot) {
  if (
    bytes.length !== state.artifact.sizeBytes ||
    verificationHash(bytes) !== state.artifact.sha256
  )
    return 'CITATION_INVALID' as const;
  return artifactCoverage(bytes, state.citations);
}
async function writeProof(
  tx: Tx,
  context: TenantContext,
  state: Snapshot,
  decision: {
    kind: 'grounding' | 'human';
    verdict: 'passed' | 'failed' | 'accepted' | 'rejected';
    reasonCode: string | null;
    reason: string | null;
  },
) {
  const previous = (
    await tx
      .select()
      .from(verifications)
      .where(
        and(
          eq(verifications.artifactId, state.artifact.id),
          eq(verifications.kind, decision.kind),
          sql`${verifications.proofOrder} is not null`,
        ),
      )
      .orderBy(sql`${verifications.proofOrder} desc nulls last`)
      .limit(1)
  )[0];
  if (
    previous?.verdict === decision.verdict &&
    previous.workUnitId === state.work.id &&
    previous.artifactSha256 === state.artifact.sha256 &&
    previous.objectiveSha256 === state.objective &&
    previous.citationsSha256 === state.digest &&
    previous.reasonCode === decision.reasonCode &&
    previous.reason === decision.reason &&
    (decision.kind === 'grounding' || previous.decidedByMembershipId === context.membershipId)
  )
    return { verificationId: previous.id };
  const verificationId = idFromRequest(
    'artifact-verification',
    context.membershipId || context.organizationId,
    state.artifact.id,
    [
      state.work.id,
      state.artifact.sha256,
      state.objective,
      state.digest,
      decision,
      previous?.id ?? null,
    ],
  );
  const [inserted] = await tx
    .insert(verifications)
    .values({
      organizationId: context.organizationId,
      id: verificationId,
      artifactId: state.artifact.id,
      workUnitId: state.work.id,
      artifactSha256: state.artifact.sha256,
      objectiveSha256: state.objective,
      citationsSha256: state.digest,
      ...decision,
      decidedByMembershipId: decision.kind === 'human' ? context.membershipId : null,
    })
    .onConflictDoNothing()
    .returning({ id: verifications.id });
  if (inserted)
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: context.actorType === 'service' ? 'service' : 'user',
      ...(context.actorType === 'service' ? {} : { actorId: context.membershipId }),
      action:
        decision.kind === 'human' ? `artifact.${decision.verdict}` : 'artifact.grounding_checked',
      targetRef: `artifact:${state.artifact.id}`,
      decision: 'allow',
      safeReason: decision.verdict.toUpperCase(),
    });
  return { verificationId };
}

/** Named user/delegated viewer, one citation batch. Identical retries include the recording identity. */
export async function recordArtifactCitations(
  database: AppDatabase,
  context: TenantContext,
  raw: Input & { citations: readonly ArtifactCitationInput[] },
): Promise<void> {
  const input = ids(raw);
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  if (!Array.isArray(raw.citations) || !raw.citations.length || raw.citations.length > 50)
    throw new AppError('INVALID_INPUT');
  const items = raw.citations.map((item) => {
    if (
      !Number.isSafeInteger(item.artifactStart) ||
      !Number.isSafeInteger(item.artifactEnd) ||
      item.artifactStart < 0 ||
      item.artifactEnd <= item.artifactStart
    )
      throw new AppError('INVALID_INPUT');
    return { ...item, chunkId: id(item.chunkId) };
  });
  if (
    new Set(items.map((item) => `${item.chunkId}:${item.artifactStart}:${item.artifactEnd}`))
      .size !== items.length
  )
    throw new AppError('INVALID_INPUT');
  await safe(() =>
    withTenantTx(database, context, async (tx) => {
      const proposedSources = await tx
        .select({ id: knowledgeChunks.sourceId })
        .from(knowledgeChunks)
        .where(
          inArray(
            knowledgeChunks.id,
            items.map((item) => item.chunkId),
          ),
        );
      await lockArtifactInputSources(tx, context, {
        artifactId: input.artifactId,
        additionalSourceIds: proposedSources.map((row) => row.id),
      });
      const state = await snapshot(tx, context, input, 'change');
      const chunks = await tx
        .select({ chunk: knowledgeChunks, document: knowledgeDocuments, source: knowledgeSources })
        .from(knowledgeChunks)
        .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
        .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeChunks.sourceId))
        .where(
          inArray(
            knowledgeChunks.id,
            items.map((item) => item.chunkId),
          ),
        )
        .for('share', { of: [knowledgeSources, knowledgeDocuments] });
      const proposed = items.map((item, index) => {
        const found = chunks.find((row) => row.chunk.id === item.chunkId);
        if (
          !found ||
          found.source.state !== 'active' ||
          found.document.state !== 'searchable' ||
          found.document.supersededAt ||
          verificationHash(found.chunk.textBody) !== found.chunk.contentSha256 ||
          item.artifactEnd > state.artifact.sizeBytes ||
          rank[found.source.classification as Classification] >
            rank[state.work.classification as Classification] ||
          rank[found.source.classification as Classification] >
            rank[state.artifact.classification as Classification] ||
          rank[found.document.classification as Classification] >
            rank[state.work.classification as Classification] ||
          rank[found.document.classification as Classification] >
            rank[state.artifact.classification as Classification]
        )
          throw new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED');
        return {
          organizationId: context.organizationId,
          artifactId: input.artifactId,
          ordinal: index + 1,
          chunkId: item.chunkId,
          documentId: found.document.id,
          sourceId: found.source.id,
          contentSha256: found.chunk.contentSha256,
          artifactStart: item.artifactStart,
          artifactEnd: item.artifactEnd,
          recordedByMembershipId: context.membershipId,
        };
      });
      if (state.digest === citationProofHash(proposed)) return;
      const proofs = await tx
        .select({ id: verifications.id })
        .from(verifications)
        .where(eq(verifications.artifactId, input.artifactId))
        .limit(1);
      if (proofs.length) throw new AppError('INVALID_STATE');
      await tx.delete(citations).where(eq(citations.artifactId, input.artifactId));
      await tx.insert(citations).values(proposed);
    }),
  );
}

export type GroundingVerdict = {
  verdict: 'passed' | 'failed';
  reasonCode: string | null;
  citations: number;
};
export async function checkArtifactGrounding(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  raw: Input,
): Promise<GroundingVerdict> {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
  const input = ids(raw);
  return safe(async () => {
    const first = await withTenantTx(database, context, (tx) => snapshot(tx, context, input));
    const viewer = recordedViewer(first.citations);
    let code: Code | null = first.citations.length ? 'CITATION_INVALID' : 'NOT_GROUNDED';
    let bytes: Buffer | null = null;
    if (viewer) {
      try {
        const delegated = await createDelegatedContext(database, context.organizationId, viewer);
        code = await withTenantTx(database, delegated, async (tx) => {
          const current = await snapshot(tx, delegated, input);
          same(first, current);
          return (await live(tx, current, viewer)).code;
        });
      } catch (error) {
        if (error instanceof AppError && error.code === 'VERSION_CONFLICT') throw error;
        if (error instanceof AppError && !['FORBIDDEN', 'NOT_FOUND'].includes(error.code))
          throw error;
        if (
          !(error instanceof AppError) &&
          !(error instanceof Error && error.name === 'TenantAccessDenied')
        )
          throw error;
        code = 'SOURCE_CLOSED';
      }
      if (!code) {
        bytes = await store.get(first.artifact.objectKey);
        code = bytesCode(bytes, first);
      }
    }
    return withTenantTx(database, context, async (tx) => {
      const current = await snapshot(tx, context, input);
      same(first, current);
      const latest = await live(tx, current, viewer);
      code = latest.code ?? code;
      if (bytes) code = latest.code ?? bytesCode(bytes, current);
      const verdict = code ? ('failed' as const) : ('passed' as const);
      await writeProof(tx, context, current, {
        kind: 'grounding',
        verdict,
        reasonCode: code,
        reason: null,
      });
      return { verdict, reasonCode: code, citations: current.citations.length };
    });
  });
}

/** Store is required for acceptance; rejection needs a bounded reason and no object I/O. */
export async function decideArtifact(
  database: AppDatabase,
  context: TenantContext,
  raw: Input & {
    artifactSha256: string;
    objectiveSha256?: string;
    citationsSha256?: string;
    verdict: 'accepted' | 'rejected';
    reason?: string;
  },
  deps?: { store: ObjectStore },
): Promise<{ verificationId: string }> {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  const input = ids(raw);
  if (
    !['accepted', 'rejected'].includes(raw.verdict) ||
    !/^[0-9a-f]{64}$/.test(raw.artifactSha256) ||
    (raw.objectiveSha256 !== undefined && !/^[0-9a-f]{64}$/.test(raw.objectiveSha256)) ||
    (raw.citationsSha256 !== undefined && !/^[0-9a-f]{64}$/.test(raw.citationsSha256)) ||
    (raw.reason !== undefined &&
      (typeof raw.reason !== 'string' || raw.reason.length > 2000 || raw.reason.includes('\0')))
  )
    throw new AppError('INVALID_INPUT');
  const why = raw.reason?.trim() || null;
  if (raw.verdict === 'rejected' && !why) throw new AppError('REASON_REQUIRED');
  if (raw.verdict === 'accepted' && (!deps?.store || !raw.objectiveSha256 || !raw.citationsSha256))
    throw new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED');
  return safe(async () => {
    const first = await withTenantTx(database, context, async (tx) => {
      const state = await snapshot(tx, context, input, true);
      if (state.artifact.sha256 !== raw.artifactSha256) throw new AppError('VERSION_CONFLICT');
      if (raw.objectiveSha256 !== undefined && raw.objectiveSha256 !== state.objective)
        throw new AppError('VERSION_CONFLICT');
      if (raw.citationsSha256 !== undefined && raw.citationsSha256 !== state.digest)
        throw new AppError('VERSION_CONFLICT');
      if (raw.verdict === 'accepted' && (await live(tx, state, context.membershipId)).code)
        throw new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED');
      return state;
    });
    const bytes =
      raw.verdict === 'accepted' ? await deps!.store.get(first.artifact.objectKey) : null;
    if (bytes && bytesCode(bytes, first)) throw new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED');
    return withTenantTx(database, context, async (tx) => {
      const current = await snapshot(tx, context, input, true);
      same(first, current);
      if (raw.verdict === 'accepted') {
        if (
          (await live(tx, current, context.membershipId)).code ||
          !bytes ||
          bytesCode(bytes, current)
        )
          throw new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED');
        const proofs = await tx
          .select({ verdict: verifications.verdict })
          .from(verifications)
          .where(
            and(
              eq(verifications.artifactId, input.artifactId),
              eq(verifications.workUnitId, input.workUnitId),
              eq(verifications.artifactSha256, current.artifact.sha256),
              eq(verifications.objectiveSha256, current.objective),
              eq(verifications.citationsSha256, current.digest),
              eq(verifications.kind, 'grounding'),
              sql`${verifications.proofOrder} is not null`,
            ),
          )
          .orderBy(sql`${verifications.proofOrder} desc nulls last`)
          .limit(1);
        if (proofs[0]?.verdict !== 'passed') throw new AppError('KNOWLEDGE_ARTIFACT_NOT_GROUNDED');
      }
      return writeProof(tx, context, current, {
        kind: 'human',
        verdict: raw.verdict,
        reasonCode: null,
        reason: why,
      });
    });
  });
}

export type ArtifactVerificationView = {
  artifactId: string;
  artifactSha256: string;
  objectiveSha256: string;
  citationsSha256: string;
  grounding: { verdict: 'passed' | 'failed'; reasonCode: string | null; at: Date } | null;
  human: { verdict: 'accepted' | 'rejected'; by: string; reason: string | null; at: Date } | null;
  citations: readonly {
    ordinal: number;
    chunkId: string;
    documentId: string;
    sourceId: string;
    title: string | null;
    excerpt: string | null;
    available: boolean;
  }[];
};
export async function getArtifactVerification(
  database: AppDatabase,
  context: TenantContext,
  raw: Input,
): Promise<ArtifactVerificationView> {
  const input = ids(raw);
  return withTenantTx(database, context, async (tx) => {
    const current = await snapshot(tx, context, input);
    const checked = await live(
      tx,
      current,
      context.actorType === 'service' ? recordedViewer(current.citations) : context.membershipId,
    );
    const proofs = await tx
      .select()
      .from(verifications)
      .where(
        and(
          eq(verifications.artifactId, input.artifactId),
          eq(verifications.workUnitId, input.workUnitId),
          eq(verifications.artifactSha256, current.artifact.sha256),
          eq(verifications.objectiveSha256, current.objective),
          eq(verifications.citationsSha256, current.digest),
          sql`${verifications.proofOrder} is not null`,
        ),
      )
      .orderBy(sql`${verifications.proofOrder} desc nulls last`);
    const grounding = proofs.find((proof) => proof.kind === 'grounding'),
      human = proofs.find((proof) => proof.kind === 'human');
    return {
      artifactId: input.artifactId,
      artifactSha256: current.artifact.sha256,
      objectiveSha256: current.objective,
      citationsSha256: current.digest,
      grounding: grounding
        ? {
            verdict: checked.code ? 'failed' : (grounding.verdict as 'passed' | 'failed'),
            reasonCode: checked.code ?? grounding.reasonCode,
            at: grounding.createdAt,
          }
        : null,
      human:
        human &&
        (human.verdict === 'rejected' || (!checked.code && grounding?.verdict === 'passed'))
          ? {
              verdict: human.verdict as 'accepted' | 'rejected',
              by: human.decidedByMembershipId!,
              reason: human.reason,
              at: human.createdAt,
            }
          : null,
      citations: current.citations.map((citation) => {
        const found = checked.rows.find(
          (row) =>
            row.chunk.id === citation.chunkId && row.chunk.contentSha256 === citation.contentSha256,
        );
        return {
          ordinal: citation.ordinal,
          chunkId: citation.chunkId,
          documentId: citation.documentId,
          sourceId: citation.sourceId,
          title: found?.document.title ?? null,
          excerpt: found?.chunk.textBody ?? null,
          available: !!found,
        };
      }),
    };
  });
}
