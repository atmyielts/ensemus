// Owned by the export slice (COMM-05). See docs/06-delivery/m6-slices.md and ADR-030 D7 and D10. How each core
// section reads itself, one bounded page at a time, in one short tenant transaction. The caller puts every
// record through `coreRecordSchema` before anything is sealed, so a slip here fails the export.
//
// What this file reads is the point of it. Every query names its columns, so `integrations.connections.config`,
// `credential_secret_id` and anything in the `secrets` schema are never fetched, and so cannot reach an archive
// however a record is built. Restricted work and what hangs off it are left out here, at the source, and counted.
import {
  approvalDecisions,
  approvals,
  artifacts,
  auditEvents,
  clients,
  connections,
  externalActionReceipts,
  externalActions,
  memberships,
  organizationExports,
  organizations,
  projects,
  teamMemberships,
  teams,
  tombstones,
  users,
  workArtifacts,
  workAssignments,
  workDependencies,
  workTransitions,
  workUnits,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import type { CoreExportSection } from '@ensemus/domain/portability';
import { and, asc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { ExportPage, PortabilitySection } from './sovereign-ports';

/** Two columns that together order a table, as text, because a cursor only ever lives in PostgreSQL. */
type Key = readonly [string, string];
type KindRead = { key: Key | null; limit: number; snapshot: string | null };
type KindPage = {
  records: readonly unknown[];
  nextKey: Key | null;
  excluded?: Readonly<Record<string, number>>;
};

/** One kind of record in a section, which becomes its own run of parts: `people/teams-000001.jsonl`. */
type KindReader = {
  recordKind: string;
  read(tx: Tx, context: TenantContext, input: KindRead): Promise<KindPage>;
};

/**
 * Rows that can hold 200 KB or more of text each. A page of them is read small, so a worker does not hold a
 * gigabyte to find out it needs to split the page. Everything else is IDs and short names.
 */
const LARGE_ROW_PAGE = 200;

const isoDate = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);

/**
 * Compares text timestamps, because a JavaScript Date drops PostgreSQL's microseconds. Paging on a rounded
 * time would skip or repeat rows that fall inside one millisecond.
 */
const afterTime = (at: PgColumn, id: PgColumn, key: Key | null) =>
  key ? sql`(${at}, ${id}) > (${key[0]}::timestamptz, ${key[1]}::uuid)` : undefined;
const afterIds = (first: PgColumn, second: PgColumn, key: Key | null) =>
  key ? sql`(${first}, ${second}) > (${key[0]}::uuid, ${key[1]}::uuid)` : undefined;
const upTo = (at: PgColumn, snapshot: string | null) =>
  snapshot ? sql`${at} <= ${snapshot}::timestamptz` : undefined;
const timeText = (at: PgColumn) => sql<string>`${at}::text`;

function keyAfter<T>(rows: readonly T[], limit: number, keyOf: (row: T) => Key): Key | null {
  const last = rows.at(-1);
  return last !== undefined && rows.length === limit ? keyOf(last) : null;
}

/**
 * What is in the running export's view of time. Anything made after it stays out, so a file attached halfway
 * through cannot have a record with no bytes, and a page of the audit log cannot chase its own tail. With no
 * export running there is no limit, which is how a section can be read on its own.
 */
async function snapshotOf(tx: Tx, context: TenantContext): Promise<string | null> {
  const [row] = await tx
    .select({ at: sql<string | null>`${organizationExports.snapshotAt}::text` })
    .from(organizationExports)
    .where(
      and(
        eq(organizationExports.organizationId, context.organizationId),
        eq(organizationExports.status, 'running'),
      ),
    );
  return row?.at ?? null;
}

const encodeCursor = (index: number, key: Key | null) => JSON.stringify({ index, key });

function decodeCursor(cursor: string | null): { index: number; key: Key | null } {
  if (cursor === null) return { index: 0, key: null };
  return JSON.parse(cursor) as { index: number; key: Key | null };
}

/** A section as a list of kinds, read in order. The cursor says which kind, and where in it. */
function sectionOf(readers: readonly [KindReader, ...KindReader[]]) {
  const exportPage: PortabilitySection['exportPage'] = async (tx, context, { cursor, limit }) => {
    const place = decodeCursor(cursor);
    const reader = readers[place.index];
    if (!reader) throw new Error('Not a cursor this section made');
    const snapshot = await snapshotOf(tx, context);
    const page = await reader.read(tx, context, { key: place.key, limit, snapshot });
    const nextCursor = page.nextKey
      ? encodeCursor(place.index, page.nextKey)
      : place.index + 1 < readers.length
        ? encodeCursor(place.index + 1, null)
        : null;
    const result: ExportPage = {
      recordKind: reader.recordKind,
      records: page.records,
      nextCursor,
      ...(page.excluded ? { excluded: page.excluded } : {}),
    };
    return result;
  };
  return exportPage;
}

const excludedOf = (name: string, count: number) => (count > 0 ? { [name]: count } : undefined);

// The rules for what is restricted, as SQL. Written as text with each table's own name, not with column
// objects, because Drizzle drops the table name from a column in the select list of a one-table query. Inside
// a subquery that would quietly bind to the subquery's own `id`.
const FILE_TOMBSTONED = sql`exists (
  select 1 from platform.tombstones t
  where t.organization_id = artifacts.organization_id
    and t.target_type = 'artifact'
    and t.target_id = artifacts.id)`;
const FILE_HAS_ANY_LINK = sql`exists (
  select 1 from work.work_artifacts l
  where l.organization_id = artifacts.organization_id and l.artifact_id = artifacts.id)`;
const FILE_HAS_OPEN_LINK = sql`exists (
  select 1 from work.work_artifacts l
  join work.work_units w on w.organization_id = l.organization_id and w.id = l.work_unit_id
  where l.organization_id = artifacts.organization_id
    and l.artifact_id = artifacts.id
    and w.classification <> 'restricted')`;
/** Restricted by its own class, or linked only to restricted work, whatever its own class says (ADR-030 D10). */
const FILE_RESTRICTED = sql`(
  artifacts.classification = 'restricted' or (${FILE_HAS_ANY_LINK} and not ${FILE_HAS_OPEN_LINK}))`;

const PARENT_RESTRICTED = sql`exists (
  select 1 from work.work_units p
  where p.organization_id = work_units.organization_id
    and p.id = work_units.parent_id
    and p.classification = 'restricted')`;
const CLIENT_RESTRICTED = sql`exists (
  select 1 from work.clients c
  where c.organization_id = projects.organization_id
    and c.id = projects.client_id
    and c.classification = 'restricted')`;
const DEPENDENCY_TOUCHES_RESTRICTED = sql`exists (
  select 1 from work.work_units w
  where w.organization_id = work_dependencies.organization_id
    and w.id in (work_dependencies.prerequisite_id, work_dependencies.dependent_id)
    and w.classification = 'restricted')`;

/** The next file whose bytes belong in this archive. A tombstoned file is not even a candidate. */
export async function nextExportableFile(tx: Tx, context: TenantContext, after: string | null) {
  const snapshot = await snapshotOf(tx, context);
  const [row] = await tx
    .select({
      id: artifacts.id,
      objectKey: artifacts.objectKey,
      sha256: artifacts.sha256,
      sizeBytes: artifacts.sizeBytes,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.organizationId, context.organizationId),
        after ? gt(artifacts.id, after) : undefined,
        upTo(artifacts.createdAt, snapshot),
        sql`not ${FILE_TOMBSTONED}`,
        sql`not ${FILE_RESTRICTED}`,
      ),
    )
    .orderBy(asc(artifacts.id))
    .limit(1);
  return row ?? null;
}

const organizationsReader: KindReader = {
  recordKind: 'organizations',
  async read(tx, context) {
    const rows = await tx
      .select({
        name: organizations.name,
        commercialMode: organizations.commercialMode,
        createdAt: organizations.createdAt,
      })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId));
    return {
      nextKey: null,
      records: rows.map((row) => ({
        kind: 'organization',
        name: row.name,
        commercial_mode: row.commercialMode,
        created_at: isoDate(row.createdAt),
      })),
    };
  },
};

/** The same narrow route `listMembers` uses. No account, session or password column is reachable from here. */
const peopleReader: KindReader = {
  recordKind: 'people',
  async read(tx, context, { key, limit, snapshot }) {
    const rows = await tx
      .select({
        id: memberships.id,
        role: memberships.role,
        status: memberships.status,
        createdAt: memberships.createdAt,
        at: timeText(memberships.createdAt),
        name: users.name,
        email: users.email,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          upTo(memberships.createdAt, snapshot),
          afterTime(memberships.createdAt, memberships.id, key),
        ),
      )
      .orderBy(asc(memberships.createdAt), asc(memberships.id))
      .limit(limit);
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.at, row.id]),
      records: rows.map((row) => ({
        kind: 'person',
        membership_id: row.id,
        display_name: row.name,
        email: row.email,
        role: row.role,
        status: row.status,
        created_at: isoDate(row.createdAt),
      })),
    };
  },
};

const teamsReader: KindReader = {
  recordKind: 'teams',
  async read(tx, context, { key, limit, snapshot }) {
    const rows = await tx
      .select({
        id: teams.id,
        parentId: teams.parentId,
        name: teams.name,
        createdAt: teams.createdAt,
        at: timeText(teams.createdAt),
      })
      .from(teams)
      .where(
        and(
          eq(teams.organizationId, context.organizationId),
          upTo(teams.createdAt, snapshot),
          afterTime(teams.createdAt, teams.id, key),
        ),
      )
      .orderBy(asc(teams.createdAt), asc(teams.id))
      .limit(limit);
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.at, row.id]),
      records: rows.map((row) => ({
        kind: 'team',
        id: row.id,
        parent_id: row.parentId,
        name: row.name,
        created_at: isoDate(row.createdAt),
      })),
    };
  },
};

const teamMembershipsReader: KindReader = {
  recordKind: 'team_memberships',
  async read(tx, context, { key, limit, snapshot }) {
    const rows = await tx
      .select({ teamId: teamMemberships.teamId, membershipId: teamMemberships.membershipId })
      .from(teamMemberships)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, teamMemberships.organizationId),
          eq(memberships.id, teamMemberships.membershipId),
        ),
      )
      .innerJoin(
        teams,
        and(
          eq(teams.organizationId, teamMemberships.organizationId),
          eq(teams.id, teamMemberships.teamId),
        ),
      )
      .where(
        and(
          eq(teamMemberships.organizationId, context.organizationId),
          upTo(memberships.createdAt, snapshot),
          upTo(teams.createdAt, snapshot),
          afterIds(teamMemberships.teamId, teamMemberships.membershipId, key),
        ),
      )
      .orderBy(asc(teamMemberships.teamId), asc(teamMemberships.membershipId))
      .limit(limit);
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.teamId, row.membershipId]),
      records: rows.map((row) => ({
        kind: 'team_membership',
        team_id: row.teamId,
        membership_id: row.membershipId,
      })),
    };
  },
};

const clientsReader: KindReader = {
  recordKind: 'clients',
  async read(tx, context, { key, limit, snapshot }) {
    const rows = await tx
      .select({
        id: clients.id,
        displayName: clients.displayName,
        classification: clients.classification,
        createdAt: clients.createdAt,
        at: timeText(clients.createdAt),
      })
      .from(clients)
      .where(
        and(
          eq(clients.organizationId, context.organizationId),
          upTo(clients.createdAt, snapshot),
          afterTime(clients.createdAt, clients.id, key),
        ),
      )
      .orderBy(asc(clients.createdAt), asc(clients.id))
      .limit(limit);
    const kept = rows.filter((row) => row.classification !== 'restricted');
    const excluded = excludedOf('restricted_clients', rows.length - kept.length);
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.at, row.id]),
      records: kept.map((row) => ({
        kind: 'client',
        id: row.id,
        display_name: row.displayName,
        classification: row.classification,
        created_at: isoDate(row.createdAt),
      })),
      ...(excluded ? { excluded } : {}),
    };
  },
};

/** A project has no class of its own. One under a restricted client stays, and loses the link to it. */
const projectsReader: KindReader = {
  recordKind: 'projects',
  async read(tx, context, { key, limit, snapshot }) {
    const rows = await tx
      .select({
        id: projects.id,
        clientId: projects.clientId,
        name: projects.name,
        createdAt: projects.createdAt,
        at: timeText(projects.createdAt),
        clientRestricted: sql<boolean>`${CLIENT_RESTRICTED}`,
      })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, context.organizationId),
          upTo(projects.createdAt, snapshot),
          afterTime(projects.createdAt, projects.id, key),
        ),
      )
      .orderBy(asc(projects.createdAt), asc(projects.id))
      .limit(limit);
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.at, row.id]),
      records: rows.map((row) => ({
        kind: 'project',
        id: row.id,
        client_id: row.clientRestricted ? null : row.clientId,
        name: row.name,
        created_at: isoDate(row.createdAt),
      })),
    };
  },
};

/** In the order they were made, so a parent comes first. Which run held the work is left out. */
const workUnitsReader: KindReader = {
  recordKind: 'work_units',
  async read(tx, context, { key, limit, snapshot }) {
    const size = Math.min(limit, LARGE_ROW_PAGE);
    const rows = await tx
      .select({
        id: workUnits.id,
        projectId: workUnits.projectId,
        parentId: workUnits.parentId,
        ownerMembershipId: workUnits.ownerMembershipId,
        createdByMembershipId: workUnits.createdByMembershipId,
        title: workUnits.title,
        objective: workUnits.objective,
        status: workUnits.status,
        completionCriteria: workUnits.completionCriteria,
        executionPlan: workUnits.executionPlan,
        classification: workUnits.classification,
        dueAt: workUnits.dueAt,
        createdAt: workUnits.createdAt,
        updatedAt: workUnits.updatedAt,
        at: timeText(workUnits.createdAt),
        parentRestricted: sql<boolean>`${PARENT_RESTRICTED}`,
      })
      .from(workUnits)
      .where(
        and(
          eq(workUnits.organizationId, context.organizationId),
          upTo(workUnits.createdAt, snapshot),
          afterTime(workUnits.createdAt, workUnits.id, key),
        ),
      )
      .orderBy(asc(workUnits.createdAt), asc(workUnits.id))
      .limit(size);
    const kept = rows.filter((row) => row.classification !== 'restricted');
    const excluded = excludedOf('restricted_work', rows.length - kept.length);
    return {
      nextKey: keyAfter(rows, size, (row) => [row.at, row.id]),
      records: kept.map((row) => ({
        kind: 'work_unit',
        id: row.id,
        project_id: row.projectId,
        parent_id: row.parentRestricted ? null : row.parentId,
        owner_membership_id: row.ownerMembershipId,
        created_by_membership_id: row.createdByMembershipId,
        title: row.title,
        objective: row.objective,
        status: row.status,
        completion_criteria: row.completionCriteria,
        execution_plan: row.executionPlan,
        classification: row.classification,
        due_at: isoOrNull(row.dueAt),
        created_at: isoDate(row.createdAt),
        updated_at: isoDate(row.updatedAt),
      })),
      ...(excluded ? { excluded } : {}),
    };
  },
};

const workDependenciesReader: KindReader = {
  recordKind: 'work_dependencies',
  async read(tx, context, { key, limit, snapshot }) {
    const rows = await tx
      .select({
        prerequisiteId: workDependencies.prerequisiteId,
        dependentId: workDependencies.dependentId,
      })
      .from(workDependencies)
      .where(
        and(
          eq(workDependencies.organizationId, context.organizationId),
          upTo(workDependencies.createdAt, snapshot),
          sql`not ${DEPENDENCY_TOUCHES_RESTRICTED}`,
          afterIds(workDependencies.prerequisiteId, workDependencies.dependentId, key),
        ),
      )
      .orderBy(asc(workDependencies.prerequisiteId), asc(workDependencies.dependentId))
      .limit(limit);
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.prerequisiteId, row.dependentId]),
      records: rows.map((row) => ({
        kind: 'work_dependency',
        prerequisite_id: row.prerequisiteId,
        dependent_id: row.dependentId,
      })),
    };
  },
};

const workAssignmentsReader: KindReader = {
  recordKind: 'work_assignments',
  async read(tx, context, { key, limit, snapshot }) {
    const rows = await tx
      .select({
        workUnitId: workAssignments.workUnitId,
        membershipId: workAssignments.membershipId,
        responsibility: workAssignments.responsibility,
        actorType: workAssignments.actorType,
      })
      .from(workAssignments)
      .innerJoin(
        workUnits,
        and(
          eq(workUnits.organizationId, workAssignments.organizationId),
          eq(workUnits.id, workAssignments.workUnitId),
        ),
      )
      .where(
        and(
          eq(workAssignments.organizationId, context.organizationId),
          ne(workUnits.classification, 'restricted'),
          upTo(workAssignments.createdAt, snapshot),
          afterIds(workAssignments.workUnitId, workAssignments.membershipId, key),
        ),
      )
      .orderBy(asc(workAssignments.workUnitId), asc(workAssignments.membershipId))
      .limit(limit);
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.workUnitId, row.membershipId]),
      records: rows.map((row) => ({
        kind: 'work_assignment',
        work_unit_id: row.workUnitId,
        membership_id: row.membershipId,
        responsibility: row.responsibility,
        actor_type: row.actorType,
      })),
    };
  },
};

/** Facts about a file. Its bytes are written separately, as their own part, by the step that reads them. */
const artifactsReader: KindReader = {
  recordKind: 'artifacts',
  async read(tx, context, { key, limit, snapshot }) {
    const rows = await tx
      .select({
        id: artifacts.id,
        name: artifacts.name,
        sha256: artifacts.sha256,
        mimeType: artifacts.mimeType,
        sizeBytes: artifacts.sizeBytes,
        classification: artifacts.classification,
        createdByMembershipId: artifacts.createdByMembershipId,
        createdAt: artifacts.createdAt,
        at: timeText(artifacts.createdAt),
        tombstoned: sql<boolean>`${FILE_TOMBSTONED}`,
        restricted: sql<boolean>`${FILE_RESTRICTED}`,
      })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.organizationId, context.organizationId),
          upTo(artifacts.createdAt, snapshot),
          afterTime(artifacts.createdAt, artifacts.id, key),
        ),
      )
      .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
      .limit(limit);
    const kept = rows.filter((row) => !row.tombstoned && !row.restricted);
    // A deleted file is not a restricted one. It goes in the tombstones, and is not counted as left out.
    const excluded = excludedOf(
      'restricted_artifacts',
      rows.filter((row) => !row.tombstoned && row.restricted).length,
    );
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.at, row.id]),
      records: kept.map((row) => ({
        kind: 'artifact',
        id: row.id,
        name: row.name,
        sha256: row.sha256,
        mime_type: row.mimeType,
        size_bytes: row.sizeBytes,
        classification: row.classification,
        created_by_membership_id: row.createdByMembershipId,
        created_at: isoDate(row.createdAt),
      })),
      ...(excluded ? { excluded } : {}),
    };
  },
};

/**
 * Here and not in `relations`, because a link needs its file to exist, and an import takes sections in order.
 * A link to restricted work is left out even when the file itself is exported through another link.
 */
const workArtifactsReader: KindReader = {
  recordKind: 'work_artifacts',
  async read(tx, context, { key, limit, snapshot }) {
    const rows = await tx
      .select({ workUnitId: workArtifacts.workUnitId, artifactId: workArtifacts.artifactId })
      .from(workArtifacts)
      .innerJoin(
        workUnits,
        and(
          eq(workUnits.organizationId, workArtifacts.organizationId),
          eq(workUnits.id, workArtifacts.workUnitId),
        ),
      )
      .innerJoin(
        artifacts,
        and(
          eq(artifacts.organizationId, workArtifacts.organizationId),
          eq(artifacts.id, workArtifacts.artifactId),
        ),
      )
      .where(
        and(
          eq(workArtifacts.organizationId, context.organizationId),
          ne(workUnits.classification, 'restricted'),
          ne(artifacts.classification, 'restricted'),
          upTo(workUnits.createdAt, snapshot),
          upTo(artifacts.createdAt, snapshot),
          sql`not ${FILE_TOMBSTONED}`,
          afterIds(workArtifacts.workUnitId, workArtifacts.artifactId, key),
        ),
      )
      .orderBy(asc(workArtifacts.workUnitId), asc(workArtifacts.artifactId))
      .limit(limit);
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.workUnitId, row.artifactId]),
      records: rows.map((row) => ({
        kind: 'work_artifact',
        work_unit_id: row.workUnitId,
        artifact_id: row.artifactId,
      })),
    };
  },
};

/** One line of history. On import these are kept read-only, and are never made live (ADR-030 D9). */
const historyRecord = (
  recordType: string,
  sourceId: string,
  workUnitId: string | null,
  occurredAt: Date,
  record: Record<string, unknown>,
) => ({
  kind: 'history',
  record_type: recordType,
  source_id: sourceId,
  work_unit_id: workUnitId,
  occurred_at: isoDate(occurredAt),
  record,
});

/** Joins a row to its Work Unit, whose class decides whether the row is exported. */
const workOf = (workUnitId: PgColumn, organizationId: PgColumn) =>
  and(eq(workUnits.organizationId, organizationId), eq(workUnits.id, workUnitId));

const approvalsReader: KindReader = {
  recordKind: 'approvals',
  async read(tx, context, { key, limit, snapshot }) {
    const size = Math.min(limit, LARGE_ROW_PAGE);
    const rows = await tx
      .select({
        id: approvals.id,
        workUnitId: approvals.workUnitId,
        toolName: approvals.toolName,
        action: approvals.action,
        actionHash: approvals.actionHash,
        targetRef: approvals.targetRef,
        approverMembershipId: approvals.approverMembershipId,
        requestedByMembershipId: approvals.requestedByMembershipId,
        status: approvals.status,
        expiresAt: approvals.expiresAt,
        decidedAt: approvals.decidedAt,
        createdAt: approvals.createdAt,
        at: timeText(approvals.createdAt),
      })
      .from(approvals)
      .innerJoin(workUnits, workOf(approvals.workUnitId, approvals.organizationId))
      .where(
        and(
          eq(approvals.organizationId, context.organizationId),
          ne(workUnits.classification, 'restricted'),
          upTo(approvals.createdAt, snapshot),
          afterTime(approvals.createdAt, approvals.id, key),
        ),
      )
      .orderBy(asc(approvals.createdAt), asc(approvals.id))
      .limit(size);
    return {
      nextKey: keyAfter(rows, size, (row) => [row.at, row.id]),
      records: rows.map((row) =>
        historyRecord('approval', row.id, row.workUnitId, row.createdAt, {
          tool_name: row.toolName,
          action: row.action,
          action_hash: row.actionHash,
          target_ref: row.targetRef,
          approver_membership_id: row.approverMembershipId,
          requested_by_membership_id: row.requestedByMembershipId,
          status: row.status,
          expires_at: isoDate(row.expiresAt),
          decided_at: isoOrNull(row.decidedAt),
        }),
      ),
    };
  },
};

const approvalDecisionsReader: KindReader = {
  recordKind: 'approval_decisions',
  async read(tx, context, { key, limit, snapshot }) {
    const rows = await tx
      .select({
        id: approvalDecisions.id,
        approvalId: approvalDecisions.approvalId,
        workUnitId: approvals.workUnitId,
        actorMembershipId: approvalDecisions.actorMembershipId,
        decision: approvalDecisions.decision,
        actionHash: approvalDecisions.actionHash,
        reason: approvalDecisions.reason,
        decidedAt: approvalDecisions.decidedAt,
        at: timeText(approvalDecisions.decidedAt),
      })
      .from(approvalDecisions)
      .innerJoin(
        approvals,
        and(
          eq(approvals.organizationId, approvalDecisions.organizationId),
          eq(approvals.id, approvalDecisions.approvalId),
        ),
      )
      .innerJoin(workUnits, workOf(approvals.workUnitId, approvals.organizationId))
      .where(
        and(
          eq(approvalDecisions.organizationId, context.organizationId),
          ne(workUnits.classification, 'restricted'),
          upTo(approvalDecisions.decidedAt, snapshot),
          afterTime(approvalDecisions.decidedAt, approvalDecisions.id, key),
        ),
      )
      .orderBy(asc(approvalDecisions.decidedAt), asc(approvalDecisions.id))
      .limit(limit);
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.at, row.id]),
      records: rows.map((row) =>
        historyRecord('approval_decision', row.id, row.workUnitId, row.decidedAt, {
          approval_id: row.approvalId,
          actor_membership_id: row.actorMembershipId,
          decision: row.decision,
          action_hash: row.actionHash,
          reason: row.reason,
        }),
      ),
    };
  },
};

const workTransitionsReader: KindReader = {
  recordKind: 'work_transitions',
  async read(tx, context, { key, limit, snapshot }) {
    const rows = await tx
      .select({
        id: workTransitions.id,
        workUnitId: workTransitions.workUnitId,
        fromVersion: workTransitions.fromVersion,
        fromStatus: workTransitions.fromStatus,
        toStatus: workTransitions.toStatus,
        actorMembershipId: workTransitions.actorMembershipId,
        reason: workTransitions.reason,
        completionBasis: workTransitions.completionBasis,
        occurredAt: workTransitions.occurredAt,
        at: timeText(workTransitions.occurredAt),
      })
      .from(workTransitions)
      .innerJoin(workUnits, workOf(workTransitions.workUnitId, workTransitions.organizationId))
      .where(
        and(
          eq(workTransitions.organizationId, context.organizationId),
          ne(workUnits.classification, 'restricted'),
          upTo(workTransitions.occurredAt, snapshot),
          afterTime(workTransitions.occurredAt, workTransitions.id, key),
        ),
      )
      .orderBy(asc(workTransitions.occurredAt), asc(workTransitions.id))
      .limit(limit);
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.at, row.id]),
      records: rows.map((row) =>
        historyRecord('work_transition', row.id, row.workUnitId, row.occurredAt, {
          from_version: row.fromVersion,
          from_status: row.fromStatus,
          to_status: row.toStatus,
          actor_membership_id: row.actorMembershipId,
          reason: row.reason,
          completion_basis: row.completionBasis,
        }),
      ),
    };
  },
};

/** What was sent or tried, as history for work that is not restricted. Never its idempotency key. */
const externalActionsReader: KindReader = {
  recordKind: 'external_actions',
  async read(tx, context, { key, limit, snapshot }) {
    const size = Math.min(limit, LARGE_ROW_PAGE);
    const rows = await tx
      .select({
        id: externalActions.id,
        workUnitId: externalActions.workUnitId,
        connectionId: externalActions.connectionId,
        toolName: externalActions.toolName,
        toolVersion: externalActions.toolVersion,
        targetRef: externalActions.targetRef,
        payload: externalActions.payload,
        requestHash: externalActions.requestHash,
        classification: externalActions.classification,
        approvalId: externalActions.approvalId,
        supersedesId: externalActions.supersedesId,
        retryOfId: externalActions.retryOfId,
        status: externalActions.status,
        statusReason: externalActions.statusReason,
        externalId: externalActions.externalId,
        createdByMembershipId: externalActions.createdByMembershipId,
        createdAt: externalActions.createdAt,
        settledAt: externalActions.settledAt,
        resolvedByMembershipId: externalActions.resolvedByMembershipId,
        resolution: externalActions.resolution,
        resolutionReason: externalActions.resolutionReason,
        at: timeText(externalActions.createdAt),
      })
      .from(externalActions)
      .innerJoin(workUnits, workOf(externalActions.workUnitId, externalActions.organizationId))
      .where(
        and(
          eq(externalActions.organizationId, context.organizationId),
          ne(workUnits.classification, 'restricted'),
          upTo(externalActions.createdAt, snapshot),
          afterTime(externalActions.createdAt, externalActions.id, key),
        ),
      )
      .orderBy(asc(externalActions.createdAt), asc(externalActions.id))
      .limit(size);
    return {
      nextKey: keyAfter(rows, size, (row) => [row.at, row.id]),
      records: rows.map((row) =>
        historyRecord('external_action', row.id, row.workUnitId, row.createdAt, {
          connection_id: row.connectionId,
          tool_name: row.toolName,
          tool_version: row.toolVersion,
          target_ref: row.targetRef,
          payload: row.payload,
          request_hash: row.requestHash,
          classification: row.classification,
          approval_id: row.approvalId,
          supersedes_id: row.supersedesId,
          retry_of_id: row.retryOfId,
          status: row.status,
          status_reason: row.statusReason,
          external_id: row.externalId,
          created_by_membership_id: row.createdByMembershipId,
          settled_at: isoOrNull(row.settledAt),
          resolved_by_membership_id: row.resolvedByMembershipId,
          resolution: row.resolution,
          resolution_reason: row.resolutionReason,
        }),
      ),
    };
  },
};

const externalActionReceiptsReader: KindReader = {
  recordKind: 'external_action_receipts',
  async read(tx, context, { key, limit, snapshot }) {
    const rows = await tx
      .select({
        id: externalActionReceipts.id,
        externalActionId: externalActionReceipts.externalActionId,
        workUnitId: externalActions.workUnitId,
        attemptId: externalActionReceipts.attemptId,
        outcome: externalActionReceipts.outcome,
        basis: externalActionReceipts.basis,
        code: externalActionReceipts.code,
        providerStatus: externalActionReceipts.providerStatus,
        externalId: externalActionReceipts.externalId,
        requestHash: externalActionReceipts.requestHash,
        actorMembershipId: externalActionReceipts.actorMembershipId,
        recordedAt: externalActionReceipts.recordedAt,
        at: timeText(externalActionReceipts.recordedAt),
      })
      .from(externalActionReceipts)
      .innerJoin(
        externalActions,
        and(
          eq(externalActions.organizationId, externalActionReceipts.organizationId),
          eq(externalActions.id, externalActionReceipts.externalActionId),
        ),
      )
      .innerJoin(workUnits, workOf(externalActions.workUnitId, externalActions.organizationId))
      .where(
        and(
          eq(externalActionReceipts.organizationId, context.organizationId),
          ne(workUnits.classification, 'restricted'),
          upTo(externalActionReceipts.recordedAt, snapshot),
          afterTime(externalActionReceipts.recordedAt, externalActionReceipts.id, key),
        ),
      )
      .orderBy(asc(externalActionReceipts.recordedAt), asc(externalActionReceipts.id))
      .limit(limit);
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.at, row.id]),
      records: rows.map((row) =>
        historyRecord('external_action_receipt', row.id, row.workUnitId, row.recordedAt, {
          external_action_id: row.externalActionId,
          attempt_id: row.attemptId,
          outcome: row.outcome,
          basis: row.basis,
          code: row.code,
          provider_status: row.providerStatus,
          external_id: row.externalId,
          request_hash: row.requestHash,
          actor_membership_id: row.actorMembershipId,
        }),
      ),
    };
  },
};

/**
 * A connection's identity and nothing else. These are the only columns of that table this code ever reads, so
 * `config` and `credential_secret_id` are never in memory here, and webhook endpoints are not read at all.
 */
const connectionsReader: KindReader = {
  recordKind: 'connections',
  async read(tx, context, { key, limit, snapshot }) {
    const rows = await tx
      .select({
        id: connections.id,
        connectorType: connections.connectorType,
        displayName: connections.displayName,
        grantedScopes: connections.grantedScopes,
        createdAt: connections.createdAt,
        at: timeText(connections.createdAt),
      })
      .from(connections)
      .where(
        and(
          eq(connections.organizationId, context.organizationId),
          upTo(connections.createdAt, snapshot),
          afterTime(connections.createdAt, connections.id, key),
        ),
      )
      .orderBy(asc(connections.createdAt), asc(connections.id))
      .limit(limit);
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.at, row.id]),
      records: rows.map((row) => ({
        kind: 'connection',
        id: row.id,
        connector_type: row.connectorType,
        display_name: row.displayName,
        granted_scopes: row.grantedScopes,
        created_at: isoDate(row.createdAt),
      })),
    };
  },
};

/** IDs, a type and a time, like the ledger. Every tombstone there is, with no snapshot, because this is last. */
const tombstonesReader: KindReader = {
  recordKind: 'tombstones',
  async read(tx, context, { key, limit }) {
    const rows = await tx
      .select({
        targetType: tombstones.targetType,
        targetId: tombstones.targetId,
        createdAt: tombstones.createdAt,
      })
      .from(tombstones)
      .where(
        and(
          eq(tombstones.organizationId, context.organizationId),
          key
            ? sql`(${tombstones.targetType}, ${tombstones.targetId}) > (${key[0]}::text, ${key[1]}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(tombstones.targetType), asc(tombstones.targetId))
      .limit(limit);
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.targetType, row.targetId]),
      records: rows.map((row) => ({
        kind: 'tombstone',
        target_type: row.targetType,
        target_id: row.targetId,
        deleted_at: isoDate(row.createdAt),
      })),
    };
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `work_unit:{id}` and so on. Null for anything else, including an ID that is not one. */
function parseTarget(targetRef: string): { type: string; id: string } | null {
  const at = targetRef.indexOf(':');
  if (at < 1) return null;
  const id = targetRef.slice(at + 1);
  return UUID.test(id) ? { type: targetRef.slice(0, at), id } : null;
}

/**
 * Which of these audit targets are restricted work, or something that exists only for restricted work. An audit
 * entry holds only codes and IDs, but "what happened on restricted work, and when" is that work's history.
 */
async function restrictedTargets(tx: Tx, targetRefs: readonly string[]): Promise<Set<string>> {
  const idsOf = (type: string) =>
    targetRefs
      .map(parseTarget)
      .filter((target): target is { type: string; id: string } => target?.type === type)
      .map((target) => target.id);
  const found = new Set<string>();
  const mark = (type: string, rows: readonly { id: string }[]) => {
    for (const { id } of rows) found.add(`${type}:${id}`);
  };

  const work = idsOf('work_unit');
  if (work.length > 0) {
    mark(
      'work_unit',
      await tx
        .select({ id: workUnits.id })
        .from(workUnits)
        .where(and(inArray(workUnits.id, work), eq(workUnits.classification, 'restricted'))),
    );
  }
  const approvalIds = idsOf('approval');
  if (approvalIds.length > 0) {
    mark(
      'approval',
      await tx
        .select({ id: approvals.id })
        .from(approvals)
        .innerJoin(workUnits, workOf(approvals.workUnitId, approvals.organizationId))
        .where(and(inArray(approvals.id, approvalIds), eq(workUnits.classification, 'restricted'))),
    );
  }
  const actionIds = idsOf('external_action');
  if (actionIds.length > 0) {
    mark(
      'external_action',
      await tx
        .select({ id: externalActions.id })
        .from(externalActions)
        .innerJoin(workUnits, workOf(externalActions.workUnitId, externalActions.organizationId))
        .where(
          and(inArray(externalActions.id, actionIds), eq(workUnits.classification, 'restricted')),
        ),
    );
  }
  const clientIds = idsOf('client');
  if (clientIds.length > 0) {
    mark(
      'client',
      await tx
        .select({ id: clients.id })
        .from(clients)
        .where(and(inArray(clients.id, clientIds), eq(clients.classification, 'restricted'))),
    );
  }
  const fileIds = idsOf('artifact');
  if (fileIds.length > 0) {
    mark(
      'artifact',
      await tx
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(and(inArray(artifacts.id, fileIds), FILE_RESTRICTED)),
    );
  }
  return found;
}

/**
 * The audit log, redacted: action, target reference, decision, reason code and time. An actor is named only
 * where it is a membership, which an import can map, so an account ID never leaves. Anything else in the row,
 * such as the correlation and dedupe keys, stays out.
 */
const auditEventsReader: KindReader = {
  recordKind: 'audit_events',
  async read(tx, context, { key, limit, snapshot }) {
    const rows = await tx
      .select({
        id: auditEvents.id,
        action: auditEvents.action,
        targetRef: auditEvents.targetRef,
        decision: auditEvents.decision,
        safeReason: auditEvents.safeReason,
        occurredAt: auditEvents.occurredAt,
        at: timeText(auditEvents.occurredAt),
        actorMembershipId: memberships.id,
      })
      .from(auditEvents)
      .leftJoin(
        memberships,
        and(
          eq(memberships.organizationId, auditEvents.organizationId),
          eq(memberships.id, auditEvents.actorId),
        ),
      )
      .where(
        and(
          eq(auditEvents.organizationId, context.organizationId),
          upTo(auditEvents.occurredAt, snapshot),
          afterTime(auditEvents.occurredAt, auditEvents.id, key),
        ),
      )
      .orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id))
      .limit(limit);
    const restricted = await restrictedTargets(
      tx,
      rows.map((row) => row.targetRef),
    );
    return {
      nextKey: keyAfter(rows, limit, (row) => [row.at, row.id]),
      records: rows
        .filter((row) => !restricted.has(row.targetRef))
        .map((row) =>
          historyRecord('audit_event', row.id, null, row.occurredAt, {
            action: row.action,
            target_ref: row.targetRef,
            decision: row.decision,
            reason_code: row.safeReason,
            actor_membership_id: row.actorMembershipId,
          }),
        ),
    };
  },
};

/** How each core section reads itself, a page at a time. The caller checks each record against the schema. */
export const CORE_SECTION_EXPORTERS: Record<CoreExportSection, PortabilitySection['exportPage']> = {
  organizations: sectionOf([organizationsReader]),
  people: sectionOf([peopleReader, teamsReader, teamMembershipsReader]),
  clients: sectionOf([clientsReader]),
  projects: sectionOf([projectsReader]),
  work: sectionOf([workUnitsReader]),
  relations: sectionOf([workDependenciesReader, workAssignmentsReader]),
  artifacts: sectionOf([artifactsReader, workArtifactsReader]),
  history: sectionOf([
    approvalsReader,
    approvalDecisionsReader,
    workTransitionsReader,
    externalActionsReader,
    externalActionReceiptsReader,
  ]),
  connections: sectionOf([connectionsReader]),
  tombstones: sectionOf([tombstonesReader]),
  'audit-redacted': sectionOf([auditEventsReader]),
};
