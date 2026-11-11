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
  DIRECTORY_MAX_NAME_LENGTH,
  DIRECTORY_STREAM,
  DIRECTORY_SYNC_SETTING,
  isValidDirectoryPage,
  type DirectoryPage,
} from '@ensemus/domain/workspace-suites';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  diffMembers,
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
      } else if (row.displayName !== name || row.seenGeneration !== lease.fullSyncGeneration) {
        if (row.displayName !== name) {
          await tx.update(teams).set({ name }).where(eq(teams.id, row.teamId));
        }
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
          ...(finishesFullSync ? { fullSyncInProgress: false } : {}),
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

/**
 * Removes every team a revoked connection's directory made, with their members and group rows. The
 * worker's revoke cleanup calls it after the revoke has committed: the revoke already stopped the
 * connection's resources being served, and this takes away the teams, in the sync's own service context
 * because 0561 refuses everyone else (ADR-038 D4). A connection that is not revoked keeps its teams, so a
 * stray call cannot empty a live directory. Repeating it finds nothing to do.
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
      .select({ state: connections.state })
      .from(connections)
      .where(eq(connections.id, input.connectionId))
      .for('share');
    if (connection?.state !== 'revoked') return { teamsRemoved: 0 };
    const rows = await tx
      .select()
      .from(directoryGroups)
      .where(eq(directoryGroups.connectionId, input.connectionId));
    await removeGroups(tx, rows);
    return { teamsRemoved: rows.length };
  });
}
