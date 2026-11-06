// Workflow drafts and the immutable specs they become (AGENT-09, ADR-031 D7). A draft is what a person draws.
// It can save in any state, because a half-drawn graph is normal. Only what compiles gets a hash, and only a
// hash can go on to a simulation, a review and a spec. Owned by the graph slice.
import { createHash } from 'node:crypto';
import {
  createProcessDraftSchema,
  processGraphSchema,
  updateProcessDraftSchema,
} from '@ensemus/contracts/studio';
import { withTenantTx, type AppDatabase, type TenantContext, type Tx } from '@ensemus/database';
import { processDrafts, processSpecs, publishReviews } from '@ensemus/database/product';
import type { ToolFacts } from '@ensemus/domain/agent-draft';
import { canonicalJson } from '@ensemus/domain/approval';
import {
  compileProcessGraph,
  verifyProcessSpec,
  type CompileResult,
  type GraphIssue,
  type ProcessGraph,
  type ProcessSpec,
} from '@ensemus/domain/process-spec';
import { canProduct, canReadRecord } from '@ensemus/domain/product-policy';
import { and, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { canonicalId } from '../ids';
import { auditAction } from '../work';
import type { AgentVersionSummary, ProductPorts } from './ports';

export type ProcessDraftView = {
  id: string;
  name: string;
  ownerMembershipId: string;
  classification: ProcessSpec['classification'];
  graph: ProcessGraph;
  specSha256: string | null;
  issues: readonly GraphIssue[];
  status: 'editing' | 'in_review' | 'published' | 'archived';
  version: number;
  updatedAt: Date;
};

export type ProcessSpecView = {
  id: string;
  processKey: string;
  versionNumber: number;
  name: string;
  classification: ProcessSpec['classification'];
  spec: ProcessSpec;
  specSha256: string;
  source: 'graph' | 'bundled' | 'pack';
  sourceRef: string | null;
  publishedAt: Date;
};

/**
 * What a graph may name, read from M4. Null means that part is not available on this deployment, which is
 * not the same as being empty: a page has to word the two differently, and drawing carries on either way.
 */
export type ProcessCatalog = {
  /** Only what can be an `external_action`. */
  tools: readonly ToolFacts[] | null;
  /** One entry per published agent, its newest version. */
  agents: readonly AgentVersionSummary[] | null;
};

type CatalogPorts = Pick<ProductPorts, 'toolCatalog' | 'agentRegistry'>;
type DraftRow = typeof processDrafts.$inferSelect;
type SpecRow = typeof processSpecs.$inferSelect;

/** A list has no catalog to compile against, and a tenant's drafts are a person's work, so few. */
const MAX_LISTED = 200;
const PROCESS_KEY = /^[a-z][a-z0-9_.-]{1,63}$/;
/** More than two people publishing the same key at the same moment already does not happen. */
const MAX_PUBLISH_ATTEMPTS = 5;

const sha256 = (canonical: string) => createHash('sha256').update(canonical).digest('hex');

/** Where a new draft starts: the two boxes every workflow needs, joined, and nothing that can run yet. */
const NEW_GRAPH: ProcessGraph = {
  schemaVersion: 1,
  nodes: [
    { id: 'start', kind: 'start', label: 'Start', x: 40, y: 120 },
    { id: 'end', kind: 'end', label: 'End', x: 680, y: 120 },
  ],
  edges: [{ from: 'start', to: 'end' }],
};

function assertCanAuthor(context: TenantContext) {
  if (context.actorType !== 'user' || !canProduct(context.role, 'studio.author')) {
    throw new AppError('FORBIDDEN');
  }
}

/** A published spec is read by those who publish and start them, and it is never a person's own work. */
function assertCanReadSpecs(context: TenantContext) {
  if (context.actorType !== 'user' || !canProduct(context.role, 'studio.publish')) {
    throw new AppError('FORBIDDEN');
  }
}

const viewer = (context: TenantContext) => ({
  membershipId: context.membershipId,
  role: context.role,
});

function parseGraph(graph: unknown): ProcessGraph {
  const parsed = processGraphSchema.safeParse(graph);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data as ProcessGraph;
}

const isUnavailable = (error: unknown) =>
  error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE';

/** Only this one failure is an answer. Anything else is a real fault, and goes up as one. */
const orNullIfUnavailable = <T>(read: Promise<T>): Promise<T | null> =>
  read.catch((error: unknown) => {
    if (isUnavailable(error)) return null;
    throw error;
  });

/**
 * Reads M4's catalog. Never in a transaction, because a port may take as long as it likes. An `external_action`
 * goes through M3's proposal, so only a tool that writes outside can be one, and a tool that reaches secrets
 * is refused here as it is in the guided builder.
 */
export async function loadProcessCatalog(
  context: TenantContext,
  ports: CatalogPorts,
): Promise<ProcessCatalog> {
  assertCanAuthor(context);
  const [tools, versions] = await Promise.all([
    orNullIfUnavailable(ports.toolCatalog.list(context)),
    orNullIfUnavailable(ports.agentRegistry.list(context)),
  ]);
  const newest = new Map<string, AgentVersionSummary>();
  for (const version of versions ?? []) {
    const held = newest.get(version.definitionId);
    if (!held || version.versionNumber > held.versionNumber) {
      newest.set(version.definitionId, version);
    }
  }
  return {
    tools:
      tools?.filter((tool) => tool.class === 'external_write' && !tool.id.startsWith('secrets.')) ??
      null,
    agents: versions ? [...newest.values()] : null,
  };
}

/**
 * A catalog that is not available names nothing, so a graph that needs it reports an unknown tool or agent and
 * gets no hash. That fails safe, and the page says why. A graph that names neither still compiles.
 */
function compileWith(
  graph: ProcessGraph,
  classification: ProcessSpec['classification'],
  catalog: ProcessCatalog,
): CompileResult {
  return compileProcessGraph(
    graph,
    {
      classification,
      agentDefinitionIds: new Set(catalog.agents?.map((agent) => agent.definitionId)),
      toolIds: new Set(catalog.tools?.map((tool) => tool.id)),
    },
    sha256,
  );
}

const EMPTY_CATALOG: ProcessCatalog = { tools: null, agents: null };

function toDraftView(
  row: DraftRow,
  issues: readonly GraphIssue[],
  specSha256: string | null,
): ProcessDraftView {
  return {
    id: row.id,
    name: row.name,
    ownerMembershipId: row.ownerMembershipId,
    classification: row.classification as ProcessSpec['classification'],
    graph: row.graph as ProcessGraph,
    specSha256,
    issues,
    status: row.status as ProcessDraftView['status'],
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

function toSpecView(row: SpecRow): ProcessSpecView {
  return {
    id: row.id,
    processKey: row.processKey,
    versionNumber: row.versionNumber,
    name: row.name,
    classification: row.classification as ProcessSpec['classification'],
    spec: row.spec as ProcessSpec,
    specSha256: row.specSha256,
    source: row.source as ProcessSpecView['source'],
    sourceRef: row.sourceRef,
    publishedAt: row.publishedAt,
  };
}

/** Whoever may not see a draft finds nothing there, the same as for another tenant's. */
async function loadDraft(tx: Tx, context: TenantContext, draftId: string, lock: boolean) {
  const id = canonicalId(draftId);
  const query = tx
    .select()
    .from(processDrafts)
    .where(
      and(eq(processDrafts.organizationId, context.organizationId), eq(processDrafts.id, id)),
    );
  const [row] = lock ? await query.for('update') : await query;
  if (!row || !canReadRecord(row, viewer(context))) throw new AppError('NOT_FOUND');
  return row;
}

/** Needs `studio.author`. */
export async function createProcessDraft(
  database: AppDatabase,
  context: TenantContext,
  input: { name: string; classification: ProcessSpec['classification'] },
): Promise<ProcessDraftView> {
  assertCanAuthor(context);
  const parsed = createProcessDraftSchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .insert(processDrafts)
      .values({
        organizationId: context.organizationId,
        name: parsed.data.name,
        ownerMembershipId: context.membershipId,
        classification: parsed.data.classification,
        graph: NEW_GRAPH,
        specSha256: null,
        createdByMembershipId: context.membershipId,
      })
      .returning();
    if (!row) throw new Error('Insert returned no row');
    await auditAction(tx, context, 'process_draft.created', `process_draft:${row.id}`);
    return toDraftView(row, issuesOf(NEW_GRAPH, parsed.data.classification), null);
  });
}

/**
 * For a pack, in its transaction. There is no catalog in a transaction, so a graph that names a tool or an
 * agent saves with no hash, and the draft's own page checks it again against the catalog. A pack gets no way
 * past the compiler: this is exactly the state a person's half-finished draft is in.
 */
export async function createProcessDraftInTx(
  tx: Tx,
  context: TenantContext,
  input: {
    name: string;
    classification: ProcessSpec['classification'];
    graph: ProcessGraph;
  },
): Promise<{ id: string }> {
  assertCanAuthor(context);
  const parsed = createProcessDraftSchema.safeParse({
    name: input.name,
    classification: input.classification,
  });
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const graph = parseGraph(input.graph);
  const compiled = compileWith(graph, parsed.data.classification, EMPTY_CATALOG);
  const [row] = await tx
    .insert(processDrafts)
    .values({
      organizationId: context.organizationId,
      name: parsed.data.name,
      ownerMembershipId: context.membershipId,
      classification: parsed.data.classification,
      graph,
      specSha256: compiled.specSha256,
      createdByMembershipId: context.membershipId,
    })
    .returning({ id: processDrafts.id });
  if (!row) throw new Error('Insert returned no row');
  await auditAction(tx, context, 'process_draft.created', `process_draft:${row.id}`, 'pack');
  return { id: row.id };
}

/** What a graph's own structure says, leaving out what only a catalog could answer. */
function issuesOf(
  graph: ProcessGraph,
  classification: ProcessSpec['classification'],
): readonly GraphIssue[] {
  return compileWith(graph, classification, EMPTY_CATALOG).issues.filter(
    (issue) => issue.code !== 'UNKNOWN_TOOL' && issue.code !== 'UNKNOWN_AGENT',
  );
}

/**
 * Newest first, and at most the newest 200. This has no catalog, so `issues` holds what the graph's own
 * structure says, and `specSha256` is what was stored when it last compiled. `getProcessDraft` is the answer
 * to whether one can go forward now.
 */
export async function listProcessDrafts(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly ProcessDraftView[]> {
  assertCanAuthor(context);
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select()
      .from(processDrafts)
      .where(
        and(
          eq(processDrafts.organizationId, context.organizationId),
          // Restricted is limited to the person holding it, so the limit counts only what they may see.
          or(
            ne(processDrafts.classification, 'restricted'),
            eq(processDrafts.ownerMembershipId, context.membershipId),
          ),
        ),
      )
      .orderBy(desc(processDrafts.updatedAt), desc(processDrafts.id))
      .limit(MAX_LISTED),
  );
  return rows
    .filter((row) => canReadRecord(row, viewer(context)))
    .map((row) =>
      toDraftView(
        row,
        issuesOf(row.graph as ProcessGraph, row.classification as ProcessSpec['classification']),
        row.specSha256,
      ),
    );
}

/**
 * Compiles it again against the catalog as it stands now. The hash here is only ever the one stored, and only
 * when that is still what the graph compiles to: a simulation binds the stored hash, so offering anything
 * else would promise something it would refuse. When the two differ, a save with no changes brings them back
 * together, and until then there is no hash.
 */
export async function getProcessDraft(
  database: AppDatabase,
  context: TenantContext,
  ports: CatalogPorts,
  draftId: string,
): Promise<ProcessDraftView> {
  const catalog = await loadProcessCatalog(context, ports);
  const row = await withTenantTx(database, context, (tx) =>
    loadDraft(tx, context, draftId, false),
  );
  const compiled = compileWith(
    row.graph as ProcessGraph,
    row.classification as ProcessSpec['classification'],
    catalog,
  );
  const agrees = compiled.ok && compiled.specSha256 === row.specSha256;
  return toDraftView(row, compiled.issues, agrees ? row.specSha256 : null);
}

/**
 * Saves the graph and recompiles it. A graph that does not compile saves, with no hash and its issues.
 *
 * Moving a box changes nothing anyone reviewed, so it keeps the draft's state and writes no audit row, and a
 * person dragging things around does not fill the record. Anything else a reader saw, the steps or the name,
 * cancels a review still open on the old content and takes the draft back to `editing`. A published spec is
 * immutable and stays exactly as it was, and the draft goes on to become its next version.
 */
export async function updateProcessDraft(
  database: AppDatabase,
  context: TenantContext,
  ports: CatalogPorts,
  input: {
    draftId: string;
    expectedVersion: number;
    name?: string;
    classification?: ProcessSpec['classification'];
    graph?: ProcessGraph;
  },
): Promise<ProcessDraftView> {
  assertCanAuthor(context);
  const parsed = updateProcessDraftSchema.safeParse({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.classification !== undefined ? { classification: input.classification } : {}),
    ...(input.graph !== undefined ? { graph: input.graph } : {}),
  });
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const changes = parsed.data;
  const catalog = await loadProcessCatalog(context, ports);

  return withTenantTx(database, context, async (tx) => {
    // The lock is what `publishApproved` holds too, so a save and a publish cannot interleave.
    const row = await loadDraft(tx, context, input.draftId, true);
    if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (row.status === 'archived') throw new AppError('INVALID_STATE');

    const name = changes.name ?? row.name;
    const classification = (changes.classification ??
      row.classification) as ProcessSpec['classification'];
    const graph = changes.graph ? (changes.graph as ProcessGraph) : (row.graph as ProcessGraph);
    const compiled = compileWith(graph, classification, catalog);

    const sameGraph = canonicalJson(graph) === canonicalJson(row.graph);
    const sameHash = compiled.specSha256 === row.specSha256;
    const moreThanMoved =
      name !== row.name || classification !== row.classification || !sameHash ||
      // Two graphs that do not compile have no hash to compare, and any edit to one is an edit.
      (compiled.specSha256 === null && !sameGraph);
    if (sameGraph && !moreThanMoved) {
      return toDraftView(row, compiled.issues, row.specSha256);
    }

    if (moreThanMoved) {
      const cancelled = await tx
        .update(publishReviews)
        .set({
          status: 'cancelled',
          version: sql`${publishReviews.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(publishReviews.organizationId, context.organizationId),
            eq(publishReviews.subjectKind, 'process_draft'),
            eq(publishReviews.subjectId, row.id),
            inArray(publishReviews.status, ['pending', 'approved']),
          ),
        )
        .returning({ id: publishReviews.id });
      for (const review of cancelled) {
        await auditAction(
          tx,
          context,
          'publish_review.cancelled',
          `publish_review:${review.id}`,
          'draft_changed',
        );
      }
    }

    const [saved] = await tx
      .update(processDrafts)
      .set({
        name,
        classification,
        graph,
        specSha256: compiled.specSha256,
        status: moreThanMoved ? 'editing' : row.status,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(processDrafts.organizationId, context.organizationId),
          eq(processDrafts.id, row.id),
          eq(processDrafts.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!saved) throw new AppError('VERSION_CONFLICT');
    if (moreThanMoved) {
      await auditAction(
        tx,
        context,
        'process_draft.updated',
        `process_draft:${row.id}`,
        compiled.ok ? 'compiles' : 'does_not_compile',
      );
    }
    return toDraftView(saved, compiled.issues, compiled.specSha256);
  });
}

/**
 * Called by `publishApproved`, in its transaction, with a draft whose hash it has already checked. Writes the
 * next version for the key. Two people publishing at once both read the same highest number, and the unique
 * index decides: the loser's insert does nothing, and its next statement sees the winner's row. Nothing is
 * read first to avoid that, because no read could.
 *
 * It looks at the spec again, because this is the only way into an immutable table: a hash that does not match
 * what is being written, or a spec the compiler would have refused, stops here whoever called. The audit row
 * is written here and the event is left to the caller, which knows what the publishing was of.
 */
export async function publishProcessSpecInTx(
  tx: Tx,
  context: TenantContext,
  input: {
    processKey: string;
    name: string;
    classification: ProcessSpec['classification'];
    spec: ProcessSpec;
    specSha256: string;
    source: 'graph' | 'bundled' | 'pack';
    sourceRef?: string;
  },
): Promise<{ specId: string; versionNumber: number }> {
  if (context.actorType !== 'user' || !canProduct(context.role, 'studio.publish')) {
    throw new AppError('FORBIDDEN');
  }
  if (!PROCESS_KEY.test(input.processKey)) throw new AppError('INVALID_INPUT');
  if (input.spec.classification !== input.classification) throw new AppError('INVALID_INPUT');
  if (sha256(canonicalJson(input.spec)) !== input.specSha256) {
    throw new AppError('SIMULATION_STALE');
  }
  if (verifyProcessSpec(input.spec).length > 0) throw new AppError('GRAPH_INVALID');

  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
    const [row] = await tx
      .insert(processSpecs)
      .values({
        organizationId: context.organizationId,
        processKey: input.processKey,
        versionNumber: sql`(
          select coalesce(max(${processSpecs.versionNumber}), 0) + 1
          from ${processSpecs}
          where ${processSpecs.organizationId} = ${context.organizationId}
            and ${processSpecs.processKey} = ${input.processKey}
        )`,
        name: input.name,
        classification: input.classification,
        spec: input.spec,
        specSha256: input.specSha256,
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        publishedByMembershipId: context.membershipId,
      })
      .onConflictDoNothing({
        target: [
          processSpecs.organizationId,
          processSpecs.processKey,
          processSpecs.versionNumber,
        ],
      })
      .returning({ id: processSpecs.id, versionNumber: processSpecs.versionNumber });
    if (row) {
      await auditAction(
        tx,
        context,
        'process_spec.published',
        `process_spec:${row.id}`,
        input.source,
      );
      return { specId: row.id, versionNumber: row.versionNumber };
    }
  }
  throw new AppError('VERSION_CONFLICT');
}

/** Newest first, and at most the newest 200. Restricted specs show only to the person who published them. */
export async function listProcessSpecs(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly ProcessSpecView[]> {
  assertCanReadSpecs(context);
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select()
      .from(processSpecs)
      .where(
        and(
          eq(processSpecs.organizationId, context.organizationId),
          or(
            ne(processSpecs.classification, 'restricted'),
            eq(processSpecs.publishedByMembershipId, context.membershipId),
          ),
        ),
      )
      .orderBy(desc(processSpecs.publishedAt), desc(processSpecs.id))
      .limit(MAX_LISTED),
  );
  return rows.filter((row) => canReadSpec(row, context)).map(toSpecView);
}

const canReadSpec = (row: SpecRow, context: TenantContext) =>
  canReadRecord(
    { classification: row.classification, ownerMembershipId: row.publishedByMembershipId },
    viewer(context),
  );

export async function getProcessSpec(
  database: AppDatabase,
  context: TenantContext,
  specId: string,
): Promise<ProcessSpecView> {
  assertCanReadSpecs(context);
  const id = canonicalId(specId);
  const [row] = await withTenantTx(database, context, (tx) =>
    tx
      .select()
      .from(processSpecs)
      .where(and(eq(processSpecs.organizationId, context.organizationId), eq(processSpecs.id, id))),
  );
  if (!row || !canReadSpec(row, context)) throw new AppError('NOT_FOUND');
  return toSpecView(row);
}
