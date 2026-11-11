// Directory sync (CONNECT-08, ADR-038 D4): each provider group mirrored as a team that only this sync may
// change. Each write runs in a transaction naming its connection in DIRECTORY_SYNC_SETTING, which is the
// only way migration 0561 lets a directory team, its members or its group row change. Both calls are the
// connector worker's: they need a service context, and 0561 refuses the setting in any other.
import {
  connections,
  directoryGroups,
  memberships,
  syncCursors,
  teamMemberships,
  teams,
  users,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { MAX_SYNC_CURSOR_LENGTH } from '@ensemus/domain/connector';
import {
  capabilityGranted,
  DIRECTORY_MAX_NAME_LENGTH,
  DIRECTORY_STREAM,
  DIRECTORY_SYNC_SETTING,
  directoryFreshness,
  isSuiteConnectorType,
  isValidDirectoryPage,
  type DirectoryPage,
} from '@ensemus/domain/workspace-suites';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  diffMembers,
  directoryEmail,
  directoryGraphOf,
  directoryTeamName,
  flattenDirectoryGroup,
} from './directory-plan';
import { AppError } from './errors';
import { idSchema } from './ids';
import type { SyncStreamLease } from './integration-ports';

type GroupRow = typeof directoryGroups.$inferSelect;

function requireWorker(context: TenantContext) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
}

/**
 * Opens the transaction as this connection's directory pass. set_config with `true` is local to the
 * transaction, so the setting ends with it and never reaches the next user of the pooled connection.
 */
async function asDirectoryPass(tx: Tx, connectionId: string) {
  await tx.execute(sql`select set_config(${DIRECTORY_SYNC_SETTING}, ${connectionId}, true)`);
}

/**
 * Removes groups' teams: members first, then the team, whose foreign key takes the group row with it.
 * In that order because 0561 lets a member go only while the group row still names this connection.
 */
async function removeGroups(tx: Tx, rows: readonly GroupRow[]) {
  const teamIds = rows.map((row) => row.teamId);
  if (!teamIds.length) return;
  await tx.delete(teamMemberships).where(inArray(teamMemberships.teamId, teamIds));
  await tx.delete(teams).where(inArray(teams.id, teamIds));
}

/** Active memberships here, by email. RLS keeps it to this tenant, so another tenant's person never matches. */
async function membershipsByEmail(
  tx: Tx,
  context: TenantContext,
  emails: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let start = 0; start < emails.length; start += 1000) {
    const chunk = emails.slice(start, start + 1000);
    const rows = await tx
      .select({ membershipId: memberships.id, email: sql<string>`lower(${users.email})` })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
          inArray(sql`lower(${users.email})`, chunk),
        ),
      );
    for (const row of rows) found.set(row.email, row.membershipId);
  }
  return found;
}

/**
 * The worker's service context only. How many of these addresses belong to an active membership here,
 * compared exactly as a directory pass compares them. For the operator's live suite check, which reports
 * the count and nothing about who.
 */
export async function countDirectoryMatches(
  database: AppDatabase,
  context: TenantContext,
  emails: readonly string[],
): Promise<number> {
  requireWorker(context);
  const unique = [...new Set(emails.flatMap((email) => directoryEmail(email) ?? []))];
  if (unique.length === 0) return 0;
  return withTenantTx(database, context, async (tx) => {
    const found = await membershipsByEmail(tx, context, unique);
    return found.size;
  });
}

/**
 * The worker's service context only. Commits a page of groups with the cursor, if the lease's generation
 * still matches and the connection is active: creates a team for a new group, renames it, replaces each
 * group's members (flattened at most DIRECTORY_MAX_NESTING deep, cycles cut, matched by email), and after
 * the last page of a completed full pass removes the members, then the team, of every group it did not
 * see. Returns the new lease, or null when nothing was written, as commitSyncPage does.
 *
 * The whole page is one transaction, so each group's membership is replaced at once and a page that does
 * not commit changes nothing. A nested group is expanded only from what this page carries: the connectors
 * put each group's nested groups in the same page, and anything they could not fit adds nobody rather than
 * someone the provider may have removed since.
 */
export async function commitDirectoryPage(
  database: AppDatabase,
  context: TenantContext,
  input: { connectionId: string; lease: SyncStreamLease; page: DirectoryPage },
): Promise<SyncStreamLease | null> {
  requireWorker(context);
  const { connectionId, lease, page } = input;
  if (
    !idSchema.safeParse(connectionId).success ||
    lease.stream !== DIRECTORY_STREAM ||
    !isValidDirectoryPage(page, MAX_SYNC_CURSOR_LENGTH) ||
    // Only a full pass may remove what it did not see, so the page and the lease have to agree on it.
    page.fullSync !== lease.fullSync
  ) {
    throw new AppError('INVALID_INPUT');
  }
  return withTenantTx(database, context, async (tx) => {
    await asDirectoryPass(tx, connectionId);
    // Shares the row with a revoke: one that has committed stops this page, one that has not waits.
    const [connection] = await tx
      .select({ state: connections.state })
      .from(connections)
      .where(eq(connections.id, connectionId))
      .for('share');
    if (connection?.state !== 'active') return null;

    const [cursor] = await tx
      .select()
      .from(syncCursors)
      .where(and(eq(syncCursors.connectionId, connectionId), eq(syncCursors.stream, lease.stream)))
      .for('update');
    if (
      !cursor ||
      cursor.generation !== lease.generation ||
      cursor.fullSyncGeneration !== lease.fullSyncGeneration
    ) {
      return null;
    }

    const ofThisConnection = eq(directoryGroups.connectionId, connectionId);
    const named = [...page.groups.map((group) => group.externalId), ...page.deletedExternalIds];
    const existing = named.length
      ? await tx
          .select()
          .from(directoryGroups)
          .where(and(ofThisConnection, inArray(directoryGroups.externalId, named)))
      : [];
    const byExternalId = new Map(existing.map((row) => [row.externalId, row]));

    const graph = directoryGraphOf(page);
    const wanted = new Map(
      page.groups.map((group) => [
        group.externalId,
        flattenDirectoryGroup(group.externalId, graph),
      ]),
    );
    const people = await membershipsByEmail(tx, context, [...new Set([...wanted.values()].flat())]);

    for (const group of page.groups) {
      const name = directoryTeamName(
        group.displayName,
        group.externalId,
        DIRECTORY_MAX_NAME_LENGTH,
      );
      let row = byExternalId.get(group.externalId);
      if (!row) {
        // A new team, top level and empty, then its group row, then its members: the order 0561 asks
        // for, so a directory team never holds anyone the provider did not name.
        const [team] = await tx
          .insert(teams)
          .values({ organizationId: context.organizationId, name })
          .returning({ id: teams.id });
        [row] = await tx
          .insert(directoryGroups)
          .values({
            organizationId: context.organizationId,
            connectionId,
            externalId: group.externalId,
            teamId: (team as { id: string }).id,
            displayName: name,
            seenGeneration: lease.fullSyncGeneration,
          })
          .returning();
      } else {
        if (row.displayName !== name) {
          await tx.update(teams).set({ name }).where(eq(teams.id, row.teamId));
        }
        // Written every time, because `updated_at` is when this group's members were last read from the
        // provider, and enforceDirectoryFreshness keeps only members read since the directory went stale.
        await tx
          .update(directoryGroups)
          .set({
            displayName: name,
            seenGeneration: lease.fullSyncGeneration,
            updatedAt: sql`now()`,
          })
          .where(and(ofThisConnection, eq(directoryGroups.externalId, group.externalId)));
      }
      const teamId = (row as GroupRow).teamId;

      const desired = (wanted.get(group.externalId) ?? []).flatMap((email) => {
        const id = people.get(email);
        return id ? [id] : [];
      });
      const current = await tx
        .select({ membershipId: teamMemberships.membershipId })
        .from(teamMemberships)
        .where(eq(teamMemberships.teamId, teamId));
      const { add, remove } = diffMembers(
        current.map((member) => member.membershipId),
        desired,
      );
      if (remove.length) {
        await tx
          .delete(teamMemberships)
          .where(
            and(
              eq(teamMemberships.teamId, teamId),
              inArray(teamMemberships.membershipId, [...remove]),
            ),
          );
      }
      if (add.length) {
        await tx.insert(teamMemberships).values(
          add.map((membershipId) => ({
            organizationId: context.organizationId,
            teamId,
            membershipId,
          })),
        );
      }
    }

    // Gone at the provider. Their members go first, then the team.
    await removeGroups(
      tx,
      page.deletedExternalIds.flatMap((id) => {
        const row = byExternalId.get(id);
        return row ? [row] : [];
      }),
    );

    const finishesFullSync = lease.fullSync && !page.hasMore;
    if (finishesFullSync) {
      // A completed full pass saw every group the provider has. One it did not see has gone.
      const unseen = await tx
        .select()
        .from(directoryGroups)
        .where(and(ofThisConnection, lt(directoryGroups.seenGeneration, lease.fullSyncGeneration)));
      await removeGroups(tx, unseen);
    }

    const moved = page.nextCursor !== cursor.cursor || finishesFullSync;
    const generation = cursor.generation + (moved ? 1 : 0);
    if (moved) {
      await tx
        .update(syncCursors)
        .set({
          cursor: page.nextCursor,
          generation,
          // On the directory stream the watermark is when the last full pass completed, which is what
          // directoryFreshness measures the directory's age from.
          ...(finishesFullSync ? { fullSyncInProgress: false, watermark: sql`now()` } : {}),
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(syncCursors.connectionId, connectionId), eq(syncCursors.stream, lease.stream)),
        );
    }
    return {
      stream: lease.stream,
      cursor: page.nextCursor,
      generation,
      fullSync: lease.fullSync && page.hasMore,
      fullSyncGeneration: lease.fullSyncGeneration,
    };
  });
}

/** Revoked, or no longer granted every scope the directory capability needs. */
export function directoryEntitlementEnded(connection: {
  state: string;
  connectorType: string;
  grantedScopes: readonly string[];
}): boolean {
  if (connection.state === 'revoked') return true;
  return (
    !isSuiteConnectorType(connection.connectorType) ||
    !capabilityGranted(connection.connectorType, 'directory', connection.grantedScopes)
  );
}

/**
 * Removes every team a connection's directory made, with their members and group rows, once the
 * connection may no longer have them: it was revoked, or it no longer holds every scope the directory
 * capability needs (an admin narrowed the grant at the provider, and a refresh narrowed `granted_scopes`).
 * The worker calls it in the sync's own service context, because 0561 refuses everyone else (ADR-038 D4),
 * and 0561's guards ask only for that context and the connection's own setting, not for a revoked row. A
 * connection still entitled to its directory keeps its teams, so a stray call cannot empty a live
 * directory: both conditions are read here, under the row's share lock, never taken from the caller.
 * Repeating it finds nothing to do.
 */
export async function removeConnectionDirectory(
  database: AppDatabase,
  context: TenantContext,
  input: { connectionId: string },
): Promise<{ teamsRemoved: number }> {
  requireWorker(context);
  if (!idSchema.safeParse(input.connectionId).success) throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    await asDirectoryPass(tx, input.connectionId);
    const [connection] = await tx
      .select({
        state: connections.state,
        connectorType: connections.connectorType,
        grantedScopes: connections.grantedScopes,
      })
      .from(connections)
      .where(eq(connections.id, input.connectionId))
      .for('share');
    if (!connection || !directoryEntitlementEnded(connection)) return { teamsRemoved: 0 };
    const rows = await tx
      .select()
      .from(directoryGroups)
      .where(eq(directoryGroups.connectionId, input.connectionId));
    await removeGroups(tx, rows);
    return { teamsRemoved: rows.length };
  });
}

const directoryCursorIs = (connectionId: string) =>
  and(eq(syncCursors.connectionId, connectionId), eq(syncCursors.stream, DIRECTORY_STREAM));

/**
 * The worker's service context only. Holds a directory to DIRECTORY_STALE_AFTER_MS and to its last pass
 * (ADR-038 D4). When the directory stream has not completed a full pass inside the bound, or its last pass
 * failed, the teams it made lose the members it gave them and keep their rows, so every grant naming them
 * reaches nobody at read time, with no file synced again: every read path reads team membership live.
 * Members a pass wrote after the directory went stale came from the provider since, so they stay. After a
 * failure the stream is sent back to a full pass, so the next one to complete restores every group.
 *
 * Runs after each directory pass and on the suite upkeep schedule, because a directory nobody asks to sync
 * would otherwise keep its last members for ever. Returns how many memberships it took away.
 */
export async function enforceDirectoryFreshness(
  database: AppDatabase,
  context: TenantContext,
  input: { connectionId: string },
): Promise<{ membershipsRemoved: number; restarted: boolean }> {
  requireWorker(context);
  if (!idSchema.safeParse(input.connectionId).success) throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    await asDirectoryPass(tx, input.connectionId);
    const [connection] = await tx
      .select({ state: connections.state })
      .from(connections)
      .where(eq(connections.id, input.connectionId))
      .for('share');
    // A revoked connection's teams go whole, through removeConnectionDirectory.
    if (!connection || connection.state === 'revoked') {
      return { membershipsRemoved: 0, restarted: false };
    }
    const [clock] = await tx
      .execute<{ ms: number | string }>(sql`select extract(epoch from now())::float8 * 1000 as ms`)
      .then((result) => result.rows);
    // The database's clock, which is the one every `updated_at` compared here was written by.
    const now = new Date(Number(clock?.ms));
    const [cursor] = await tx
      .select({
        cursor: syncCursors.cursor,
        generation: syncCursors.generation,
        state: syncCursors.state,
        watermark: syncCursors.watermark,
        updatedAt: syncCursors.updatedAt,
      })
      .from(syncCursors)
      .where(directoryCursorIs(input.connectionId))
      .for('update');
    const decision = cursor
      ? directoryFreshness({
          lastFullPassAt: cursor.watermark,
          state: cursor.state,
          stateAt: cursor.updatedAt,
          now,
        })
      : // Teams with no directory stream behind them were read by nothing this can vouch for.
        { fresh: false as const, emptyThrough: now, restart: false };
    if (decision.fresh) return { membershipsRemoved: 0, restarted: false };

    // Times reach here cut to the millisecond, so one is added back: a group written in the same
    // millisecond as the failure, and before it, still loses its members.
    const through = new Date(decision.emptyThrough.getTime() + 1);
    const staleTeams = tx
      .select({ teamId: directoryGroups.teamId })
      .from(directoryGroups)
      .where(
        and(
          eq(directoryGroups.connectionId, input.connectionId),
          lt(directoryGroups.updatedAt, through),
        ),
      );
    const removed = await tx
      .delete(teamMemberships)
      .where(inArray(teamMemberships.teamId, staleTeams))
      .returning({ teamId: teamMemberships.teamId });

    // Once per failure: a cursor already sent back to the start has a full pass owed. A failed stream
    // holds no lease, so moving its generation fences only a pass whose lease had already run out. The
    // error code stays, so the connection still says why until a pass succeeds.
    const restarted = Boolean(cursor && decision.restart && cursor.cursor !== null);
    if (restarted && cursor) {
      await tx
        .update(syncCursors)
        .set({
          state: 'resync_required',
          cursor: null,
          fullSyncInProgress: false,
          generation: cursor.generation + 1,
          leaseUntil: null,
          updatedAt: sql`now()`,
        })
        .where(directoryCursorIs(input.connectionId));
    }
    return { membershipsRemoved: removed.length, restarted };
  });
}

/** The worker's service context only. Every connection in this tenant that has directory teams. */
export async function listDirectoryConnections(
  database: AppDatabase,
  context: TenantContext,
): Promise<string[]> {
  requireWorker(context);
  const rows = await withTenantTx(database, context, (tx) =>
    tx.selectDistinct({ connectionId: directoryGroups.connectionId }).from(directoryGroups),
  );
  return rows.map((row) => row.connectionId);
}
