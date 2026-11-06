// Owned by the import slice (COMM-05). See docs/06-delivery/m6-slices.md and ADR-030 D8 and D9. How each core
// section writes itself back. Every record is hostile until its strict schema has passed, and whatever a record
// says, nothing here starts anything: no workflow, no event a workflow listens to, no pending approval and no
// connection with a credential. The only events written are `tombstone.recorded`, which keep a deletion deleted.
import {
  artifacts,
  blobLifecycle,
  clients,
  connections,
  importedPeople,
  importedRecords,
  organizationImports,
  projects,
  teamMemberships,
  teams,
  tombstones,
  workArtifacts,
  workAssignments,
  workDependencies,
  workUnits,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { coreRecordSchema, type CoreRecord } from '@ensemus/contracts/portability-records';
import {
  importedWorkStatus,
  type CoreExportSection,
  type ImportWarningCode,
} from '@ensemus/domain/portability';
import { ledgerKeyFor, TOMBSTONE_RECORDED } from '@ensemus/domain/tombstone-ledger';
import { and, asc, eq, sql } from 'drizzle-orm';
import { objectKey } from './artifacts';
import { pgCode } from './errors';
import { emit } from './events';
import { idFromRequest } from './request-id';
import type { ImportedPage, ImportScope, PortabilitySection } from './sovereign-ports';
import { auditAction } from './work';

/** A record that cannot be taken in. It carries no text from the record, so nothing can leak through it. */
export class RecordRefused extends Error {
  override name = 'RecordRefused';
  constructor() {
    super('RECORD_REFUSED');
  }
}

type RecordKind = CoreRecord['kind'];
type RecordOf<K extends RecordKind> = Extract<CoreRecord, { kind: K }>;

/**
 * Which records may sit in which section. A record in the wrong place is refused, however good it is on its
 * own, because an honest export never puts it there. Links are allowed beside what they link where a section
 * could fairly hold either, and `SECTION_ORDER` in portability-import.ts puts them after what they point at.
 */
const SECTION_KINDS: Record<CoreExportSection, readonly RecordKind[]> = {
  organizations: ['organization'],
  people: ['person', 'team', 'team_membership'],
  clients: ['client'],
  projects: ['project'],
  work: ['work_unit', 'work_dependency', 'work_assignment'],
  relations: ['team', 'team_membership', 'work_dependency', 'work_assignment', 'work_artifact'],
  artifacts: ['artifact', 'work_artifact'],
  history: ['history'],
  connections: ['connection'],
  tombstones: ['tombstone'],
  'audit-redacted': ['history'],
};

const ID_FIELD = /(^id|_id)$/;

/**
 * One record, through its schema and its section's rule. IDs are compared and put in object keys as text, and
 * PostgreSQL itself only ever writes them in lower case. So one in capitals never came from an export, and it
 * would slip past a comparison with a tombstone, which is why it is refused rather than tidied up.
 */
export function validateCoreRecord(section: CoreExportSection, raw: unknown): CoreRecord {
  let parsed;
  try {
    parsed = coreRecordSchema.safeParse(raw);
  } catch {
    // Nesting deep enough to overflow the stack is still only a bad record.
    throw new RecordRefused();
  }
  if (!parsed.success) throw new RecordRefused();
  const record = parsed.data;
  if (!SECTION_KINDS[section].includes(record.kind)) throw new RecordRefused();
  if (section === 'audit-redacted' && record.kind === 'history') {
    if (record.record_type !== 'audit_event') throw new RecordRefused();
  }
  for (const [field, value] of Object.entries(record)) {
    if (ID_FIELD.test(field) && typeof value === 'string' && value !== value.toLowerCase()) {
      throw new RecordRefused();
    }
  }
  return record;
}

type Page = {
  tx: Tx;
  context: TenantContext;
  scope: ImportScope;
  warn(code: ImportWarningCode, count?: number): void;
};

const organizationId = (page: Page) => page.context.organizationId;

/** Runs something a trigger may stop, in its own savepoint, so the rest of the page survives it. */
async function stoppedByTrigger(tx: Tx, sqlState: string, fn: (inner: Tx) => Promise<unknown>) {
  try {
    await tx.transaction(fn);
    return false;
  } catch (error) {
    if (pgCode(error) === sqlState) return true;
    throw error;
  }
}

const exists = async (found: PromiseLike<readonly unknown[]>) => (await found).length > 0;

const workExists = (tx: Tx, id: string) =>
  exists(tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, id)));
const teamExists = (tx: Tx, id: string) =>
  exists(tx.select({ id: teams.id }).from(teams).where(eq(teams.id, id)));
const clientExists = (tx: Tx, id: string) =>
  exists(tx.select({ id: clients.id }).from(clients).where(eq(clients.id, id)));
const projectExists = (tx: Tx, id: string) =>
  exists(tx.select({ id: projects.id }).from(projects).where(eq(projects.id, id)));
const artifactExists = (tx: Tx, id: string) =>
  exists(tx.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.id, id)));

/** Who stands in for people not linked yet. Being that person says nothing true about who did the work. */
async function fallbackMembership(page: Page) {
  const [row] = await page.tx
    .select({ fallback: organizationImports.fallbackMembershipId })
    .from(organizationImports)
    .where(eq(organizationImports.id, page.scope.importId));
  if (!row) throw new RecordRefused();
  return row.fallback;
}

/** Which link can only be said of a real person here: null when they have not been linked. */
const linkedOrNull = (page: Page, fallback: string, source: string | null) => {
  if (!source) return null;
  const mapped = page.scope.membershipFor(source);
  return mapped === fallback ? null : mapped;
};

export const IMPORT_HOLDING_KIND = 'import_holding';
export type ImportHolding = {
  kind: typeof IMPORT_HOLDING_KIND;
  source_membership_id: string;
  target_type: 'work_unit' | 'team';
  target_id: string;
  responsibility: 'owner' | 'contributor' | 'reviewer' | 'member';
};

/** Depends on what it says, under this import's own ID, which no archive could have known when it was made. */
export const importHoldingId = (importId: string, holding: ImportHolding) =>
  idFromRequest(IMPORT_HOLDING_KIND, holding.source_membership_id, importId, [
    holding.target_type,
    holding.target_id,
    holding.responsibility,
  ]);

/**
 * Says what somebody not linked yet had here, so linking them later can give it to them. Kept with the history,
 * where it can be read as what it is: the record that their work is being held, by whom it was held for and in
 * what capacity. There is no table of its own for this yet, and the handoff says what one would look like.
 */
async function recordHolding(page: Page, holding: Omit<ImportHolding, 'kind'>) {
  const full: ImportHolding = { kind: IMPORT_HOLDING_KIND, ...holding };
  await page.tx
    .insert(importedRecords)
    .values({
      organizationId: organizationId(page),
      importId: page.scope.importId,
      recordType: 'audit_event',
      sourceId: importHoldingId(page.scope.importId, full),
      workUnitId: holding.target_type === 'work_unit' ? holding.target_id : null,
      occurredAt: new Date(),
      record: full,
    })
    .onConflictDoNothing();
}

/** What a person was holding, for linking them. A row is believed only if its ID is the one it should have. */
export async function listImportHoldings(
  tx: Tx,
  importId: string,
  sourceMembershipId: string,
): Promise<readonly ImportHolding[]> {
  const rows = await tx
    .select({ sourceId: importedRecords.sourceId, record: importedRecords.record })
    .from(importedRecords)
    .where(
      and(
        eq(importedRecords.importId, importId),
        eq(importedRecords.recordType, 'audit_event'),
        sql`${importedRecords.record} ->> 'kind' = ${IMPORT_HOLDING_KIND}`,
        sql`${importedRecords.record} ->> 'source_membership_id' = ${sourceMembershipId}`,
      ),
    )
    .orderBy(asc(importedRecords.occurredAt), asc(importedRecords.sourceId));
  return rows
    .map((row) => ({ id: row.sourceId, holding: row.record as ImportHolding }))
    .filter(({ id, holding }) => id === importHoldingId(importId, holding))
    .map(({ holding }) => holding);
}

/**
 * Keeps a deletion deleted here too. The event carries it to this organization's own ledger, and is left out
 * for a type the ledger does not know, because an event that cannot become an entry goes dead and stays there.
 * Returns whether this was new.
 */
export async function recordImportedTombstone(
  tx: Tx,
  context: TenantContext,
  tombstone: { targetType: string; targetId: string; deletedAt: Date },
) {
  const { targetType, targetId, deletedAt } = tombstone;
  const added = await tx
    .insert(tombstones)
    .values({
      organizationId: context.organizationId,
      targetType,
      targetId,
      reasonCode: 'USER_DELETED',
      createdAt: deletedAt,
    })
    .onConflictDoNothing()
    .returning({ id: tombstones.targetId });
  if (added.length === 0) return false;
  let knownToLedger = true;
  try {
    ledgerKeyFor({ organizationId: context.organizationId, targetType, targetId });
  } catch {
    knownToLedger = false;
  }
  if (knownToLedger) {
    await emit(tx, context, {
      eventType: TOMBSTONE_RECORDED,
      aggregateType: targetType,
      aggregateId: targetId,
      aggregateVersion: 1,
      classification: 'internal',
      payload: { [`${targetType}_id`]: targetId },
    });
  }
  await auditAction(tx, context, 'tombstone.imported', `${targetType}:${targetId}`);
  return true;
}

/**
 * Puts a page of records with parents in an order that can be inserted, since a parent has to exist first and
 * `parent_id` on work cannot be changed later. A loop in a hostile archive has no such order, so the record that
 * would close it is named in `broken`, and it loses that link.
 */
export function parentsFirst<T extends { id: string; parent_id: string | null }>(
  records: readonly T[],
) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const placed = new Set<string>();
  const broken = new Set<string>();
  const ordered: T[] = [];
  for (const start of records) {
    const chain: T[] = [];
    const onChain = new Set<string>();
    let at: T | undefined = start;
    while (at && !placed.has(at.id) && !onChain.has(at.id)) {
      chain.push(at);
      onChain.add(at.id);
      const next: T | undefined = at.parent_id ? byId.get(at.parent_id) : undefined;
      if (next && onChain.has(next.id)) broken.add(at.id);
      at = next;
    }
    for (const record of chain.reverse()) {
      placed.add(record.id);
      ordered.push(record);
    }
  }
  return { ordered, broken };
}

const CRITERIA = new Set(['artifact_exists', 'reviewer_approved', 'external_receipt']);
const KNOWN_PLANS = new Set(['checklist']);

/** The app reads this as a list of known kinds, so anything else would break the work's own page later. */
function assertCriteria(value: unknown) {
  const fits =
    Array.isArray(value) &&
    value.every((item) => {
      if (typeof item !== 'object' || item === null) return false;
      const fields = Object.entries(item as Record<string, unknown>);
      return fields.length === 1 && fields[0]?.[0] === 'kind' && CRITERIA.has(String(fields[0][1]));
    });
  if (!fits) throw new RecordRefused();
}

const WRITERS: {
  [K in RecordKind]: (page: Page, records: readonly RecordOf<K>[]) => Promise<number>;
} = {
  /**
   * Nothing to write. The organization is already here, its owner named it when they made it, and a record may
   * not change its name or commercial mode. Taken in only so that its count agrees with the manifest.
   */
  organization: async (_page, records) => records.length,

  person: async (page, records) => {
    let applied = 0;
    for (const record of records) {
      const added = await page.tx
        .insert(importedPeople)
        .values({
          organizationId: organizationId(page),
          importId: page.scope.importId,
          sourceMembershipId: record.membership_id,
          displayName: record.display_name,
          email: record.email,
          sourceRole: record.role,
          sourceStatus: record.status,
        })
        .onConflictDoNothing()
        .returning({ id: importedPeople.sourceMembershipId });
      applied += added.length;
    }
    return applied;
  },

  /**
   * Teams go in with no parent, and then each gets its link, so the order in the page does not matter and the
   * existing trigger gets to stop a loop. A loop or a parent that is not there loses the link and is counted.
   */
  team: async (page, records) => {
    let applied = 0;
    for (const record of records) {
      const added = await page.tx
        .insert(teams)
        .values({
          organizationId: organizationId(page),
          id: record.id,
          name: record.name,
          createdAt: new Date(record.created_at),
        })
        .onConflictDoNothing()
        .returning({ id: teams.id });
      applied += added.length;
    }
    for (const record of records) {
      if (!record.parent_id) continue;
      const parentId = record.parent_id;
      const usable = parentId !== record.id && (await teamExists(page.tx, parentId));
      const stopped =
        !usable ||
        (await stoppedByTrigger(page.tx, 'EN002', (inner) =>
          inner.update(teams).set({ parentId }).where(eq(teams.id, record.id)),
        ));
      if (stopped) page.warn('RELATION_DANGLING');
    }
    return applied;
  },

  /** Only a real person joins a team. Someone not linked is remembered, and joins when they are. */
  team_membership: async (page, records) => {
    const fallback = await fallbackMembership(page);
    let applied = 0;
    for (const record of records) {
      if (!(await teamExists(page.tx, record.team_id))) {
        page.warn('RELATION_DANGLING');
        continue;
      }
      const membershipId = linkedOrNull(page, fallback, record.membership_id);
      if (!membershipId) {
        await recordHolding(page, {
          source_membership_id: record.membership_id,
          target_type: 'team',
          target_id: record.team_id,
          responsibility: 'member',
        });
        applied += 1;
        continue;
      }
      await page.tx
        .insert(teamMemberships)
        .values({ organizationId: organizationId(page), teamId: record.team_id, membershipId })
        .onConflictDoNothing();
      applied += 1;
    }
    return applied;
  },

  client: async (page, records) => {
    let applied = 0;
    for (const record of records) {
      const added = await page.tx
        .insert(clients)
        .values({
          organizationId: organizationId(page),
          id: record.id,
          displayName: record.display_name,
          classification: record.classification,
          createdAt: new Date(record.created_at),
        })
        .onConflictDoNothing()
        .returning({ id: clients.id });
      applied += added.length;
    }
    return applied;
  },

  project: async (page, records) => {
    let applied = 0;
    for (const record of records) {
      let clientId = record.client_id;
      if (clientId && !(await clientExists(page.tx, clientId))) {
        page.warn('RELATION_DANGLING');
        clientId = null;
      }
      const added = await page.tx
        .insert(projects)
        .values({
          organizationId: organizationId(page),
          id: record.id,
          clientId,
          name: record.name,
          createdAt: new Date(record.created_at),
        })
        .onConflictDoNothing()
        .returning({ id: projects.id });
      applied += added.length;
    }
    return applied;
  },

  /**
   * The Work Unit as it stood, with nothing to say it is moving: no run, no request to run and no reviewer
   * chosen. Anything that was in flight waits for a person (ADR-030 D9).
   */
  work_unit: async (page, records) => {
    const fallback = await fallbackMembership(page);
    const { ordered, broken } = parentsFirst(records);
    const inserted = new Set<string>();
    for (const record of ordered) {
      assertCriteria(record.completion_criteria);
      let projectId = record.project_id;
      if (projectId && !(await projectExists(page.tx, projectId))) {
        page.warn('RELATION_DANGLING');
        projectId = null;
      }
      let parentId = record.parent_id;
      if (
        parentId &&
        (broken.has(record.id) || !(inserted.has(parentId) || (await workExists(page.tx, parentId))))
      ) {
        page.warn('RELATION_DANGLING');
        parentId = null;
      }
      const status = importedWorkStatus(record.status);
      if (status !== record.status) page.warn('WORK_PAUSED_ON_IMPORT');
      let executionPlan = record.execution_plan;
      if (executionPlan && !KNOWN_PLANS.has(executionPlan)) {
        // Not a plan this release can run, so people do this work by hand.
        page.warn('WORK_PAUSED_ON_IMPORT');
        executionPlan = null;
      }
      const ownerMembershipId = page.scope.membershipFor(record.owner_membership_id);
      const added = await page.tx
        .insert(workUnits)
        .values({
          organizationId: organizationId(page),
          id: record.id,
          projectId,
          parentId,
          ownerMembershipId,
          createdByMembershipId: linkedOrNull(page, fallback, record.created_by_membership_id),
          title: record.title,
          objective: record.objective,
          status,
          completionCriteria: record.completion_criteria,
          executionPlan,
          classification: record.classification,
          dueAt: record.due_at ? new Date(record.due_at) : null,
          createdAt: new Date(record.created_at),
          updatedAt: new Date(record.updated_at),
        })
        .onConflictDoNothing()
        .returning({ id: workUnits.id });
      if (added.length === 0) continue;
      inserted.add(record.id);
      if (ownerMembershipId === fallback) {
        await recordHolding(page, {
          source_membership_id: record.owner_membership_id,
          target_type: 'work_unit',
          target_id: record.id,
          responsibility: 'owner',
        });
      }
    }
    return inserted.size;
  },

  /** The trigger that keeps the graph acyclic runs here as anywhere, and a loop loses the edge that closes it. */
  work_dependency: async (page, records) => {
    let applied = 0;
    for (const record of records) {
      const usable =
        record.prerequisite_id !== record.dependent_id &&
        (await workExists(page.tx, record.prerequisite_id)) &&
        (await workExists(page.tx, record.dependent_id));
      const stopped =
        !usable ||
        (await stoppedByTrigger(page.tx, 'EN001', (inner) =>
          inner
            .insert(workDependencies)
            .values({
              organizationId: organizationId(page),
              prerequisiteId: record.prerequisite_id,
              dependentId: record.dependent_id,
            })
            .onConflictDoNothing(),
        ));
      if (stopped) page.warn('RELATION_DANGLING');
      else applied += 1;
    }
    return applied;
  },

  /**
   * Being put on work grants access, and saying the stand-in contributed would be false, so someone not linked
   * is remembered and put on it when they are. An agent's assignment has no agent to name here.
   */
  work_assignment: async (page, records) => {
    const fallback = await fallbackMembership(page);
    let applied = 0;
    for (const record of records) {
      if (record.actor_type !== 'human' || !(await workExists(page.tx, record.work_unit_id))) {
        page.warn('RELATION_DANGLING');
        continue;
      }
      const membershipId = linkedOrNull(page, fallback, record.membership_id);
      if (!membershipId) {
        await recordHolding(page, {
          source_membership_id: record.membership_id,
          target_type: 'work_unit',
          target_id: record.work_unit_id,
          responsibility: record.responsibility,
        });
        applied += 1;
        continue;
      }
      await page.tx
        .insert(workAssignments)
        .values({
          organizationId: organizationId(page),
          workUnitId: record.work_unit_id,
          membershipId,
          responsibility: record.responsibility,
          actorType: 'human',
        })
        .onConflictDoNothing();
      applied += 1;
    }
    return applied;
  },

  /**
   * A file's row. Its bytes were checked and written by the runner before this transaction began, so a row here
   * always has bytes behind it. A deleted file gets neither.
   */
  artifact: async (page, records) => {
    const fallback = await fallbackMembership(page);
    let applied = 0;
    for (const record of records) {
      if (page.scope.isTombstoned('artifact', record.id)) {
        page.warn('TOMBSTONED_SKIPPED');
        continue;
      }
      const added = await page.tx
        .insert(artifacts)
        .values({
          organizationId: organizationId(page),
          id: record.id,
          name: record.name,
          objectKey: objectKey(organizationId(page), record.id),
          sha256: record.sha256,
          mimeType: record.mime_type,
          sizeBytes: record.size_bytes,
          classification: record.classification,
          createdByMembershipId: linkedOrNull(page, fallback, record.created_by_membership_id),
          createdAt: new Date(record.created_at),
        })
        .onConflictDoNothing()
        .returning({ id: artifacts.id });
      // The file has its row now, so the sweep must not take its bytes. The same step `addArtifact` ends with.
      await page.tx.delete(blobLifecycle).where(eq(blobLifecycle.artifactId, record.id));
      applied += added.length;
    }
    return applied;
  },

  work_artifact: async (page, records) => {
    let applied = 0;
    for (const record of records) {
      // Already counted when the file itself was skipped.
      if (page.scope.isTombstoned('artifact', record.artifact_id)) continue;
      const usable =
        (await workExists(page.tx, record.work_unit_id)) &&
        (await artifactExists(page.tx, record.artifact_id));
      if (!usable) {
        page.warn('RELATION_DANGLING');
        continue;
      }
      await page.tx
        .insert(workArtifacts)
        .values({
          organizationId: organizationId(page),
          workUnitId: record.work_unit_id,
          artifactId: record.artifact_id,
        })
        .onConflictDoNothing();
      applied += 1;
    }
    return applied;
  },

  /** Kept to be read, and never made live (ADR-030 D9). A row with no work is for owners. */
  history: async (page, records) => {
    let applied = 0;
    for (const record of records) {
      let workUnitId = record.work_unit_id;
      if (workUnitId && !(await workExists(page.tx, workUnitId))) {
        page.warn('RELATION_DANGLING');
        workUnitId = null;
      }
      const added = await page.tx
        .insert(importedRecords)
        .values({
          organizationId: organizationId(page),
          importId: page.scope.importId,
          recordType: record.record_type,
          sourceId: record.source_id,
          workUnitId,
          occurredAt: new Date(record.occurred_at),
          record: record.record,
        })
        .onConflictDoNothing()
        .returning({ id: importedRecords.sourceId });
      applied += added.length;
    }
    return applied;
  },

  /** It comes back switched off and with no credential, and someone authorized binds a new one. */
  connection: async (page, records) => {
    let applied = 0;
    for (const record of records) {
      const added = await page.tx
        .insert(connections)
        .values({
          organizationId: organizationId(page),
          id: record.id,
          connectorType: record.connector_type,
          displayName: record.display_name,
          state: 'disabled',
          credentialSecretId: null,
          grantedScopes: record.granted_scopes,
          createdAt: new Date(record.created_at),
        })
        .onConflictDoNothing()
        .returning({ id: connections.id });
      if (added.length > 0) page.warn('CONNECTION_NEEDS_CREDENTIAL');
      applied += added.length;
    }
    return applied;
  },

  tombstone: async (page, records) => {
    let applied = 0;
    for (const record of records) {
      await recordImportedTombstone(page.tx, page.context, {
        targetType: record.target_type,
        targetId: record.target_id,
        deletedAt: new Date(record.deleted_at),
      });
      // Counted either way: one the source's ledger already added is still this archive's record.
      applied += 1;
    }
    return applied;
  },
};

const importerFor =
  (section: CoreExportSection): PortabilitySection['importPage'] =>
  async (tx, context, scope, input) => {
    const records = input.records.map((raw) => validateCoreRecord(section, raw));
    const [first] = records;
    if (!first) return { applied: 0 };
    // A part holds one kind of record, which its name says. Anything else was not written by an export.
    if (records.some((record) => record.kind !== first.kind)) throw new RecordRefused();
    const warnings: NonNullable<ImportedPage['warnings']> = {};
    const page: Page = {
      tx,
      context,
      scope,
      warn: (code, count = 1) => {
        warnings[code] = (warnings[code] ?? 0) + count;
      },
    };
    const write = WRITERS[first.kind] as (
      page: Page,
      records: readonly CoreRecord[],
    ) => Promise<number>;
    return { applied: await write(page, records), warnings };
  };

/** How each core section writes itself back, validating every record against `coreRecordSchema`. */
export const CORE_SECTION_IMPORTERS: Record<CoreExportSection, PortabilitySection['importPage']> = {
  organizations: importerFor('organizations'),
  people: importerFor('people'),
  clients: importerFor('clients'),
  projects: importerFor('projects'),
  work: importerFor('work'),
  relations: importerFor('relations'),
  artifacts: importerFor('artifacts'),
  history: importerFor('history'),
  connections: importerFor('connections'),
  tombstones: importerFor('tombstones'),
  'audit-redacted': importerFor('audit-redacted'),
};
