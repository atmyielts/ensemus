// Directory sync (CONNECT-08, ADR-038 D4) against the real database and the 0561 guards: a provider group
// becomes a team only the directory pass can change, a Drive group grant reaches that team, and the team
// follows the provider. The provider is an in-memory fake of the Directory and Drive APIs. Generated values
// only. Written, not yet run.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commitDirectoryPage,
  commitSyncPage,
  finishSyncStream,
  leaseSyncStream,
  pgCode,
  removeConnectionDirectory,
  resolveSourcePrincipal,
  revokeConnection,
  type SyncStreamLease,
} from '@ensemus/application';
import {
  connections,
  createOrganization,
  directoryGroups,
  externalResourceAcl,
  externalResources,
  openAppDatabase,
  resolveTenantContext,
  teamMemberships,
  teams,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  createGoogleWorkspaceConnector,
  type GoogleWorkspaceConfig,
} from '@ensemus/connectors/google';
import type { ConnectorContext, SyncPage } from '@ensemus/connectors';
import type { ProviderHttpClient, ProviderResponse } from '@ensemus/connectors/knowledge';
import { mapSourceGrants } from '@ensemus/connectors/runtime';
import { DIRECTORY_STREAM, DIRECTORY_SYNC_SETTING } from '@ensemus/domain/workspace-suites';
import { and, eq, sql } from 'drizzle-orm';
import { seedMember } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
];
const LEASE_MS = 60_000;

type FakeMember = { email: string; type: 'USER' | 'GROUP' };
type FakeWorkspace = {
  groups: Map<string, { name: string; members: FakeMember[] }>;
  /** The one Drive file's permissions. */
  permissions: unknown[];
  driveReads: number;
};

const json = (body: unknown, status = 200): ProviderResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});

/** Directory API and Drive v3, one group per groups.list page so a pass spans pages. */
function fakeHttp(workspace: FakeWorkspace): ProviderHttpClient {
  return {
    request: async (request) => {
      if (request.route === 'google_oauth')
        return json({ access_token: 'generated-access', token_type: 'Bearer', expires_in: 3600 });
      const url = new URL(`https://fake.invalid${request.path}`);
      if (url.pathname === '/admin/directory/v1/groups') {
        const all = [...workspace.groups.keys()].sort();
        const start = Number(url.searchParams.get('pageToken') ?? 0);
        return json({
          groups: all
            .slice(start, start + 1)
            .map((email) => ({ email, name: workspace.groups.get(email)!.name })),
          ...(start + 1 < all.length ? { nextPageToken: String(start + 1) } : {}),
        });
      }
      const group = /^\/admin\/directory\/v1\/groups\/([^/]+)(\/members)?$/.exec(url.pathname);
      if (group) {
        const found = workspace.groups.get(decodeURIComponent(group[1]!));
        if (!found) return json({}, 404);
        return group[2]
          ? json({ members: found.members })
          : json({ email: decodeURIComponent(group[1]!), name: found.name });
      }
      workspace.driveReads += 1;
      if (url.pathname === '/drive/v3/changes/startPageToken')
        return json({ startPageToken: 'generated_start' });
      if (url.pathname === '/drive/v3/files')
        return json({
          files: [{ id: 'generated_file', name: 'Ledger', mimeType: 'text/plain', version: '1' }],
        });
      if (url.pathname.endsWith('/permissions'))
        return json({ permissions: workspace.permissions });
      return json({}, 404);
    },
  };
}

describe('directory sync', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  const db = () => app.db;

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });
  afterAll(async () => {
    await auth.end();
    await app.close();
  });

  /** A tenant with an owner, two members, a Google connection and a fake Workspace. */
  async function tenant(label: string) {
    const ownerId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      ownerId,
      `${label} owner`,
      `owner-${ownerId}@example.invalid`,
    ]);
    const { organizationId } = await createOrganization(db(), {
      userId: ownerId,
      name: label,
      commercialMode: 'byom',
    });
    const owner = await resolveTenantContext(db(), ownerId, organizationId);
    const service = createServiceContext(organizationId);
    const person = async () => {
      const { userId, membershipId } = await seedMember(db(), owner, auth);
      return {
        userId,
        membershipId,
        email: `person-${userId}@example.invalid`,
        context: () => resolveTenantContext(db(), userId, organizationId),
      };
    };
    const alex = await person();
    const sam = await person();
    const connectionId = randomUUID();
    await withTenantTx(db(), owner, (tx) =>
      tx.insert(connections).values({
        organizationId,
        id: connectionId,
        connectorType: 'google_workspace',
        displayName: 'Generated Workspace',
        grantedScopes: SCOPES,
      }),
    );
    const workspace: FakeWorkspace = { groups: new Map(), permissions: [], driveReads: 0 };
    const connector = createGoogleWorkspaceConnector({ http: fakeHttp(workspace) });
    const context: ConnectorContext<GoogleWorkspaceConfig> = {
      organizationId,
      connectionId,
      config: { driveIds: [] },
      grantedScopes: SCOPES,
      signal: AbortSignal.timeout(30_000),
      network: {
        openRelay: async () => {
          throw new Error('NO_TEST_NETWORK');
        },
      },
      credentials: {
        withCredential: async (use) =>
          use(
            Buffer.from(
              JSON.stringify({
                client_id: 'generated',
                client_secret: 'generated-secret',
                refresh_token: 'generated-refresh',
              }),
            ),
          ),
      },
    };

    /**
     * The worker's directory pass: a fresh start asks for a full pass, then pages commit with the cursor.
     * `stopAfter` ends the pass early, as running out of time would.
     */
    async function directoryPass(options: { stopAfter?: number } = {}) {
      let lease = await leaseSyncStream(db(), service, {
        connectionId,
        stream: DIRECTORY_STREAM,
        leaseMs: LEASE_MS,
      });
      if (!lease) throw new Error('MISSING_TEST_LEASE');
      if (lease.cursor === null && !lease.fullSync) {
        await finishSyncStream(db(), service, {
          connectionId,
          stream: DIRECTORY_STREAM,
          outcome: { resyncRequired: true },
        });
        lease = await leaseSyncStream(db(), service, {
          connectionId,
          stream: DIRECTORY_STREAM,
          leaseMs: LEASE_MS,
        });
        if (!lease) throw new Error('MISSING_TEST_LEASE');
      }
      for (let read = 0; read < (options.stopAfter ?? 100); read += 1) {
        const page = await connector.directory.readGroups(context, lease.cursor);
        const next: SyncStreamLease | null = await commitDirectoryPage(db(), service, {
          connectionId,
          lease,
          page,
        });
        if (!next) throw new Error('LOST_TEST_LEASE');
        lease = next;
        if (!page.hasMore) break;
      }
      await finishSyncStream(db(), service, {
        connectionId,
        stream: DIRECTORY_STREAM,
        outcome: { ok: true },
      });
    }

    /** The worker's Drive pass, mapping grants through this connection's directory. */
    async function drivePass() {
      const lease = await leaseSyncStream(db(), service, {
        connectionId,
        stream: 'drive_files',
        leaseMs: LEASE_MS,
      });
      if (!lease) throw new Error('MISSING_TEST_LEASE');
      const page: SyncPage = await connector.sync!.readPage(context, {
        stream: 'drive_files',
        cursor: lease.cursor,
        fullSync: lease.fullSync,
        pageSize: 100,
      });
      const mappedGrants = await Promise.all(
        page.resources.map((resource) =>
          mapSourceGrants(resource.acl, {
            resolve: (principal) =>
              resolveSourcePrincipal(db(), service, principal, { connectionId }),
          }),
        ),
      );
      const next = await commitSyncPage(db(), service, {
        connectionId,
        lease,
        page: { ...page, mappedGrants },
      });
      if (!next) throw new Error('LOST_TEST_LEASE');
      await finishSyncStream(db(), service, {
        connectionId,
        stream: 'drive_files',
        outcome: { ok: true },
      });
    }

    const teamOf = async (externalId: string) => {
      const [row] = await withTenantTx(db(), service, (tx) =>
        tx
          .select({ teamId: directoryGroups.teamId, displayName: directoryGroups.displayName })
          .from(directoryGroups)
          .where(
            and(
              eq(directoryGroups.connectionId, connectionId),
              eq(directoryGroups.externalId, externalId),
            ),
          ),
      );
      return row ?? null;
    };
    const membersOf = async (teamId: string) =>
      (
        await withTenantTx(db(), service, (tx) =>
          tx
            .select({ membershipId: teamMemberships.membershipId })
            .from(teamMemberships)
            .where(eq(teamMemberships.teamId, teamId)),
        )
      )
        .map((row) => row.membershipId)
        .sort();
    /** Who the file's ACL lets read it: named people, and the people in each team it names. */
    const readers = async () =>
      (
        await withTenantTx(db(), service, (tx) =>
          tx.execute<{ membership_id: string }>(sql`
            select a.membership_id from integrations.external_resource_acl a
              join integrations.external_resources r
                on r.organization_id = a.organization_id and r.id = a.resource_id
             where r.connection_id = ${connectionId} and a.membership_id is not null
            union
            select tm.membership_id from integrations.external_resource_acl a
              join integrations.external_resources r
                on r.organization_id = a.organization_id and r.id = a.resource_id
              join org.team_memberships tm
                on tm.organization_id = a.organization_id and tm.team_id = a.team_id
             where r.connection_id = ${connectionId}`),
        )
      ).rows
        .map((row) => row.membership_id)
        .sort();

    return {
      organizationId,
      owner,
      service,
      alex,
      sam,
      connectionId,
      workspace,
      directoryPass,
      drivePass,
      teamOf,
      membersOf,
      readers,
    };
  }

  it('resolves a Drive group grant to the group team, and follows the provider without re-reading the file', async () => {
    const t = await tenant('Directory grants');
    t.workspace.groups.set('finance@example.invalid', {
      name: 'Finance',
      members: [
        { email: t.alex.email.toUpperCase(), type: 'USER' },
        { email: 'nobody-here@example.invalid', type: 'USER' },
      ],
    });
    t.workspace.permissions = [
      {
        id: 'generated_permission',
        type: 'group',
        emailAddress: 'Finance@Example.invalid',
        role: 'reader',
      },
    ];
    await t.directoryPass();
    const finance = await t.teamOf('finance@example.invalid');
    expect(finance).toMatchObject({ displayName: 'Finance' });
    expect(await t.membersOf(finance!.teamId)).toEqual([t.alex.membershipId]);

    await t.drivePass();
    const [grant] = await withTenantTx(db(), t.service, (tx) =>
      tx
        .select({ teamId: externalResourceAcl.teamId, kind: externalResourceAcl.principalKind })
        .from(externalResourceAcl)
        .innerJoin(externalResources, eq(externalResources.id, externalResourceAcl.resourceId))
        .where(eq(externalResources.connectionId, t.connectionId)),
    );
    expect(grant).toEqual({ teamId: finance!.teamId, kind: 'group' });
    expect(await t.readers()).toEqual([t.alex.membershipId]);

    // Alex leaves the group and Sam joins. Only the directory runs: the file is not read again.
    t.workspace.groups.get('finance@example.invalid')!.members = [
      { email: t.sam.email, type: 'USER' },
    ];
    const driveReads = t.workspace.driveReads;
    await t.directoryPass();
    expect(t.workspace.driveReads).toBe(driveReads);
    expect(await t.readers()).toEqual([t.sam.membershipId]);

    // Without its connection, or from another connection, a group finds nobody.
    expect(
      await resolveSourcePrincipal(db(), t.service, {
        kind: 'group',
        externalId: 'finance@example.invalid',
      }),
    ).toBeNull();
    expect(
      await resolveSourcePrincipal(
        db(),
        t.service,
        { kind: 'group', externalId: 'finance@example.invalid' },
        { connectionId: randomUUID() },
      ),
    ).toBeNull();
  });

  it('flattens nested groups five levels down and cuts cycles', async () => {
    const t = await tenant('Directory nesting');
    // A cycle: each holds the other, so each team holds both people.
    t.workspace.groups.set('cycle-a@example.invalid', {
      name: 'Cycle A',
      members: [
        { email: t.alex.email, type: 'USER' },
        { email: 'cycle-b@example.invalid', type: 'GROUP' },
      ],
    });
    t.workspace.groups.set('cycle-b@example.invalid', {
      name: 'Cycle B',
      members: [
        { email: t.sam.email, type: 'USER' },
        { email: 'cycle-a@example.invalid', type: 'GROUP' },
      ],
    });
    // A chain six deep: Alex five levels under the top counts, Sam six levels under does not.
    for (let depth = 0; depth <= 6; depth += 1) {
      const members: FakeMember[] =
        depth < 6 ? [{ email: `chain-${depth + 1}@example.invalid`, type: 'GROUP' }] : [];
      if (depth === 5) members.push({ email: t.alex.email, type: 'USER' });
      if (depth === 6) members.push({ email: t.sam.email, type: 'USER' });
      t.workspace.groups.set(`chain-${depth}@example.invalid`, { name: `Chain ${depth}`, members });
    }
    await t.directoryPass();

    const both = [t.alex.membershipId, t.sam.membershipId].sort();
    expect(await t.membersOf((await t.teamOf('cycle-a@example.invalid'))!.teamId)).toEqual(both);
    expect(await t.membersOf((await t.teamOf('cycle-b@example.invalid'))!.teamId)).toEqual(both);
    expect(await t.membersOf((await t.teamOf('chain-0@example.invalid'))!.teamId)).toEqual([
      t.alex.membershipId,
    ]);
    expect(await t.membersOf((await t.teamOf('chain-1@example.invalid'))!.teamId)).toEqual(both);

    // Breaking the cycle at the provider takes Sam out of Cycle A at the next pass.
    t.workspace.groups.get('cycle-a@example.invalid')!.members = [
      { email: t.alex.email, type: 'USER' },
    ];
    await t.directoryPass();
    expect(await t.membersOf((await t.teamOf('cycle-a@example.invalid'))!.teamId)).toEqual([
      t.alex.membershipId,
    ]);
  });

  it('refuses anyone but the directory pass changing a directory team (EN123)', async () => {
    const t = await tenant('Directory guard');
    t.workspace.groups.set('finance@example.invalid', {
      name: 'Finance',
      members: [{ email: t.alex.email, type: 'USER' }],
    });
    await t.directoryPass();
    const { teamId } = (await t.teamOf('finance@example.invalid'))!;
    const refusal = (promise: Promise<unknown>) =>
      promise.then(
        () => 'allowed',
        (error: unknown) => pgCode(error) ?? (error as { code?: string }).code ?? 'unknown',
      );
    const addSam = (context: TenantContext, setting: string | null) =>
      withTenantTx(db(), context, async (tx) => {
        if (setting !== null)
          await tx.execute(sql`select set_config(${DIRECTORY_SYNC_SETTING}, ${setting}, true)`);
        await tx.insert(teamMemberships).values({
          organizationId: t.organizationId,
          teamId,
          membershipId: t.sam.membershipId,
        });
      });

    // A member adding themselves, with or without naming the connection.
    const sam = await t.sam.context();
    expect(await refusal(addSam(sam, null))).toBe('EN123');
    expect(await refusal(addSam(sam, t.connectionId))).toBe('EN123');
    // The owner, a web and interactive context, even naming the connection: the setting proves nothing.
    expect(await refusal(addSam(t.owner, t.connectionId))).toBe('EN123');
    expect(
      await refusal(
        withTenantTx(db(), t.owner, async (tx) => {
          await tx.execute(
            sql`select set_config(${DIRECTORY_SYNC_SETTING}, ${t.connectionId}, true)`,
          );
          await tx.update(teams).set({ name: 'Renamed' }).where(eq(teams.id, teamId));
        }),
      ),
    ).toBe('EN123');
    expect(
      await refusal(
        withTenantTx(db(), t.owner, (tx) =>
          tx.delete(teamMemberships).where(eq(teamMemberships.teamId, teamId)),
        ),
      ),
    ).toBe('EN123');
    // A worker without the setting, or naming another connection.
    expect(await refusal(addSam(t.service, null))).toBe('EN123');
    expect(await refusal(addSam(t.service, randomUUID()))).toBe('EN123');

    expect(await t.membersOf(teamId)).toEqual([t.alex.membershipId]);
  });

  it('keeps one tenant out of another tenant directory', async () => {
    const a = await tenant('Directory tenant A');
    const b = await tenant('Directory tenant B');
    a.workspace.groups.set('finance@example.invalid', {
      name: 'Finance',
      members: [{ email: a.alex.email, type: 'USER' }],
    });
    await a.directoryPass();
    const { teamId } = (await a.teamOf('finance@example.invalid'))!;

    // B's worker naming A's connection finds no group and removes nothing.
    expect(
      await resolveSourcePrincipal(
        db(),
        b.service,
        { kind: 'group', externalId: 'finance@example.invalid' },
        { connectionId: a.connectionId },
      ),
    ).toBeNull();
    expect(
      await removeConnectionDirectory(db(), b.service, { connectionId: a.connectionId }),
    ).toEqual({ teamsRemoved: 0 });
    // B's pass cannot commit against A's connection: its lease never finds the row.
    await expect(
      leaseSyncStream(db(), b.service, {
        connectionId: a.connectionId,
        stream: DIRECTORY_STREAM,
        leaseMs: LEASE_MS,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await a.membersOf(teamId)).toEqual([a.alex.membershipId]);
  });

  it('removes the teams of a revoked connection, and nothing for a live one', async () => {
    const t = await tenant('Directory revoke');
    t.workspace.groups.set('finance@example.invalid', {
      name: 'Finance',
      members: [{ email: t.alex.email, type: 'USER' }],
    });
    t.workspace.permissions = [
      {
        id: 'generated_permission',
        type: 'group',
        emailAddress: 'finance@example.invalid',
        role: 'reader',
      },
    ];
    await t.directoryPass();
    await t.drivePass();
    const { teamId } = (await t.teamOf('finance@example.invalid'))!;

    expect(
      await removeConnectionDirectory(db(), t.service, { connectionId: t.connectionId }),
    ).toEqual({ teamsRemoved: 0 });
    expect(await t.membersOf(teamId)).toEqual([t.alex.membershipId]);

    await revokeConnection(db(), t.owner, { connectionId: t.connectionId, expectedVersion: 1 });
    expect(
      await removeConnectionDirectory(db(), t.service, { connectionId: t.connectionId }),
    ).toEqual({ teamsRemoved: 1 });
    expect(await t.teamOf('finance@example.invalid')).toBeNull();
    expect(
      await withTenantTx(db(), t.service, (tx) =>
        tx.select().from(teams).where(eq(teams.id, teamId)),
      ),
    ).toEqual([]);
    expect(await t.readers()).toEqual([]);
    // Doing it again finds nothing.
    expect(
      await removeConnectionDirectory(db(), t.service, { connectionId: t.connectionId }),
    ).toEqual({ teamsRemoved: 0 });
  });

  it('changes nothing for a pass that does not finish, and removes a gone group once one does', async () => {
    const t = await tenant('Directory incomplete');
    // One group per page, so the pass after the deletion still spans two pages.
    for (const name of ['a-first', 'b-second', 'c-third']) {
      t.workspace.groups.set(`${name}@example.invalid`, {
        name,
        members: [{ email: t.alex.email, type: 'USER' }],
      });
    }
    await t.directoryPass();
    const second = (await t.teamOf('b-second@example.invalid'))!;

    // The second group goes at the provider, and the next pass stops after its first page.
    t.workspace.groups.delete('b-second@example.invalid');
    t.workspace.groups.get('a-first@example.invalid')!.members.push({
      email: t.sam.email,
      type: 'USER',
    });
    await t.directoryPass({ stopAfter: 1 });
    expect(await t.teamOf('b-second@example.invalid')).toEqual(second);
    expect(await t.membersOf(second.teamId)).toEqual([t.alex.membershipId]);

    // A page whose lease has moved on writes nothing at all.
    const stale: SyncStreamLease = {
      stream: DIRECTORY_STREAM,
      cursor: null,
      generation: 0,
      fullSync: true,
      fullSyncGeneration: 0,
    };
    expect(
      await commitDirectoryPage(db(), t.service, {
        connectionId: t.connectionId,
        lease: stale,
        page: {
          groups: [
            {
              externalId: 'b-second@example.invalid',
              displayName: 'b-second',
              members: [{ kind: 'user', externalId: t.sam.email }],
            },
          ],
          deletedExternalIds: [],
          nextCursor: null,
          hasMore: false,
          fullSync: true,
        },
      }),
    ).toBeNull();
    expect(await t.membersOf(second.teamId)).toEqual([t.alex.membershipId]);

    // The same full pass carries on from its cursor and finishes: the gone group loses its team.
    await t.directoryPass();
    expect(await t.teamOf('b-second@example.invalid')).toBeNull();
    const first = (await t.teamOf('a-first@example.invalid'))!;
    expect(await t.membersOf(first.teamId)).toEqual(
      [t.alex.membershipId, t.sam.membershipId].sort(),
    );
  });
});
