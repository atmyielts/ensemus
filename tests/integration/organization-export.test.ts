// COMM-05 out, QA-024, SEC-016, ADR-030 D6, D7 and D10. Real PostgreSQL and real roles, with an object store in
// memory. Every archive here is opened with its private key and searched: what matters is what is in the parts,
// which nothing but the holder of that key could otherwise see.
//
// Needs migrations 0300 and 0301 in the journal, which the final merge stitches. Until then this cannot pass, and
// it has never run. Generated values only: `@example.invalid`, generated keys, and canaries made up here.
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  addArtifact,
  addTeamMember,
  beginExport,
  CORE_PORTABILITY_SECTIONS,
  createClient,
  createInvitation,
  createProject,
  createTeam,
  createWorkUnit,
  deleteArtifact,
  exportNextBatch,
  ExportStoreUnavailable,
  failExport,
  finishExport,
  getOrganizationExport,
  listOrganizationExports,
  openExportArchive,
  purgeExpiredExports,
  requestOrganizationExport,
  requestWorkReview,
  transitionWorkUnit,
  type ExportDeps,
  type ExportStep,
  type ObjectStore,
  type PortabilitySection,
} from '@ensemus/application';
import { exportManifestSchema, type ExportManifest } from '@ensemus/contracts/portability-records';
import {
  artifacts,
  connections,
  createOrganization,
  domainEvents,
  notifications,
  openAppDatabase,
  organizationExportParts,
  organizationExports,
  resolveTenantContext,
  sealedSecrets,
  webhookEndpoints,
  withTenantTx,
  workArtifacts,
  workAssignments,
  workDependencies,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  artifactPartPath,
  EXPORT_MANIFEST_PATH,
  EXPORT_OBJECT_PREFIX,
  isArchivePath,
} from '@ensemus/domain/portability';
import {
  exportTargetRef,
  ORGANIZATION_EXPORT_READY,
  ORGANIZATION_EXPORT_REQUESTED,
} from '@ensemus/domain/sovereign-events';
import { open } from '@ensemus/sovereign/sealed';
import { readTarEntries } from '@ensemus/sovereign/tar';
import { createPortabilityActivities } from '@ensemus/workflows/portability-activities';
import { and, eq } from 'drizzle-orm';
import { seedExportRow, sha256Hex, testRecipient } from '../helpers/sovereign';
import { seedConnection, seedExternalAction } from '../helpers/integrations';
import { urls } from '../helpers/stack';

/** A store in memory, which remembers what was asked of it and can be told to fail. */
class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  readonly puts: string[] = [];
  readonly gets: string[] = [];
  failNextPut = false;
  async put(key: string, body: Buffer) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('store text that must not travel');
    }
    this.puts.push(key);
    this.objects.set(key, body);
  }
  async get(key: string) {
    this.gets.push(key);
    const body = this.objects.get(key);
    if (!body) throw new Error('missing');
    return body;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  exportKeys() {
    return [...this.objects.keys()].filter((key) => key.startsWith(EXPORT_OBJECT_PREFIX));
  }
}

const NOW = () => new Date();
const deps: ExportDeps = {
  sections: CORE_PORTABILITY_SECTIONS,
  sourceRelease: 'test-release',
  retentionHours: 24,
};

type Opened = { manifest: ExportManifest; parts: Map<string, Buffer>; text: string };

describe('organization export', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let su: pg.Client;
  const db = () => app.db;
  const recipient = testRecipient();

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

  /** Two tenants get the same organization name, on purpose. */
  async function newOrg(): Promise<TenantContext> {
    const user = await makeUser('owner');
    const { organizationId } = await createOrganization(db(), {
      userId: user.id,
      name: 'Same Name Ltd',
      commercialMode: 'sovereign',
    });
    return resolveTenantContext(db(), user.id, organizationId);
  }

  async function join(context: TenantContext, label: string, role: 'admin' | 'member') {
    const user = await makeUser(label);
    const { token } = await createInvitation(db(), context, { email: user.email, role });
    await acceptInvitation(db(), {
      token,
      userId: user.id,
      email: user.email,
      emailVerified: true,
    });
    return resolveTenantContext(db(), user.id, context.organizationId);
  }

  const worker = (context: TenantContext) => createServiceContext(context.organizationId);

  const request = async (context: TenantContext) =>
    (
      await requestOrganizationExport(db(), context, {
        recipientPublicKey: recipient.publicKeyBase64,
        sourceRelease: 'test-release',
      })
    ).id;

  /** What the workflow does, without the workflow. */
  async function drive(
    context: TenantContext,
    store: ObjectStore,
    exportId: string,
    using: ExportDeps = deps,
    untilBatchesDone?: () => Promise<void>,
  ): Promise<ExportStep> {
    const service = worker(context);
    let step = await beginExport(db(), service, { exportId }, using);
    while (step.state === 'continue') {
      step = await exportNextBatch(db(), store, service, { exportId }, using);
    }
    if (step.state === 'failed') return step;
    await untilBatchesDone?.();
    step = await finishExport(db(), store, service, { exportId }, using);
    while (step.state === 'continue') {
      step = await finishExport(db(), store, service, { exportId }, using);
    }
    return step;
  }

  /** Downloads it as an owner would, and opens every part as the holder of the private key would. */
  async function downloadAndOpen(
    context: TenantContext,
    store: ObjectStore,
    exportId: string,
  ): Promise<Opened> {
    const archive = await openExportArchive(db(), store, context, exportId);
    const chunks: Buffer[] = [];
    for await (const chunk of archive.chunks) chunks.push(chunk);
    const tar = Buffer.concat(chunks);
    expect(tar.length).toBe(archive.totalBytes);
    expect(archive.fileName).not.toContain('Same Name');

    const read = async (offset: number, length: number) => tar.subarray(offset, offset + length);
    const entries: { path: string; body: Buffer }[] = [];
    for await (const entry of readTarEntries(read, tar.length)) {
      expect(isArchivePath(entry.path)).toBe(true);
      entries.push({ path: entry.path, body: await read(entry.offset, entry.size) });
    }
    expect(entries[0]?.path).toBe(EXPORT_MANIFEST_PATH);
    const manifest = exportManifestSchema.parse(
      JSON.parse(open(entries[0]!.body, recipient.privateKey).toString('utf8')),
    );

    // Each part the manifest lists is there, with the hashes it gives, and nothing else is.
    const listed = new Map(manifest.parts.map((part) => [part.path, part]));
    expect(
      entries
        .slice(1)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([...listed.keys()].sort());
    const parts = new Map<string, Buffer>();
    for (const { path, body } of entries.slice(1)) {
      const part = listed.get(path)!;
      expect(body.length).toBe(part.sealed_bytes);
      expect(sha256Hex(body)).toBe(part.sealed_sha256);
      const plain = open(body, recipient.privateKey);
      expect(sha256Hex(plain)).toBe(part.plaintext_sha256);
      parts.set(path, plain);
    }
    const text = [...parts.values()].map((part) => part.toString('latin1')).join('\n');
    return { manifest, parts, text: `${text}\n${tar.toString('latin1')}` };
  }

  /** Every record of one kind in an opened archive. */
  function recordsOf(opened: Opened, kind: string) {
    const found: Record<string, unknown>[] = [];
    for (const [path, body] of opened.parts) {
      if (!path.endsWith('.jsonl.sealed')) continue;
      for (const line of body.toString('utf8').split('\n')) {
        if (!line) continue;
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.kind === kind) found.push(record);
      }
    }
    return found;
  }

  const file = (
    context: TenantContext,
    store: ObjectStore,
    workUnitId: string,
    name: string,
    body = `bytes of ${name}`,
  ) =>
    addArtifact(db(), store, context, {
      workUnitId,
      name,
      mimeType: 'text/plain',
      body: Buffer.from(body),
    });

  const work = (
    context: TenantContext,
    title: string,
    classification: 'internal' | 'confidential' | 'restricted' = 'internal',
    objective?: string,
  ) =>
    createWorkUnit(db(), context, {
      title,
      classification,
      ...(objective ? { objective } : {}),
    }) as Promise<{ id: string; version: number }>;

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    su = new pg.Client({ connectionString: urls.superuser() });
    await auth.connect();
    await su.connect();
  });

  afterAll(async () => {
    await app.close();
    await auth.end();
    await su.end();
  });

  describe('who may ask', () => {
    let owner: TenantContext;
    let admin: TenantContext;
    let member: TenantContext;
    let stranger: TenantContext;
    let store: MemoryStore;

    beforeEach(async () => {
      owner = await newOrg();
      admin = await join(owner, 'admin', 'admin');
      member = await join(owner, 'member', 'member');
      stranger = await newOrg();
      store = new MemoryStore();
    });

    it('lets an owner ask, and records the request, its event and its audit entry together', async () => {
      const id = await request(owner);
      const view = await getOrganizationExport(db(), owner, id);
      expect(view).toMatchObject({
        id,
        status: 'requested',
        scope: 'standard',
        recipientKeyId: recipient.keyId,
        downloadable: false,
      });
      const events = await withTenantTx(db(), owner, (tx) =>
        tx.select().from(domainEvents).where(eq(domainEvents.aggregateId, id)),
      );
      expect(events.map((event) => event.eventType)).toEqual([ORGANIZATION_EXPORT_REQUESTED]);
      // IDs only. The recipient's key does not travel, and nor does anything else.
      expect(events[0]?.payload).toEqual({ export_id: id });
      const { rows } = await su.query(
        'select action from governance.audit_events where organization_id = $1 and target_ref = $2',
        [owner.organizationId, exportTargetRef(id)],
      );
      expect(rows.map((row: { action: string }) => row.action)).toEqual([
        'organization_export.requested',
      ]);
    });

    it.each(['admin', 'member'] as const)('refuses an %s at every door', async (who) => {
      const context = who === 'admin' ? admin : member;
      const id = await request(owner);
      await expect(request(context)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(listOrganizationExports(db(), context)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(getOrganizationExport(db(), context, id)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(openExportArchive(db(), store, context, id)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('finds nothing of another tenant, even for its owner', async () => {
      const id = await request(owner);
      await expect(getOrganizationExport(db(), stranger, id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(openExportArchive(db(), store, stranger, id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(await listOrganizationExports(db(), stranger)).toEqual([]);
      // Nor can the worker be pointed at it from the other tenant.
      const elsewhere = worker(stranger);
      await expect(beginExport(db(), elsewhere, { exportId: id }, deps)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        exportNextBatch(db(), store, elsewhere, { exportId: id }, deps),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        failExport(db(), elsewhere, { exportId: id, code: 'SECTION_FAILED' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await getOrganizationExport(db(), owner, id)).status).toBe('requested');
    });

    it('finds nothing for something that is not an ID', async () => {
      await expect(getOrganizationExport(db(), owner, 'not-an-id')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it.each([
      ['an Ed25519 key', () => edPublicKey()],
      ['text that is not a key', () => 'bm90IGEga2V5'],
      ['nothing', () => ''],
      ['far too long', () => 'A'.repeat(4096)],
    ])('refuses %s as the recipient', async (_label, key) => {
      await expect(
        requestOrganizationExport(db(), owner, {
          recipientPublicKey: key(),
          sourceRelease: 'test-release',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await listOrganizationExports(db(), owner)).toEqual([]);
    });

    it('refuses a second running export, and takes another once the first has ended', async () => {
      const first = await request(owner);
      await expect(request(owner)).rejects.toMatchObject({ code: 'EXPORT_ALREADY_RUNNING' });
      // Another tenant has its own place.
      await expect(request(stranger)).resolves.toBeDefined();
      await failExport(db(), worker(owner), { exportId: first, code: 'SECTION_FAILED' });
      await expect(request(owner)).resolves.toBeDefined();
    });

    it('lets only the worker run the steps', async () => {
      const exportId = await request(owner);
      for (const context of [owner, admin, member]) {
        await expect(beginExport(db(), context, { exportId }, deps)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(
          exportNextBatch(db(), store, context, { exportId }, deps),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(finishExport(db(), store, context, { exportId }, deps)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(
          failExport(db(), context, { exportId, code: 'SECTION_FAILED' }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(purgeExpiredExports(db(), store, context, NOW())).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      }
    });

    it('will not read a row nothing has claimed', async () => {
      const exportId = await request(owner);
      await expect(
        exportNextBatch(db(), store, worker(owner), { exportId }, deps),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    });

    it('will not hand over what is not ready', async () => {
      const exportId = await request(owner);
      await expect(openExportArchive(db(), store, owner, exportId)).rejects.toMatchObject({
        code: 'EXPORT_NOT_READY',
      });
      await beginExport(db(), worker(owner), { exportId }, deps);
      await expect(openExportArchive(db(), store, owner, exportId)).rejects.toMatchObject({
        code: 'EXPORT_NOT_READY',
      });
    });
  });

  describe('what is in an archive', () => {
    const OPEN_TITLE = `open-work-${randomUUID()}`;
    const OPEN_FILE_NAME = `open-file-${randomUUID()}.txt`;
    const OPEN_FILE_BYTES = `open-bytes-${randomUUID()}`;
    const LINKED_BOTH_NAME = `linked-both-${randomUUID()}.txt`;
    const RESTRICTED_TITLE = `restricted-title-${randomUUID()}`;
    const RESTRICTED_OBJECTIVE = `restricted-objective-${randomUUID()}`;
    const RESTRICTED_FILE_NAME = `restricted-file-${randomUUID()}.txt`;
    const RESTRICTED_FILE_BYTES = `restricted-bytes-${randomUUID()}`;
    const ONLY_LINKED_NAME = `only-linked-${randomUUID()}.txt`;
    const ONLY_LINKED_BYTES = `only-linked-bytes-${randomUUID()}`;
    const RESTRICTED_CLIENT = `restricted-client-${randomUUID()}`;
    const RESTRICTED_REASON = `restricted-reason-${randomUUID()}`;
    const RESTRICTED_PAYLOAD = `restricted-payload-${randomUUID()}`;
    const OTHER_OBJECTIVE = `other-tenant-objective-${randomUUID()}`;
    const OTHER_FILE_BYTES = `other-tenant-bytes-${randomUUID()}`;
    const OTHER_CLIENT = `other-tenant-client-${randomUUID()}`;
    const SHARED_TITLE = 'A name both tenants use';
    // QA-024, SEC-016. Each goes where a credential could be, and none may reach a part.
    const KEY_IN_CREDENTIAL = `canary-credential-${randomBytes(16).toString('hex')}`;
    const KEY_IN_CONFIG = `canary-config-${randomBytes(16).toString('hex')}`;
    const KEY_IN_WEBHOOK = `canary-webhook-${randomBytes(16).toString('hex')}`;

    let owner: TenantContext;
    let other: TenantContext;
    let store: MemoryStore;
    let opened: Opened;
    let exportId: string;
    let invitationToken: string;
    let otherWorkId: string;
    let restrictedWorkId: string;
    let restrictedFileId: string;
    let onlyLinkedFileId: string;
    let openWorkId: string;
    let openFileId: string;
    let deletedBeforeId: string;
    let reviewerId: string;

    const sealedSecret = (context: TenantContext, plaintext: string) => {
      const id = randomUUID();
      return withTenantTx(db(), context, async (tx) => {
        await tx.insert(sealedSecrets).values({
          organizationId: context.organizationId,
          id,
          purpose: 'connector_credential',
          keyId: 'test',
          wrappedKey: randomBytes(32),
          iv: randomBytes(12),
          // Not really sealed, which makes this the worst case: if this table were read, it would show.
          ciphertext: Buffer.from(plaintext),
          authTag: randomBytes(16),
        });
        return id;
      });
    };

    beforeAll(async () => {
      store = new MemoryStore();
      owner = await newOrg();
      other = await newOrg();
      const reviewer = await join(owner, 'reviewer', 'admin');
      reviewerId = reviewer.membershipId;

      // Every kind of record.
      const team = (await createTeam(db(), owner, { name: 'Same team name' })) as { id: string };
      await addTeamMember(db(), owner, { teamId: team.id, membershipId: owner.membershipId });
      const client = (await createClient(db(), owner, {
        displayName: 'Same client name',
        classification: 'confidential',
      })) as { id: string };
      const hidden = (await createClient(db(), owner, {
        displayName: RESTRICTED_CLIENT,
        classification: 'restricted',
      })) as { id: string };
      await createProject(db(), owner, { name: 'Same project name', clientId: client.id });
      const underHidden = (await createProject(db(), owner, {
        name: 'Project under a restricted client',
        clientId: hidden.id,
      })) as { id: string };

      const open = await work(owner, OPEN_TITLE, 'internal', 'An open objective');
      const second = await work(owner, SHARED_TITLE, 'confidential');
      const restricted = await work(owner, RESTRICTED_TITLE, 'restricted', RESTRICTED_OBJECTIVE);
      openWorkId = open.id;
      restrictedWorkId = restricted.id;

      openFileId = (await file(owner, store, open.id, OPEN_FILE_NAME, OPEN_FILE_BYTES)).id;
      const both = await file(owner, store, open.id, LINKED_BOTH_NAME);
      restrictedFileId = (
        await file(owner, store, restricted.id, RESTRICTED_FILE_NAME, RESTRICTED_FILE_BYTES)
      ).id;
      // Internal by its own class, and linked only to restricted work, so it stays out all the same.
      onlyLinkedFileId = randomUUID();
      const organizationId = owner.organizationId;
      await withTenantTx(db(), owner, async (tx) => {
        const key = `${organizationId}/artifacts/${onlyLinkedFileId}`;
        store.objects.set(key, Buffer.from(ONLY_LINKED_BYTES));
        await tx.insert(artifacts).values({
          organizationId,
          id: onlyLinkedFileId,
          name: ONLY_LINKED_NAME,
          objectKey: key,
          sha256: sha256Hex(ONLY_LINKED_BYTES),
          mimeType: 'text/plain',
          sizeBytes: ONLY_LINKED_BYTES.length,
          classification: 'internal',
        });
        await tx.insert(workArtifacts).values([
          { organizationId, workUnitId: restricted.id, artifactId: onlyLinkedFileId },
          // Linked to both, so it is exported, and only the link to restricted work stays out.
          { organizationId, workUnitId: restricted.id, artifactId: both.id },
        ]);
        await tx.insert(workDependencies).values([
          { organizationId, prerequisiteId: open.id, dependentId: second.id },
          { organizationId, prerequisiteId: open.id, dependentId: restricted.id },
        ]);
        await tx.insert(workAssignments).values([
          { organizationId, workUnitId: second.id, membershipId: reviewerId },
          { organizationId, workUnitId: restricted.id, membershipId: reviewerId },
        ]);
      });

      // Deleted before anything started, so its bytes must never even be read.
      const doomed = await file(owner, store, open.id, 'deleted-before.txt');
      deletedBeforeId = doomed.id;
      await deleteArtifact(db(), store, owner, { workUnitId: open.id, artifactId: doomed.id });

      // History on both sides of the line.
      await transitionWorkUnit(db(), owner, {
        id: second.id,
        expectedVersion: second.version,
        to: 'ready',
        reason: 'An open reason',
      });
      await transitionWorkUnit(db(), owner, {
        id: restricted.id,
        expectedVersion: restricted.version,
        to: 'ready',
        reason: RESTRICTED_REASON,
      });
      const restrictedNow = (await su.query(
        'select version from work.work_units where organization_id = $1 and id = $2',
        [organizationId, restricted.id],
      )) as { rows: { version: string }[] };
      await requestWorkReview(db(), owner, {
        workUnitId: restricted.id,
        expectedVersion: Number(restrictedNow.rows[0]?.version),
        approverMembershipId: reviewerId,
      });

      const credentialId = await sealedSecret(owner, KEY_IN_CREDENTIAL);
      const connectionId = await seedConnection(db(), owner, {
        displayName: 'Same connection name',
        credentialSecretId: credentialId,
        config: { api_key: KEY_IN_CONFIG },
      });
      const webhookSecretId = await sealedSecret(owner, KEY_IN_WEBHOOK);
      await withTenantTx(db(), owner, (tx) =>
        tx.insert(webhookEndpoints).values({
          organizationId,
          connectionId,
          tokenHash: createHash('sha256').update(KEY_IN_WEBHOOK).digest('hex'),
          signingSecretId: webhookSecretId,
          signatureScheme: 'test',
        }),
      );
      invitationToken = (
        await createInvitation(db(), owner, {
          email: `invited-${randomUUID()}@example.invalid`,
          role: 'member',
        })
      ).token;
      await seedExternalAction(db(), owner, {
        workUnitId: open.id,
        connectionId,
        approverMembershipId: reviewerId,
        status: 'sent',
      });
      // Seeded while open and then made restricted, since an intent cannot start on restricted work.
      const madeRestricted = await work(owner, 'Becomes restricted');
      await seedExternalAction(db(), owner, {
        workUnitId: madeRestricted.id,
        connectionId,
        approverMembershipId: reviewerId,
        status: 'sent',
        payload: { to: ['recipient@example.invalid'], subject: RESTRICTED_PAYLOAD },
      });
      await su.query(
        `update work.work_units set classification = 'restricted' where organization_id = $1 and id = $2`,
        [organizationId, madeRestricted.id],
      );

      // The other tenant has the same names, and its own words.
      const otherWork = await work(other, SHARED_TITLE, 'internal', OTHER_OBJECTIVE);
      otherWorkId = otherWork.id;
      await file(other, store, otherWork.id, OPEN_FILE_NAME, OTHER_FILE_BYTES);
      await createClient(db(), other, { displayName: OTHER_CLIENT });
      await createClient(db(), other, { displayName: 'Same client name' });
      await createTeam(db(), other, { name: 'Same team name' });

      exportId = await request(owner);
      store.gets.length = 0;
      const step = await drive(owner, store, exportId);
      expect(step.state).toBe('finished');
      opened = await downloadAndOpen(owner, store, exportId);

      // Used only to show the project stays, without its link to the restricted client.
      expect(underHidden.id).toBeDefined();
    }, 120_000);

    it('holds the records of every kind', () => {
      for (const kind of [
        'organization',
        'person',
        'team',
        'team_membership',
        'client',
        'project',
        'work_unit',
        'work_dependency',
        'work_assignment',
        'artifact',
        'work_artifact',
        'tombstone',
        'connection',
        'history',
      ]) {
        expect(recordsOf(opened, kind).length, kind).toBeGreaterThan(0);
      }
      expect(opened.text).toContain(OPEN_TITLE);
      expect(opened.text).toContain(OPEN_FILE_NAME);
    });

    it('holds a file exactly as it was, under its own ID', () => {
      expect(opened.parts.get(artifactPartPath(openFileId))?.toString()).toBe(OPEN_FILE_BYTES);
      const record = recordsOf(opened, 'artifact').find((row) => row.id === openFileId);
      expect(record?.sha256).toBe(sha256Hex(OPEN_FILE_BYTES));
    });

    it('names no tenant in any record', () => {
      for (const [path, body] of opened.parts) {
        if (path.endsWith('.jsonl.sealed')) {
          expect(body.toString()).not.toContain(owner.organizationId);
        }
      }
    });

    it('has a manifest that adds up, and shows sections with nothing in them', () => {
      const { manifest } = opened;
      expect(manifest.export_id).toBe(exportId);
      expect(manifest.organization_id).toBe(owner.organizationId);
      expect(manifest.encryption.recipient_key_id).toBe(recipient.keyId);
      expect(manifest.source_release).toBe('test-release');
      expect(manifest.scope).toBe('standard');
      const sum = manifest.parts.reduce((total, part) => total + part.records, 0);
      const bySection = Object.values(manifest.sections).reduce(
        (total, section) => total + section.records,
        0,
      );
      expect(bySection).toBe(sum);
      expect(manifest.sections.knowledge).toEqual({ records: 0, parts: 0 });
      expect(manifest.sections['custom-objects']).toEqual({ records: 0, parts: 0 });
    });

    it('agrees with its row', async () => {
      const view = await getOrganizationExport(db(), owner, exportId);
      expect(view.status).toBe('ready');
      expect(view.partCount).toBe(opened.manifest.parts.length);
      expect(view.recordCount).toBe(
        opened.manifest.parts.reduce((total, part) => total + part.records, 0),
      );
      expect(view.downloadable).toBe(true);
    });

    it('leaves restricted work out, with everything hanging off it', () => {
      for (const words of [
        RESTRICTED_TITLE,
        RESTRICTED_OBJECTIVE,
        RESTRICTED_REASON,
        RESTRICTED_PAYLOAD,
        restrictedWorkId,
      ]) {
        expect(opened.text).not.toContain(words);
      }
    });

    it('leaves restricted clients and files out, and a file linked only to restricted work', () => {
      for (const words of [
        RESTRICTED_CLIENT,
        RESTRICTED_FILE_NAME,
        RESTRICTED_FILE_BYTES,
        restrictedFileId,
        ONLY_LINKED_NAME,
        ONLY_LINKED_BYTES,
        onlyLinkedFileId,
      ]) {
        expect(opened.text).not.toContain(words);
      }
      expect(opened.parts.has(artifactPartPath(onlyLinkedFileId))).toBe(false);
    });

    it('keeps a file linked to both, and drops only the link to restricted work', () => {
      expect(opened.text).toContain(LINKED_BOTH_NAME);
      const links = recordsOf(opened, 'work_artifact');
      expect(links.every((link) => link.work_unit_id !== restrictedWorkId)).toBe(true);
    });

    it('keeps a project under a restricted client, without saying which client', () => {
      const project = recordsOf(opened, 'project').find(
        (row) => row.name === 'Project under a restricted client',
      );
      expect(project?.client_id).toBeNull();
    });

    it('counts all that was left out, so nothing is missing silently', async () => {
      // Two restricted Work Units, including the one reclassified after its intent.
      expect(opened.manifest.excluded).toEqual({
        restricted_work: 2,
        restricted_artifacts: 2,
        restricted_clients: 1,
      });
      const view = await getOrganizationExport(db(), owner, exportId);
      expect(view.excluded).toEqual({
        restrictedWork: 2,
        restrictedArtifacts: 2,
        restrictedClients: 1,
      });
    });

    it('has nothing of the other tenant, whose names are the same', () => {
      for (const words of [OTHER_OBJECTIVE, OTHER_FILE_BYTES, OTHER_CLIENT, otherWorkId]) {
        expect(opened.text).not.toContain(words);
      }
      expect(opened.text).not.toContain(other.organizationId);
      expect(opened.text).not.toContain(other.membershipId);
      expect(recordsOf(opened, 'organization')).toHaveLength(1);
      expect(recordsOf(opened, 'client').map((row) => row.display_name)).toEqual([
        'Same client name',
      ]);
    });

    it('has no credential in it, wherever one could be (QA-024, SEC-016)', () => {
      for (const canary of [
        KEY_IN_CREDENTIAL,
        KEY_IN_CONFIG,
        KEY_IN_WEBHOOK,
        createHash('sha256').update(KEY_IN_WEBHOOK).digest('hex'),
        invitationToken,
        createHash('sha256').update(invitationToken).digest('hex'),
      ]) {
        expect(opened.text).not.toContain(canary);
      }
      for (const connection of recordsOf(opened, 'connection')) {
        expect(Object.keys(connection).sort()).toEqual([
          'connector_type',
          'created_at',
          'display_name',
          'granted_scopes',
          'id',
          'kind',
        ]);
      }
    });

    it('has no account behind a person, and only what the schema allows about them', () => {
      expect(opened.text).not.toContain(owner.userId);
      for (const person of recordsOf(opened, 'person')) {
        expect(Object.keys(person).sort()).toEqual([
          'created_at',
          'display_name',
          'email',
          'kind',
          'membership_id',
          'role',
          'status',
        ]);
      }
    });

    it('redacts the audit log to what it promises', () => {
      const audit = recordsOf(opened, 'history').filter((row) => row.record_type === 'audit_event');
      expect(audit.length).toBeGreaterThan(0);
      for (const row of audit) {
        expect(Object.keys(row.record as object).sort()).toEqual([
          'action',
          'actor_membership_id',
          'decision',
          'reason_code',
          'target_ref',
        ]);
        expect((row.record as { target_ref: string }).target_ref).not.toContain(restrictedWorkId);
      }
    });

    it('keeps history for open work', () => {
      const history = recordsOf(opened, 'history');
      expect(history.some((row) => row.record_type === 'work_transition')).toBe(true);
      expect(history.some((row) => row.record_type === 'external_action')).toBe(true);
      expect(history.every((row) => row.work_unit_id !== restrictedWorkId)).toBe(true);
    });

    it('never reads a file that had already been deleted', () => {
      expect(store.gets.some((key) => key.includes(deletedBeforeId))).toBe(false);
      expect(opened.parts.has(artifactPartPath(deletedBeforeId))).toBe(false);
      expect(opened.text).not.toContain('deleted-before.txt');
      expect(recordsOf(opened, 'tombstone').map((row) => row.target_id)).toContain(deletedBeforeId);
    });

    it('never reads a restricted file', () => {
      const restricted = [restrictedFileId, onlyLinkedFileId];
      const read = store.gets.filter((key) => !key.startsWith(EXPORT_OBJECT_PREFIX));
      for (const id of restricted) {
        expect(read.some((key) => key.includes(id))).toBe(false);
      }
      expect(read.some((key) => key.includes(openFileId))).toBe(true);
    });

    it('holds only sealed bytes in the store', () => {
      for (const key of store.exportKeys()) {
        const bytes = store.objects.get(key)!.toString('latin1');
        expect(bytes).not.toContain(OPEN_TITLE);
        expect(bytes).not.toContain(OPEN_FILE_BYTES);
      }
    });

    it('tells whoever asked, and records it as ready', async () => {
      const sent = await withTenantTx(db(), owner, (tx) =>
        tx
          .select()
          .from(notifications)
          .where(eq(notifications.targetRef, exportTargetRef(exportId))),
      );
      expect(sent.map((row) => row.recipientMembershipId)).toEqual([owner.membershipId]);
      const events = await withTenantTx(db(), owner, (tx) =>
        tx.select().from(domainEvents).where(eq(domainEvents.aggregateId, exportId)),
      );
      expect(events.map((event) => event.eventType)).toContain(ORGANIZATION_EXPORT_READY);
      expect(openWorkId).toBeDefined();
    });

    it('audits who took it', async () => {
      const { rows } = await su.query(
        `select actor_id from governance.audit_events
         where organization_id = $1 and action = 'organization_export.downloaded' and target_ref = $2`,
        [owner.organizationId, exportTargetRef(exportId)],
      );
      expect(rows.map((row: { actor_id: string }) => row.actor_id)).toContain(owner.membershipId);
    });

    it('answers the same when any step is asked again, and writes nothing', async () => {
      const service = worker(owner);
      const before = store.puts.length;
      for (const step of [
        await beginExport(db(), service, { exportId }, deps),
        await exportNextBatch(db(), store, service, { exportId }, deps),
        await finishExport(db(), store, service, { exportId }, deps),
      ]) {
        expect(step.state).toBe('finished');
      }
      expect(store.puts.length).toBe(before);
    });
  });

  describe('a step tried again', () => {
    let owner: TenantContext;
    let store: MemoryStore;
    let exportId: string;

    beforeEach(async () => {
      owner = await newOrg();
      store = new MemoryStore();
      await createClient(db(), owner, { displayName: 'Same client name' });
      exportId = await request(owner);
      await beginExport(db(), worker(owner), { exportId }, deps);
    });

    const partRows = () =>
      withTenantTx(db(), owner, (tx) =>
        tx
          .select()
          .from(organizationExportParts)
          .where(eq(organizationExportParts.exportId, exportId)),
      );

    it('says only that the store failed, and repeats nothing when tried again', async () => {
      store.failNextPut = true;
      const error = await exportNextBatch(db(), store, worker(owner), { exportId }, deps).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ExportStoreUnavailable);
      expect(String((error as Error).message)).not.toContain('must not travel');
      expect(await partRows()).toEqual([]);

      const step = await exportNextBatch(db(), store, worker(owner), { exportId }, deps);
      expect(step).toEqual({ state: 'continue', parts: 1, records: 1 });
      const rows = await partRows();
      expect(rows).toHaveLength(1);
      expect(sha256Hex(store.objects.get(rows[0]!.objectKey)!)).toBe(rows[0]!.sealedSha256);
    });

    it('keeps one part when the first try wrote its bytes and never recorded them', async () => {
      // An attempt that dies after the store took its bytes and before its transaction: the bytes, and no row.
      const dying: ObjectStore = {
        put: async (key, body) => {
          await store.put(key, body);
          throw new Error('died here');
        },
        get: (key) => store.get(key),
        delete: (key) => store.delete(key),
        exists: (key) => store.exists(key),
      };
      await expect(
        exportNextBatch(db(), dying, worker(owner), { exportId }, deps),
      ).rejects.toBeInstanceOf(ExportStoreUnavailable);
      expect(store.exportKeys()).toHaveLength(1);
      expect(await partRows()).toEqual([]);

      const step = await exportNextBatch(db(), store, worker(owner), { exportId }, deps);
      expect(step).toEqual({ state: 'continue', parts: 1, records: 1 });
      // The same place, so the same key, and what is stored is what was recorded.
      const rows = await partRows();
      expect(rows).toHaveLength(1);
      expect(store.exportKeys()).toEqual([rows[0]!.objectKey]);
      expect(sha256Hex(store.objects.get(rows[0]!.objectKey)!)).toBe(rows[0]!.sealedSha256);
    });

    it('moves on once per call, writing no path twice', async () => {
      const service = worker(owner);
      await exportNextBatch(db(), store, service, { exportId }, deps);
      await exportNextBatch(db(), store, service, { exportId }, deps);
      expect(new Set(store.puts).size).toBe(store.puts.length);
    });

    it('lets one of two attempts at the same step win', async () => {
      const service = worker(owner);
      const answers = await Promise.all([
        exportNextBatch(db(), store, service, { exportId }, deps),
        exportNextBatch(db(), store, service, { exportId }, deps),
      ]);
      expect(answers.every((answer) => answer.state === 'continue')).toBe(true);
      const rows = await partRows();
      const [row] = await withTenantTx(db(), owner, (tx) =>
        tx
          .select()
          .from(organizationExports)
          .where(
            and(
              eq(organizationExports.organizationId, owner.organizationId),
              eq(organizationExports.id, exportId),
            ),
          ),
      );
      expect(row?.partCount).toBe(rows.length);
    });

    it('finishes correctly after every step has been repeated', async () => {
      const service = worker(owner);
      let step = await exportNextBatch(db(), store, service, { exportId }, deps);
      while (step.state === 'continue') {
        await exportNextBatch(db(), store, service, { exportId }, deps);
        step = await exportNextBatch(db(), store, service, { exportId }, deps);
      }
      step = await finishExport(db(), store, service, { exportId }, deps);
      while (step.state === 'continue') {
        step = await finishExport(db(), store, service, { exportId }, deps);
      }
      expect(step.state).toBe('finished');
      const { manifest } = await downloadAndOpen(owner, store, exportId);
      expect(manifest.sections.clients?.records).toBe(1);
    });
  });

  describe('bytes that are not what they should be', () => {
    let owner: TenantContext;
    let store: MemoryStore;
    let fileKey: string;
    let exportId: string;

    beforeEach(async () => {
      owner = await newOrg();
      store = new MemoryStore();
      const unit = await work(owner, 'Has a file');
      const { id } = await file(owner, store, unit.id, 'kept.txt');
      fileKey = `${owner.organizationId}/artifacts/${id}`;
      exportId = await request(owner);
    });

    it('stops with BYTES_CHANGED, and writes none of them', async () => {
      store.objects.set(fileKey, Buffer.from('bytes somebody changed'));
      expect(await drive(owner, store, exportId)).toEqual({
        state: 'failed',
        code: 'BYTES_CHANGED',
      });
      const view = await getOrganizationExport(db(), owner, exportId);
      expect(view).toMatchObject({ status: 'failed', failureCode: 'BYTES_CHANGED' });
      for (const key of store.exportKeys()) {
        expect(store.objects.get(key)!.toString('latin1')).not.toContain('somebody changed');
      }
    });

    it('stops with BYTES_MISSING', async () => {
      store.objects.delete(fileKey);
      expect(await drive(owner, store, exportId)).toEqual({
        state: 'failed',
        code: 'BYTES_MISSING',
      });
    });

    it('treats a store that cannot say as an outage, and tries again', async () => {
      const down: ObjectStore = {
        put: (key, body) => store.put(key, body),
        delete: (...args) => store.delete(...args),
        get: async () => {
          throw new Error('down');
        },
        exists: async () => {
          throw new Error('down');
        },
      };
      const service = worker(owner);
      await beginExport(db(), service, { exportId }, deps);
      let failure: unknown;
      for (let i = 0; i < 40 && !failure; i += 1) {
        await exportNextBatch(db(), down, service, { exportId }, deps).catch((caught: unknown) => {
          failure = caught;
        });
      }
      expect(failure).toBeInstanceOf(ExportStoreUnavailable);
      expect((await getOrganizationExport(db(), owner, exportId)).status).toBe('running');
    });
  });

  describe('a record that should not be there', () => {
    let owner: TenantContext;
    let store: MemoryStore;

    beforeEach(async () => {
      owner = await newOrg();
      store = new MemoryStore();
    });

    const usingClients = (records: readonly unknown[]): ExportDeps => ({
      ...deps,
      sections: [
        {
          section: 'clients',
          exportPage: async () => ({ recordKind: 'clients', records, nextCursor: null }),
          importPage: async () => ({ applied: 0 }),
        } satisfies PortabilitySection,
      ],
    });

    it.each([
      [
        'a restricted class',
        {
          kind: 'client',
          id: randomUUID(),
          display_name: 'CANARY-CLIENT',
          classification: 'restricted',
          created_at: new Date().toISOString(),
        },
      ],
      [
        'a field with no place in the schema',
        {
          kind: 'client',
          id: randomUUID(),
          display_name: 'CANARY-CLIENT',
          classification: 'internal',
          created_at: new Date().toISOString(),
          api_key: 'generated-test-value',
        },
      ],
      ['a kind nothing knows', { kind: 'secret', value: 'CANARY-CLIENT' }],
    ])('fails the export with RECORD_REFUSED for %s, writing nothing', async (_label, record) => {
      const exportId = await request(owner);
      const step = await drive(owner, store, exportId, usingClients([record]));
      expect(step).toEqual({ state: 'failed', code: 'RECORD_REFUSED' });
      expect(store.exportKeys()).toEqual([]);
      const view = await getOrganizationExport(db(), owner, exportId);
      expect(view).toMatchObject({ status: 'failed', failureCode: 'RECORD_REFUSED' });
      await expect(openExportArchive(db(), store, owner, exportId)).rejects.toMatchObject({
        code: 'EXPORT_NOT_READY',
      });
      // A code and nothing else, in the row and in the audit log.
      const { rows } = await su.query(
        'select * from sovereign.organization_exports where id = $1',
        [exportId],
      );
      expect(JSON.stringify(rows[0])).not.toContain('CANARY-CLIENT');
    });

    it('does not let a late failure undo a ready archive', async () => {
      const exportId = await request(owner);
      expect((await drive(owner, store, exportId)).state).toBe('finished');
      await failExport(db(), worker(owner), { exportId, code: 'SECTION_FAILED' });
      expect((await getOrganizationExport(db(), owner, exportId)).status).toBe('ready');
    });

    it('refuses a failure code that is not on the list', async () => {
      const exportId = await request(owner);
      await expect(
        failExport(db(), worker(owner), { exportId, code: 'because of TEXT' as never }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
  });

  describe('a deletion', () => {
    const NAME = `deleted-during-${randomUUID()}.txt`;
    const BYTES = `deleted-bytes-${randomUUID()}`;
    let owner: TenantContext;
    let store: MemoryStore;
    let unitId: string;
    let fileId: string;
    let exportId: string;

    beforeEach(async () => {
      owner = await newOrg();
      store = new MemoryStore();
      const unit = await work(owner, 'Has a file');
      unitId = unit.id;
      fileId = (await file(owner, store, unit.id, NAME, BYTES)).id;
      await file(owner, store, unit.id, 'stays.txt');
      exportId = await request(owner);
    });

    const remove = () =>
      deleteArtifact(db(), store, owner, { workUnitId: unitId, artifactId: fileId });

    it('after the archive was made means no download, and upkeep takes the bytes', async () => {
      expect((await drive(owner, store, exportId)).state).toBe('finished');
      expect((await getOrganizationExport(db(), owner, exportId)).downloadable).toBe(true);
      await remove();
      await expect(openExportArchive(db(), store, owner, exportId)).rejects.toMatchObject({
        code: 'EXPORT_SUPERSEDED',
      });
      expect((await getOrganizationExport(db(), owner, exportId)).downloadable).toBe(false);

      expect(await purgeExpiredExports(db(), store, worker(owner), new Date())).toBe(1);
      expect(store.exportKeys()).toEqual([]);
      expect((await getOrganizationExport(db(), owner, exportId)).status).toBe('expired');
    });

    it('in flight when the tombstones were read is still caught, by the count', async () => {
      expect((await drive(owner, store, exportId)).state).toBe('finished');
      // Written with an old time, as a deletion that committed late looks, or a ledger re-apply.
      await su.query(
        `insert into platform.tombstones (organization_id, target_type, target_id, reason_code, created_at)
         values ($1, 'artifact', $2, 'USER_DELETED', '2020-01-01T00:00:00Z')`,
        [owner.organizationId, randomUUID()],
      );
      await expect(openExportArchive(db(), store, owner, exportId)).rejects.toMatchObject({
        code: 'EXPORT_SUPERSEDED',
      });
    });

    it('stops a download already under way', async () => {
      expect((await drive(owner, store, exportId)).state).toBe('finished');
      const archive = await openExportArchive(db(), store, owner, exportId);
      const reader = archive.chunks[Symbol.asyncIterator]();
      await reader.next();
      await remove();
      const read = async () => {
        for (;;) {
          const { done } = await reader.next();
          if (done) return;
        }
      };
      await expect(read()).rejects.toMatchObject({ code: 'EXPORT_SUPERSEDED' });
    });

    it('during the export leaves it absent, and in the tombstones', async () => {
      // After every byte and every record about it has been written, before the tombstones are read.
      const step = await drive(owner, store, exportId, deps, remove);
      expect(step.state).toBe('finished');
      const opened = await downloadAndOpen(owner, store, exportId);
      expect(opened.parts.has(artifactPartPath(fileId))).toBe(false);
      expect(opened.manifest.parts.map((part) => part.path)).not.toContain(
        artifactPartPath(fileId),
      );
      expect(opened.text).not.toContain(NAME);
      expect(opened.text).not.toContain(BYTES);
      expect(recordsOf(opened, 'artifact').map((row) => row.name)).toEqual(['stays.txt']);
      expect(recordsOf(opened, 'tombstone').map((row) => row.target_id)).toContain(fileId);
      // Its sealed bytes have left the store too, and what is left is exactly what is listed.
      const expected = opened.manifest.parts.length + 1;
      expect(store.exportKeys()).toHaveLength(expected);
      for (const key of store.exportKeys()) expect(key).not.toContain(fileId);
    });

    it('between the bytes and the records leaves no trace but the tombstone', async () => {
      const service = worker(owner);
      let step = await beginExport(db(), service, { exportId }, deps);
      // Stop as soon as this file's bytes have been written.
      while (step.state === 'continue' && !store.puts.some((key) => key.includes(fileId))) {
        step = await exportNextBatch(db(), store, service, { exportId }, deps);
      }
      expect(store.puts.some((key) => key.includes(fileId))).toBe(true);
      await remove();
      while (step.state === 'continue') {
        step = await exportNextBatch(db(), store, service, { exportId }, deps);
      }
      do {
        step = await finishExport(db(), store, service, { exportId }, deps);
      } while (step.state === 'continue');
      expect(step.state).toBe('finished');
      const opened = await downloadAndOpen(owner, store, exportId);
      expect(opened.text).not.toContain(NAME);
      expect(opened.text).not.toContain(BYTES);
      expect(recordsOf(opened, 'tombstone').map((row) => row.target_id)).toContain(fileId);
    });

    it('during the bytes being read is skipped, not reported as lost', async () => {
      const service = worker(owner);
      const racing: ObjectStore = {
        put: (key, body) => store.put(key, body),
        delete: (...args) => store.delete(...args),
        exists: (...args) => store.exists(...args),
        get: async (key) => {
          if (key.includes(fileId)) {
            await remove();
            throw new Error('gone');
          }
          return store.get(key);
        },
      };
      let step = await beginExport(db(), service, { exportId }, deps);
      while (step.state === 'continue') {
        step = await exportNextBatch(db(), racing, service, { exportId }, deps);
      }
      expect(step.state).toBe('finished');
    });
  });

  describe('an archive past its time', () => {
    let owner: TenantContext;
    let store: MemoryStore;
    let exportId: string;
    const longAgo = () => new Date(Date.now() - 48 * 60 * 60 * 1000);

    beforeEach(async () => {
      owner = await newOrg();
      store = new MemoryStore();
      const unit = await work(owner, 'Has a file');
      await file(owner, store, unit.id, 'kept.txt');
      exportId = await request(owner);
      expect((await drive(owner, store, exportId, { ...deps, now: longAgo })).state).toBe(
        'finished',
      );
    });

    it('cannot be downloaded, even before upkeep has been', async () => {
      await expect(openExportArchive(db(), store, owner, exportId)).rejects.toMatchObject({
        code: 'EXPORT_NOT_READY',
      });
      expect((await getOrganizationExport(db(), owner, exportId)).downloadable).toBe(false);
    });

    it('loses its bytes and keeps its row', async () => {
      const keptFiles = [...store.objects.keys()].filter((key) => key.includes('/artifacts/'));
      expect(store.exportKeys().length).toBeGreaterThan(0);
      expect(await purgeExpiredExports(db(), store, worker(owner), new Date())).toBe(1);
      expect(store.exportKeys()).toEqual([]);
      // Only the archive. The tenant's own files are not touched.
      for (const key of keptFiles) expect(store.objects.has(key)).toBe(true);

      const view = await getOrganizationExport(db(), owner, exportId);
      expect(view).toMatchObject({ status: 'expired', downloadable: false });
      expect(view.partCount).toBeGreaterThan(0);
      await expect(openExportArchive(db(), store, owner, exportId)).rejects.toMatchObject({
        code: 'EXPORT_NOT_READY',
      });
      const { rows } = await su.query(
        'select purged_at from sovereign.organization_exports where id = $1',
        [exportId],
      );
      expect(rows[0].purged_at).not.toBeNull();
    });

    it('is purged once, and leaves one still in date alone', async () => {
      const fresh = await request(owner);
      expect((await drive(owner, store, fresh)).state).toBe('finished');
      expect(await purgeExpiredExports(db(), store, worker(owner), new Date())).toBe(1);
      expect(await purgeExpiredExports(db(), store, worker(owner), new Date())).toBe(0);
      expect((await getOrganizationExport(db(), owner, fresh)).downloadable).toBe(true);
      await expect(downloadAndOpen(owner, store, fresh)).resolves.toBeDefined();
    });

    it('leaves another tenant’s archive alone', async () => {
      const other = await newOrg();
      const otherStore = store;
      const otherId = await request(other);
      expect((await drive(other, otherStore, otherId)).state).toBe('finished');
      expect(await purgeExpiredExports(db(), store, worker(owner), new Date())).toBe(1);
      expect((await getOrganizationExport(db(), other, otherId)).downloadable).toBe(true);
      await expect(downloadAndOpen(other, otherStore, otherId)).resolves.toBeDefined();
    });

    it('keeps its row when the store will not answer, and tries at the next sweep', async () => {
      const down: ObjectStore = {
        put: (key, body) => store.put(key, body),
        get: (...args) => store.get(...args),
        exists: (...args) => store.exists(...args),
        delete: async () => {
          throw new Error('down');
        },
      };
      expect(await purgeExpiredExports(db(), down, worker(owner), new Date())).toBe(0);
      expect((await getOrganizationExport(db(), owner, exportId)).status).toBe('ready');
      await expect(openExportArchive(db(), store, owner, exportId)).rejects.toMatchObject({
        code: 'EXPORT_NOT_READY',
      });
      expect(await purgeExpiredExports(db(), store, worker(owner), new Date())).toBe(1);
    });
  });

  it('removes the partial bytes of a failed export, and its row stays failed', async () => {
    const owner = await newOrg();
    const store = new MemoryStore();
    await createClient(db(), owner, { displayName: 'Same client name' });
    const exportId = await request(owner);
    const service = worker(owner);
    await beginExport(db(), service, { exportId }, deps);
    let step = await exportNextBatch(db(), store, service, { exportId }, deps);
    while (step.state === 'continue' && store.exportKeys().length === 0) {
      step = await exportNextBatch(db(), store, service, { exportId }, deps);
    }
    await failExport(db(), service, { exportId, code: 'STORE_UNAVAILABLE' });
    expect(store.exportKeys().length).toBeGreaterThan(0);
    // Failed is not expired, so it is not in the count, and its bytes go all the same.
    expect(await purgeExpiredExports(db(), store, service, new Date())).toBe(0);
    expect(store.exportKeys()).toEqual([]);
    expect((await getOrganizationExport(db(), owner, exportId)).status).toBe('failed');
  });

  it('runs through its Activities, taking only IDs', async () => {
    const owner = await newOrg();
    const store = new MemoryStore();
    await createClient(db(), owner, { displayName: 'Same client name' });
    const exportId = await request(owner);
    const activities = createPortabilityActivities({ database: db(), store, exportDeps: deps });
    const input = { organizationId: owner.organizationId, exportId };

    await expect(
      activities.beginOrganizationExport({ ...input, note: 'free text' } as typeof input),
    ).rejects.toThrow();

    let step = await activities.beginOrganizationExport(input);
    while (step.state === 'continue') step = await activities.exportOrganizationBatch(input);
    do step = await activities.finishOrganizationExport(input);
    while (step.state === 'continue');
    expect(step.state).toBe('finished');
    // Enums and counters, so nothing about a record can go through Temporal.
    expect(Object.keys(step).sort()).toEqual(['parts', 'records', 'state']);
    await expect(downloadAndOpen(owner, store, exportId)).resolves.toBeDefined();

    // A store outage is named for the workflow, and is left to retry.
    const second = await request(owner);
    store.failNextPut = true;
    const secondInput = { organizationId: owner.organizationId, exportId: second };
    await activities.beginOrganizationExport(secondInput);
    await expect(activities.exportOrganizationBatch(secondInput)).rejects.toMatchObject({
      type: 'STORE_UNAVAILABLE',
      nonRetryable: false,
    });
  });

  it('claims a row written directly like any other, with nothing to go on but its key', async () => {
    const owner = await newOrg();
    const store = new MemoryStore();
    const exportId = await seedExportRow(db(), owner, recipient);
    expect((await drive(owner, store, exportId)).state).toBe('finished');
    await expect(downloadAndOpen(owner, store, exportId)).resolves.toBeDefined();
  });

  it('keeps a connection identified by what the row says, and nothing it holds', async () => {
    const owner = await newOrg();
    const store = new MemoryStore();
    const connectionId = await seedConnection(db(), owner, {
      displayName: 'Same connection name',
      config: { region: 'canary-config-value' },
    });
    const exportId = await request(owner);
    expect((await drive(owner, store, exportId)).state).toBe('finished');
    const opened = await downloadAndOpen(owner, store, exportId);
    const [record] = recordsOf(opened, 'connection');
    expect(record?.id).toBe(connectionId);
    expect(opened.text).not.toContain('canary-config-value');
    const [row] = await withTenantTx(db(), owner, (tx) =>
      tx.select({ state: connections.state }).from(connections),
    );
    expect(row?.state).toBe('active');
  });
});

function edPublicKey() {
  return generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'der' })
    .toString('base64');
}
