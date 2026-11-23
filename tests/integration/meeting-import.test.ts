import { createHash, randomUUID } from 'node:crypto';
import {
  approveMeetingProvider,
  beginMeetingImport,
  createConnection,
  createMeetingFromResource,
  getMeetingImport,
  listMeetingSourceChoices,
  getMeeting,
  recordMeetingConsent,
  requestMeetingNotesImport,
  revokeMeetingProvider,
} from '@ensemus/application';
import { createMeetingNotesConnector } from '@ensemus/connectors/meetings';
import { createConnectorRegistry } from '@ensemus/connectors/runtime';
import { createFakeAdapter } from '@ensemus/connectors/testing/business-adapter';
import {
  domainEvents,
  externalResourceAcl,
  externalResources,
  meetingImportRequests,
  meetingNotes,
  openAppDatabase,
  withTenantTx,
  users,
} from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { createServiceContext } from '@ensemus/database/service';
import { FileKeyProvider, SecretBroker } from '@ensemus/secrets/broker';
import { storeSecret } from '@ensemus/secrets/seal';
import { createConnectorSyncActivities } from '@ensemus/workflows/connector-sync-activities';
import {
  createMeetingImportConnectorActivities,
  createMeetingImportPlatformActivities,
} from '@ensemus/workflows/meeting-import-activities';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enableMeetings,
  recordConsent,
  seedMeeting,
  TEST_NOTICE,
  TEST_TERMS,
} from '../helpers/expansion';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { secret, urls } from '../helpers/stack';

const SOURCE_TYPE = 'meeting_notes_http';
const STREAM = 'meetings.notes';
const text = 'Generated import canary. No real meeting content.';
const credential = 'GENERATED-MEETING-ADAPTER-KEY';
const code = (value: string) => ({ code: value });

describe('native connector meeting import', () => {
  const app = openAppDatabase(urls.app());
  const connector = openAppDatabase(urls.connector());
  const platform = openAppDatabase(urls.worker());
  const secrets = openSecretsDatabase(urls.secrets());
  const broker = new SecretBroker(
    secrets.db,
    new FileKeyProvider([secret('sealing_private_key.pem')]),
  );
  const registry = createConnectorRegistry([createMeetingNotesConnector({ tls: 'none' })]);
  let pair: Awaited<ReturnType<typeof makeTwoTenants>>;
  let connectionId: string;
  const owner = () => pair.a.owner.context;
  const org = () => owner().organizationId;
  const input = (importRequestId: string) => ({ organizationId: org(), importRequestId });

  beforeAll(async () => {
    pair = await makeTwoTenants(app.db);
    await proveSecondFactor(pair.a.owner);
    await enableMeetings(app.db, owner());
    await enableMeetings(app.db, pair.b.owner.context);
    const sealed = await storeSecret(app.db, owner(), {
      publicKeyPem: secret('sealing_public_key.pem'),
      purpose: 'connector_credential',
      plaintext: credential,
    });
    const connection = await createConnection(app.db, owner(), {
      connectorType: SOURCE_TYPE,
      displayName: 'Generated meeting adapter',
      config: {},
      credentialSecretId: sealed.secretRef,
    });
    connectionId = connection.id;
  });
  afterAll(async () => {
    await Promise.all([app.close(), connector.close(), platform.close(), secrets.close()]);
  });

  async function fixture(options: { acl?: boolean; consent?: boolean } = {}) {
    const id = randomUUID();
    const externalId = `generated/${id}`;
    await withTenantTx(app.db, owner(), async (tx) => {
      await tx.insert(externalResources).values({
        organizationId: org(),
        id,
        connectionId,
        externalId,
        stream: STREAM,
        resourceType: STREAM,
        classification: 'confidential',
        aclState: 'mapped',
      });
      if (options.acl !== false)
        await tx.insert(externalResourceAcl).values({
          organizationId: org(),
          resourceId: id,
          principalKind: 'user',
          principalExternalId: 'generated-user',
          access: 'read',
          membershipId: owner().membershipId,
        });
    });
    const room = await seedMeeting(app.db, owner(), {
      sourceKind: 'connector',
      connectionId,
      sourceResourceId: id,
    });
    if (options.consent !== false)
      await recordConsent(app.db, owner(), {
        meetingId: room.id,
        participantId: room.organizerParticipantId,
      });
    const provider = await approveMeetingProvider(app.db, owner(), {
      kind: 'source',
      connectionId,
      maxClassification: 'confidential',
      termsRef: TEST_TERMS,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    return { ...room, externalId, resourceId: id, providerApprovalId: provider.id };
  }
  function queue(room: { id: string; providerApprovalId: string }) {
    return requestMeetingNotesImport(app.db, owner(), {
      meetingId: room.id,
      providerApprovalId: room.providerApprovalId,
    });
  }
  async function requestStatus(id: string) {
    const [row] = await withTenantTx(app.db, owner(), (tx) =>
      tx.select().from(meetingImportRequests).where(eq(meetingImportRequests.id, id)),
    );
    return row;
  }
  function source(externalId: string) {
    return createFakeAdapter({ credential, notes: { [externalId]: text } });
  }
  function activity(fake: ReturnType<typeof source>, temporalRunId = randomUUID()) {
    return createMeetingImportConnectorActivities({
      database: connector.db,
      registry,
      network: fake.network,
      secrets: broker,
      activity: () => ({ temporalRunId, signal: new AbortController().signal }),
    });
  }

  it('syncs metadata through the native connector and maps the source grant before showing the choice', async () => {
    const [person] = await withTenantTx(app.db, owner(), (tx) =>
      tx.select({ email: users.email }).from(users).where(eq(users.id, owner().userId)),
    );
    const fake = createFakeAdapter({
      credential,
      streams: {
        [STREAM]: [
          {
            id: 'generated-sync-note',
            version: '1',
            fields: { title: 'Generated synchronized note', transcript: text },
            acl: [{ principal_kind: 'user', principal_external_id: person!.email, access: 'read' }],
          },
        ],
      },
    });
    const sync = createConnectorSyncActivities({
      database: connector.db,
      registry,
      network: fake.network,
      secrets: broker,
    });
    await expect(
      sync.syncConnection({ organizationId: org(), connectionId }),
    ).resolves.toMatchObject({
      outcome: 'synced',
      pages: 1,
      resources: 1,
    });
    const choices = await listMeetingSourceChoices(app.db, owner());
    expect(choices).toEqual([
      {
        resourceId: expect.any(String),
        title: 'Generated synchronized note',
        connectionName: 'Generated meeting adapter',
      },
    ]);
    expect(JSON.stringify(choices)).not.toContain(text);
    await expect(listMeetingSourceChoices(app.db, pair.a.admin.context)).resolves.toEqual([]);
    expect(fake.requests().map((request) => request.path)).toEqual([
      '/ensemus-adapter/v1/streams/meetings.notes/records?limit=100&full=1',
    ]);
  });

  it('opens a linked room from permitted source metadata without importing notes', async () => {
    const room = await fixture();
    const args = {
      resourceId: room.resourceId,
      title: 'Generated connected room',
      occurredAt: new Date(),
    };
    await expect(
      createMeetingFromResource(app.db, pair.a.admin.context, args),
    ).rejects.toMatchObject(code('NOT_FOUND'));
    await expect(
      createMeetingFromResource(app.db, pair.b.owner.context, args),
    ).rejects.toMatchObject(code('NOT_FOUND'));
    await expect(
      createMeetingFromResource(app.db, owner(), { ...args, classification: 'internal' }),
    ).rejects.toMatchObject(code('CLASSIFICATION_NOT_ALLOWED'));
    const meeting = await createMeetingFromResource(app.db, owner(), args);
    expect(meeting).toMatchObject({
      sourceKind: 'connector',
      consent: 'pending',
      currentNotes: null,
    });
    await expect(queue({ ...room, id: meeting.id })).rejects.toMatchObject(
      code('CONSENT_INCOMPLETE'),
    );
  });

  it('queues one request, imports the exact source once, and keeps text and external IDs out of events', async () => {
    const room = await fixture();
    const [requested, repeat] = await Promise.all([queue(room), queue(room)]);
    expect(repeat).toEqual(requested);
    const fake = source(room.externalId);
    const worker = activity(fake);
    await expect(worker.readMeetingNotes(input(requested.id))).resolves.toBe('completed');
    await expect(worker.readMeetingNotes(input(requested.id))).resolves.toBe('completed');
    expect(fake.requests().map(({ method, path }) => ({ method, path }))).toEqual([
      { method: 'GET', path: '/ensemus-adapter/v1/notes/' + encodeURIComponent(room.externalId) },
    ]);
    await expect(getMeetingImport(app.db, owner(), room.id, requested.id)).resolves.toMatchObject({
      status: 'completed',
    });
    const view = await getMeeting(app.db, owner(), room.id);
    expect(view.currentNotes).toMatchObject({ id: requested.id, version: 1, text });
    const events = await withTenantTx(app.db, owner(), (tx) =>
      tx
        .select({ payload: domainEvents.payload })
        .from(domainEvents)
        .where(eq(domainEvents.aggregateId, requested.id)),
    );
    expect(events).toEqual([{ payload: { meeting_id: room.id } }]);
    expect(JSON.stringify(events)).not.toContain(room.externalId);
  });

  it('refuses cross-tenant and service requests, lack of consent, and lack of an exact ACL grant', async () => {
    const room = await fixture({ consent: false });
    const args = { meetingId: room.id, providerApprovalId: room.providerApprovalId };
    await expect(queue(room)).rejects.toMatchObject(code('CONSENT_INCOMPLETE'));
    await expect(
      requestMeetingNotesImport(app.db, pair.b.owner.context, args),
    ).rejects.toMatchObject(code('NOT_FOUND'));
    await expect(
      requestMeetingNotesImport(connector.db, createServiceContext(org()), args),
    ).rejects.toMatchObject(code('FORBIDDEN'));
    await expect(
      requestMeetingNotesImport(app.db, pair.a.admin.context, args),
    ).rejects.toMatchObject(code('NOT_FOUND'));
    await expect(queue(await fixture({ acl: false }))).rejects.toMatchObject(code('NOT_FOUND'));
  });

  it('blocks missing and revoked provider grants before a connection opens', async () => {
    const room = await fixture();
    await expect(queue({ ...room, providerApprovalId: randomUUID() })).rejects.toMatchObject(
      code('PROVIDER_NOT_APPROVED'),
    );
    const requested = await queue(room);
    await revokeMeetingProvider(app.db, owner(), { providerApprovalId: room.providerApprovalId });
    const fake = source(room.externalId);
    await expect(activity(fake).readMeetingNotes(input(requested.id))).resolves.toBe('refused');
    expect(fake.opened()).toBe(0);
    expect(await requestStatus(requested.id)).toMatchObject({
      statusCode: 'PROVIDER_NOT_APPROVED',
    });
  });

  it('rechecks after obtaining the gateway and refuses source permission loss before sending the GET', async () => {
    const room = await fixture();
    const requested = await queue(room);
    const fake = source(room.externalId);
    const network = {
      openRelay: async (...args: Parameters<typeof fake.network.openRelay>) => {
        await withTenantTx(app.db, owner(), (tx) =>
          tx.delete(externalResourceAcl).where(eq(externalResourceAcl.resourceId, room.resourceId)),
        );
        return fake.network.openRelay(...args);
      },
    };
    const worker = createMeetingImportConnectorActivities({
      database: connector.db,
      registry,
      network,
      secrets: broker,
      activity: () => ({ temporalRunId: randomUUID(), signal: new AbortController().signal }),
    });
    await expect(worker.readMeetingNotes(input(requested.id))).resolves.toBe('refused');
    expect(fake.requests()).toHaveLength(0);
    expect(await requestStatus(requested.id)).toMatchObject({ statusCode: 'SOURCE_NOT_FOUND' });
  });

  it('discards a generated reply when consent is withdrawn while the read completes', async () => {
    const room = await fixture();
    const requested = await queue(room);
    const fake = source(room.externalId);
    const gate = {
      revoke: broker.revoke.bind(broker),
      withSecret: async <T>(
        ref: Parameters<SecretBroker['withSecret']>[0],
        use: (value: Buffer) => Promise<T>,
      ) => {
        const reply = await broker.withSecret(ref, use);
        await recordMeetingConsent(app.db, owner(), {
          meetingId: room.id,
          participantId: room.organizerParticipantId,
          decision: 'withdrawn',
          noticeRef: TEST_NOTICE,
        });
        return reply;
      },
    };
    const worker = createMeetingImportConnectorActivities({
      database: connector.db,
      registry,
      network: fake.network,
      secrets: gate,
      activity: () => ({ temporalRunId: randomUUID(), signal: new AbortController().signal }),
    });
    await expect(worker.readMeetingNotes(input(requested.id))).resolves.toBe('refused');
    expect(fake.requests()).toHaveLength(1);
    const rows = await withTenantTx(app.db, owner(), (tx) =>
      tx.select().from(meetingNotes).where(eq(meetingNotes.meetingId, room.id)),
    );
    expect(rows).toEqual([]);
    expect(await requestStatus(requested.id)).toMatchObject({ statusCode: 'CONSENT_WITHDRAWN' });
  });

  it('rejects web-role binding and writes, and can settle a request when the connector never polled', async () => {
    const room = await fixture();
    const requested = await queue(room);
    const temporalRunId = randomUUID();
    await expect(
      beginMeetingImport(app.db, createServiceContext(org()), {
        importRequestId: requested.id,
        temporalRunId,
      }),
    ).rejects.toMatchObject(code('FORBIDDEN'));
    await expect(
      withTenantTx(app.db, owner(), (tx) =>
        tx
          .update(meetingImportRequests)
          .set({ temporalRunId })
          .where(eq(meetingImportRequests.id, requested.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      withTenantTx(app.db, owner(), (tx) =>
        tx.insert(meetingNotes).values({
          organizationId: org(),
          id: requested.id,
          meetingId: room.id,
          version: 1,
          sourceKind: 'connector',
          sourceApprovalId: room.providerApprovalId,
          classification: 'confidential',
          body: text,
          bodySha256: createHash('sha256').update(text).digest('hex'),
          sizeBytes: Buffer.byteLength(text),
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    const fallback = createMeetingImportPlatformActivities({
      database: platform.db,
      activity: () => ({ temporalRunId, signal: new AbortController().signal }),
    });
    await expect(fallback.stopUnreadImport(input(requested.id))).resolves.toBe('failed');
    const fake = source(room.externalId);
    await expect(activity(fake).readMeetingNotes(input(requested.id))).resolves.toBe('failed');
    expect(fake.requests()).toHaveLength(0);
    expect(await requestStatus(requested.id)).toMatchObject({
      statusCode: 'CONNECTOR_UNAVAILABLE',
    });
  });
});
