// Connections and their sync state (CONNECT-01, ADR-027 D3). Managing a connection needs
// connection.manage. A credential arrives here already sealed, as a reference, and this file never reads
// one. The worker's half is at the end: it holds a service context, and nothing a person calls reaches it.
import { randomUUID } from 'node:crypto';
import {
  appendAudit,
  connections,
  directoryGroups,
  externalResourceAcl,
  externalResources,
  memberships,
  syncCursors,
  users,
  webhookEndpoints,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  aclStateOf,
  configMatchesFields,
  CONNECTOR_TYPE_PATTERN,
  isSafeConnectorConfig,
  isValidSyncPage,
  MAX_COMPOSITE_SYNC_CURSOR_LENGTH,
  syncCursorLimit,
  safeSyncErrorCode,
  SHIPPED_CONNECTOR_RULES,
  SYNC_STREAM_PATTERN,
  type ConnectionState,
  type ConnectorTypeRule,
  type SyncedResource,
  type SyncPage,
} from '@ensemus/domain/connector';
import { connectionRef } from '@ensemus/domain/external-action';
import {
  AGGREGATE_CONNECTION,
  CONNECTION_CREATED,
  CONNECTION_REVOKED,
  CONNECTOR_SYNC_REQUESTED,
} from '@ensemus/domain/integration-events';
import { can } from '@ensemus/domain/policy';
import { assertInteractivePrivilege, withPrivilegeTx as withTenantTx } from './product/privileged';
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, foreignReference, pgCode } from './errors';
import { emit } from './events';
import { idSchema } from './ids';
import type { SyncStreamLease } from './integration-ports';

const FOREIGN_KEY_VIOLATION = '23503';
const identifier = idSchema;
// One line, since it is shown in lists and in the approver's page.
const displayName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/\p{Cc}/u.test(value));

export type ConnectionView = {
  id: string;
  connectorType: string;
  displayName: string;
  state: ConnectionState;
  /** Whether a credential is on file. The credential itself is never read here. */
  hasCredential: boolean;
  /** Settings, for those who manage connections. Null for everyone else. Never a secret or a host. */
  config: Record<string, unknown> | null;
  /** A code from a fixed list, for those who manage connections. Never a provider's text. */
  lastErrorCode: string | null;
  version: number;
  createdAt: Date;
};

type ConnectionRow = typeof connections.$inferSelect;

function viewOf(context: TenantContext, row: ConnectionRow): ConnectionView {
  const manages = can(context.role, 'connection.manage');
  return {
    id: row.id,
    connectorType: row.connectorType,
    displayName: row.displayName,
    state: row.state as ConnectionState,
    hasCredential: row.credentialSecretId !== null,
    config: manages ? (row.config as Record<string, unknown>) : null,
    lastErrorCode: manages ? row.lastErrorCode : null,
    version: row.version,
    createdAt: row.createdAt,
  };
}

function requireManage(context: TenantContext) {
  if (!can(context.role, 'connection.manage')) throw new AppError('FORBIDDEN');
}

/** The worker's calls read cursors and credential references, so a person's session cannot make them. */
function requireWorker(context: TenantContext) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
}

function isIdentifier(value: string) {
  return identifier.safeParse(value).success;
}

export async function createConnection(
  database: AppDatabase,
  context: TenantContext,
  input: {
    connectorType: string;
    displayName: string;
    /**
     * Checked here against what a shipped connector takes, since the web tier may not load one, and
     * again by the connector's own schema in the worker before anything uses it.
     */
    config: unknown;
    credentialSecretId: string | null;
    /** Which connectors this caller offers. Their manifests fit. Defaults to the ones we ship. */
    manifests?: readonly ConnectorTypeRule[];
  },
): Promise<ConnectionView> {
  requireManage(context);
  const rules = input.manifests ?? SHIPPED_CONNECTOR_RULES;
  const rule = rules.find((candidate) => candidate.type === input.connectorType);
  if (!rule || !CONNECTOR_TYPE_PATTERN.test(input.connectorType)) {
    throw new AppError('INVALID_INPUT');
  }
  const name = displayName.safeParse(input.displayName);
  if (!name.success) throw new AppError('INVALID_INPUT');
  if (!isSafeConnectorConfig(input.config)) throw new AppError('INVALID_INPUT');
  const fields =
    rule.configFields ??
    SHIPPED_CONNECTOR_RULES.find((shipped) => shipped.type === rule.type)?.configFields;
  if (fields && !configMatchesFields(input.config, fields)) throw new AppError('INVALID_INPUT');
  if (rule.credential.required !== (input.credentialSecretId !== null)) {
    throw new AppError('INVALID_INPUT');
  }
  if (input.credentialSecretId !== null && !isIdentifier(input.credentialSecretId)) {
    throw foreignReference();
  }

  const id = randomUUID();
  return withTenantTx(database, context, async (tx) => {
    await assertInteractivePrivilege(tx, context, 'connection.manage');
    let row: ConnectionRow | undefined;
    try {
      [row] = await tx
        .insert(connections)
        .values({
          organizationId: context.organizationId,
          id,
          connectorType: input.connectorType,
          displayName: name.data,
          config: input.config,
          credentialSecretId: input.credentialSecretId,
          createdByMembershipId: context.membershipId,
        })
        .returning();
    } catch (error) {
      // The key is composite, so another tenant's sealed value fails the same as one that never was.
      if (pgCode(error) === FOREIGN_KEY_VIOLATION) throw foreignReference();
      throw error;
    }
    await emit(tx, context, {
      eventType: CONNECTION_CREATED,
      aggregateType: AGGREGATE_CONNECTION,
      aggregateId: id,
      aggregateVersion: 1,
      classification: 'internal',
      payload: { connectionId: id },
    });
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'connection.created',
      targetRef: connectionRef(id),
      decision: 'allow',
    });
    return viewOf(context, row as ConnectionRow);
  });
}

export function listConnections(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly ConnectionView[]> {
  return withTenantTx(database, context, async (tx) => {
    const rows = await tx.select().from(connections).orderBy(connections.createdAt);
    return rows.map((row) => viewOf(context, row));
  });
}

export async function getConnection(
  database: AppDatabase,
  context: TenantContext,
  connectionId: string,
): Promise<ConnectionView> {
  if (!isIdentifier(connectionId)) throw new AppError('NOT_FOUND');
  const [row] = await withTenantTx(database, context, (tx) =>
    tx.select().from(connections).where(eq(connections.id, connectionId)),
  );
  if (!row) throw new AppError('NOT_FOUND');
  return viewOf(context, row);
}

/**
 * Takes effect at once for anything not already past its attempt, because the recheck before each send
 * reads this row. Its webhook addresses close in the same transaction. Emits connection.revoked, and the
 * connector worker then revokes the sealed secrets.
 */
export async function revokeConnection(
  database: AppDatabase,
  context: TenantContext,
  input: { connectionId: string; expectedVersion: number },
): Promise<void> {
  requireManage(context);
  if (!isIdentifier(input.connectionId)) throw new AppError('NOT_FOUND');
  await withTenantTx(database, context, async (tx) => {
    await assertInteractivePrivilege(tx, context, 'connection.manage');
    const [row] = await tx
      .select()
      .from(connections)
      .where(eq(connections.id, input.connectionId))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (row.state === 'revoked') throw new AppError('CONNECTION_NOT_ACTIVE');
    const version = row.version + 1;
    await tx
      .update(connections)
      .set({ state: 'revoked', revokedAt: sql`now()`, updatedAt: sql`now()`, version })
      .where(eq(connections.id, input.connectionId));
    await tx
      .update(webhookEndpoints)
      .set({ state: 'revoked', updatedAt: sql`now()` })
      .where(
        and(
          eq(webhookEndpoints.connectionId, input.connectionId),
          ne(webhookEndpoints.state, 'revoked'),
        ),
      );
    await emit(tx, context, {
      eventType: CONNECTION_REVOKED,
      aggregateType: AGGREGATE_CONNECTION,
      aggregateId: input.connectionId,
      aggregateVersion: version,
      classification: 'internal',
      payload: { connectionId: input.connectionId },
    });
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'connection.revoked',
      targetRef: connectionRef(input.connectionId),
      decision: 'allow',
    });
  });
}

export async function requestConnectorSync(
  database: AppDatabase,
  context: TenantContext,
  input: { connectionId: string },
): Promise<void> {
  requireManage(context);
  if (!isIdentifier(input.connectionId)) throw new AppError('NOT_FOUND');
  await withTenantTx(database, context, async (tx) => {
    await assertInteractivePrivilege(tx, context, 'connection.manage');
    const [row] = await tx
      .select({ state: connections.state, version: connections.version })
      .from(connections)
      .where(eq(connections.id, input.connectionId));
    if (!row) throw new AppError('NOT_FOUND');
    if (row.state !== 'active') throw new AppError('CONNECTION_NOT_ACTIVE');
    await emit(tx, context, {
      eventType: CONNECTOR_SYNC_REQUESTED,
      aggregateType: AGGREGATE_CONNECTION,
      aggregateId: input.connectionId,
      aggregateVersion: row.version,
      classification: 'internal',
      payload: { connectionId: input.connectionId },
    });
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'connection.sync_requested',
      targetRef: connectionRef(input.connectionId),
      decision: 'allow',
    });
  });
}

// --- The connector worker's half. RLS confines every query here to the context's tenant, so a connector
// handed one tenant has no way to name another's cursor, resources or credential reference.

/** What the connector worker does with a connection it was told about. Read under the tenant. */
export async function loadConnectionForWorker(
  database: AppDatabase,
  context: TenantContext,
  connectionId: string,
): Promise<{
  id: string;
  connectorType: string;
  state: ConnectionState;
  config: unknown;
  credentialSecretId: string | null;
  /** Secrets its webhook endpoints verify with, which a revoke has to stop as well. */
  signingSecretIds: readonly string[];
  grantedScopes: readonly string[];
} | null> {
  requireWorker(context);
  if (!isIdentifier(connectionId)) return null;
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx.select().from(connections).where(eq(connections.id, connectionId));
    if (!row) return null;
    const endpoints = await tx
      .select({
        current: webhookEndpoints.signingSecretId,
        previous: webhookEndpoints.previousSigningSecretId,
      })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.connectionId, connectionId));
    const signing = endpoints.flatMap(({ current, previous }) =>
      previous ? [current, previous] : [current],
    );
    return {
      id: row.id,
      connectorType: row.connectorType,
      state: row.state as ConnectionState,
      config: row.config,
      credentialSecretId: row.credentialSecretId,
      signingSecretIds: [...new Set(signing)],
      grantedScopes: [...row.grantedScopes],
    };
  });
}

/**
 * Takes one stream's lease, creating the row if this is its first pass. Null if someone holds it.
 *
 * A full sync can span passes, and has no column of its own to say so, so the row stays
 * `resync_required` until the last page of one commits: a crash, or running out of pages, carries on in
 * the same mode from the same cursor. Starting one moves `generation` as well, which shuts out any pass
 * still running from before.
 */
export async function leaseSyncStream(
  database: AppDatabase,
  context: TenantContext,
  input: { connectionId: string; stream: string; leaseMs: number },
): Promise<SyncStreamLease | null> {
  requireWorker(context);
  if (
    !isIdentifier(input.connectionId) ||
    !SYNC_STREAM_PATTERN.test(input.stream) ||
    !Number.isInteger(input.leaseMs) ||
    input.leaseMs < 1 ||
    input.leaseMs > 3_600_000
  ) {
    throw new AppError('INVALID_INPUT');
  }
  return withTenantTx(database, context, async (tx) => {
    const [connection] = await tx
      .select({ state: connections.state })
      .from(connections)
      .where(eq(connections.id, input.connectionId));
    if (!connection) throw new AppError('NOT_FOUND');
    if (connection.state !== 'active') throw new AppError('CONNECTION_NOT_ACTIVE');

    await tx
      .insert(syncCursors)
      .values({
        organizationId: context.organizationId,
        connectionId: input.connectionId,
        stream: input.stream,
      })
      .onConflictDoNothing();
    const [row] = await tx
      .select({
        cursor: syncCursors.cursor,
        generation: syncCursors.generation,
        fullSyncGeneration: syncCursors.fullSyncGeneration,
        fullSyncInProgress: syncCursors.fullSyncInProgress,
        state: syncCursors.state,
        held: sql<boolean>`coalesce(${syncCursors.leaseUntil} > now(), false)`,
      })
      .from(syncCursors)
      .where(streamIs(input.connectionId, input.stream))
      .for('update');
    if (!row || row.held) return null;

    const firstEver = row.generation === 0 && row.cursor === null;
    const fullSync = firstEver || row.fullSyncInProgress || row.state === 'resync_required';
    // Carrying on from a page it committed keeps its generation. With no page yet, it starts afresh.
    const starting = fullSync && row.cursor === null;
    const generation = row.generation + (starting ? 1 : 0);
    const fullSyncGeneration = row.fullSyncGeneration + (starting ? 1 : 0);
    await tx
      .update(syncCursors)
      .set({
        state: 'running',
        fullSyncInProgress: fullSync,
        leaseUntil: sql`now() + make_interval(secs => ${input.leaseMs / 1000})`,
        generation,
        fullSyncGeneration,
        updatedAt: sql`now()`,
      })
      .where(streamIs(input.connectionId, input.stream));
    return { stream: input.stream, cursor: row.cursor, generation, fullSync, fullSyncGeneration };
  });
}

const streamIs = (connectionId: string, stream: string) =>
  and(eq(syncCursors.connectionId, connectionId), eq(syncCursors.stream, stream));

type MappedGrantRow = {
  principalKind: string;
  principalExternalId: string;
  access: string;
  membershipId: string | null;
  teamId: string | null;
};

export type MappedSyncPage = SyncPage & {
  /** Each resource's grants with who they mapped to, by the resource's position in the page. */
  mappedGrants: ReadonlyArray<ReadonlyArray<MappedGrantRow>>;
};

/** One row per grant, whatever the source repeated. `domain` and `anyone` can never carry a target. */
function desiredGrants(grants: ReadonlyArray<MappedGrantRow>): Map<string, MappedGrantRow> {
  const desired = new Map<string, MappedGrantRow>();
  for (const grant of grants) {
    const open = grant.principalKind === 'domain' || grant.principalKind === 'anyone';
    desired.set(aclKey(grant), {
      ...grant,
      membershipId: open ? null : grant.membershipId,
      teamId: open ? null : grant.teamId,
    });
  }
  return desired;
}

const aclKey = (grant: { principalKind: string; principalExternalId: string; access: string }) =>
  JSON.stringify([grant.principalKind, grant.principalExternalId, grant.access]);

/**
 * Makes the stored grants what the source says, touching only what differs. This runs even for a version
 * already stored: a source can change who may see something without changing the thing, and leaving out
 * a principal is how a revoke reaches here. A repeat finds nothing to do.
 */
async function reconcileGrants(
  tx: Tx,
  context: TenantContext,
  resourceId: string,
  desired: Map<string, MappedGrantRow>,
  generation: number,
): Promise<boolean> {
  const stored = await tx
    .select()
    .from(externalResourceAcl)
    .where(eq(externalResourceAcl.resourceId, resourceId));
  let changed = false;
  const keep = new Set<string>();
  for (const row of stored) {
    const key = aclKey(row);
    const want = desired.get(key);
    const matches = and(
      eq(externalResourceAcl.resourceId, resourceId),
      eq(externalResourceAcl.principalKind, row.principalKind),
      eq(externalResourceAcl.principalExternalId, row.principalExternalId),
      eq(externalResourceAcl.access, row.access),
    );
    if (!want) {
      await tx.delete(externalResourceAcl).where(matches);
      changed = true;
      continue;
    }
    keep.add(key);
    if (want.membershipId !== row.membershipId || want.teamId !== row.teamId) {
      await tx
        .update(externalResourceAcl)
        .set({
          membershipId: want.membershipId,
          teamId: want.teamId,
          syncedGeneration: generation,
          updatedAt: sql`now()`,
        })
        .where(matches);
      changed = true;
    }
  }
  const fresh = [...desired.entries()].filter(([key]) => !keep.has(key));
  if (fresh.length) {
    await tx.insert(externalResourceAcl).values(
      fresh.map(([, grant]) => ({
        organizationId: context.organizationId,
        resourceId,
        principalKind: grant.principalKind,
        principalExternalId: grant.principalExternalId,
        access: grant.access,
        membershipId: grant.membershipId,
        teamId: grant.teamId,
        syncedGeneration: generation,
      })),
    );
    changed = true;
  }
  return changed;
}

function fieldsOf(resource: SyncedResource) {
  return {
    externalVersion: resource.externalVersion,
    displayName: resource.displayName ?? null,
    contentSha256: resource.contentSha256 ?? null,
    classification: resource.classification ?? 'internal',
  };
}

async function applyResource(
  tx: Tx,
  context: TenantContext,
  input: {
    connectionId: string;
    stream: string;
    resource: SyncedResource;
    grants: ReadonlyArray<MappedGrantRow>;
    existing: typeof externalResources.$inferSelect | undefined;
    generation: number;
    fullSync: boolean;
  },
) {
  const { connectionId, stream, resource, existing, generation, fullSync } = input;
  const desired = desiredGrants(input.grants);
  const mapped = [...desired.values()].filter((g) => g.membershipId || g.teamId).length;
  const aclState = aclStateOf(desired.size, mapped);
  const fields = fieldsOf(resource);

  if (!existing) {
    const [row] = await tx
      .insert(externalResources)
      .values({
        organizationId: context.organizationId,
        connectionId,
        stream,
        resourceType: resource.resourceType,
        externalId: resource.externalId,
        ...fields,
        aclState,
        seenGeneration: generation,
      })
      .returning({ id: externalResources.id });
    await reconcileGrants(tx, context, (row as { id: string }).id, desired, generation);
    return;
  }
  // The same ID under another stream would have one stream's full sync decide the other's resources.
  if (existing.stream !== stream) throw new AppError('INVALID_INPUT');
  // The same ID as another kind of thing is not the same thing, so it cannot quietly become it.
  if (existing.resourceType !== resource.resourceType) throw new AppError('INVALID_INPUT');

  // A version says whether anything changed. With none to go on, the fields themselves have to.
  const contentChanged =
    existing.deletedAt !== null ||
    (fields.externalVersion === null
      ? existing.externalVersion !== null ||
        existing.displayName !== fields.displayName ||
        existing.contentSha256 !== fields.contentSha256 ||
        existing.classification !== fields.classification
      : existing.externalVersion !== fields.externalVersion);
  const grantsChanged = await reconcileGrants(tx, context, existing.id, desired, generation);
  const stateChanged = existing.aclState !== aclState;

  if (contentChanged || grantsChanged || stateChanged) {
    await tx
      .update(externalResources)
      .set({
        ...(contentChanged ? { ...fields, deletedAt: null } : {}),
        aclState,
        seenGeneration: generation,
        updatedAt: sql`now()`,
      })
      .where(eq(externalResources.id, existing.id));
  } else if (fullSync && existing.seenGeneration !== generation) {
    // Seen by this full sync, and nothing about it changed, so `updatedAt` stays where it is.
    await tx
      .update(externalResources)
      .set({ seenGeneration: generation })
      .where(eq(externalResources.id, existing.id));
  }
}

/** Marks resources gone. They grant nothing from here on, and doing this again changes nothing. */
async function markGone(tx: Tx, where: ReturnType<typeof and>) {
  const gone = tx.select({ id: externalResources.id }).from(externalResources).where(where);
  await tx.delete(externalResourceAcl).where(inArray(externalResourceAcl.resourceId, gone));
  await tx
    .update(externalResources)
    .set({ deletedAt: sql`now()`, aclState: 'unmapped', updatedAt: sql`now()` })
    .where(where);
}

/**
 * Commits a page: resources, their grants, deletions and the cursor, in one transaction, if the
 * generation still matches. A resource already at this version is left alone, which is what makes a
 * repeat of a page do nothing. Returns the new state, or null if the generation had moved or the
 * connection is no longer active, in which case nothing at all was written.
 */
export async function commitSyncPage(
  database: AppDatabase,
  context: TenantContext,
  input: { connectionId: string; lease: SyncStreamLease; page: MappedSyncPage },
): Promise<SyncStreamLease | null> {
  requireWorker(context);
  const { connectionId, lease, page } = input;
  if (
    !isIdentifier(connectionId) ||
    !isValidSyncPage(lease.stream, page, MAX_COMPOSITE_SYNC_CURSOR_LENGTH) ||
    page.mappedGrants.length !== page.resources.length
  ) {
    throw new AppError('INVALID_INPUT');
  }
  try {
    return await withTenantTx(database, context, async (tx) => {
      // Shares the row with a revoke, so one that has committed stops this page and one that has not
      // waits for it.
      const [connection] = await tx
        .select({ state: connections.state, connectorType: connections.connectorType })
        .from(connections)
        .where(eq(connections.id, connectionId))
        .for('share');
      if (connection?.state !== 'active') return null;
      // The larger composite bound belongs to this stored connector/stream, never a caller's claim.
      if (
        !isValidSyncPage(
          lease.stream,
          page,
          syncCursorLimit(connection.connectorType, lease.stream),
        )
      )
        throw new AppError('INVALID_INPUT');

      const [cursor] = await tx
        .select()
        .from(syncCursors)
        .where(streamIs(connectionId, lease.stream))
        .for('update');
      if (
        !cursor ||
        cursor.generation !== lease.generation ||
        cursor.fullSyncGeneration !== lease.fullSyncGeneration
      ) {
        return null;
      }

      const ofThisConnection = eq(externalResources.connectionId, connectionId);
      const ids = page.resources.map((resource) => resource.externalId);
      const existing = ids.length
        ? await tx
            .select()
            .from(externalResources)
            .where(and(ofThisConnection, inArray(externalResources.externalId, ids)))
        : [];
      const byExternalId = new Map(existing.map((row) => [row.externalId, row]));
      for (const [index, resource] of page.resources.entries()) {
        await applyResource(tx, context, {
          connectionId,
          stream: lease.stream,
          resource,
          grants: page.mappedGrants[index] ?? [],
          existing: byExternalId.get(resource.externalId),
          generation: lease.fullSyncGeneration,
          fullSync: lease.fullSync,
        });
      }

      if (page.deletedExternalIds.length) {
        await markGone(
          tx,
          and(
            ofThisConnection,
            inArray(externalResources.externalId, [...page.deletedExternalIds]),
            isNull(externalResources.deletedAt),
          ),
        );
      }

      const finishesFullSync = lease.fullSync && !page.hasMore;
      if (finishesFullSync) {
        // What this full sync did not see has gone at the source. Only this stream's: another stream
        // has its own full sync, and it may hold the same kind of thing.
        await markGone(
          tx,
          and(
            ofThisConnection,
            eq(externalResources.stream, lease.stream),
            lt(externalResources.seenGeneration, lease.fullSyncGeneration),
            isNull(externalResources.deletedAt),
          ),
        );
      }

      // A page that moves nothing leaves this row alone too, generation included.
      const moved = page.nextCursor !== cursor.cursor || finishesFullSync;
      const generation = cursor.generation + (moved ? 1 : 0);
      if (moved) {
        await tx
          .update(syncCursors)
          .set({
            cursor: page.nextCursor,
            generation,
            ...(page.watermark ? { watermark: page.watermark } : {}),
            ...(finishesFullSync ? { fullSyncInProgress: false } : {}),
            updatedAt: sql`now()`,
          })
          .where(streamIs(connectionId, lease.stream));
      }
      return {
        stream: lease.stream,
        cursor: page.nextCursor,
        generation,
        fullSync: lease.fullSync && page.hasMore,
        fullSyncGeneration: lease.fullSyncGeneration,
      };
    });
  } catch (error) {
    // A grant naming someone outside this tenant fails its tenant-safe key. Nothing was written.
    if (pgCode(error) === FOREIGN_KEY_VIOLATION) throw foreignReference();
    throw error;
  }
}

/**
 * Lets go of a stream's lease, and says how its pass ended. The connection shows the first stream
 * currently failing, so that one stream recovering does not hide another. The code comes from the fixed
 * list, whatever a connector said. Writing it does not move the connection's version, which belongs to
 * the person changing it.
 */
export async function finishSyncStream(
  database: AppDatabase,
  context: TenantContext,
  input: {
    connectionId: string;
    stream: string;
    outcome: { ok: true } | { ok: false; code: string } | { resyncRequired: true };
  },
): Promise<void> {
  requireWorker(context);
  if (!isIdentifier(input.connectionId)) throw new AppError('INVALID_INPUT');
  const { connectionId, stream, outcome } = input;
  await withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .select({ state: syncCursors.state, generation: syncCursors.generation })
      .from(syncCursors)
      .where(streamIs(connectionId, stream))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');

    if ('resyncRequired' in outcome) {
      await tx
        .update(syncCursors)
        .set({
          state: 'resync_required',
          // Owed from the start again, so one already under way counts for nothing.
          fullSyncInProgress: false,
          cursor: null,
          generation: row.generation + 1,
          leaseUntil: null,
          lastErrorCode: null,
          updatedAt: sql`now()`,
        })
        .where(streamIs(connectionId, stream));
    } else if (outcome.ok) {
      await tx
        .update(syncCursors)
        .set({
          state: 'idle',
          leaseUntil: null,
          lastErrorCode: null,
          lastSyncedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(streamIs(connectionId, stream));
    } else {
      await tx
        .update(syncCursors)
        .set({
          state: 'failed',
          leaseUntil: null,
          lastErrorCode: safeSyncErrorCode(outcome.code),
          updatedAt: sql`now()`,
        })
        .where(streamIs(connectionId, stream));
    }

    const [failing] = await tx
      .select({ code: syncCursors.lastErrorCode })
      .from(syncCursors)
      .where(and(eq(syncCursors.connectionId, connectionId), isNotNull(syncCursors.lastErrorCode)))
      .orderBy(syncCursors.stream)
      .limit(1);
    await recordConnectionError(tx, connectionId, failing?.code ?? null);
  });
}

async function recordConnectionError(tx: Tx, connectionId: string, code: string | null) {
  await tx
    .update(connections)
    .set({ lastErrorCode: code, lastErrorAt: code ? sql`now()` : null })
    .where(
      and(
        eq(connections.id, connectionId),
        sql`${connections.lastErrorCode} is distinct from ${code}`,
      ),
    );
}

/**
 * Says a connection could not start its pass at all, such as settings its connector refuses. Only a code
 * from the fixed list reaches the row.
 */
export async function recordConnectionFailure(
  database: AppDatabase,
  context: TenantContext,
  input: { connectionId: string; code: string },
): Promise<void> {
  requireWorker(context);
  if (!isIdentifier(input.connectionId)) throw new AppError('INVALID_INPUT');
  await withTenantTx(database, context, (tx) =>
    recordConnectionError(tx, input.connectionId, safeSyncErrorCode(input.code)),
  );
}

/**
 * The default directory: an email address finds an active membership in this tenant, and everything else
 * finds nobody. The email has to be the whole address, in any case. RLS keeps this to one tenant, so the
 * same address in another tenant is another person.
 *
 * A group finds the team its connection's directory made for it (ADR-038 D4): Google's by the group's
 * email, which is what a Drive permission carries, and Microsoft's by object ID. Only the connection whose
 * file named the group is asked, since the same ID in another connection's directory is another group.
 * Without a connection, or before the directory has seen the group, it finds nobody.
 */
export async function resolveSourcePrincipal(
  database: AppDatabase,
  context: TenantContext,
  principal: { kind: 'user' | 'group' | 'domain' | 'anyone'; externalId: string },
  source: { connectionId: string } | null = null,
): Promise<{ membershipId: string } | { teamId: string } | null> {
  requireWorker(context);
  if (principal.kind === 'group') {
    if (!source || !isIdentifier(source.connectionId) || !principal.externalId) return null;
    const [group] = await withTenantTx(database, context, (tx) =>
      tx
        .select({ teamId: directoryGroups.teamId })
        .from(directoryGroups)
        .where(
          and(
            eq(directoryGroups.connectionId, source.connectionId),
            eq(directoryGroups.externalId, principal.externalId),
          ),
        ),
    );
    return group ? { teamId: group.teamId } : null;
  }
  if (principal.kind !== 'user' || !principal.externalId.includes('@')) return null;
  const email = principal.externalId.trim().toLowerCase();
  const [row] = await withTenantTx(database, context, (tx) =>
    tx
      .select({ membershipId: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
          sql`lower(${users.email}) = ${email}`,
        ),
      ),
  );
  return row ? { membershipId: row.membershipId } : null;
}
