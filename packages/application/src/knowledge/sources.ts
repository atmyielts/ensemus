// Owned by the ingest slice (KNOW-01). See docs/06-delivery/m5-slices.md and ADR-029 D1, D2. A person's half:
// adding a source, who can see it, and what it says. Reading goes through row-level security, so a source
// someone cannot read shows no title and answers not found for its content.
import { createHash, randomUUID } from 'node:crypto';
import {
  appendAudit,
  domainEvents,
  knowledgeDocuments,
  knowledgeChunks,
  knowledgeSourceGrants,
  knowledgeSources,
  memberships,
  teams,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  AGGREGATE_KNOWLEDGE_DOCUMENT,
  KNOWLEDGE_DOCUMENT_RECEIVED,
} from '@ensemus/domain/knowledge-events';
import {
  canRaiseClass,
  grantAllowedFor,
  INGESTIBLE_MEDIA_TYPES,
  knowledgeObjectKey,
  MAX_DOCUMENT_BYTES,
  strongestClass,
} from '@ensemus/domain/knowledge';
import { can } from '@ensemus/domain/policy';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { emit } from '../events';
import { idSchema } from '../ids';
import { idFromRequest } from '../request-id';
import { requestHash, runIdempotent } from '../idempotency';
import { beginObjectWrite, settleObjectWrite } from './object-writes';
import type {
  DocumentState,
  EmbeddingState,
  ScanState,
  SourceKind,
  SourceState,
} from '@ensemus/domain/knowledge';
import type { Classification } from '@ensemus/domain/policy';
import type { ObjectStore } from '../artifacts';

export type SourceGrantInput =
  | { kind: 'membership'; membershipId: string }
  | { kind: 'team'; teamId: string }
  | { kind: 'organization' };

export type SourceSummary = {
  id: string;
  kind: SourceKind;
  state: SourceState;
  classification: Classification;
  /** Null when the viewer's ACL does not cover it. A manager still sees that it exists, and its class. */
  title: string | null;
  canRead: boolean;
  documentState: DocumentState | null;
  embeddingState: EmbeddingState | null;
  searchableAt: Date | null;
  sourceModifiedAt: Date | null;
  version: number;
  createdAt: Date;
};

export type SourcePage = { items: readonly SourceSummary[]; next: string | null };

export type SourceDetail = SourceSummary & {
  canManage: boolean;
  documentId: string | null;
  mediaType: string | null;
  sizeBytes: number | null;
  sourceUrl: string | null;
  sourceVersion: string | null;
  scanState: ScanState | null;
  rejectCode: string | null;
  grants: readonly (SourceGrantInput & { id: string })[];
  /** True for a connector's source, whose permissions come from the provider and cannot be edited here. */
  grantsManagedByProvider: boolean;
  /** Populated on the detailed read, under document RLS. It can be newer than the searchable
   * document above; an unsuccessful replacement never hides the still-published revision. */
  latestVersion?: {
    id: string;
    number: number;
    state: DocumentState;
    scanState: ScanState;
    rejectCode: string | null;
  } | null;
};

/** A readable current passage for a person's fact proposal form. IDs in a URL are never authority;
 * both the document RLS and the explicit source ACL apply before returning any words. */
export async function getSourcePassage(
  database: AppDatabase,
  context: TenantContext,
  chunkId: string,
): Promise<{
  chunkId: string;
  documentId: string;
  sourceId: string;
  title: string;
  text: string;
  classification: Classification;
}> {
  const id = validId(chunkId);
  return withTenantTx(database, context, async (tx) => {
    await person(tx, context);
    const [row] = await tx
      .select({
        chunkId: knowledgeChunks.id,
        documentId: knowledgeDocuments.id,
        sourceId: knowledgeSources.id,
        title: knowledgeDocuments.title,
        text: knowledgeChunks.textBody,
        documentClass: knowledgeDocuments.classification,
        sourceClass: knowledgeSources.classification,
      })
      .from(knowledgeChunks)
      .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
      .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId))
      .where(
        and(
          eq(knowledgeChunks.id, id),
          eq(knowledgeSources.state, 'active'),
          eq(knowledgeDocuments.state, 'searchable'),
          isNull(knowledgeDocuments.supersededAt),
          sql`${knowledgeSources.id} in(select knowledge.readable_source_ids(app.current_membership_id()))`,
        ),
      );
    if (!row) throw new AppError('NOT_FOUND');
    return {
      chunkId: row.chunkId,
      documentId: row.documentId,
      sourceId: row.sourceId,
      title: row.title,
      text: row.text,
      classification: strongestClass([
        row.documentClass as Classification,
        row.sourceClass as Classification,
      ]),
    };
  });
}

/**
 * Needs `knowledge.add`. Writes the source, its grants (always including the adder) and a `received`
 * document, then the bytes, then the outbox event, so nothing is ingested before its bytes exist. Refuses
 * a format outside `INGESTIBLE_MEDIA_TYPES`, and a size over `MAX_DOCUMENT_BYTES`. The same `requestKey`
 * with the same content returns the first result.
 */
export async function addUploadedSource(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  input: {
    title: string;
    mediaType: string;
    body: Buffer;
    classification: Classification;
    grants: readonly SourceGrantInput[];
    requestKey?: string;
  },
): Promise<{ sourceId: string; documentId: string }> {
  validateUpload(input);
  const grants = normalizeGrants(input.grants);
  const hash = digest(input.body);
  const sourceId = input.requestKey
    ? idFromRequest('knowledge-source', context.membershipId, input.requestKey, [
        context.organizationId,
        input.title.trim(),
        input.mediaType,
        hash,
        input.classification,
        grants,
      ])
    : randomUUID();
  const documentId = idFromRequest('knowledge-document', context.membershipId, sourceId, hash);
  const prepare = (target: AppDatabase) =>
    safeWrite(() =>
      withTenantTx(target, context, async (tx) => {
        await person(tx, context, 'add');
        await serial(tx, context.organizationId, sourceId);
        const [existing] = await tx
          .select()
          .from(knowledgeSources)
          .where(eq(knowledgeSources.id, sourceId));
        if (existing) {
          if (existing.state !== 'active') throw new AppError('KNOWLEDGE_SOURCE_CLOSED');
          await readableDocument(tx, documentId);
          return { sourceId, documentId };
        }
        await validateGrants(tx, grants, input.classification);
        await tx.insert(knowledgeSources).values({
          organizationId: context.organizationId,
          id: sourceId,
          kind: 'upload',
          classification: input.classification,
          ownerMembershipId: context.membershipId,
        });
        for (const grant of normalizeGrants([
          ...grants,
          { kind: 'membership', membershipId: context.membershipId },
        ])) {
          await writeGrant(tx, context, sourceId, grant);
        }
        await tx.insert(knowledgeDocuments).values({
          organizationId: context.organizationId,
          id: documentId,
          sourceId,
          versionNo: 1,
          title: input.title.trim(),
          contentSha256: hash,
          sizeBytes: input.body.length,
          mediaType: input.mediaType,
          objectKey: knowledgeObjectKey(context.organizationId, documentId),
          classification: input.classification,
          createdByMembershipId: context.membershipId,
        });
        await audit(tx, context, 'knowledge.source_added', sourceId);
        return { sourceId, documentId };
      }),
    );
  if (input.requestKey) {
    // Reserve metadata and the key together. Object I/O follows after commit; a retry still goes
    // through storeUpload's fresh access check and writer fence before resuming these same IDs.
    const outcome = await runIdempotent(
      database,
      context,
      {
        key: input.requestKey,
        requestHash: requestHash([
          'POST',
          'knowledge-sources',
          JSON.stringify([input.title.trim(), input.mediaType, hash, input.classification, grants]),
        ]),
      },
      prepare,
      (result) => ({ status: 201, body: result }),
    );
    if (outcome.kind === 'conflict') throw new AppError('IDEMPOTENCY_KEY_REUSED');
  } else await prepare(database);
  await storeUpload(database, store, context, {
    sourceId,
    documentId,
    body: input.body,
    mediaType: input.mediaType,
  });
  return { sourceId, documentId };
}

/** A new version of an upload. Needs fresh readable owner/manager authority and `knowledge.add`.
 * Same content: no extra version. A connector revision belongs to trusted provider ingestion. */
export async function addDocumentVersion(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  input: {
    sourceId: string;
    expectedVersion: number;
    title: string;
    mediaType: string;
    body: Buffer;
  },
): Promise<{ documentId: string; unchanged: boolean }> {
  validateUpload(input);
  const sourceId = validId(input.sourceId);
  const hash = digest(input.body);
  const prepared = await safeWrite(() =>
    withTenantTx(database, context, async (tx) => {
      const actor = await person(tx, context, 'add');
      const source = await sourceForUpdate(tx, sourceId);
      if (source.ownerMembershipId !== actor.id && !can(actor.role, 'knowledge.manage'))
        throw new AppError('FORBIDDEN');
      if (source.state !== 'active') throw new AppError('KNOWLEDGE_SOURCE_CLOSED');
      if (source.kind !== 'upload') throw new AppError('KNOWLEDGE_GRANT_ON_CONNECTOR_SOURCE');
      const [latest] = await tx
        .select()
        .from(knowledgeDocuments)
        .where(eq(knowledgeDocuments.sourceId, sourceId))
        .orderBy(desc(knowledgeDocuments.versionNo))
        .limit(1);
      if (!latest) throw new AppError('NOT_FOUND');
      // A repeated upload of the same version is harmless even if its first response got lost.
      if (
        latest.contentSha256 === hash &&
        latest.title === input.title.trim() &&
        latest.mediaType === input.mediaType
      ) {
        return { documentId: latest.id, unchanged: true };
      }
      if (source.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
      if (latest.state === 'received' || latest.state === 'parsing')
        throw new AppError('INVALID_STATE');
      const documentId = randomUUID();
      // The old searchable version stays current until the ingest transaction publishes this one.
      await tx.insert(knowledgeDocuments).values({
        organizationId: context.organizationId,
        id: documentId,
        sourceId,
        versionNo: latest.versionNo + 1,
        title: input.title.trim(),
        contentSha256: hash,
        sizeBytes: input.body.length,
        mediaType: input.mediaType,
        objectKey: knowledgeObjectKey(context.organizationId, documentId),
        classification: source.classification,
        createdByMembershipId: context.membershipId,
      });
      await tx
        .update(knowledgeSources)
        .set({ version: source.version + 1, updatedAt: new Date() })
        .where(eq(knowledgeSources.id, sourceId));
      await audit(tx, context, 'knowledge.version_added', sourceId);
      return { documentId, unchanged: false };
    }),
  );
  await storeUpload(database, store, context, {
    ...prepared,
    sourceId,
    body: input.body,
    mediaType: input.mediaType,
  });
  return prepared;
}

/** Sources the viewer can read. With `knowledge.manage`, every source, with no title on the rest. */
export function listSources(
  database: AppDatabase,
  context: TenantContext,
  input: { state?: SourceState; after?: string; limit?: number },
): Promise<SourcePage> {
  const limit = bounded(input.limit);
  let after: { at: string; id: string } | null = null;
  if (input.after) {
    try {
      const value = JSON.parse(Buffer.from(input.after, 'base64url').toString()) as {
        at?: unknown;
        id?: unknown;
      };
      if (
        typeof value.at !== 'string' ||
        !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?\+\d\d(?::\d\d)?$/.test(value.at) ||
        typeof value.id !== 'string'
      )
        throw new Error();
      after = { at: value.at, id: validId(value.id) };
    } catch {
      throw new AppError('INVALID_INPUT');
    }
  }
  if (input.state && !['active', 'revoked', 'deleted'].includes(input.state))
    throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    const actor = await person(tx, context);
    const manage = can(actor.role, 'knowledge.manage');
    const rows = await tx
      .select({
        source: knowledgeSources,
        cursorAt: sql<string>`${knowledgeSources.createdAt}::text`,
      })
      .from(knowledgeSources)
      .where(
        and(
          input.state ? eq(knowledgeSources.state, input.state) : undefined,
          manage
            ? undefined
            : sql`${knowledgeSources.id} in (select knowledge.readable_source_ids(app.current_membership_id()))`,
          after
            ? sql`(${knowledgeSources.createdAt}, ${knowledgeSources.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(knowledgeSources.createdAt), desc(knowledgeSources.id))
      .limit(limit + 1);
    const items = await Promise.all(
      rows.slice(0, limit).map(({ source }) => view(tx, context, source, actor.role)),
    );
    const last = rows[limit - 1];
    return {
      items,
      next:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ at: last.cursorAt, id: last.source.id })).toString(
              'base64url',
            )
          : null,
    };
  });
}

/** NOT_FOUND unless the viewer can read it, or has `knowledge.manage`, which shows no title or URL. */
export function getSource(
  database: AppDatabase,
  context: TenantContext,
  sourceId: string,
): Promise<SourceDetail> {
  const id = validId(sourceId);
  return withTenantTx(database, context, async (tx) => {
    const actor = await person(tx, context);
    // Publication/grant changes take the source's write lock. Keep the published and incoming
    // metadata coherent while this short, authorized detail read loads both document views.
    const [source] = await tx
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, id))
      .for('share');
    if (!source) throw new AppError('NOT_FOUND');
    const result = await view(tx, context, source, actor.role);
    if (!result.canRead && !can(actor.role, 'knowledge.manage')) throw new AppError('NOT_FOUND');
    const [latest] = await tx
      .select({
        id: knowledgeDocuments.id,
        number: knowledgeDocuments.versionNo,
        state: knowledgeDocuments.state,
        scanState: knowledgeDocuments.scanState,
        rejectCode: knowledgeDocuments.rejectCode,
      })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.sourceId, id))
      .orderBy(desc(knowledgeDocuments.versionNo))
      .limit(1);
    return {
      ...result,
      latestVersion: latest
        ? {
            ...latest,
            state: latest.state as DocumentState,
            scanState: latest.scanState as ScanState,
          }
        : null,
    };
  });
}

/** The original bytes, as a citation's path back to its source. NOT_FOUND through the ACL. */
export async function openDocumentBytes(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  documentId: string,
): Promise<{ body: Buffer; mediaType: string; title: string; classification: Classification }> {
  const id = validId(documentId);
  const load = () =>
    withTenantTx(database, context, async (tx) => {
      await person(tx, context);
      const doc = await readableDocument(tx, id);
      if (!doc.objectKey || doc.state === 'purged') throw new AppError('NOT_FOUND');
      if (doc.objectKey !== knowledgeObjectKey(context.organizationId, id))
        throw new AppError('NOT_FOUND');
      const [source] = await tx
        .select({ classification: knowledgeSources.classification })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.id, doc.sourceId));
      if (!source) throw new AppError('NOT_FOUND');
      return {
        ...doc,
        classification: strongestClass([
          doc.classification as Classification,
          source.classification as Classification,
        ]),
      };
    });
  const doc = await load();
  let body: Buffer;
  try {
    body = await store.get(doc.objectKey as string);
  } catch {
    throw new AppError('NOT_FOUND');
  }
  // Revoking while storage was responding is not a right to receive the bytes afterwards.
  const current = await load();
  if (digest(body) !== doc.contentSha256) throw new AppError('INVALID_STATE');
  return {
    body,
    mediaType: doc.mediaType,
    title: doc.title,
    classification: current.classification,
  };
}

/**
 * Needs `knowledge.manage` or to be the source's owner. Takes effect in this commit. Audited with IDs, not
 * names. A connector's source answers KNOWLEDGE_GRANT_ON_CONNECTOR_SOURCE, and a grant too wide for the
 * class answers KNOWLEDGE_GRANT_TOO_WIDE. Removing someone's access needs no purge: reads are live.
 */
export function setSourceGrants(
  database: AppDatabase,
  context: TenantContext,
  input: {
    sourceId: string;
    expectedVersion: number;
    add: readonly SourceGrantInput[];
    removeGrantIds: readonly string[];
  },
): Promise<{ version: number }> {
  const sourceId = validId(input.sourceId);
  const grants = normalizeGrants(input.add);
  const removed = input.removeGrantIds.map(validId);
  if (removed.length > 100) throw new AppError('INVALID_INPUT');
  return safeWrite(() =>
    withTenantTx(database, context, async (tx) => {
      const actor = await person(tx, context, 'write');
      const source = await sourceForUpdate(tx, sourceId);
      if (source.ownerMembershipId !== actor.id && !can(actor.role, 'knowledge.manage'))
        throw new AppError('FORBIDDEN');
      if (source.state !== 'active') throw new AppError('KNOWLEDGE_SOURCE_CLOSED');
      if (source.kind !== 'upload') throw new AppError('KNOWLEDGE_GRANT_ON_CONNECTOR_SOURCE');
      if (source.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
      await validateGrants(tx, grants, source.classification as Classification);
      if (removed.length)
        await tx
          .delete(knowledgeSourceGrants)
          .where(
            and(
              eq(knowledgeSourceGrants.sourceId, sourceId),
              inArray(knowledgeSourceGrants.id, removed),
            ),
          );
      for (const grant of grants) await writeGrant(tx, context, sourceId, grant);
      const version = source.version + 1;
      await tx
        .update(knowledgeSources)
        .set({ version, updatedAt: new Date() })
        .where(eq(knowledgeSources.id, sourceId));
      await audit(tx, context, 'knowledge.grants_changed', sourceId);
      return { version };
    }),
  );
}

/** Same rights as grants. Only rises, and the database refuses the rest. */
export function raiseSourceClassification(
  database: AppDatabase,
  context: TenantContext,
  input: { sourceId: string; expectedVersion: number; classification: Classification },
): Promise<{ version: number }> {
  const sourceId = validId(input.sourceId);
  if (!['public', 'internal', 'confidential', 'restricted'].includes(input.classification))
    throw new AppError('INVALID_INPUT');
  return safeWrite(() =>
    withTenantTx(database, context, async (tx) => {
      const actor = await person(tx, context, 'write');
      const source = await sourceForUpdate(tx, sourceId);
      if (source.ownerMembershipId !== actor.id && !can(actor.role, 'knowledge.manage'))
        throw new AppError('FORBIDDEN');
      if (source.state !== 'active') throw new AppError('KNOWLEDGE_SOURCE_CLOSED');
      if (source.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
      if (!canRaiseClass(source.classification as Classification, input.classification))
        throw new AppError('INVALID_INPUT');
      const version = source.version + 1;
      await tx
        .update(knowledgeSources)
        .set({ classification: input.classification, version, updatedAt: new Date() })
        .where(eq(knowledgeSources.id, sourceId));
      await audit(tx, context, 'knowledge.classification_raised', sourceId);
      return { version };
    }),
  );
}

type SourceRow = typeof knowledgeSources.$inferSelect;
const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const validId = (value: string) => {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data;
};
const bounded = (value = 50) => {
  if (!Number.isInteger(value) || value < 1) throw new AppError('INVALID_INPUT');
  return Math.min(value, 50);
};

/** Re-read authority in the transaction, including calls made with an old context after revocation. */
async function person(tx: Tx, context: TenantContext, operation?: 'add' | 'write') {
  if (context.actorType === 'service' || (operation && context.actorType !== 'user'))
    throw new AppError('FORBIDDEN');
  const [member] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, context.membershipId), eq(memberships.status, 'active')))
    .for('share');
  if (!member) throw new AppError('FORBIDDEN');
  if (operation === 'add' && !can(member.role, 'knowledge.add')) throw new AppError('FORBIDDEN');
  return member;
}

function validateUpload(input: {
  title: string;
  mediaType: string;
  body: Buffer;
  classification?: Classification;
}) {
  if (
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.trim().length > 512 ||
    input.title.includes('\0')
  )
    throw new AppError('INVALID_INPUT');
  if (!Buffer.isBuffer(input.body) || !input.body.length) throw new AppError('INVALID_INPUT');
  if (input.body.length > MAX_DOCUMENT_BYTES) throw new AppError('FILE_TOO_LARGE');
  if (!(INGESTIBLE_MEDIA_TYPES as readonly string[]).includes(input.mediaType))
    throw new AppError('KNOWLEDGE_FORMAT_UNSUPPORTED');
  if (
    input.classification !== undefined &&
    !['public', 'internal', 'confidential', 'restricted'].includes(input.classification)
  )
    throw new AppError('INVALID_INPUT');
}

function normalizeGrants(input: readonly SourceGrantInput[]): SourceGrantInput[] {
  if (!Array.isArray(input) || input.length > 101) throw new AppError('INVALID_INPUT');
  const grants = new Map<string, SourceGrantInput>();
  for (const grant of input) {
    if (grant.kind === 'membership') {
      const membershipId = validId(grant.membershipId);
      grants.set(`m:${membershipId}`, { kind: 'membership', membershipId });
    } else if (grant.kind === 'team') {
      const teamId = validId(grant.teamId);
      grants.set(`t:${teamId}`, { kind: 'team', teamId });
    } else if (grant.kind === 'organization') grants.set('o', { kind: 'organization' });
    else throw new AppError('INVALID_INPUT');
  }
  return [...grants.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, grant]) => grant);
}

async function validateGrants(
  tx: Tx,
  grants: readonly SourceGrantInput[],
  classification: Classification,
) {
  for (const grant of grants) {
    if (!grantAllowedFor(grant.kind, classification))
      throw new AppError('KNOWLEDGE_GRANT_TOO_WIDE');
    if (grant.kind === 'membership') {
      const [member] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.id, grant.membershipId), eq(memberships.status, 'active')))
        .for('share');
      if (!member) throw new AppError('INVALID_INPUT');
    } else if (grant.kind === 'team') {
      const [team] = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.id, grant.teamId))
        .for('share');
      if (!team) throw new AppError('INVALID_INPUT');
    }
  }
}

const writeGrant = (tx: Tx, context: TenantContext, sourceId: string, grant: SourceGrantInput) =>
  tx
    .insert(knowledgeSourceGrants)
    .values({
      organizationId: context.organizationId,
      sourceId,
      principalKind: grant.kind,
      membershipId: grant.kind === 'membership' ? grant.membershipId : null,
      teamId: grant.kind === 'team' ? grant.teamId : null,
      grantedByMembershipId: context.membershipId,
    })
    .onConflictDoNothing();

const serial = (tx: Tx, organizationId: string, key: string) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${organizationId + ':knowledge:' + key}, 0))`,
  );
const audit = (tx: Tx, context: TenantContext, action: string, id: string) =>
  appendAudit(tx, {
    organizationId: context.organizationId,
    actorType: 'user',
    actorId: context.membershipId,
    action,
    targetRef: `knowledge_source:${id}`,
    decision: 'allow',
  });
async function sourceForUpdate(tx: Tx, id: string) {
  const [source] = await tx
    .select()
    .from(knowledgeSources)
    .where(eq(knowledgeSources.id, id))
    .for('update');
  if (!source) throw new AppError('NOT_FOUND');
  return source;
}
async function readableDocument(tx: Tx, id: string) {
  const [doc] = await tx.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, id));
  if (!doc) throw new AppError('NOT_FOUND');
  return doc;
}
async function safeWrite<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    const mapped = {
      EN102: 'INVALID_INPUT',
      EN103: 'KNOWLEDGE_SOURCE_CLOSED',
      EN104: 'KNOWLEDGE_GRANT_ON_CONNECTOR_SOURCE',
      EN105: 'KNOWLEDGE_GRANT_TOO_WIDE',
      '23503': 'INVALID_INPUT',
      '42501': 'FORBIDDEN',
    } as const;
    const code = pgCode(error) as keyof typeof mapped;
    if (mapped[code]) throw new AppError(mapped[code]);
    throw error;
  }
}

async function view(
  tx: Tx,
  _context: TenantContext,
  source: SourceRow,
  role: string,
): Promise<SourceDetail> {
  // RLS filters this read; a manager's extra ability to list sources never becomes access to titles.
  const [doc] = await tx
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.sourceId, source.id), isNull(knowledgeDocuments.supersededAt)))
    .orderBy(
      sql`(${knowledgeDocuments.state} = 'searchable') desc`,
      desc(knowledgeDocuments.versionNo),
    )
    .limit(1);
  const grants = await tx
    .select()
    .from(knowledgeSourceGrants)
    .where(eq(knowledgeSourceGrants.sourceId, source.id));
  return {
    id: source.id,
    canManage: source.ownerMembershipId === _context.membershipId || can(role, 'knowledge.manage'),
    kind: source.kind as SourceKind,
    state: source.state as SourceState,
    classification: source.classification as Classification,
    title: doc?.title ?? null,
    canRead: !!doc,
    documentState: (doc?.state as DocumentState | undefined) ?? null,
    embeddingState: (doc?.embeddingState as EmbeddingState | undefined) ?? null,
    searchableAt: doc?.searchableAt ?? null,
    sourceModifiedAt: doc?.sourceModifiedAt ?? null,
    version: source.version,
    createdAt: source.createdAt,
    documentId: doc?.id ?? null,
    mediaType: doc?.mediaType ?? null,
    sizeBytes: doc?.sizeBytes ?? null,
    sourceUrl: doc?.sourceUrl ?? null,
    sourceVersion: doc?.sourceVersion ?? null,
    scanState: (doc?.scanState as ScanState | undefined) ?? null,
    rejectCode: doc?.rejectCode ?? null,
    grantsManagedByProvider: source.kind === 'connector',
    grants: grants.map((g) =>
      g.principalKind === 'membership'
        ? { id: g.id, kind: 'membership' as const, membershipId: g.membershipId as string }
        : g.principalKind === 'team'
          ? { id: g.id, kind: 'team' as const, teamId: g.teamId as string }
          : { id: g.id, kind: 'organization' as const },
    ),
  };
}

async function storeUpload(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  input: { sourceId: string; documentId: string; body: Buffer; mediaType: string },
) {
  const key = knowledgeObjectKey(context.organizationId, input.documentId);
  // Repeats must not replace an already published object's bytes after its source has moved on.
  const needed = await withTenantTx(database, context, async (tx) => {
    const actor = await person(tx, context, 'add'),
      source = await sourceForUpdate(tx, input.sourceId);
    if (source.ownerMembershipId !== actor.id && !can(actor.role, 'knowledge.manage'))
      throw new AppError('FORBIDDEN');
    const doc = await readableDocument(tx, input.documentId);
    return doc.state === 'received' || doc.state === 'failed'
      ? beginObjectWrite(tx, context, input)
      : null;
  });
  if (!needed) return;
  try {
    await store.put(key, input.body, input.mediaType);
  } catch {
    // The received row is durable. A retry can upload again, and the sweep can mark missing bytes failed.
    throw new AppError('INVALID_STATE');
  }
  try {
    await safeWrite(() =>
      withTenantTx(database, context, async (tx) => {
        const actor = await person(tx, context, 'add');
        const source = await sourceForUpdate(tx, input.sourceId);
        if (source.ownerMembershipId !== actor.id && !can(actor.role, 'knowledge.manage'))
          throw new AppError('FORBIDDEN');
        if (source.state !== 'active') throw new AppError('KNOWLEDGE_SOURCE_CLOSED');
        await readableDocument(tx, input.documentId);
        const [event] = await tx
          .select({ id: domainEvents.id })
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.aggregateId, input.documentId),
              eq(domainEvents.eventType, KNOWLEDGE_DOCUMENT_RECEIVED),
            ),
          );
        if (!event)
          await emit(tx, context, {
            eventType: KNOWLEDGE_DOCUMENT_RECEIVED,
            aggregateType: AGGREGATE_KNOWLEDGE_DOCUMENT,
            aggregateId: input.documentId,
            aggregateVersion: 1,
            classification: source.classification,
            payload: { source_id: source.id },
          });
        await settleObjectWrite(tx, needed);
      }),
    );
  } catch (error) {
    // The put resolved, so this particular writer has ended. Do not release its barrier until failed
    // publication's bytes are confirmed absent; a delete outage intentionally strands it for recovery.
    await store.delete(key);
    if (await store.exists(key)) throw new AppError('INVALID_STATE');
    await withTenantTx(database, context, (tx) => settleObjectWrite(tx, needed));
    throw error;
  }
}
