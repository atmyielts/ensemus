// M2 tables: teams, invitations, clients, projects, Work Units, approvals and lifecycle.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { memberships, orgSchema, organizations, platformSchema } from './schema';

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const classificationCheck = (name: string, column: unknown) =>
  check(name, sql`${column} in ('public','internal','confidential','restricted')`);

export const workSchema = pgSchema('work');

const tenantId = () =>
  uuid()
    .notNull()
    .references(() => organizations.id);

// --- People
export const teams = orgSchema.table(
  'teams',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    parentId: uuid(),
    name: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.parentId],
      foreignColumns: [t.organizationId, t.id],
    }),
    check('teams_not_own_parent', sql`${t.parentId} is distinct from ${t.id}`),
  ],
);

export const teamMemberships = orgSchema.table(
  'team_memberships',
  {
    organizationId: uuid().notNull(),
    teamId: uuid().notNull(),
    membershipId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.teamId, t.membershipId] }),
    foreignKey({
      columns: [t.organizationId, t.teamId],
      foreignColumns: [teams.organizationId, teams.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.organizationId, t.membershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }).onDelete('cascade'),
  ],
);

export const invitations = orgSchema.table(
  'invitations',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    email: text().notNull(),
    role: text().notNull().default('member'),
    // Only a hash is stored, so a database read does not reveal a usable invitation.
    tokenHash: text().notNull().unique(),
    invitedByMembershipId: uuid().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    /** An account whose address nobody has proven asked to join. An admin has to confirm it. */
    claimedByUserId: uuid(),
    claimedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.invitedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    check('invitations_role_check', sql`${t.role} in ('admin','member')`),
  ],
);

// --- Relationships
export const clients = workSchema.table(
  'clients',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    displayName: text().notNull(),
    classification: text().notNull().default('internal'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    classificationCheck('clients_classification_check', t.classification),
  ],
);

export const projects = workSchema.table(
  'projects',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    clientId: uuid(),
    name: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.clientId],
      foreignColumns: [clients.organizationId, clients.id],
    }),
  ],
);

// --- Work
export const workUnits = workSchema.table(
  'work_units',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    projectId: uuid(),
    parentId: uuid(),
    ownerMembershipId: uuid().notNull(),
    createdByMembershipId: uuid(),
    title: text().notNull(),
    objective: text(),
    status: text().notNull().default('queued'),
    completionCriteria: jsonb().notNull().default([]),
    /** The generic plan the workflow interprets. Null means people do this work by hand. */
    executionPlan: text(),
    /** Someone asked the plan to run, and no workflow has taken it yet. */
    runRequestedAt: timestamp({ withTimezone: true }),
    runRequestedByMembershipId: uuid(),
    /** Who the plan asks to review. Chosen when it is run, and never the person who ran it. */
    planReviewerMembershipId: uuid(),
    /** The workflow run holding this work. A workflow only ever acts on work it claimed. */
    runId: text(),
    classification: text().notNull().default('internal'),
    dueAt: timestamp({ withTimezone: true }),
    version: bigint({ mode: 'number' }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.projectId],
      foreignColumns: [projects.organizationId, projects.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.parentId],
      foreignColumns: [t.organizationId, t.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.ownerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.createdByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.runRequestedByMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.planReviewerMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('work_units_status_idx').on(t.organizationId, t.status, t.dueAt),
    index('work_units_page_idx').on(t.organizationId, t.createdAt, t.id),
    check(
      'work_units_status_check',
      sql`${t.status} in ('queued','ready','running','blocked','awaiting_approval','verifying','completed','failed','cancelled')`,
    ),
    check('work_units_version_check', sql`${t.version} > 0`),
    classificationCheck('work_units_classification_check', t.classification),
  ],
);

export const workDependencies = workSchema.table(
  'work_dependencies',
  {
    organizationId: uuid().notNull(),
    prerequisiteId: uuid().notNull(),
    dependentId: uuid().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.prerequisiteId, t.dependentId] }),
    foreignKey({
      columns: [t.organizationId, t.prerequisiteId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.dependentId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    index('work_dependencies_reverse_idx').on(t.organizationId, t.dependentId),
    check('work_dependencies_no_self_edge', sql`${t.prerequisiteId} <> ${t.dependentId}`),
  ],
);

export const workAssignments = workSchema.table(
  'work_assignments',
  {
    organizationId: uuid().notNull(),
    workUnitId: uuid().notNull(),
    membershipId: uuid().notNull(),
    responsibility: text().notNull().default('contributor'),
    /** Who holds this assignment. Only people are assigned until agents arrive in M4. */
    actorType: text().notNull().default('human'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.workUnitId, t.membershipId] }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.membershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('work_assignments_member_idx').on(t.organizationId, t.membershipId),
    check('work_assignments_kind_check', sql`${t.responsibility} in ('contributor','reviewer')`),
    check('work_assignments_actor_type_check', sql`${t.actorType} in ('human','agent')`),
  ],
);

export const artifacts = workSchema.table(
  'artifacts',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    name: text().notNull(),
    objectKey: text().notNull(),
    sha256: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: bigint({ mode: 'number' }).notNull(),
    classification: text().notNull().default('internal'),
    createdByMembershipId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    classificationCheck('artifacts_classification_check', t.classification),
  ],
);

export const workArtifacts = workSchema.table(
  'work_artifacts',
  {
    organizationId: uuid().notNull(),
    workUnitId: uuid().notNull(),
    artifactId: uuid().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.workUnitId, t.artifactId] }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.artifactId],
      foreignColumns: [artifacts.organizationId, artifacts.id],
    }).onDelete('cascade'),
  ],
);

export const approvals = workSchema.table(
  'approvals',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    workUnitId: uuid().notNull(),
    toolName: text().notNull(),
    /** The exact action the approver reviews. It is immutable: no role can update this column. */
    action: jsonb().notNull(),
    actionHash: text().notNull(),
    targetRef: text(),
    approverMembershipId: uuid().notNull(),
    requestedByMembershipId: uuid(),
    status: text().notNull().default('pending'),
    /** True for the one approval that paused the work. Only its decision can release the pause. */
    holdsWork: boolean().notNull().default(false),
    /** The workflow run that asked, so a retry finds its own request and nothing older. */
    runId: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.approverMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('approvals_pending_idx').on(t.organizationId, t.approverMembershipId, t.status),
    // One open decision per Work Unit, so a later request can never override an earlier one.
    uniqueIndex('approvals_one_open_per_work')
      .on(t.organizationId, t.workUnitId)
      .where(sql`${t.status} = 'pending'`),
    check(
      'approvals_status_check',
      sql`${t.status} in ('pending','approved','denied','expired','cancelled')`,
    ),
  ],
);

export const approvalDecisions = workSchema.table(
  'approval_decisions',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    approvalId: uuid().notNull(),
    actorMembershipId: uuid().notNull(),
    decision: text().notNull(),
    actionHash: text().notNull(),
    reason: text(),
    decidedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.approvalId],
      foreignColumns: [approvals.organizationId, approvals.id],
    }),
    check('approval_decisions_decision_check', sql`${t.decision} in ('approve','deny')`),
  ],
);

/**
 * Every status change, with who made it and why. The reason is free text, so it lives here, with the
 * Work Unit's own access rules, and never in events, the audit log or Temporal.
 */
export const workTransitions = workSchema.table(
  'work_transitions',
  {
    organizationId: uuid().notNull(),
    id: uuid().notNull().defaultRandom(),
    workUnitId: uuid().notNull(),
    /** The version this move started from. Empty only on rows written before this was recorded. */
    fromVersion: integer(),
    fromStatus: text().notNull(),
    toStatus: text().notNull(),
    actorMembershipId: uuid(),
    reason: text(),
    /** On a move to completed: what it rests on. Evidence, or the accountable owner's own word. */
    completionBasis: text(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.workUnitId],
      foreignColumns: [workUnits.organizationId, workUnits.id],
    }),
    foreignKey({
      columns: [t.organizationId, t.actorMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('work_transitions_work_idx').on(t.organizationId, t.workUnitId, t.occurredAt),
    check(
      'work_transitions_completion_basis_check',
      sql`${t.completionBasis} in ('evidence','owner_confirmed')`,
    ),
  ],
);

// --- Platform
export const notifications = platformSchema.table(
  'notifications',
  {
    organizationId: tenantId(),
    id: uuid().notNull().defaultRandom(),
    recipientMembershipId: uuid().notNull(),
    kind: text().notNull(),
    /** An opaque reference. The page resolves it with the reader's permissions. */
    targetRef: text().notNull(),
    remindAt: timestamp({ withTimezone: true }),
    remindersSent: integer().notNull().default(0),
    /** When a reminder last brought this back up the inbox. */
    lastRemindedAt: timestamp({ withTimezone: true }),
    readAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    foreignKey({
      columns: [t.organizationId, t.recipientMembershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }),
    index('notifications_inbox_idx').on(t.organizationId, t.recipientMembershipId, t.readAt),
  ],
);

export const tombstones = platformSchema.table(
  'tombstones',
  {
    organizationId: tenantId(),
    targetType: text().notNull(),
    targetId: uuid().notNull(),
    reasonCode: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.targetType, t.targetId] })],
);

/**
 * Stored bytes that have to go: a deleted file (LIFE-01, steps 5 and 7), or an upload whose row never
 * arrived. Written before the bytes can be stranded, so nothing relies on a crash not happening.
 */
export const blobLifecycle = platformSchema.table(
  'blob_lifecycle',
  {
    organizationId: tenantId(),
    artifactId: uuid().notNull(),
    objectKey: text().notNull(),
    state: text().notNull(),
    purgeAfter: timestamp({ withTimezone: true }).notNull(),
    attempts: integer().notNull().default(0),
    purgedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.artifactId] }),
    index('blob_lifecycle_due_idx').on(t.organizationId, t.state, t.purgeAfter),
    check('blob_lifecycle_state_check', sql`${t.state} in ('uploading','deleting','purged')`),
  ],
);

export const idempotencyKeys = platformSchema.table(
  'idempotency_keys',
  {
    organizationId: tenantId(),
    membershipId: uuid().notNull(),
    key: text().notNull(),
    requestHash: text().notNull(),
    responseStatus: integer().notNull(),
    responseBody: jsonb().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.membershipId, t.key] }),
    unique('idempotency_keys_unique').on(t.organizationId, t.membershipId, t.key),
  ],
);
