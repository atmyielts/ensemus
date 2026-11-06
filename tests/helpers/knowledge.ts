// Test seeds and doubles for ADR-029, shared by every M5 slice. They go through the real triggers and
// policies as the application role, so a seed can never reach a state the rules forbid. Generated test
// values only: no real document, address, credential or provider.
import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentRuns,
  AgentWorkloads,
  EgressLedgerRow,
  RunEgressDecisions,
  RunTranscriptPurge,
} from '@ensemus/application/knowledge/ports';
import {
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeSourceGrants,
  knowledgeSources,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import type { Classification } from '@ensemus/domain/policy';
import { eq, sql } from 'drizzle-orm';

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A word no document would hold, built at run time, for proving something did not reach a place. */
export const knowledgeCanary = (label = 'canary') => `${label}${randomUUID().replaceAll('-', '')}`;

export async function seedMember(
  database: AppDatabase,
  context: TenantContext,
  auth: { query(text: string, values: unknown[]): Promise<unknown> },
  role: 'owner' | 'admin' | 'member' = 'member',
) {
  const userId = randomUUID();
  await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
    userId,
    'Test person',
    `person-${userId}@example.invalid`,
  ]);
  const membershipId = randomUUID();
  await withTenantTx(database, context, (tx) =>
    tx.execute(
      sql`insert into org.memberships (organization_id, id, user_id, role)
          values (${context.organizationId}, ${membershipId}, ${userId}, ${role})`,
    ),
  );
  return { userId, membershipId };
}

export type SeededGrant =
  | { kind: 'membership'; membershipId: string }
  | { kind: 'team'; teamId: string }
  | { kind: 'organization' };

export type SeededSource = {
  sourceId: string;
  documentId: string;
  chunkIds: readonly string[];
};

/**
 * An uploaded source, already searchable, with `passages` as its chunks. The source, grants and document
 * are written as `context`, as a person's upload is. The chunks are written as a service, as the worker
 * writes them.
 */
export async function seedSearchableSource(
  database: AppDatabase,
  context: TenantContext,
  input: {
    title?: string;
    classification?: Classification;
    grants?: readonly SeededGrant[];
    passages: readonly string[];
  },
): Promise<SeededSource> {
  const { organizationId } = context;
  const classification = input.classification ?? 'internal';
  const sourceId = randomUUID();
  const documentId = randomUUID();
  const body = input.passages.join('\n\n');
  await withTenantTx(database, context, async (tx) => {
    await tx.insert(knowledgeSources).values({
      organizationId,
      id: sourceId,
      kind: 'upload',
      classification,
      ownerMembershipId: context.membershipId || null,
    });
    for (const grant of input.grants ?? []) {
      await tx.insert(knowledgeSourceGrants).values({
        organizationId,
        sourceId,
        principalKind: grant.kind,
        membershipId: grant.kind === 'membership' ? grant.membershipId : null,
        teamId: grant.kind === 'team' ? grant.teamId : null,
      });
    }
    await tx.insert(knowledgeDocuments).values({
      organizationId,
      id: documentId,
      sourceId,
      versionNo: 1,
      title: input.title ?? 'A test document',
      contentSha256: sha256(body),
      sizeBytes: Buffer.byteLength(body),
      mediaType: 'text/plain',
      classification,
    });
  });
  const service = createServiceContext(organizationId);
  const chunkIds = input.passages.map(() => randomUUID());
  await withTenantTx(database, service, async (tx) => {
    await tx
      .update(knowledgeDocuments)
      .set({ state: 'parsing' })
      .where(eq(knowledgeDocuments.id, documentId));
    let start = 0;
    for (const [ordinal, passage] of input.passages.entries()) {
      await tx.insert(knowledgeChunks).values({
        organizationId,
        id: chunkIds[ordinal] as string,
        documentId,
        sourceId,
        ordinal,
        textBody: passage,
        contentSha256: sha256(passage),
        tokenEstimate: Math.ceil(passage.length / 4),
        charStart: start,
        charEnd: start + passage.length,
      });
      start += passage.length + 2;
    }
    await tx
      .update(knowledgeDocuments)
      .set({ state: 'searchable', searchableAt: new Date() })
      .where(eq(knowledgeDocuments.id, documentId));
  });
  return { sourceId, documentId, chunkIds };
}

/** Fails if called: what a slice's test uses until M4's real port is wired at the final merge. */
export const unusedAgentRuns: AgentRuns = {
  requestRun: () => Promise.reject(new Error('Not expected in this test')),
  statusOf: () => Promise.reject(new Error('Not expected in this test')),
};

export function recordingTranscriptPurge(): RunTranscriptPurge & { runIds: string[] } {
  const runIds: string[] = [];
  return {
    runIds,
    async purgeUsing(_tx, _context, query) {
      runIds.push(...query.runIds);
      return { removed: query.runIds.length };
    },
  };
}

export const scriptedRunDecisions = (
  rows: readonly EgressLedgerRow[] = [],
): RunEgressDecisions => ({
  list: async (_tx, query) => rows.slice(0, query.limit),
});

export const scriptedAgentWorkloads = (
  workloads: Awaited<ReturnType<AgentWorkloads['list']>> = [],
): AgentWorkloads => ({ list: async () => workloads });
