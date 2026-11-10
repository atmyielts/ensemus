// Owned by the packs slice (AGENT-14). See docs/06-delivery/m7-slices.md and ADR-031 D10. A manifest grants
// nothing: nothing in this file, or anywhere else, reads a capability review to allow anything. A review only
// says which drafts and types get made, and each draft still has to pass Studio's simulation and review.
import { createHash } from 'node:crypto';
import { withTenantTx, type AppDatabase, type TenantContext, type Tx } from '@ensemus/database';
import {
  agentDrafts,
  objectMigrations,
  objectTypes,
  objectTypeVersions,
  packCapabilityReviews,
  packInstallations,
  packInstalledItems,
  processDrafts,
  publishReviews,
} from '@ensemus/database/product';
import type { AgentDraftAnswers, ToolFacts } from '@ensemus/domain/agent-draft';
import { canonicalJson } from '@ensemus/domain/approval';
import type { ObjectField, ObjectRelationDefinition } from '@ensemus/domain/custom-object';
import {
  dataAccessStringKey,
  mergePackTypeShape,
  planPackItems,
  planPackRollback,
  planPackUpgrade,
  sideEffectsStringKey,
  validatePackManifest,
  type PackCapability,
  type PackItemRow,
  type PackLeftOutReason,
  type PackManifest,
  type TypeShape,
  type UpgradePlan,
} from '@ensemus/domain/pack';
import {
  AGGREGATE_OBJECT_MIGRATION,
  AGGREGATE_OBJECT_TYPE,
  AGGREGATE_PACK_INSTALLATION,
  OBJECT_MIGRATION_REQUESTED,
  OBJECT_TYPE_CHANGED,
  PACK_ACTIVATED,
  PACK_ROLLED_BACK,
} from '@ensemus/domain/product-events';
import { canProduct } from '@ensemus/domain/product-policy';
import { PACK_CATALOG } from '@ensemus/packs';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { emit } from '../events';
import { auditAction } from '../work';
import { createAgentDraftInTx } from './agent-drafts';
import { createObjectTypeInTx } from './custom-objects';
import { unavailablePorts, type ToolCatalogPort } from './ports';
import { assertRecentMfa, type SessionProof } from './privileged';
import { createProcessDraftInTx } from './process-specs';

export type PackCatalogEntry = {
  key: string;
  version: string;
  name: string;
  description: string;
  installation: { id: string; version: string; status: string } | null;
  upgrade: UpgradePlan | null;
};

export type PackInstallationView = {
  id: string;
  packKey: string;
  packVersion: string;
  manifestSha256: string;
  status: 'reviewing' | 'active' | 'superseded' | 'rolled_back' | 'cancelled';
  capabilities: readonly (PackCapability & {
    decision: 'pending' | 'accepted' | 'declined';
    decidedByMembershipId: string | null;
  })[];
  items: readonly { kind: string; key: string; id: string }[];
  version: number;
};

export type PackInstallationSummary = {
  id: string;
  packKey: string;
  packVersion: string;
  status: PackInstallationView['status'];
  createdAt: Date;
  activatedAt: Date | null;
};

/** Why something the manifest proposes is not among what an installation makes. */
export type PackItemLeftOutReason = PackLeftOutReason | 'name_in_use';

/** What the review page needs: each request in plain words, and what deciding would actually make. */
export type PackReview = {
  installation: PackInstallationView;
  name: string;
  description: string;
  toolCatalog: 'available' | 'unavailable';
  requests: readonly {
    key: string;
    kind: PackCapability['kind'];
    subject: string;
    risk: PackCapability['risk'];
    decision: 'pending' | 'accepted' | 'declined';
    why: string;
    dataAccess: string;
    sideEffects: string;
    tool: {
      availability: 'available' | 'unavailable' | 'unknown';
      class: ToolFacts['class'] | null;
      requiresApproval: boolean | null;
    } | null;
    /** The items left out if this is declined, by the names the pack gives them. */
    neededBy: readonly string[];
    /** Not asked for by the version this one replaces. */
    isNew: boolean;
  }[];
  /** What activating would make with today's decisions, or what activating did make. */
  willMake: readonly { kind: string; key: string; name: string }[];
  leftOut: readonly { name: string; reason: PackItemLeftOutReason; subject: string | null }[];
  /** Filled in once a version was left behind by a rollback. */
  rollback: {
    keptTypes: readonly { key: string; name: string; id: string }[];
    published: readonly { kind: string; key: string; name: string; id: string }[];
    archived: readonly { kind: string; key: string; name: string; id: string }[];
  } | null;
  canActivate: boolean;
  canRollback: boolean;
};

/**
 * What the services need that is not a table. The fixed signatures below take no ports, so a caller that has a
 * tool catalog passes it to `createPackService`, and one that does not gets the honest default: the catalog
 * says unavailable, so nothing that names a tool is made. Tests pass doubles here, and nothing ships one.
 */
export type PackDependencies = {
  toolCatalog: ToolCatalogPort;
  catalog: readonly PackManifest[];
  createObjectTypeInTx: typeof createObjectTypeInTx;
  createAgentDraftInTx: typeof createAgentDraftInTx;
  createProcessDraftInTx: typeof createProcessDraftInTx;
  addObjectTypeVersionInTx: (
    tx: Tx,
    context: TenantContext,
    input: { typeId: string; shape: TypeShape },
  ) => Promise<void>;
};

type InstallationRow = typeof packInstallations.$inferSelect;

const INSTALLATION_LIST_LIMIT = 50;

/** Over the canonical manifest, so a catalog version that changed under an installation is noticed. */
export function packManifestSha256(manifest: PackManifest): string {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

function requireManager(context: TenantContext) {
  if (!canProduct(context.role, 'pack.manage')) throw new AppError('FORBIDDEN');
}

/** A trigger said no after the service's own check passed, which takes a race. It means the same thing. */
function translated(error: unknown): unknown {
  switch (pgCode(error)) {
    case 'EN404':
      return new AppError('PACK_CAPABILITY_UNREVIEWED');
    case 'EN401':
      return new AppError('INVALID_STATE');
    case '23505':
      return new AppError('VERSION_CONFLICT');
    default:
      return error;
  }
}

function findManifest(deps: PackDependencies, key: string, version: string): PackManifest | null {
  return deps.catalog.find((pack) => pack.key === key && pack.version === version) ?? null;
}

function requireSoundManifest(deps: PackDependencies, key: string, version: string): PackManifest {
  const manifest = findManifest(deps, key, version);
  if (!manifest || validatePackManifest(manifest).length > 0) throw new AppError('PACK_INVALID');
  return manifest;
}

/** A catalog with nothing behind it is not an error. It is what a deployment without M4 honestly has. */
async function readTools(
  deps: PackDependencies,
  context: TenantContext,
): Promise<readonly ToolFacts[] | null> {
  try {
    return await deps.toolCatalog.list(context);
  } catch (error) {
    if (error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE') return null;
    throw error;
  }
}

const installationWhere = (context: TenantContext, id: string) =>
  and(eq(packInstallations.organizationId, context.organizationId), eq(packInstallations.id, id));

async function readInstallation(tx: Tx, context: TenantContext, id: string) {
  const [row] = await tx.select().from(packInstallations).where(installationWhere(context, id));
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

/**
 * Every row of one pack in this tenant, locked, always in the same order, so activation and rollback cannot
 * deadlock and neither can see the other half done.
 */
async function lockPackRows(tx: Tx, context: TenantContext, packKey: string) {
  return tx
    .select()
    .from(packInstallations)
    .where(
      and(
        eq(packInstallations.organizationId, context.organizationId),
        eq(packInstallations.packKey, packKey),
      ),
    )
    .orderBy(asc(packInstallations.id))
    .for('no key update');
}

async function readDecisions(tx: Tx, context: TenantContext, installationId: string) {
  return tx
    .select()
    .from(packCapabilityReviews)
    .where(
      and(
        eq(packCapabilityReviews.organizationId, context.organizationId),
        eq(packCapabilityReviews.installationId, installationId),
      ),
    );
}

async function readItems(
  tx: Tx,
  context: TenantContext,
  installationId: string,
): Promise<PackItemRow[]> {
  const rows = await tx
    .select({
      kind: packInstalledItems.itemKind,
      key: packInstalledItems.itemKey,
      id: packInstalledItems.itemId,
    })
    .from(packInstalledItems)
    .where(
      and(
        eq(packInstalledItems.organizationId, context.organizationId),
        eq(packInstalledItems.installationId, installationId),
      ),
    )
    .orderBy(asc(packInstalledItems.itemKind), asc(packInstalledItems.itemKey));
  return rows;
}

async function viewOf(
  tx: Tx,
  deps: PackDependencies,
  context: TenantContext,
  row: InstallationRow,
): Promise<PackInstallationView> {
  // Older versions stay in the catalog, so this only happens if a release breaks that promise.
  const manifest = findManifest(deps, row.packKey, row.packVersion);
  if (!manifest) throw new AppError('PACK_INVALID');
  const decisions = await readDecisions(tx, context, row.id);
  return {
    id: row.id,
    packKey: row.packKey,
    packVersion: row.packVersion,
    manifestSha256: row.manifestSha256,
    status: row.status as PackInstallationView['status'],
    capabilities: manifest.capabilities.map((capability) => {
      const review = decisions.find((item) => item.capabilityKey === capability.key);
      return {
        ...capability,
        decision: (review?.decision ?? 'pending') as 'pending' | 'accepted' | 'declined',
        decidedByMembershipId: review?.decidedByMembershipId ?? null,
      };
    }),
    items: await readItems(tx, context, row.id),
    version: row.version,
  };
}

/**
 * The audit reason for one capability decision. appendAudit accepts only upper-case codes, so the lower-case
 * decision itself was refused there and every decision over HTTP or the form answered 500. Anything but the
 * two decisions is refused, so nothing a caller wrote can reach the log.
 */
export function capabilityDecisionReason(
  decision: 'accepted' | 'declined',
): 'ACCEPTED' | 'DECLINED' {
  if (decision === 'accepted') return 'ACCEPTED';
  if (decision === 'declined') return 'DECLINED';
  throw new AppError('INVALID_INPUT');
}

const decidedOnly = (decisions: readonly { capabilityKey: string; decision: string }[]) => {
  const decided: Record<string, 'accepted' | 'declined'> = {};
  for (const { capabilityKey, decision } of decisions) {
    if (decision === 'accepted' || decision === 'declined') decided[capabilityKey] = decision;
  }
  return decided;
};

/**
 * The same table work the objects slice does for `addObjectTypeVersion`, in the caller's transaction, because
 * an upgrade has to be one transaction and that service opens its own. The shape has already been through
 * `planTypeMigration`. Records move in the worker afterwards, each staying valid where it is until then.
 */
async function addObjectTypeVersionThroughTables(
  tx: Tx,
  context: TenantContext,
  input: { typeId: string; shape: TypeShape },
): Promise<void> {
  const [type] = await tx
    .select()
    .from(objectTypes)
    .where(
      and(eq(objectTypes.organizationId, context.organizationId), eq(objectTypes.id, input.typeId)),
    )
    .for('no key update');
  if (!type) throw new AppError('NOT_FOUND');
  const from = type.currentVersionNumber;
  const to = from + 1;
  await tx.insert(objectTypeVersions).values({
    organizationId: context.organizationId,
    typeId: type.id,
    versionNumber: to,
    fields: input.shape.fields,
    relations: input.shape.relations,
    schemaSha256: createHash('sha256')
      .update(canonicalJson({ fields: input.shape.fields, relations: input.shape.relations }))
      .digest('hex'),
    createdByMembershipId: context.membershipId,
  });
  await tx
    .update(objectTypes)
    .set({ currentVersionNumber: to, version: type.version + 1, updatedAt: new Date() })
    .where(
      and(eq(objectTypes.organizationId, context.organizationId), eq(objectTypes.id, type.id)),
    );
  const [migration] = await tx
    .insert(objectMigrations)
    .values({
      organizationId: context.organizationId,
      typeId: type.id,
      fromVersionNumber: from,
      toVersionNumber: to,
      requestedByMembershipId: context.membershipId,
    })
    .returning({ id: objectMigrations.id });
  if (!migration) throw new AppError('INVALID_STATE');
  await emit(tx, context, {
    eventType: OBJECT_TYPE_CHANGED,
    aggregateType: AGGREGATE_OBJECT_TYPE,
    aggregateId: type.id,
    aggregateVersion: type.version + 1,
    classification: type.classification,
    payload: { typeId: type.id, fromVersion: from, toVersion: to },
  });
  await emit(tx, context, {
    eventType: OBJECT_MIGRATION_REQUESTED,
    aggregateType: AGGREGATE_OBJECT_MIGRATION,
    aggregateId: migration.id,
    aggregateVersion: 1,
    classification: type.classification,
    payload: { typeId: type.id, fromVersion: from, toVersion: to },
  });
}

async function readCurrentShape(tx: Tx, context: TenantContext, typeId: string) {
  const [row] = await tx
    .select({
      fields: objectTypeVersions.fields,
      relations: objectTypeVersions.relations,
      classification: objectTypes.classification,
      version: objectTypes.version,
    })
    .from(objectTypes)
    .innerJoin(
      objectTypeVersions,
      and(
        eq(objectTypeVersions.organizationId, objectTypes.organizationId),
        eq(objectTypeVersions.typeId, objectTypes.id),
        eq(objectTypeVersions.versionNumber, objectTypes.currentVersionNumber),
      ),
    )
    .where(and(eq(objectTypes.organizationId, context.organizationId), eq(objectTypes.id, typeId)));
  if (!row) throw new AppError('NOT_FOUND');
  return {
    shape: {
      fields: row.fields as readonly ObjectField[],
      relations: row.relations as readonly ObjectRelationDefinition[],
    },
    classification: row.classification,
    version: row.version,
  };
}

const CLASS_RANK: Readonly<Record<string, number>> = {
  public: 1,
  internal: 2,
  confidential: 3,
  restricted: 4,
};

/** Moves a type the pack already made, on top of whatever people have done to it since. It never narrows. */
async function moveType(
  tx: Tx,
  deps: PackDependencies,
  context: TenantContext,
  typeId: string,
  before: PackManifest['objectTypes'][number] | undefined,
  after: PackManifest['objectTypes'][number],
) {
  const current = await readCurrentShape(tx, context, typeId);
  const merged = mergePackTypeShape(
    current.shape,
    before ? { fields: before.fields, relations: before.relations } : current.shape,
    { fields: after.fields, relations: after.relations },
  );
  if (merged.changed) {
    if (!merged.plan.safe) throw new AppError('PACK_INVALID');
    await deps.addObjectTypeVersionInTx(tx, context, { typeId, shape: merged.shape });
  }
  if ((CLASS_RANK[after.classification] ?? 0) > (CLASS_RANK[current.classification] ?? 0)) {
    // A trigger raises any record below the new floor, and it is never lowered.
    await tx
      .update(objectTypes)
      .set({ classification: after.classification, updatedAt: new Date() })
      .where(
        and(eq(objectTypes.organizationId, context.organizationId), eq(objectTypes.id, typeId)),
      );
  }
}

/**
 * An earlier version of this pack may have made a type that this version's chain of rows no longer lists, after
 * a rollback. That one is ours to pick up again. Any other type with the name is the tenant's own, and a pack
 * never takes it over.
 */
async function existingType(tx: Tx, context: TenantContext, slug: string, packKey: string) {
  const [type] = await tx
    .select({ id: objectTypes.id, from: objectTypes.fromPackInstallationId })
    .from(objectTypes)
    .where(and(eq(objectTypes.organizationId, context.organizationId), eq(objectTypes.slug, slug)));
  if (!type) return null;
  if (!type.from) return { id: type.id, ours: false };
  const [origin] = await tx
    .select({ packKey: packInstallations.packKey })
    .from(packInstallations)
    .where(installationWhere(context, type.from));
  return { id: type.id, ours: origin?.packKey === packKey };
}

/** Everything activating makes, in the caller's transaction. A failure anywhere leaves nothing behind. */
async function makeItems(
  tx: Tx,
  deps: PackDependencies,
  context: TenantContext,
  row: InstallationRow,
  manifest: PackManifest,
  previous: PackManifest | null,
  decisions: Readonly<Record<string, 'accepted' | 'declined'>>,
  tools: readonly ToolFacts[] | null,
): Promise<PackItemRow[]> {
  const plan = planPackItems(manifest, decisions, tools);
  const upgrade = previous ? planPackUpgrade(previous, manifest) : null;
  const priorItems = row.previousInstallationId
    ? await readItems(tx, context, row.previousInstallationId)
    : [];
  const prior = (kind: string, key: string) =>
    priorItems.find((item) => item.kind === kind && item.key === key);
  const kept = (itemKind: string, key: string) =>
    upgrade?.steps.some(
      (step) => step.kind === 'keep_item' && step.itemKind === itemKind && step.key === key,
    ) ?? false;
  const made: PackItemRow[] = [];

  for (const type of manifest.objectTypes) {
    if (!plan.objectTypes.includes(type.slug)) continue;
    const before = previous?.objectTypes.find((item) => item.slug === type.slug);
    const earlier = prior('object_type', type.slug);
    if (earlier) {
      await moveType(tx, deps, context, earlier.id, before, type);
      made.push({ kind: 'object_type', key: type.slug, id: earlier.id });
      continue;
    }
    const existing = await existingType(tx, context, type.slug, manifest.key);
    if (existing && !existing.ours) continue;
    if (existing) {
      await moveType(tx, deps, context, existing.id, before, type);
      made.push({ kind: 'object_type', key: type.slug, id: existing.id });
      continue;
    }
    const { id } = await deps.createObjectTypeInTx(tx, context, {
      slug: type.slug,
      displayName: type.displayName,
      classification: type.classification,
      fields: type.fields,
      relations: type.relations,
      fromPackInstallationId: row.id,
    });
    made.push({ kind: 'object_type', key: type.slug, id });
  }

  for (const draft of manifest.agentDrafts) {
    if (!plan.agentDrafts.includes(draft.key)) continue;
    const earlier = prior('agent_draft', draft.key);
    if (earlier && kept('agent_draft', draft.key)) {
      made.push({ kind: 'agent_draft', key: draft.key, id: earlier.id });
      continue;
    }
    // The owner is whoever activates, and which sources it may read is theirs to choose later.
    const answers: AgentDraftAnswers = {
      ...draft.answers,
      ownerMembershipId: context.membershipId,
      knowledgeSourceIds: [],
    };
    const { id } = await deps.createAgentDraftInTx(tx, context, {
      name: draft.name,
      answers,
      fromPackInstallationId: row.id,
    });
    made.push({ kind: 'agent_draft', key: draft.key, id });
  }

  for (const process of manifest.processes) {
    if (!plan.processes.includes(process.key)) continue;
    const earlier = prior('process_draft', process.key);
    if (earlier && kept('process_draft', process.key)) {
      made.push({ kind: 'process_draft', key: process.key, id: earlier.id });
      continue;
    }
    const { id } = await deps.createProcessDraftInTx(tx, context, {
      name: process.name,
      classification: process.classification,
      graph: process.graph,
    });
    made.push({ kind: 'process_draft', key: process.key, id });
  }

  if (made.length > 0) {
    await tx.insert(packInstalledItems).values(
      made.map((item) => ({
        organizationId: context.organizationId,
        installationId: row.id,
        itemKind: item.kind,
        itemKey: item.key,
        itemId: item.id,
      })),
    );
  }
  return made;
}

/** Archives each draft the plan names, and cancels any review open on it. A published one is never touched. */
async function archiveDrafts(tx: Tx, context: TenantContext, items: readonly PackItemRow[]) {
  const now = new Date();
  const cancelReviews = (subjectKind: string, ids: readonly string[]) =>
    tx
      .update(publishReviews)
      .set({ status: 'cancelled', version: sql`${publishReviews.version} + 1`, updatedAt: now })
      .where(
        and(
          eq(publishReviews.organizationId, context.organizationId),
          eq(publishReviews.subjectKind, subjectKind),
          inArray(publishReviews.subjectId, [...ids]),
          inArray(publishReviews.status, ['pending', 'approved']),
        ),
      );
  const agentIds = items.filter((item) => item.kind === 'agent_draft').map((item) => item.id);
  if (agentIds.length > 0) {
    await tx
      .update(agentDrafts)
      .set({ status: 'archived', version: sql`${agentDrafts.version} + 1`, updatedAt: now })
      .where(
        and(
          eq(agentDrafts.organizationId, context.organizationId),
          inArray(agentDrafts.id, agentIds),
          inArray(agentDrafts.status, ['editing', 'in_review']),
        ),
      );
    await cancelReviews('agent_draft', agentIds);
  }
  const processIds = items.filter((item) => item.kind === 'process_draft').map((item) => item.id);
  if (processIds.length > 0) {
    await tx
      .update(processDrafts)
      .set({ status: 'archived', version: sql`${processDrafts.version} + 1`, updatedAt: now })
      .where(
        and(
          eq(processDrafts.organizationId, context.organizationId),
          inArray(processDrafts.id, processIds),
          inArray(processDrafts.status, ['editing', 'in_review']),
        ),
      );
    await cancelReviews('process_draft', processIds);
  }
}

async function readDraftStatuses(tx: Tx, context: TenantContext, items: readonly PackItemRow[]) {
  const statuses: Record<string, string> = {};
  const agentIds = items.filter((item) => item.kind === 'agent_draft').map((item) => item.id);
  const processIds = items.filter((item) => item.kind === 'process_draft').map((item) => item.id);
  if (agentIds.length > 0) {
    const rows = await tx
      .select({ id: agentDrafts.id, status: agentDrafts.status })
      .from(agentDrafts)
      .where(
        and(
          eq(agentDrafts.organizationId, context.organizationId),
          inArray(agentDrafts.id, agentIds),
        ),
      );
    for (const row of rows) statuses[row.id] = row.status;
  }
  if (processIds.length > 0) {
    const rows = await tx
      .select({ id: processDrafts.id, status: processDrafts.status })
      .from(processDrafts)
      .where(
        and(
          eq(processDrafts.organizationId, context.organizationId),
          inArray(processDrafts.id, processIds),
        ),
      );
    for (const row of rows) statuses[row.id] = row.status;
  }
  return statuses;
}

function itemName(manifest: PackManifest | null, kind: string, key: string): string {
  if (kind === 'object_type') {
    return manifest?.objectTypes.find((item) => item.slug === key)?.displayName ?? key;
  }
  if (kind === 'agent_draft') {
    return manifest?.agentDrafts.find((item) => item.key === key)?.name ?? key;
  }
  return manifest?.processes.find((item) => item.key === key)?.name ?? key;
}

const refName = (manifest: PackManifest, ref: string) => {
  const at = ref.indexOf(':');
  return itemName(manifest, ref.slice(0, at), ref.slice(at + 1));
};

function plannedItems(manifest: PackManifest, plan: ReturnType<typeof planPackItems>) {
  return [
    ...plan.objectTypes.map((key) => ({
      kind: 'object_type',
      key,
      name: itemName(manifest, 'object_type', key),
    })),
    ...plan.agentDrafts.map((key) => ({
      kind: 'agent_draft',
      key,
      name: itemName(manifest, 'agent_draft', key),
    })),
    ...plan.processes.map((key) => ({
      kind: 'process_draft',
      key,
      name: itemName(manifest, 'process_draft', key),
    })),
  ];
}

export function createPackService(overrides: Partial<PackDependencies> = {}) {
  const deps: PackDependencies = {
    toolCatalog: unavailablePorts().toolCatalog,
    catalog: PACK_CATALOG,
    createObjectTypeInTx,
    createAgentDraftInTx,
    createProcessDraftInTx,
    addObjectTypeVersionInTx: addObjectTypeVersionThroughTables,
    ...overrides,
  };

  return {
    /** Needs `pack.manage`. */
    async listPackCatalog(
      database: AppDatabase,
      context: TenantContext,
    ): Promise<readonly PackCatalogEntry[]> {
      requireManager(context);
      const open = await withTenantTx(database, context, (tx) =>
        tx
          .select()
          .from(packInstallations)
          .where(
            and(
              eq(packInstallations.organizationId, context.organizationId),
              inArray(packInstallations.status, ['active', 'reviewing']),
            ),
          ),
      );
      return deps.catalog
        .filter((manifest) => validatePackManifest(manifest).length === 0)
        .map((manifest) => {
          const rows = open.filter((row) => row.packKey === manifest.key);
          const active = rows.find((row) => row.status === 'active');
          const shown = rows.find((row) => row.status === 'reviewing') ?? active;
          const installed = active && findManifest(deps, active.packKey, active.packVersion);
          return {
            key: manifest.key,
            version: manifest.version,
            name: manifest.name,
            description: manifest.description,
            installation: shown
              ? { id: shown.id, version: shown.packVersion, status: shown.status }
              : null,
            upgrade:
              installed && installed.version !== manifest.version
                ? planPackUpgrade(installed, manifest)
                : null,
          };
        });
    },

    /** Needs `pack.manage`. A short, bounded history, because rollback and superseded rows are the record. */
    async listPackInstallations(
      database: AppDatabase,
      context: TenantContext,
    ): Promise<readonly PackInstallationSummary[]> {
      requireManager(context);
      const rows = await withTenantTx(database, context, (tx) =>
        tx
          .select()
          .from(packInstallations)
          .where(eq(packInstallations.organizationId, context.organizationId))
          .orderBy(desc(packInstallations.createdAt))
          .limit(INSTALLATION_LIST_LIMIT),
      );
      return rows.map((row) => ({
        id: row.id,
        packKey: row.packKey,
        packVersion: row.packVersion,
        status: row.status as PackInstallationView['status'],
        createdAt: row.createdAt,
        activatedAt: row.activatedAt,
      }));
    },

    /** Needs `pack.manage`. Only writes a `reviewing` row and one pending review per capability. Grants nothing. */
    async requestPackInstall(
      database: AppDatabase,
      context: TenantContext,
      input: { packKey: string; version: string },
    ): Promise<PackInstallationView> {
      requireManager(context);
      const manifest = requireSoundManifest(deps, input.packKey, input.version);
      const manifestSha256 = packManifestSha256(manifest);
      try {
        return await withTenantTx(database, context, async (tx) => {
          const rows = await lockPackRows(tx, context, manifest.key);
          const open = rows.find((row) => row.status === 'reviewing');
          if (open) {
            // The same form sent twice lands on the same review. Another version has to wait for it.
            if (open.packVersion === manifest.version) return viewOf(tx, deps, context, open);
            throw new AppError('INVALID_STATE');
          }
          const active = rows.find((row) => row.status === 'active');
          if (active) {
            const installed = findManifest(deps, active.packKey, active.packVersion);
            if (!installed || planPackUpgrade(installed, manifest).refused) {
              throw new AppError('PACK_INVALID');
            }
          }
          const [row] = await tx
            .insert(packInstallations)
            .values({
              organizationId: context.organizationId,
              packKey: manifest.key,
              packVersion: manifest.version,
              manifestSha256,
              previousInstallationId: active?.id ?? null,
              requestedByMembershipId: context.membershipId,
            })
            .returning();
          if (!row) throw new AppError('INVALID_STATE');
          // Every request starts pending, so a new one cannot inherit an answer given to an older one.
          if (manifest.capabilities.length > 0) {
            await tx.insert(packCapabilityReviews).values(
              manifest.capabilities.map((capability) => ({
                organizationId: context.organizationId,
                installationId: row.id,
                capabilityKey: capability.key,
              })),
            );
          }
          await auditAction(tx, context, 'pack.install_requested', `pack_installation:${row.id}`);
          return viewOf(tx, deps, context, row);
        });
      } catch (error) {
        throw translated(error);
      }
    },

    /** Needs `pack.manage`. Another tenant's installation is simply not found. */
    async getPackInstallation(
      database: AppDatabase,
      context: TenantContext,
      installationId: string,
    ): Promise<PackInstallationView> {
      requireManager(context);
      return withTenantTx(database, context, async (tx) =>
        viewOf(tx, deps, context, await readInstallation(tx, context, installationId)),
      );
    },

    /** Needs `pack.manage`. Reads only. The tool catalog is read first, with no transaction held. */
    async getPackReview(
      database: AppDatabase,
      context: TenantContext,
      installationId: string,
    ): Promise<PackReview> {
      requireManager(context);
      const tools = await readTools(deps, context);
      return withTenantTx(database, context, async (tx) => {
        const row = await readInstallation(tx, context, installationId);
        const installation = await viewOf(tx, deps, context, row);
        const manifest = findManifest(deps, row.packKey, row.packVersion);
        if (!manifest) throw new AppError('PACK_INVALID');
        const previousRow = row.previousInstallationId
          ? await readInstallation(tx, context, row.previousInstallationId)
          : null;
        const previous = previousRow
          ? findManifest(deps, previousRow.packKey, previousRow.packVersion)
          : null;
        const decisions = decidedOnly(await readDecisions(tx, context, row.id));
        const plan = planPackItems(manifest, decisions, tools);

        const leftOut: { name: string; reason: PackItemLeftOutReason; subject: string | null }[] =
          plan.leftOut.map((item) => ({
            name: refName(manifest, item.ref),
            reason: item.reason,
            subject: item.subject,
          }));
        let willMake = plannedItems(manifest, plan);
        if (row.status === 'reviewing') {
          const taken: string[] = [];
          for (const slug of plan.objectTypes) {
            const existing = await existingType(tx, context, slug, manifest.key);
            if (existing && !existing.ours) taken.push(slug);
          }
          willMake = willMake.filter(
            (item) => !(item.kind === 'object_type' && taken.includes(item.key)),
          );
          for (const slug of taken) {
            leftOut.push({
              name: itemName(manifest, 'object_type', slug),
              reason: 'name_in_use',
              subject: null,
            });
          }
        } else {
          // After activation, the record of what was made is the answer, not today's catalog.
          willMake = installation.items.map((item) => ({
            kind: item.kind,
            key: item.key,
            name: itemName(manifest, item.kind, item.key),
          }));
        }

        let rollback: PackReview['rollback'] = null;
        if (row.status === 'rolled_back') {
          const older = previousRow ? await readItems(tx, context, previousRow.id) : [];
          const newer = installation.items;
          const olderIds = new Set(older.map((item) => item.id));
          const statuses = await readDraftStatuses(tx, context, newer);
          const plain = planPackRollback(newer, older, statuses);
          const named = (item: PackItemRow) => ({
            ...item,
            name: itemName(manifest, item.kind, item.key),
          });
          rollback = {
            keptTypes: plain.keptTypes.map((item) => ({
              key: item.key,
              id: item.id,
              name: itemName(manifest, item.kind, item.key),
            })),
            published: plain.published.map(named),
            // Once rolled back, what the plan would archive has been, so read it off the rows.
            archived: newer
              .filter((item) => !olderIds.has(item.id) && statuses[item.id] === 'archived')
              .map(named),
          };
        }

        return {
          installation,
          name: manifest.name,
          description: manifest.description,
          toolCatalog: tools ? 'available' : 'unavailable',
          requests: installation.capabilities.map((capability) => {
            const isTool =
              capability.kind === 'agent_tool' || capability.kind === 'external_effect';
            const tool = tools?.find((item) => item.id === capability.subject);
            return {
              key: capability.key,
              kind: capability.kind,
              subject: capability.subject,
              risk: capability.risk,
              decision: capability.decision,
              why: manifest.strings[capability.reasonCode] ?? '',
              dataAccess: manifest.strings[dataAccessStringKey(capability.key)] ?? '',
              sideEffects: manifest.strings[sideEffectsStringKey(capability.key)] ?? '',
              tool: isTool
                ? {
                    availability: !tools ? 'unknown' : tool ? 'available' : 'unavailable',
                    class: tool?.class ?? null,
                    requiresApproval: tool?.requiresApproval ?? null,
                  }
                : null,
              neededBy: capability.requiredBy.map((ref) => refName(manifest, ref)),
              isNew: previous
                ? !previous.capabilities.some((item) => item.key === capability.key)
                : false,
            };
          }),
          willMake,
          leftOut,
          rollback,
          canActivate:
            row.status === 'reviewing' &&
            installation.capabilities.every((item) => item.decision !== 'pending'),
          canRollback: row.status === 'active' && previousRow?.status === 'superseded',
        };
      });
    },

    /** Needs `pack.manage`. Each capability on its own, with no accept-all path. */
    async decidePackCapability(
      database: AppDatabase,
      context: TenantContext,
      input: {
        installationId: string;
        capabilityKey: string;
        decision: 'accepted' | 'declined';
      },
    ): Promise<PackInstallationView> {
      requireManager(context);
      if (input.decision !== 'accepted' && input.decision !== 'declined') {
        throw new AppError('INVALID_INPUT');
      }
      return withTenantTx(database, context, async (tx) => {
        const [row] = await tx
          .select()
          .from(packInstallations)
          .where(installationWhere(context, input.installationId))
          .for('no key update');
        if (!row) throw new AppError('NOT_FOUND');
        // Nothing else stops this column changing afterwards, and the record of who said what must stand.
        if (row.status !== 'reviewing') throw new AppError('INVALID_STATE');
        const [review] = await tx
          .update(packCapabilityReviews)
          .set({
            decision: input.decision,
            decidedByMembershipId: context.membershipId,
            decidedAt: new Date(),
          })
          .where(
            and(
              eq(packCapabilityReviews.organizationId, context.organizationId),
              eq(packCapabilityReviews.installationId, row.id),
              eq(packCapabilityReviews.capabilityKey, input.capabilityKey),
            ),
          )
          .returning({ key: packCapabilityReviews.capabilityKey });
        if (!review) throw new AppError('NOT_FOUND');
        // A page read before this decision can no longer activate on what it showed.
        const [next] = await tx
          .update(packInstallations)
          .set({ version: row.version + 1, updatedAt: new Date() })
          .where(installationWhere(context, row.id))
          .returning();
        // The audit log takes codes, never words (ADR-013), so the decision goes in as one.
        await auditAction(
          tx,
          context,
          'pack.capability_decided',
          `pack_installation:${row.id}`,
          capabilityDecisionReason(input.decision),
        );
        return viewOf(tx, deps, context, next ?? row);
      });
    },

    /**
     * Needs `pack.manage` and recent MFA. In one transaction: makes the object types, agent drafts and process
     * drafts the decisions allow, and moves the installation to `active`. Nothing it makes can act: every draft
     * still needs a simulation and a review, and a type holds no records. The old installation is `superseded`.
     */
    async activatePack(
      database: AppDatabase,
      context: TenantContext,
      proof: SessionProof | null,
      input: { installationId: string; expectedVersion: number },
    ): Promise<PackInstallationView> {
      requireManager(context);
      const tools = await readTools(deps, context);
      try {
        return await withTenantTx(database, context, async (tx) => {
          await assertRecentMfa(tx, context, 'pack.activate', proof);
          const { packKey } = await readInstallation(tx, context, input.installationId);
          const rows = await lockPackRows(tx, context, packKey);
          const row = rows.find((item) => item.id === input.installationId);
          if (!row) throw new AppError('NOT_FOUND');
          // The same request sent again finds its work done, and changes nothing.
          if (row.status === 'active') return viewOf(tx, deps, context, row);
          if (row.status !== 'reviewing') throw new AppError('INVALID_STATE');
          if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');

          const manifest = requireSoundManifest(deps, row.packKey, row.packVersion);
          if (packManifestSha256(manifest) !== row.manifestSha256) {
            throw new AppError('PACK_INVALID');
          }
          const reviews = await readDecisions(tx, context, row.id);
          const decided = decidedOnly(reviews);
          if (manifest.capabilities.some((capability) => !Object.hasOwn(decided, capability.key))) {
            throw new AppError('PACK_CAPABILITY_UNREVIEWED');
          }

          const active = rows.find((item) => item.status === 'active');
          // A rollback cancels any open review, so only a broken chain can land here.
          if ((active?.id ?? null) !== row.previousInstallationId) {
            throw new AppError('INVALID_STATE');
          }
          const previous = active ? findManifest(deps, active.packKey, active.packVersion) : null;
          if (active && (!previous || planPackUpgrade(previous, manifest).refused)) {
            throw new AppError('PACK_INVALID');
          }

          const made = await makeItems(tx, deps, context, row, manifest, previous, decided, tools);
          const now = new Date();
          // The old row first, because one tenant can only hold one active row of a pack at any moment.
          if (active) {
            await tx
              .update(packInstallations)
              .set({ status: 'superseded', version: active.version + 1, updatedAt: now })
              .where(installationWhere(context, active.id));
          }
          const [activated] = await tx
            .update(packInstallations)
            .set({
              status: 'active',
              version: row.version + 1,
              activatedByMembershipId: context.membershipId,
              activatedAt: now,
              updatedAt: now,
            })
            .where(installationWhere(context, row.id))
            .returning();
          if (!activated) throw new AppError('INVALID_STATE');
          await auditAction(tx, context, 'pack.activated', `pack_installation:${row.id}`);
          await emit(tx, context, {
            eventType: PACK_ACTIVATED,
            aggregateType: AGGREGATE_PACK_INSTALLATION,
            aggregateId: row.id,
            aggregateVersion: activated.version,
            classification: 'internal',
            payload: {
              packKey: row.packKey,
              packVersion: row.packVersion,
              previousInstallationId: active?.id ?? null,
              itemCount: made.length,
            },
          });
          return viewOf(tx, deps, context, activated);
        });
      } catch (error) {
        throw translated(error);
      }
    },

    /**
     * Needs `pack.manage` and recent MFA. Reactivates the superseded installation. Drafts the newer version made
     * are archived unless published, and types it added stay, with their records, because rollback never loses
     * data. An agent or process someone already published stays, and the page lists it for them to decide on.
     */
    async rollbackPack(
      database: AppDatabase,
      context: TenantContext,
      proof: SessionProof | null,
      input: { installationId: string; expectedVersion: number },
    ): Promise<PackInstallationView> {
      requireManager(context);
      try {
        return await withTenantTx(database, context, async (tx) => {
          await assertRecentMfa(tx, context, 'pack.rollback', proof);
          const { packKey } = await readInstallation(tx, context, input.installationId);
          const rows = await lockPackRows(tx, context, packKey);
          const row = rows.find((item) => item.id === input.installationId);
          if (!row) throw new AppError('NOT_FOUND');
          const older = rows.find((item) => item.id === row.previousInstallationId);
          // The same request sent again finds its work done, and changes nothing.
          if (row.status === 'rolled_back' && older?.status === 'active') {
            return viewOf(tx, deps, context, older);
          }
          if (row.status !== 'active' || older?.status !== 'superseded') {
            throw new AppError('PACK_NOT_ROLLBACKABLE');
          }
          if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');

          const newerItems = await readItems(tx, context, row.id);
          const olderItems = await readItems(tx, context, older.id);
          const plan = planPackRollback(
            newerItems,
            olderItems,
            await readDraftStatuses(tx, context, newerItems),
          );
          await archiveDrafts(tx, context, plan.archive);

          const now = new Date();
          // Whatever was being reviewed was on top of the version being left, so it no longer applies.
          for (const open of rows.filter((item) => item.status === 'reviewing')) {
            await tx
              .update(packInstallations)
              .set({ status: 'cancelled', version: open.version + 1, updatedAt: now })
              .where(installationWhere(context, open.id));
          }
          await tx
            .update(packInstallations)
            .set({ status: 'rolled_back', version: row.version + 1, updatedAt: now })
            .where(installationWhere(context, row.id));
          const [restored] = await tx
            .update(packInstallations)
            .set({
              status: 'active',
              version: older.version + 1,
              activatedByMembershipId: context.membershipId,
              activatedAt: now,
              updatedAt: now,
            })
            .where(installationWhere(context, older.id))
            .returning();
          if (!restored) throw new AppError('INVALID_STATE');
          await auditAction(tx, context, 'pack.rolled_back', `pack_installation:${row.id}`);
          await emit(tx, context, {
            eventType: PACK_ROLLED_BACK,
            aggregateType: AGGREGATE_PACK_INSTALLATION,
            aggregateId: row.id,
            aggregateVersion: row.version + 1,
            classification: 'internal',
            payload: {
              packKey: row.packKey,
              fromVersion: row.packVersion,
              toVersion: older.packVersion,
              restoredInstallationId: older.id,
              archivedCount: plan.archive.length,
              keptTypeCount: plan.keptTypes.length,
              publishedCount: plan.published.length,
            },
          });
          return viewOf(tx, deps, context, restored);
        });
      } catch (error) {
        throw translated(error);
      }
    },
  };
}

const honest = createPackService();

/** Needs `pack.manage`. */
export async function listPackCatalog(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly PackCatalogEntry[]> {
  return honest.listPackCatalog(database, context);
}

/** Needs `pack.manage`. Only writes a `reviewing` row and one pending review per capability. Grants nothing. */
export async function requestPackInstall(
  database: AppDatabase,
  context: TenantContext,
  input: { packKey: string; version: string },
): Promise<PackInstallationView> {
  return honest.requestPackInstall(database, context, input);
}

export async function getPackInstallation(
  database: AppDatabase,
  context: TenantContext,
  installationId: string,
): Promise<PackInstallationView> {
  return honest.getPackInstallation(database, context, installationId);
}

/** Needs `pack.manage`. Each capability on its own, with no accept-all path. */
export async function decidePackCapability(
  database: AppDatabase,
  context: TenantContext,
  input: {
    installationId: string;
    capabilityKey: string;
    decision: 'accepted' | 'declined';
  },
): Promise<PackInstallationView> {
  return honest.decidePackCapability(database, context, input);
}

/**
 * Needs `pack.manage` and recent MFA. In one transaction: makes the object types, agent drafts and process
 * drafts the decisions allow, and moves the installation to `active`. Nothing it makes can act: every draft
 * still needs a simulation and a review, and a type holds no records. The old installation is `superseded`.
 * With no tool catalog given, nothing that names a tool is made: use `createPackService` to pass one.
 */
export async function activatePack(
  database: AppDatabase,
  context: TenantContext,
  proof: SessionProof | null,
  input: { installationId: string; expectedVersion: number },
): Promise<PackInstallationView> {
  return honest.activatePack(database, context, proof, input);
}

/**
 * Needs `pack.manage` and recent MFA. Reactivates the superseded installation. Drafts the newer version made
 * are archived unless published, and types it added stay, with their records, because rollback never loses
 * data. An agent or process someone already published stays, and the page lists it for them to decide on.
 */
export async function rollbackPack(
  database: AppDatabase,
  context: TenantContext,
  proof: SessionProof | null,
  input: { installationId: string; expectedVersion: number },
): Promise<PackInstallationView> {
  return honest.rollbackPack(database, context, proof, input);
}
