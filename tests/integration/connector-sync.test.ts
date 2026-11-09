// CONNECT-01's acceptance: incremental sync is idempotent and source ACLs are mapped, on real roles and
// RLS, with two tenants using the same external IDs. A connector can never read another tenant's cursor
// or credentials. Scripted sources and generated values: no provider has been used.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  acceptInvitation,
  commitSyncPage,
  createConnection,
  createInvitation,
  finishSyncStream,
  leaseSyncStream,
  resolveSourcePrincipal,
  revokeConnection,
  type MappedSyncPage,
} from '@ensemus/application';
import {
  connections,
  createOrganization,
  externalResourceAcl,
  externalResources,
  openAppDatabase,
  resolveTenantContext,
  syncCursors,
  webhookEndpoints,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import {
  SECRET_PURPOSE_CONNECTOR_CREDENTIAL,
  SECRET_PURPOSE_WEBHOOK_SIGNING,
  type SourceGrant,
  type SyncPage,
  type SyncedResource,
} from '@ensemus/domain/connector';
import {
  CursorExpired,
  type Connector,
  type ConnectorContext,
  type ConnectorRegistry,
  type CredentialLease,
} from '@ensemus/connectors';
import { createConnectorRegistry, mapSourceGrants, runSyncPass } from '@ensemus/connectors/runtime';
import { createFakeConnector } from '@ensemus/connectors/testing';
import { FileKeyProvider, SecretBroker } from '@ensemus/secrets/broker';
import { storeSecret } from '@ensemus/secrets/seal';
import { createConnectorSyncActivities } from '@ensemus/workflows/connector-sync-activities';
import type { ConnectorActivityDeps } from '@ensemus/workflows/connector-deps';
import { eq, sql } from 'drizzle-orm';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { secret, urls } from '../helpers/stack';

const code = (name: string) => expect.objectContaining({ code: name });
const STREAM = 'files';
const LEASE_MS = 60_000;
const CANARY = `CANARY-${randomUUID()}`;

const resource = (externalId: string, overrides: Partial<SyncedResource> = {}): SyncedResource => ({
  externalId,
  resourceType: STREAM,
  externalVersion: '1',
  displayName: externalId,
  acl: [],
  ...overrides,
});

const page = (resources: SyncedResource[], overrides: Partial<SyncPage> = {}): SyncPage => ({
  resources,
  deletedExternalIds: [],
  nextCursor: 'cursor-1',
  hasMore: false,
  ...overrides,
});

describe('connector sync', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let secretsDb: ReturnType<typeof openSecretsDatabase>;
  let auth: pg.Client;
  let broker: SecretBroker;
  let ownerA: TenantContext;
  let ownerB: TenantContext;
  let serviceA: TenantContext;
  let serviceB: TenantContext;
  let member: { email: string; membershipId: string };
  const db = () => app.db;
  const publicKeyPem = secret('sealing_public_key.pem');

  async function makeUser(label: string) {
    const id = randomUUID();
    const email = `${label}-${id}@example.invalid`;
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      email,
    ]);
    return { id, email };
  }

  async function newOrg(label: string) {
    const user = await makeUser(`${label}-owner`);
    const { organizationId } = await createOrganization(db(), {
      userId: user.id,
      name: label,
      commercialMode: 'byom',
    });
    return resolveTenantContext(db(), user.id, organizationId);
  }

  async function join(context: TenantContext, user: { id: string; email: string }) {
    const { token } = await createInvitation(db(), context, { email: user.email, role: 'member' });
    await auth.query('update identity.users set email_verified=true where id=$1', [user.id]);
    await acceptInvitation(db(), {
      token,
      userId: user.id,
      email: user.email,
      emailVerified: true,
    });
    return resolveTenantContext(db(), user.id, context.organizationId);
  }

  /** The fake's type is not one we ship, so the test names it as the caller's manifest. */
  async function newConnection(context: TenantContext, credentialSecretId: string | null = null) {
    const view = await createConnection(db(), context, {
      connectorType: 'fake_connector',
      displayName: 'Fake source',
      config: {},
      credentialSecretId,
      manifests: [
        { type: 'fake_connector', credential: { required: credentialSecretId !== null } },
      ],
    });
    return view.id;
  }

  /** Maps with the real directory, as the worker does, and commits. */
  async function commit(
    context: TenantContext,
    connectionId: string,
    lease: NonNullable<Awaited<ReturnType<typeof leaseSyncStream>>>,
    source: SyncPage,
  ) {
    const mappedGrants = [];
    for (const item of source.resources) {
      mappedGrants.push(
        await mapSourceGrants(item.acl, {
          resolve: (principal) => resolveSourcePrincipal(db(), context, principal),
        }),
      );
    }
    const mapped: MappedSyncPage = { ...source, mappedGrants };
    return commitSyncPage(db(), context, { connectionId, lease, page: mapped });
  }

  async function takeLease(context: TenantContext, connectionId: string, stream = STREAM) {
    const lease = await leaseSyncStream(db(), context, {
      connectionId,
      stream,
      leaseMs: LEASE_MS,
    });
    if (!lease) throw new Error('The test expected to get this lease');
    return lease;
  }

  const finish = (context: TenantContext, connectionId: string, stream = STREAM) =>
    finishSyncStream(db(), context, { connectionId, stream, outcome: { ok: true } });

  /** A commit with its lease taken and let go, as one short pass does. */
  async function applyPage(context: TenantContext, connectionId: string, source: SyncPage) {
    const lease = await takeLease(context, connectionId);
    const next = await commit(context, connectionId, lease, source);
    await finish(context, connectionId);
    return next;
  }

  const snapshot = (context: TenantContext, connectionId: string) =>
    withTenantTx(db(), context, async (tx) => ({
      resources: await tx
        .select()
        .from(externalResources)
        .where(eq(externalResources.connectionId, connectionId))
        .orderBy(externalResources.externalId),
      grants: await tx
        .select({
          resourceId: externalResourceAcl.resourceId,
          principalKind: externalResourceAcl.principalKind,
          principalExternalId: externalResourceAcl.principalExternalId,
          access: externalResourceAcl.access,
          membershipId: externalResourceAcl.membershipId,
          teamId: externalResourceAcl.teamId,
          updatedAt: externalResourceAcl.updatedAt,
        })
        .from(externalResourceAcl)
        .innerJoin(externalResources, eq(externalResources.id, externalResourceAcl.resourceId))
        .where(eq(externalResources.connectionId, connectionId))
        .orderBy(externalResourceAcl.principalExternalId),
    }));

  const cursorRow = async (context: TenantContext, connectionId: string, stream = STREAM) => {
    const [row] = await withTenantTx(db(), context, (tx) =>
      tx
        .select()
        .from(syncCursors)
        .where(
          sql`${syncCursors.connectionId} = ${connectionId} and ${syncCursors.stream} = ${stream}`,
        ),
    );
    return row;
  };

  const resourceRow = async (context: TenantContext, connectionId: string, externalId: string) =>
    (await snapshot(context, connectionId)).resources.find((r) => r.externalId === externalId);

  const userGrant = (email: string, access: SourceGrant['access'] = 'read'): SourceGrant => ({
    principalKind: 'user',
    principalExternalId: email,
    access,
  });

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    secretsDb = openSecretsDatabase(urls.secrets());
    broker = new SecretBroker(
      secretsDb.db,
      new FileKeyProvider([secret('sealing_private_key.pem')]),
    );
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    ownerA = await newOrg('a');
    ownerB = await newOrg('b');
    serviceA = createServiceContext(ownerA.organizationId);
    serviceB = createServiceContext(ownerB.organizationId);
    const user = await makeUser('person');
    const joined = await join(ownerA, user);
    member = { email: user.email, membershipId: joined.membershipId };
  });

  afterAll(async () => {
    await app?.close();
    await secretsDb?.close();
    await auth?.end();
  });

  describe('bounded composite cursors', () => {
    const compositeCursor = 'x'.repeat(16_384);

    it.each([
      ['google_workspace', 'drive_files'],
      ['microsoft_365', 'drive_items'],
    ])('persists a composite cursor for the stored %s connector', async (connectorType, stream) => {
      const connection = await createConnection(db(), ownerA, {
        connectorType,
        displayName: 'Generated composite cursor source',
        config: {},
        credentialSecretId: null,
        manifests: [{ type: connectorType, credential: { required: false } }],
      });
      const lease = await takeLease(serviceA, connection.id, stream);
      const next = await commit(
        serviceA,
        connection.id,
        lease,
        page([], {
          nextCursor: compositeCursor,
        }),
      );
      expect(next?.cursor).toBe(compositeCursor);
      expect((await cursorRow(serviceA, connection.id, stream))?.cursor).toBe(compositeCursor);
    });

    it('refuses a larger cursor from another connector even when it names a Drive stream', async () => {
      const connectionId = await newConnection(ownerA);
      const lease = await takeLease(serviceA, connectionId, 'drive_files');
      const before = await cursorRow(serviceA, connectionId, 'drive_files');
      await expect(
        commit(
          serviceA,
          connectionId,
          lease,
          page([resource('must-not-commit')], {
            nextCursor: compositeCursor,
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await cursorRow(serviceA, connectionId, 'drive_files')).toEqual(before);
      expect((await snapshot(serviceA, connectionId)).resources).toHaveLength(0);
    });
  });

  describe('idempotent pages', () => {
    it('leaves every row and updated_at alone when the same page is applied twice', async () => {
      const connectionId = await newConnection(ownerA);
      const source = page([
        resource('one', { acl: [userGrant(member.email), userGrant('nobody@example.invalid')] }),
        resource('two'),
      ]);
      const first = await applyPage(serviceA, connectionId, source);
      const before = await snapshot(serviceA, connectionId);
      const cursorBefore = await cursorRow(serviceA, connectionId);
      expect(before.resources).toHaveLength(2);
      expect(before.grants).toHaveLength(2);

      // Long enough that a write would show in a timestamp.
      await new Promise((done) => setTimeout(done, 20));
      const lease = await takeLease(serviceA, connectionId);
      const second = await commit(serviceA, connectionId, lease, source);

      expect(await snapshot(serviceA, connectionId)).toEqual(before);
      const cursorAfter = await cursorRow(serviceA, connectionId);
      expect(cursorAfter?.cursor).toBe(cursorBefore?.cursor);
      expect(cursorAfter?.generation).toBe(cursorBefore?.generation);
      expect(second).toMatchObject({ generation: first?.generation, cursor: 'cursor-1' });
    });

    it('changes a resource when its version does', async () => {
      const connectionId = await newConnection(ownerA);
      await applyPage(serviceA, connectionId, page([resource('one')]));
      const before = await resourceRow(serviceA, connectionId, 'one');
      await new Promise((done) => setTimeout(done, 20));
      await applyPage(
        serviceA,
        connectionId,
        page([resource('one', { externalVersion: '2', displayName: 'Renamed' })], {
          nextCursor: 'cursor-2',
        }),
      );
      const after = await resourceRow(serviceA, connectionId, 'one');
      expect(after).toMatchObject({ externalVersion: '2', displayName: 'Renamed' });
      expect(after?.id).toBe(before?.id);
      expect(after?.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
    });

    it('leaves fields alone at a version already stored', async () => {
      const connectionId = await newConnection(ownerA);
      await applyPage(serviceA, connectionId, page([resource('one')]));
      await applyPage(
        serviceA,
        connectionId,
        page([resource('one', { displayName: 'Same version, other name' })], {
          nextCursor: 'cursor-2',
        }),
      );
      expect((await resourceRow(serviceA, connectionId, 'one'))?.displayName).toBe('one');
    });

    it('compares the fields when a source has no versions', async () => {
      const connectionId = await newConnection(ownerA);
      const unversioned = resource('one', { externalVersion: null });
      await applyPage(serviceA, connectionId, page([unversioned]));
      const before = await resourceRow(serviceA, connectionId, 'one');
      await applyPage(serviceA, connectionId, page([unversioned], { nextCursor: 'cursor-2' }));
      expect(await resourceRow(serviceA, connectionId, 'one')).toEqual(before);
      await applyPage(
        serviceA,
        connectionId,
        page([{ ...unversioned, displayName: 'Changed' }], { nextCursor: 'cursor-3' }),
      );
      expect((await resourceRow(serviceA, connectionId, 'one'))?.displayName).toBe('Changed');
    });

    it('marks what a page says has gone, once, and that grants nothing', async () => {
      const connectionId = await newConnection(ownerA);
      await applyPage(
        serviceA,
        connectionId,
        page([resource('one', { acl: [userGrant(member.email)] })]),
      );
      const gone = page([], { deletedExternalIds: ['one'], nextCursor: 'cursor-2' });
      await applyPage(serviceA, connectionId, gone);
      const once = await snapshot(serviceA, connectionId);
      expect(once.resources[0]).toMatchObject({ aclState: 'unmapped' });
      expect(once.resources[0]?.deletedAt).toBeInstanceOf(Date);
      expect(once.grants).toEqual([]);

      await new Promise((done) => setTimeout(done, 20));
      await applyPage(serviceA, connectionId, gone);
      expect(await snapshot(serviceA, connectionId)).toEqual(once);
    });

    it('brings back a resource that returns', async () => {
      const connectionId = await newConnection(ownerA);
      await applyPage(serviceA, connectionId, page([resource('one')]));
      await applyPage(
        serviceA,
        connectionId,
        page([], { deletedExternalIds: ['one'], nextCursor: 'cursor-2' }),
      );
      await applyPage(serviceA, connectionId, page([resource('one')], { nextCursor: 'cursor-3' }));
      expect((await resourceRow(serviceA, connectionId, 'one'))?.deletedAt).toBeNull();
    });
  });

  describe('compare-and-swap', () => {
    it('returns null on a lost race, and nothing partial commits', async () => {
      const connectionId = await newConnection(ownerA);
      const stale = await takeLease(serviceA, connectionId);
      const winner = await commit(serviceA, connectionId, stale, page([resource('winner')]));
      expect(winner).not.toBeNull();
      const before = await snapshot(serviceA, connectionId);
      const beforeCursor = await cursorRow(serviceA, connectionId);

      await expect(
        commit(
          serviceA,
          connectionId,
          stale,
          page([resource('loser'), resource('winner', { externalVersion: '2' })], {
            nextCursor: 'cursor-loser',
          }),
        ),
      ).resolves.toBeNull();

      expect(await snapshot(serviceA, connectionId)).toEqual(before);
      expect(await cursorRow(serviceA, connectionId)).toEqual(beforeCursor);
    });

    it('lets exactly one of two writers with the same lease win', async () => {
      const connectionId = await newConnection(ownerA);
      const lease = await takeLease(serviceA, connectionId);
      const results = await Promise.all(
        ['left', 'right'].map((name) =>
          commit(serviceA, connectionId, lease, page([resource(name)], { nextCursor: name })),
        ),
      );
      expect(results.filter((result) => result === null)).toHaveLength(1);
      expect((await snapshot(serviceA, connectionId)).resources).toHaveLength(1);
    });

    it('rolls the whole page back when one grant is refused', async () => {
      const connectionId = await newConnection(ownerA);
      const lease = await takeLease(serviceA, connectionId);
      const before = await cursorRow(serviceA, connectionId);
      const source = page([resource('one'), resource('two')]);
      await expect(
        commitSyncPage(db(), serviceA, {
          connectionId,
          lease,
          page: {
            ...source,
            mappedGrants: [
              [],
              [
                {
                  principalKind: 'user',
                  principalExternalId: 'x@example.invalid',
                  access: 'read',
                  membershipId: randomUUID(),
                  teamId: null,
                },
              ],
            ],
          },
        }),
      ).rejects.toEqual(code('INVALID_INPUT'));
      expect((await snapshot(serviceA, connectionId)).resources).toEqual([]);
      expect(await cursorRow(serviceA, connectionId)).toEqual(before);
    });

    it('refuses a page its stream could not have produced', async () => {
      const connectionId = await newConnection(ownerA);
      const lease = await takeLease(serviceA, connectionId);
      await expect(
        commitSyncPage(db(), serviceA, {
          connectionId,
          lease,
          page: {
            ...page([resource('one', { resourceType: 'Not a Type!' })]),
            mappedGrants: [[]],
          },
        }),
      ).rejects.toEqual(code('INVALID_INPUT'));
    });

    it('stops a page when the connection was revoked underneath the pass', async () => {
      const connectionId = await newConnection(ownerA);
      const lease = await takeLease(serviceA, connectionId);
      await revokeConnection(db(), ownerA, { connectionId, expectedVersion: 1 });
      await expect(
        commit(serviceA, connectionId, lease, page([resource('late')])),
      ).resolves.toBeNull();
      expect((await snapshot(serviceA, connectionId)).resources).toEqual([]);
    });
  });

  describe('the lease', () => {
    it('is held until it is let go of, and then it can be taken again', async () => {
      const connectionId = await newConnection(ownerA);
      await takeLease(serviceA, connectionId);
      await expect(
        leaseSyncStream(db(), serviceA, { connectionId, stream: STREAM, leaseMs: LEASE_MS }),
      ).resolves.toBeNull();
      await finish(serviceA, connectionId);
      await expect(takeLease(serviceA, connectionId)).resolves.toBeTruthy();
    });

    it('can be taken again once it has run out, so a crash holds nothing', async () => {
      const connectionId = await newConnection(ownerA);
      await leaseSyncStream(db(), serviceA, { connectionId, stream: STREAM, leaseMs: 1 });
      await new Promise((done) => setTimeout(done, 20));
      await expect(takeLease(serviceA, connectionId)).resolves.toBeTruthy();
    });

    it('is refused for a connection that is not active', async () => {
      const connectionId = await newConnection(ownerA);
      await revokeConnection(db(), ownerA, { connectionId, expectedVersion: 1 });
      await expect(
        leaseSyncStream(db(), serviceA, { connectionId, stream: STREAM, leaseMs: LEASE_MS }),
      ).rejects.toEqual(code('CONNECTION_NOT_ACTIVE'));
    });

    it('refuses a stream name the database would', async () => {
      const connectionId = await newConnection(ownerA);
      await expect(
        leaseSyncStream(db(), serviceA, { connectionId, stream: 'Not Valid!', leaseMs: LEASE_MS }),
      ).rejects.toEqual(code('INVALID_INPUT'));
    });
  });

  describe('full sync', () => {
    it('finds what it did not see, across pages, and only in its own stream', async () => {
      const connectionId = await newConnection(ownerA);
      // Everything is seeded by a first full sync of each stream.
      const first = await takeLease(serviceA, connectionId);
      expect(first).toMatchObject({ fullSync: true, fullSyncGeneration: 1 });
      await commit(
        serviceA,
        connectionId,
        first,
        page([
          resource('kept', { acl: [userGrant(member.email)] }),
          resource('removed', { acl: [userGrant(member.email)] }),
        ]),
      );
      await finish(serviceA, connectionId);
      const other = await takeLease(serviceA, connectionId, 'notes');
      await commit(
        serviceA,
        connectionId,
        other,
        page([resource('note', { resourceType: 'notes' })], { nextCursor: 'n1' }),
      );
      await finish(serviceA, connectionId, 'notes');

      await finishSyncStream(db(), serviceA, {
        connectionId,
        stream: STREAM,
        outcome: { resyncRequired: true },
      });
      await expect(cursorRow(serviceA, connectionId)).resolves.toMatchObject({
        state: 'resync_required',
        cursor: null,
      });

      const full = await takeLease(serviceA, connectionId);
      expect(full).toMatchObject({ fullSync: true, fullSyncGeneration: 2, cursor: null });
      const beforeKept = await resourceRow(serviceA, connectionId, 'kept');
      const middle = await commit(
        serviceA,
        connectionId,
        full,
        page([resource('kept', { acl: [userGrant(member.email)] })], {
          nextCursor: 'f1',
          hasMore: true,
        }),
      );
      expect(middle).toMatchObject({ fullSync: true });
      // Nothing is gone until the last page, because it might be on one still to come.
      expect((await resourceRow(serviceA, connectionId, 'removed'))?.deletedAt).toBeNull();

      const last = await commit(
        serviceA,
        connectionId,
        middle!,
        page([resource('added')], { nextCursor: 'f2' }),
      );
      expect(last).toMatchObject({ fullSync: false });
      await finish(serviceA, connectionId);

      const after = await snapshot(serviceA, connectionId);
      const named = Object.fromEntries(after.resources.map((r) => [r.externalId, r]));
      expect(named['removed']?.deletedAt).toBeInstanceOf(Date);
      expect(named['removed']?.aclState).toBe('unmapped');
      expect(named['kept']?.deletedAt).toBeNull();
      expect(named['added']?.deletedAt).toBeNull();
      expect(named['note']?.deletedAt).toBeNull();
      // Being seen is not a change to the thing that was seen.
      expect(named['kept']?.updatedAt).toEqual(beforeKept?.updatedAt);
      expect(named['kept']?.seenGeneration).toBe(2);
      expect(after.grants).toHaveLength(1);

      await expect(takeLease(serviceA, connectionId)).resolves.toMatchObject({ fullSync: false });
    });

    it('decides by the stream that found a thing, whatever kind of thing it is', async () => {
      const connectionId = await newConnection(ownerA);
      const shared = { resourceType: 'document' };
      const read = async (stream: string, resources: SyncedResource[]) => {
        const lease = await takeLease(serviceA, connectionId, stream);
        await commit(serviceA, connectionId, lease, page(resources));
        await finish(serviceA, connectionId, stream);
      };
      await read(STREAM, [resource('in-files', shared)]);
      await read('notes', [resource('in-notes', shared), resource('note-gone', shared)]);

      // A full sync of notes that no longer has one of its own, and never saw what files holds.
      await finishSyncStream(db(), serviceA, {
        connectionId,
        stream: 'notes',
        outcome: { resyncRequired: true },
      });
      await read('notes', [resource('in-notes', shared)]);

      const after = await snapshot(serviceA, connectionId);
      const named = Object.fromEntries(after.resources.map((r) => [r.externalId, r]));
      expect(named['note-gone']?.deletedAt).toBeInstanceOf(Date);
      expect(named['in-notes']?.deletedAt).toBeNull();
      expect(named['in-files']?.deletedAt).toBeNull();
      expect(named['in-files']).toMatchObject({ stream: STREAM, resourceType: 'document' });
      expect(named['in-notes']).toMatchObject({ stream: 'notes', resourceType: 'document' });
    });

    it('refuses the same source ID from another stream, and writes nothing', async () => {
      const connectionId = await newConnection(ownerA);
      const lease = await takeLease(serviceA, connectionId);
      await commit(serviceA, connectionId, lease, page([resource('one')]));
      await finish(serviceA, connectionId);
      const before = await snapshot(serviceA, connectionId);

      const other = await takeLease(serviceA, connectionId, 'notes');
      await expect(commit(serviceA, connectionId, other, page([resource('one')]))).rejects.toEqual(
        code('INVALID_INPUT'),
      );
      expect(await snapshot(serviceA, connectionId)).toEqual(before);
    });

    it('will not let the application move a resource to another stream', async () => {
      const connectionId = await newConnection(ownerA);
      const lease = await takeLease(serviceA, connectionId);
      await commit(serviceA, connectionId, lease, page([resource('one')]));
      await expect(
        withTenantTx(db(), serviceA, (tx) =>
          tx
            .update(externalResources)
            .set({ stream: 'notes' })
            .where(eq(externalResources.connectionId, connectionId)),
        ),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ message: expect.stringMatching(/permission denied/) }),
      });
    });

    it('says a full sync is under way across passes, and when it has ended', async () => {
      const connectionId = await newConnection(ownerA);
      const flag = async () => {
        const row = await cursorRow(serviceA, connectionId);
        return { state: row?.state, running: row?.fullSyncInProgress };
      };
      const first = await takeLease(serviceA, connectionId);
      await expect(flag()).resolves.toEqual({ state: 'running', running: true });
      const middle = await commit(
        serviceA,
        connectionId,
        first,
        page([resource('one')], { nextCursor: 'p1', hasMore: true }),
      );
      await finish(serviceA, connectionId);
      // Between passes nothing is running, and a full sync is still under way.
      await expect(flag()).resolves.toEqual({ state: 'idle', running: true });

      const next = await takeLease(serviceA, connectionId);
      expect(next).toMatchObject({
        fullSync: true,
        cursor: 'p1',
        fullSyncGeneration: middle?.fullSyncGeneration,
      });
      await commit(serviceA, connectionId, next, page([resource('two')], { nextCursor: 'p2' }));
      await expect(flag()).resolves.toEqual({ state: 'running', running: false });
      await finish(serviceA, connectionId);
      await expect(flag()).resolves.toEqual({ state: 'idle', running: false });
      await expect(takeLease(serviceA, connectionId)).resolves.toMatchObject({ fullSync: false });
    });

    it('starts again when the cursor is lost partway through a full sync', async () => {
      const connectionId = await newConnection(ownerA);
      const first = await takeLease(serviceA, connectionId);
      await commit(
        serviceA,
        connectionId,
        first,
        page([resource('one')], { nextCursor: 'p1', hasMore: true }),
      );
      await finishSyncStream(db(), serviceA, {
        connectionId,
        stream: STREAM,
        outcome: { resyncRequired: true },
      });
      await expect(cursorRow(serviceA, connectionId)).resolves.toMatchObject({
        state: 'resync_required',
        fullSyncInProgress: false,
        cursor: null,
      });
      await expect(takeLease(serviceA, connectionId)).resolves.toMatchObject({
        fullSync: true,
        cursor: null,
        fullSyncGeneration: 2,
      });
    });

    it('carries on a full sync interrupted by a crash, from its cursor, in the same mode', async () => {
      const connectionId = await newConnection(ownerA);
      const start = await leaseSyncStream(db(), serviceA, {
        connectionId,
        stream: STREAM,
        leaseMs: 1,
      });
      await commit(
        serviceA,
        connectionId,
        start!,
        page([resource('one')], { nextCursor: 'halfway', hasMore: true }),
      );
      await new Promise((done) => setTimeout(done, 20));
      await expect(takeLease(serviceA, connectionId)).resolves.toMatchObject({
        fullSync: true,
        cursor: 'halfway',
        fullSyncGeneration: start!.fullSyncGeneration,
      });
    });

    it('shuts out a pass still running from before a resync', async () => {
      const connectionId = await newConnection(ownerA);
      const stale = await takeLease(serviceA, connectionId);
      await finishSyncStream(db(), serviceA, {
        connectionId,
        stream: STREAM,
        outcome: { resyncRequired: true },
      });
      await expect(
        commit(serviceA, connectionId, stale, page([resource('stale')])),
      ).resolves.toBeNull();
    });
  });

  describe('source ACLs', () => {
    it('maps an email address to an active membership, whatever its case', async () => {
      await expect(
        resolveSourcePrincipal(db(), serviceA, {
          kind: 'user',
          externalId: member.email.toUpperCase(),
        }),
      ).resolves.toEqual({ membershipId: member.membershipId });
    });

    it('does not map someone who has left, nor a partial address', async () => {
      const user = await makeUser('leaving');
      const joined = await join(ownerA, user);
      await expect(
        resolveSourcePrincipal(db(), serviceA, { kind: 'user', externalId: user.email }),
      ).resolves.toEqual({ membershipId: joined.membershipId });
      const su = new pg.Client({ connectionString: urls.superuser() });
      await su.connect();
      try {
        await inFixtureTenant(su, ownerA.organizationId, () =>
          su.query(`update org.memberships set status = 'disabled' where id = $1`, [
            joined.membershipId,
          ]),
        );
      } finally {
        await su.end();
      }
      await expect(
        resolveSourcePrincipal(db(), serviceA, { kind: 'user', externalId: user.email }),
      ).resolves.toBeNull();
      await expect(
        resolveSourcePrincipal(db(), serviceA, { kind: 'user', externalId: '%@example.invalid' }),
      ).resolves.toBeNull();
    });

    it.each(['group', 'domain', 'anyone'] as const)('finds nobody for %s', async (kind) => {
      await expect(
        resolveSourcePrincipal(db(), serviceA, { kind, externalId: member.email }),
      ).resolves.toBeNull();
    });

    it("does not find another tenant's person by the same address", async () => {
      await expect(
        resolveSourcePrincipal(db(), serviceB, { kind: 'user', externalId: member.email }),
      ).resolves.toBeNull();
    });

    it('gives the same person a target in each tenant they belong to, and no other', async () => {
      const both = await makeUser('both');
      const inA = await join(ownerA, both);
      const inB = await join(ownerB, both);
      await expect(
        resolveSourcePrincipal(db(), serviceA, { kind: 'user', externalId: both.email }),
      ).resolves.toEqual({ membershipId: inA.membershipId });
      await expect(
        resolveSourcePrincipal(db(), serviceB, { kind: 'user', externalId: both.email }),
      ).resolves.toEqual({ membershipId: inB.membershipId });
    });

    it('keeps a grant nobody matches, gives nothing, and says partial', async () => {
      const connectionId = await newConnection(ownerA);
      await applyPage(
        serviceA,
        connectionId,
        page([
          resource('both', {
            acl: [userGrant(member.email), userGrant('stranger@example.invalid', 'write')],
          }),
          resource('nobody', { acl: [userGrant('stranger@example.invalid')] }),
          resource('all', { acl: [userGrant(member.email)] }),
          resource('none', { acl: [] }),
        ]),
      );
      const { resources, grants } = await snapshot(serviceA, connectionId);
      const state = Object.fromEntries(resources.map((r) => [r.externalId, r.aclState]));
      expect(state).toEqual({
        both: 'partial',
        nobody: 'unmapped',
        all: 'mapped',
        none: 'unmapped',
      });
      const stranger = grants.filter(
        (grant) => grant.principalExternalId === 'stranger@example.invalid',
      );
      expect(stranger).toHaveLength(2);
      for (const grant of stranger) {
        expect(grant).toMatchObject({ membershipId: null, teamId: null });
      }
    });

    it.each(['domain', 'anyone'] as const)(
      'gives %s nothing, even if a target were to reach the service',
      async (principalKind) => {
        const connectionId = await newConnection(ownerA);
        const lease = await takeLease(serviceA, connectionId);
        await commitSyncPage(db(), serviceA, {
          connectionId,
          lease,
          page: {
            ...page([
              resource('open', {
                acl: [{ principalKind, principalExternalId: 'x', access: 'read' }],
              }),
            ]),
            mappedGrants: [
              [
                {
                  principalKind,
                  principalExternalId: 'x',
                  access: 'read',
                  membershipId: member.membershipId,
                  teamId: null,
                },
              ],
            ],
          },
        });
        const { resources, grants } = await snapshot(serviceA, connectionId);
        expect(resources[0]?.aclState).toBe('unmapped');
        expect(grants[0]).toMatchObject({ membershipId: null, teamId: null });
      },
    );

    it('removes a grant the source no longer reports, even at the same version', async () => {
      const connectionId = await newConnection(ownerA);
      await applyPage(
        serviceA,
        connectionId,
        page([resource('one', { acl: [userGrant(member.email)] })]),
      );
      expect((await resourceRow(serviceA, connectionId, 'one'))?.aclState).toBe('mapped');
      await applyPage(serviceA, connectionId, page([resource('one')], { nextCursor: 'cursor-2' }));
      const after = await snapshot(serviceA, connectionId);
      expect(after.grants).toEqual([]);
      expect(after.resources[0]?.aclState).toBe('unmapped');
    });

    it('collapses a grant the source repeated', async () => {
      const connectionId = await newConnection(ownerA);
      await applyPage(
        serviceA,
        connectionId,
        page([resource('one', { acl: [userGrant(member.email), userGrant(member.email)] })]),
      );
      const after = await snapshot(serviceA, connectionId);
      expect(after.grants).toHaveLength(1);
      expect(after.resources[0]?.aclState).toBe('mapped');
    });

    it("refuses a grant naming another tenant's member", async () => {
      const connectionId = await newConnection(ownerB);
      const lease = await takeLease(serviceB, connectionId);
      await expect(
        commitSyncPage(db(), serviceB, {
          connectionId,
          lease,
          page: {
            ...page([resource('one')]),
            mappedGrants: [
              [
                {
                  principalKind: 'user',
                  principalExternalId: member.email,
                  access: 'read',
                  membershipId: member.membershipId,
                  teamId: null,
                },
              ],
            ],
          },
        }),
      ).rejects.toEqual(code('INVALID_INPUT'));
    });
  });

  describe('two tenants', () => {
    it('keeps the same external ID in separate rows', async () => {
      const inA = await newConnection(ownerA);
      const inB = await newConnection(ownerB);
      await applyPage(serviceA, inA, page([resource('same-id', { displayName: 'From A' })]));
      await applyPage(serviceB, inB, page([resource('same-id', { displayName: 'From B' })]));
      const a = await resourceRow(serviceA, inA, 'same-id');
      const b = await resourceRow(serviceB, inB, 'same-id');
      expect(a?.displayName).toBe('From A');
      expect(b?.displayName).toBe('From B');
      expect(a?.id).not.toBe(b?.id);
    });

    it("cannot lease another tenant's stream, read its cursor, or commit into it", async () => {
      const theirs = await newConnection(ownerA);
      const lease = await takeLease(serviceA, theirs);
      await commit(serviceA, theirs, lease, page([resource('secret-doc')]));

      await expect(
        leaseSyncStream(db(), serviceB, {
          connectionId: theirs,
          stream: STREAM,
          leaseMs: LEASE_MS,
        }),
      ).rejects.toEqual(code('NOT_FOUND'));
      await expect(cursorRow(serviceB, theirs)).resolves.toBeUndefined();
      await expect(
        commit(
          serviceB,
          theirs,
          { ...lease, generation: lease.generation + 1 },
          page([resource('x')]),
        ),
      ).resolves.toBeNull();
      await expect(
        finishSyncStream(db(), serviceB, {
          connectionId: theirs,
          stream: STREAM,
          outcome: { ok: true },
        }),
      ).rejects.toEqual(code('NOT_FOUND'));
      expect((await snapshot(serviceA, theirs)).resources.map((r) => r.externalId)).toEqual([
        'secret-doc',
      ]);
      expect((await snapshot(serviceB, theirs)).resources).toEqual([]);
      await expect(cursorRow(serviceA, theirs)).resolves.toMatchObject({ cursor: 'cursor-1' });
    });

    it('keeps the worker functions from a person, whatever their role', async () => {
      const connectionId = await newConnection(ownerA);
      const lease = {
        stream: STREAM,
        cursor: null,
        generation: 0,
        fullSync: true,
        fullSyncGeneration: 0,
      };
      await expect(
        leaseSyncStream(db(), ownerA, { connectionId, stream: STREAM, leaseMs: LEASE_MS }),
      ).rejects.toEqual(code('FORBIDDEN'));
      await expect(
        commitSyncPage(db(), ownerA, {
          connectionId,
          lease,
          page: { ...page([]), mappedGrants: [] },
        }),
      ).rejects.toEqual(code('FORBIDDEN'));
      await expect(
        finishSyncStream(db(), ownerA, { connectionId, stream: STREAM, outcome: { ok: true } }),
      ).rejects.toEqual(code('FORBIDDEN'));
      await expect(
        resolveSourcePrincipal(db(), ownerA, { kind: 'user', externalId: member.email }),
      ).rejects.toEqual(code('FORBIDDEN'));
    });

    it("cannot hold another tenant's sealed credential on a connection", async () => {
      const { secretRef } = await storeSecret(db(), ownerA, {
        publicKeyPem,
        purpose: SECRET_PURPOSE_CONNECTOR_CREDENTIAL,
        plaintext: CANARY,
      });
      await expect(newConnection(ownerB, secretRef)).rejects.toEqual(code('INVALID_INPUT'));
    });
  });

  describe('what an administrator can be shown', () => {
    it('reduces any code off the fixed list to a failure and nothing more', async () => {
      const connectionId = await newConnection(ownerA);
      await takeLease(serviceA, connectionId);
      await finishSyncStream(db(), serviceA, {
        connectionId,
        stream: STREAM,
        outcome: { ok: false, code: `550 ${CANARY} password=hunter2` },
      });
      const row = await cursorRow(serviceA, connectionId);
      expect(row?.lastErrorCode).toBe('SYNC_FAILED');
      // Its first pass is a full sync, and a failure leaves it one, to carry on from where it got to.
      expect(row?.state).toBe('failed');
      expect(row?.fullSyncInProgress).toBe(true);
      const [connection] = await withTenantTx(db(), ownerA, (tx) =>
        tx.select().from(connections).where(eq(connections.id, connectionId)),
      );
      expect(connection?.lastErrorCode).toBe('SYNC_FAILED');
      expect(connection?.version).toBe(1);
      expect(JSON.stringify(connection)).not.toContain(CANARY);
    });

    it('marks a stream failed when an incremental read fails, and keeps its cursor', async () => {
      const connectionId = await newConnection(ownerA);
      await applyPage(serviceA, connectionId, page([resource('one')]));
      await takeLease(serviceA, connectionId);
      await finishSyncStream(db(), serviceA, {
        connectionId,
        stream: STREAM,
        outcome: { ok: false, code: 'SYNC_RATE_LIMITED' },
      });
      await expect(cursorRow(serviceA, connectionId)).resolves.toMatchObject({
        state: 'failed',
        cursor: 'cursor-1',
        lastErrorCode: 'SYNC_RATE_LIMITED',
        leaseUntil: null,
      });
      await expect(takeLease(serviceA, connectionId)).resolves.toMatchObject({
        fullSync: false,
        cursor: 'cursor-1',
      });
    });

    it('clears an error when the stream recovers, and not while another is failing', async () => {
      const connectionId = await newConnection(ownerA);
      const fail = (stream: string) =>
        finishSyncStream(db(), serviceA, {
          connectionId,
          stream,
          outcome: { ok: false, code: 'SYNC_TIMEOUT' },
        });
      await takeLease(serviceA, connectionId, 'files');
      await takeLease(serviceA, connectionId, 'notes');
      await fail('files');
      await fail('notes');
      const errorOf = async () =>
        (
          await withTenantTx(db(), ownerA, (tx) =>
            tx.select().from(connections).where(eq(connections.id, connectionId)),
          )
        )[0]?.lastErrorCode;
      await finish(serviceA, connectionId, 'files');
      expect(await errorOf()).toBe('SYNC_TIMEOUT');
      await finish(serviceA, connectionId, 'notes');
      expect(await errorOf()).toBeNull();
    });
  });

  describe('runSyncPass over the real service', () => {
    const store = (context: TenantContext, connectionId: string) => ({
      lease: (stream: string, leaseMs: number) =>
        leaseSyncStream(db(), context, { connectionId, stream, leaseMs }),
      commitPage: (state: Parameters<typeof commit>[2], next: SyncPage) =>
        commit(context, connectionId, state, next),
      finish: (stream: string, outcome: { ok: true } | { ok: false; code: string }) =>
        finishSyncStream(db(), context, { connectionId, stream, outcome }),
      markResyncRequired: (stream: string) =>
        finishSyncStream(db(), context, {
          connectionId,
          stream,
          outcome: { resyncRequired: true },
        }),
    });
    const passContext = (context: TenantContext, connectionId: string) => ({
      organizationId: context.organizationId,
      connectionId,
      config: {},
      credentials: {
        withCredential: async () => {
          throw new Error('not used');
        },
      },
      network: {
        openRelay: async () => {
          throw new Error('not used');
        },
      },
    });

    it('syncs to the end, and a second pass changes nothing', async () => {
      const connectionId = await newConnection(ownerA);
      const connector = createFakeConnector({
        pages: {
          [STREAM]: [
            page([resource('one', { acl: [userGrant(member.email)] })]),
            page([resource('two')]),
          ],
        },
      });
      const deps = {
        connector,
        context: passContext(serviceA, connectionId),
        store: store(serviceA, connectionId),
        maxPages: 10,
      };
      await expect(runSyncPass(deps)).resolves.toMatchObject({ pages: 2, resources: 2, failed: 0 });
      const before = await snapshot(serviceA, connectionId);
      expect(before.resources.map((r) => r.externalId)).toEqual(['one', 'two']);

      await new Promise((done) => setTimeout(done, 20));
      await expect(runSyncPass(deps)).resolves.toMatchObject({ pages: 1, resources: 0, failed: 0 });
      expect(await snapshot(serviceA, connectionId)).toEqual(before);
    });

    it('repeats only the page a crash lost', async () => {
      const connectionId = await newConnection(ownerA);
      const connector = createFakeConnector({
        pages: { [STREAM]: [page([resource('one')]), page([resource('two')])] },
      });
      const real = store(serviceA, connectionId);
      let commits = 0;
      const crashing = {
        ...real,
        commitPage: async (state: Parameters<typeof commit>[2], next: SyncPage) => {
          commits += 1;
          if (commits === 2) throw new Error('The worker died here');
          return real.commitPage(state, next);
        },
      };
      await expect(
        runSyncPass({
          connector,
          context: passContext(serviceA, connectionId),
          store: crashing,
          maxPages: 10,
          leaseMs: 1,
        }),
      ).rejects.toThrow('The worker died here');
      expect((await snapshot(serviceA, connectionId)).resources).toHaveLength(1);

      await new Promise((done) => setTimeout(done, 20));
      await runSyncPass({
        connector,
        context: passContext(serviceA, connectionId),
        store: real,
        maxPages: 10,
      });
      const after = await snapshot(serviceA, connectionId);
      expect(after.resources.map((r) => r.externalId)).toEqual(['one', 'two']);
    });

    it('goes back to a full sync when the cursor has expired', async () => {
      const connectionId = await newConnection(ownerA);
      let expired = false;
      const connector: Connector = createFakeConnector({
        pages: { [STREAM]: [page([resource('one')])] },
      });
      const scripted = connector.sync!;
      const expiring: Connector = {
        ...connector,
        sync: {
          readPage: async (context, request) => {
            if (expired && request.cursor !== null) {
              throw new CursorExpired();
            }
            return scripted.readPage(context, request);
          },
        },
      };
      const deps = {
        connector: expiring,
        context: passContext(serviceA, connectionId),
        store: store(serviceA, connectionId),
        maxPages: 10,
      };
      await runSyncPass(deps);
      expired = true;
      await runSyncPass(deps);
      await expect(cursorRow(serviceA, connectionId)).resolves.toMatchObject({
        state: 'resync_required',
        cursor: null,
      });
      await runSyncPass(deps);
      await expect(cursorRow(serviceA, connectionId)).resolves.toMatchObject({
        state: 'idle',
        fullSyncGeneration: 2,
      });
    });
  });

  describe('the Activity', () => {
    const activitiesFor = (
      registry: ConnectorRegistry,
      secrets: ConnectorActivityDeps['secrets'] = broker,
    ) =>
      createConnectorSyncActivities({
        database: db(),
        registry,
        secrets,
        network: {
          openRelay: async () => {
            throw new Error('The fake has no network');
          },
        },
      });

    const fake = (): Connector =>
      createFakeConnector({
        pages: { [STREAM]: [page([resource('one')]), page([resource('two')])] },
      });

    it('syncs a connection it is told about', async () => {
      const connectionId = await newConnection(ownerA);
      const { syncConnection } = activitiesFor(createConnectorRegistry([fake()]));
      await expect(
        syncConnection({ organizationId: ownerA.organizationId, connectionId }),
      ).resolves.toEqual({ outcome: 'synced', pages: 2, resources: 2 });
    });

    it('uses current recorded consent independently of forged config scopes', async () => {
      const connectionId = await newConnection(ownerA);
      const setup = new pg.Client({ connectionString: urls.superuser() });
      await setup.connect();
      const readPage = vi.fn(async (context: ConnectorContext) => {
        expect(context.config).toEqual({ grantedScopes: ['forged-admin'] });
        return page([]);
      });
      const { syncConnection } = activitiesFor(
        createConnectorRegistry([{ ...fake(), parseConfig: (raw) => raw, sync: { readPage } }]),
      );
      try {
        await inFixtureTenant(setup, ownerA.organizationId, () =>
          setup.query(
            'update integrations.connections set config = $1, granted_scopes = $2 where organization_id = $3 and id = $4',
            [
              { grantedScopes: ['forged-admin'] },
              ['recorded-read'],
              ownerA.organizationId,
              connectionId,
            ],
          ),
        );
        await expect(
          syncConnection({ organizationId: ownerA.organizationId, connectionId }),
        ).resolves.toMatchObject({ outcome: 'synced' });
        expect(readPage.mock.calls[0]?.[0].grantedScopes).toEqual(['recorded-read']);
        await inFixtureTenant(setup, ownerA.organizationId, () =>
          setup.query(
            'update integrations.connections set granted_scopes = $1 where organization_id = $2 and id = $3',
            [[], ownerA.organizationId, connectionId],
          ),
        );
        await expect(
          syncConnection({ organizationId: ownerA.organizationId, connectionId }),
        ).resolves.toMatchObject({ outcome: 'synced' });
        expect(readPage).toHaveBeenCalledTimes(2);
        expect(readPage.mock.calls[1]?.[0].grantedScopes).toEqual([]);
      } finally {
        await setup.end();
      }
    });

    it('does not claim to have synced a stream another pass holds', async () => {
      const connectionId = await newConnection(ownerA);
      await takeLease(serviceA, connectionId);
      const { syncConnection } = activitiesFor(
        createConnectorRegistry([
          createFakeConnector({ pages: { [STREAM]: [page([resource('one')])] } }),
        ]),
      );
      await expect(
        syncConnection({ organizationId: ownerA.organizationId, connectionId }),
      ).resolves.toEqual({ outcome: 'nothing_to_do', pages: 0, resources: 0 });
    });

    it("finds nothing to do for another tenant's connection, and takes no lease of it", async () => {
      const theirs = await newConnection(ownerA);
      const revoke = vi.fn();
      const withSecret = vi.fn();
      const { syncConnection } = activitiesFor(createConnectorRegistry([fake()]), {
        revoke,
        withSecret,
      });
      await expect(
        syncConnection({ organizationId: ownerB.organizationId, connectionId: theirs }),
      ).resolves.toEqual({ outcome: 'nothing_to_do', pages: 0, resources: 0 });
      await expect(cursorRow(serviceA, theirs)).resolves.toBeUndefined();
      expect(withSecret).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    });

    it('revokes the secret instead of syncing a revoked connection, for real', async () => {
      const { secretRef } = await storeSecret(db(), ownerA, {
        publicKeyPem,
        purpose: SECRET_PURPOSE_CONNECTOR_CREDENTIAL,
        plaintext: CANARY,
      });
      const connectionId = await newConnection(ownerA, secretRef);
      await broker.withSecret(
        {
          organizationId: ownerA.organizationId,
          secretId: secretRef,
          purpose: SECRET_PURPOSE_CONNECTOR_CREDENTIAL,
        },
        async (value) => expect(value.toString()).toBe(CANARY),
      );
      await revokeConnection(db(), ownerA, { connectionId, expectedVersion: 1 });
      const readPage = vi.fn();
      const { syncConnection } = activitiesFor(
        createConnectorRegistry([{ ...fake(), sync: { readPage } }]),
      );
      await expect(
        syncConnection({ organizationId: ownerA.organizationId, connectionId }),
      ).resolves.toEqual({ outcome: 'revoked', pages: 0, resources: 0 });
      expect(readPage).not.toHaveBeenCalled();
      await expect(
        broker.withSecret(
          {
            organizationId: ownerA.organizationId,
            secretId: secretRef,
            purpose: SECRET_PURPOSE_CONNECTOR_CREDENTIAL,
          },
          async () => undefined,
        ),
      ).rejects.toThrow();
      // A repeat of the event finds it already done.
      await expect(
        syncConnection({ organizationId: ownerA.organizationId, connectionId }),
      ).resolves.toEqual({ outcome: 'revoked', pages: 0, resources: 0 });
    });

    it('revokes the signing secrets of its endpoints too', async () => {
      const connectionId = await newConnection(ownerA);
      const { secretRef } = await storeSecret(db(), ownerA, {
        publicKeyPem,
        purpose: SECRET_PURPOSE_WEBHOOK_SIGNING,
        plaintext: randomUUID(),
      });
      await withTenantTx(db(), ownerA, (tx) =>
        tx.insert(webhookEndpoints).values({
          organizationId: ownerA.organizationId,
          connectionId,
          tokenHash: randomUUID(),
          signingSecretId: secretRef,
          signatureScheme: 'ensemus_hmac_sha256_v1',
        }),
      );
      await revokeConnection(db(), ownerA, { connectionId, expectedVersion: 1 });
      const revoke = vi.fn(async () => undefined);
      const { syncConnection } = activitiesFor(createConnectorRegistry([fake()]), {
        revoke,
        withSecret: vi.fn(),
      });
      await syncConnection({ organizationId: ownerA.organizationId, connectionId });
      expect(revoke.mock.calls).toEqual([[ownerA.organizationId, secretRef]]);
    });

    it('lends only its own credential, and only for the connector’s declared purpose', async () => {
      const { secretRef } = await storeSecret(db(), ownerA, {
        publicKeyPem,
        purpose: SECRET_PURPOSE_CONNECTOR_CREDENTIAL,
        plaintext: CANARY,
      });
      const connectionId = await newConnection(ownerA, secretRef);
      const seen: string[] = [];
      let lease: CredentialLease | undefined;
      const base = fake();
      const connector: Connector = {
        ...base,
        manifest: {
          ...base.manifest,
          credential: { required: true, purpose: SECRET_PURPOSE_CONNECTOR_CREDENTIAL },
        },
        sync: {
          readPage: async (context, request) => {
            lease = context.credentials;
            await context.credentials.withCredential(async (value) => {
              seen.push(value.toString());
            });
            return base.sync!.readPage(context, request);
          },
        },
      };
      const { syncConnection } = activitiesFor(createConnectorRegistry([connector]));
      await syncConnection({ organizationId: ownerA.organizationId, connectionId });
      expect(new Set(seen)).toEqual(new Set([CANARY]));
      expect(lease).toBeDefined();
      expect(Object.keys(lease as object)).toEqual(['withCredential']);
    });

    it('gives a connection with no credential a lease that refuses', async () => {
      const connectionId = await newConnection(ownerA);
      const base = fake();
      const { syncConnection } = activitiesFor(
        createConnectorRegistry([
          {
            ...base,
            sync: {
              readPage: async (context) => context.credentials.withCredential(async () => page([])),
            },
          },
        ]),
      );
      await expect(
        syncConnection({ organizationId: ownerA.organizationId, connectionId }),
      ).resolves.toMatchObject({ outcome: 'failed' });
      await expect(cursorRow(serviceA, connectionId)).resolves.toMatchObject({
        lastErrorCode: 'SYNC_FAILED',
      });
    });

    it('never gives a connector declaring no network the way out', async () => {
      const connectionId = await newConnection(ownerA);
      const opened = vi.fn(async () => {
        throw new Error('The real gateway was reached');
      });
      const base = fake();
      let thrown: unknown;
      const { syncConnection } = createConnectorSyncActivities({
        database: db(),
        registry: createConnectorRegistry([
          {
            ...base,
            sync: {
              readPage: async (context, request) => {
                await context.network.openRelay({ timeoutMs: 1 }).catch((error: unknown) => {
                  thrown = error;
                });
                return base.sync!.readPage(context, request);
              },
            },
          },
        ]),
        secrets: broker,
        network: { openRelay: opened },
      });
      await syncConnection({ organizationId: ownerA.organizationId, connectionId });
      expect(opened).not.toHaveBeenCalled();
      expect(thrown).toBeInstanceOf(Error);
    });

    it('finds nothing to do for a connector that is not on the list, or has no sync', async () => {
      const connectionId = await newConnection(ownerA);
      const { syncConnection } = activitiesFor(createConnectorRegistry([]));
      await expect(
        syncConnection({ organizationId: ownerA.organizationId, connectionId }),
      ).resolves.toEqual({ outcome: 'nothing_to_do', pages: 0, resources: 0 });
      const nothing = activitiesFor(createConnectorRegistry([createFakeConnector({})]));
      await expect(
        nothing.syncConnection({ organizationId: ownerA.organizationId, connectionId }),
      ).resolves.toEqual({ outcome: 'nothing_to_do', pages: 0, resources: 0 });
    });

    it('records settings the connector refuses, as a code, without syncing', async () => {
      const connectionId = await newConnection(ownerA);
      const base = fake();
      const readPage = vi.fn();
      const { syncConnection } = activitiesFor(
        createConnectorRegistry([
          {
            ...base,
            sync: { readPage },
            parseConfig: () => {
              throw new Error(`Bad settings: ${CANARY}`);
            },
          },
        ]),
      );
      await expect(
        syncConnection({ organizationId: ownerA.organizationId, connectionId }),
      ).resolves.toEqual({ outcome: 'failed', pages: 0, resources: 0 });
      expect(readPage).not.toHaveBeenCalled();
      const [row] = await withTenantTx(db(), ownerA, (tx) =>
        tx.select().from(connections).where(eq(connections.id, connectionId)),
      );
      expect(row?.lastErrorCode).toBe('CONFIG_INVALID');
    });

    it('lets no source or database text out through what it returns or throws', async () => {
      const connectionId = await newConnection(ownerA);
      const base = fake();
      const failing = activitiesFor(
        createConnectorRegistry([
          {
            ...base,
            sync: {
              readPage: async () => {
                throw new Error(CANARY);
              },
            },
          },
        ]),
      );
      const result = await failing.syncConnection({
        organizationId: ownerA.organizationId,
        connectionId,
      });
      expect(result).toEqual({ outcome: 'failed', pages: 0, resources: 0 });

      const broken = createConnectorSyncActivities({
        database: {
          transaction: async () => {
            throw new Error(`Failed query with params: ${CANARY}`);
          },
        } as never,
        registry: createConnectorRegistry([base]),
        secrets: broker,
        network: { openRelay: async () => Promise.reject(new Error('unused')) },
      });
      const failure = await broken
        .syncConnection({ organizationId: ownerA.organizationId, connectionId })
        .catch((error: unknown) => error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect(JSON.stringify([(failure as Error).message, (failure as Error).stack])).not.toContain(
        CANARY,
      );
    });

    it('refuses an input with anything but IDs in it', async () => {
      const { syncConnection } = activitiesFor(createConnectorRegistry([fake()]));
      await expect(
        syncConnection({
          organizationId: ownerA.organizationId,
          connectionId: randomUUID(),
          note: CANARY,
        } as never),
      ).rejects.toThrow();
      await expect(
        syncConnection({ organizationId: CANARY, connectionId: randomUUID() }),
      ).rejects.toThrow();
    });

    it('notices a revoke that happened during its pass, and revokes the secret', async () => {
      const { secretRef } = await storeSecret(db(), ownerA, {
        publicKeyPem,
        purpose: SECRET_PURPOSE_CONNECTOR_CREDENTIAL,
        plaintext: CANARY,
      });
      const connectionId = await newConnection(ownerA, secretRef);
      const base = fake();
      const revoke = vi.fn(async () => undefined);
      const { syncConnection } = activitiesFor(
        createConnectorRegistry([
          {
            ...base,
            sync: {
              readPage: async (context, request) => {
                await revokeConnection(db(), ownerA, { connectionId, expectedVersion: 1 });
                return base.sync!.readPage(context, request);
              },
            },
          },
        ]),
        { revoke, withSecret: vi.fn() },
      );
      await expect(
        syncConnection({ organizationId: ownerA.organizationId, connectionId }),
      ).resolves.toMatchObject({ outcome: 'revoked' });
      expect(revoke).toHaveBeenCalledWith(ownerA.organizationId, secretRef);
      expect((await snapshot(serviceA, connectionId)).resources).toEqual([]);
    });
  });
});
