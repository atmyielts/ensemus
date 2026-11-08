// QA-023, ADR-030 D8 and D9: an archive read into a new organization keeps its names, relationships, DAG and
// bytes, starts nothing, and leaves every other tenant alone. Real PostgreSQL and real roles, with a store in
// memory, and archives from fixtures/archive-builder.ts until `export` lands.
//
// Written and typechecked, and unverified: it needs migrations 0300 and 0301 in the journal, which the final merge
// stitches, and a database. Nobody should read this as having passed.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptInvitation,
  CORE_PORTABILITY_SECTIONS,
  createInvitation,
  createWorkUnit,
  getOrganizationImport,
  getWorkUnit,
  linkImportedPerson,
  listImportedPeople,
  listImportedRecordsForWork,
  objectKey,
  requestOrganizationImport,
  runOrganizationImport,
  type ImportRunDeps,
  listImportedArchiveFiles,
  readImportedArchiveFile,
} from '@ensemus/application';
import {
  approvals,
  artifacts,
  clients,
  connections,
  createOrganization,
  externalActions,
  importedPeople,
  importedRecords,
  openAppDatabase,
  organizationImports,
  projects,
  teams,
  tombstones,
  withTenantTx,
  workArtifacts,
  workAssignments,
  workDependencies,
  workTransitions,
  workUnits,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  ledgerKeyFor,
  serializeLedgerEntry,
  TOMBSTONE_RECORDED,
} from '@ensemus/domain/tombstone-ledger';
import { eq, sql } from 'drizzle-orm';
import { seedImportRow, testRecipient, nativeSovereignContext } from '../helpers/sovereign';
import { urls } from '../helpers/stack';
import { archiveReader, buildArchive, sourceTenant } from './fixtures/archive-builder';

class MemoryStore {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) {
    this.objects.set(key, body);
  }
  async get(key: string) {
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
  async *listPages(prefix: string) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    for (let at = 0; at < keys.length; at += 2) yield keys.slice(at, at + 2);
  }
}

describe('importing an organization archive', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let su: pg.Client;
  let auth: pg.Client;
  const db = () => app.db;
  const recipient = testRecipient();

  const makeUser = async (label: string) => {
    const id = randomUUID();
    const email = `${label}-${id}@example.invalid`;
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      email,
    ]);
    return { id, email };
  };

  /** A new organization with its one owner. The same name each time, on purpose. */
  const makeOwner = async (label: string) => {
    const user = await makeUser(label);
    const { organizationId } = await createOrganization(db(), {
      userId: user.id,
      name: 'Same Name Ltd',
      commercialMode: 'sovereign',
    });
    return nativeSovereignContext(db(), user.id, organizationId);
  };

  const joinAs = async (owner: TenantContext, role: 'admin' | 'member') => {
    const user = await makeUser(role);
    const invitation = await createInvitation(db(), owner, { email: user.email, role });
    await acceptInvitation(db(), {
      userId: user.id,
      email: user.email,
      emailVerified: true,
      token: invitation.token,
    });
    return nativeSovereignContext(db(), user.id, owner.organizationId);
  };

  const depsFor = (store: MemoryStore): ImportRunDeps => ({
    sections: CORE_PORTABILITY_SECTIONS,
    ledger: store,
    store,
  });

  const imported = async (owner: TenantContext, spec: ReturnType<typeof sourceTenant>['spec']) => {
    const store = new MemoryStore();
    const view = await requestOrganizationImport(db(), owner);
    const built = buildArchive(recipient, spec);
    const result = await runOrganizationImport(
      db(),
      createServiceContext(owner.organizationId),
      {
        importId: view.id,
        archive: archiveReader(built.bytes),
        recipientPrivateKeyPem: recipient.privateKeyPem,
      },
      depsFor(store),
    );
    return { store, view, built, result };
  };

  const rows = <T>(context: TenantContext, fn: Parameters<typeof withTenantTx<T>>[2]) =>
    withTenantTx(db(), context, fn);

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    su = new pg.Client({ connectionString: urls.superuser() });
    auth = new pg.Client({ connectionString: urls.auth() });
    await su.connect();
    await auth.connect();
  });

  afterAll(async () => {
    await app.close();
    await su.end();
    await auth.end();
  });

  describe('QA-023', () => {
    it('keeps metadata and the DAG while verified files remain inert and unlinked', async () => {
      const owner = await makeOwner('owner');
      const { spec, ids, kept } = sourceTenant('Moved');
      const { store, view, result } = await imported(owner, spec);
      expect(result.status).toBe('completed_with_warnings');

      const expected: Record<string, number> = {};
      for (const page of spec.pages) {
        const kind = (page.records[0] as { kind: string }).kind;
        expected[kind] = (expected[kind] ?? 0) + page.records.length;
      }
      expected.work_artifact = 0;
      expect(result.appliedCounts).toEqual(expected);
      expect((await getOrganizationImport(db(), owner, view.id)).appliedCounts).toEqual(expected);

      await rows(owner, async (tx) => {
        const [client] = await tx.select().from(clients).where(eq(clients.id, ids.client));
        expect(client?.displayName).toBe('Moved client');
        const [project] = await tx.select().from(projects).where(eq(projects.id, ids.project));
        expect(project).toMatchObject({ name: 'Moved project', clientId: ids.client });

        const teamRows = await tx.select().from(teams);
        expect(teamRows.find((team) => team.id === ids.childTeam)?.parentId).toBe(ids.team);

        const work = await tx.select().from(workUnits);
        expect(work).toHaveLength(4);
        expect(work.find((unit) => unit.id === ids.childWork)?.parentId).toBe(ids.parentWork);
        expect(work.every((unit) => unit.projectId === ids.project)).toBe(true);

        const edges = await tx.select().from(workDependencies);
        expect(edges).toEqual([
          expect.objectContaining({
            prerequisiteId: ids.parentWork,
            dependentId: ids.movingWork,
          }),
        ]);

        expect(await tx.select().from(artifacts)).toEqual([]);
        const links = await tx.select().from(workArtifacts);
        expect(links).toEqual([]);
      });
      expect(await listImportedArchiveFiles(db(), owner, { importId: view.id })).toEqual([
        expect.objectContaining({
          sourceArtifactId: ids.keptFile,
          state: 'quarantined',
          sizeBytes: kept.length,
        }),
      ]);
      expect(
        (
          await readImportedArchiveFile(db(), store, owner, {
            importId: view.id,
            sourceArtifactId: ids.keptFile,
          })
        ).bytes,
      ).toEqual(kept);
      expect(result.warningCounts).toMatchObject({
        FILES_AWAIT_REVIEW: 1,
        FILE_LINK_REQUIRES_REUPLOAD: 1,
      });
    });

    it('leaves another tenant with the same names and the same IDs untouched', async () => {
      const other = await makeOwner('other');
      const before = await createWorkUnit(db(), other, { title: 'Moved work, somewhere else' });
      const owner = await makeOwner('owner');
      const { spec } = sourceTenant('Moved');
      await imported(owner, spec);

      const seen = await rows(other, (tx) => tx.select().from(workUnits));
      expect(seen.map(({ id }) => id)).toEqual([before.id]);
      expect(await rows(other, (tx) => tx.select().from(clients))).toEqual([]);
      expect(await rows(other, (tx) => tx.select().from(importedPeople))).toEqual([]);

      // The same archive into a second new tenant: keys are (organization, id), so nothing collides.
      const third = await makeOwner('third');
      const second = await imported(third, spec);
      expect(second.result.status).toBe('completed_with_warnings');
      expect((await rows(owner, (tx) => tx.select().from(workUnits))).length).toBe(4);
      expect((await rows(third, (tx) => tx.select().from(workUnits))).length).toBe(4);
    });

    it('a record cannot reach another tenant by naming its IDs', async () => {
      const victim = await makeOwner('victim');
      const theirWork = await createWorkUnit(db(), victim, { title: 'Theirs' });
      const owner = await makeOwner('owner');
      const { spec, ids } = sourceTenant('Hostile');
      const pointing = {
        ...spec,
        pages: [
          ...spec.pages,
          {
            section: 'relations' as const,
            recordKind: 'work_dependencies',
            records: [
              {
                kind: 'work_dependency' as const,
                prerequisite_id: theirWork.id,
                dependent_id: ids.parentWork,
              },
            ],
          },
          {
            section: 'history' as const,
            recordKind: 'approvals',
            records: [
              {
                kind: 'history' as const,
                record_type: 'approval' as const,
                source_id: randomUUID(),
                work_unit_id: theirWork.id,
                occurred_at: '2026-01-02T03:04:05.000Z',
                record: {},
              },
            ],
          },
        ],
      };
      const { result } = await imported(owner, pointing);
      expect(result.warningCounts.RELATION_DANGLING).toBeGreaterThanOrEqual(2);
      expect(await rows(victim, (tx) => tx.select().from(workDependencies))).toEqual([]);
      expect(await rows(victim, (tx) => tx.select().from(importedRecords))).toEqual([]);
      await expect(getWorkUnit(db(), owner, theirWork.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('an import starts nothing', () => {
    it('leaves nothing live, however the archive was', async () => {
      const owner = await makeOwner('owner');
      const { spec, ids } = sourceTenant('Paused');
      const { result } = await imported(owner, spec);

      expect(await rows(owner, (tx) => tx.select().from(approvals))).toEqual([]);
      expect(await rows(owner, (tx) => tx.select().from(externalActions))).toEqual([]);
      expect(await rows(owner, (tx) => tx.select().from(workTransitions))).toEqual([]);
      // Those three of the history came through as history.
      expect(
        (await rows(owner, (tx) => tx.select().from(importedRecords))).length,
      ).toBeGreaterThanOrEqual(3);

      const work = await rows(owner, (tx) => tx.select().from(workUnits));
      const statusOf = (id: string) => work.find((unit) => unit.id === id)?.status;
      expect(statusOf(ids.movingWork)).toBe('blocked');
      expect(statusOf(ids.pendingWork)).toBe('blocked');
      expect(statusOf(ids.parentWork)).toBe('ready');
      expect(statusOf(ids.childWork)).toBe('completed');
      for (const unit of work) {
        expect(unit.runId).toBeNull();
        expect(unit.runRequestedAt).toBeNull();
        expect(unit.runRequestedByMembershipId).toBeNull();
        expect(unit.planReviewerMembershipId).toBeNull();
      }
      expect(result.warningCounts.WORK_PAUSED_ON_IMPORT).toBe(2);

      const [connection] = await rows(owner, (tx) => tx.select().from(connections));
      expect(connection).toMatchObject({ state: 'disabled', credentialSecretId: null, config: {} });
      expect(result.warningCounts.CONNECTION_NEEDS_CREDENTIAL).toBe(1);

      // Nothing for a workflow to listen to, whatever the archive said.
      const { rows: events } = await su.query<{ event_type: string }>(
        'select distinct event_type from platform.domain_events where organization_id = $1',
        [owner.organizationId],
      );
      expect(events.map(({ event_type }) => event_type).sort()).toEqual(
        expect.not.arrayContaining([
          'work.created',
          'work.execution_requested',
          'external_action.ready',
        ]),
      );
    });

    it('makes no accounts, and grants nothing for the role someone had', async () => {
      const owner = await makeOwner('owner');
      const before = await auth.query('select count(*)::int as n from identity.users');
      const { spec, ids } = sourceTenant('People');
      const { result } = await imported(owner, spec);
      const after = await auth.query('select count(*)::int as n from identity.users');
      expect(after.rows[0].n).toBe(before.rows[0].n);

      const people = await listImportedPeople(db(), owner);
      expect(people.map((person) => person.sourceMembershipId).sort()).toEqual(
        [ids.ada, ids.grace].sort(),
      );
      expect(people.every((person) => person.targetMembershipId === null)).toBe(true);
      expect(result.warningCounts.PERSON_NOT_LINKED).toBeGreaterThan(0);

      const work = await rows(owner, (tx) => tx.select().from(workUnits));
      expect(work.every((unit) => unit.ownerMembershipId === owner.membershipId)).toBe(true);
      expect(work.every((unit) => unit.createdByMembershipId === null)).toBe(true);
      expect(await rows(owner, (tx) => tx.select().from(workAssignments))).toEqual([]);
    });
  });

  describe('revoked stays gone', () => {
    it('keeps out what the archive says was deleted, in row and bytes, and keeps it deleted here', async () => {
      const owner = await makeOwner('owner');
      const { spec, ids } = sourceTenant('Revoked');
      const { store } = await imported(owner, spec);
      const [tombstone] = await rows(owner, (tx) =>
        tx.select().from(tombstones).where(eq(tombstones.targetId, ids.deletedFile)),
      );
      expect(tombstone?.targetType).toBe('artifact');
      expect(store.objects.has(objectKey(owner.organizationId, ids.deletedFile))).toBe(false);
      const { rows: events } = await su.query(
        'select aggregate_id from platform.domain_events where organization_id = $1 and event_type = $2',
        [owner.organizationId, TOMBSTONE_RECORDED],
      );
      expect(events.map((event) => event.aggregate_id)).toContain(ids.deletedFile);
    });

    it('keeps out what only the source ledger knows, when this store has that ledger', async () => {
      const owner = await makeOwner('owner');
      const { spec, ids } = sourceTenant('Later');
      const store = new MemoryStore();
      const entry = {
        organizationId: ids.organization,
        targetType: 'artifact',
        targetId: ids.keptFile,
        deletedAt: new Date('2026-03-03T00:00:00.000Z'),
      };
      await store.put(ledgerKeyFor(entry), serializeLedgerEntry(entry));
      const view = await requestOrganizationImport(db(), owner);
      const result = await runOrganizationImport(
        db(),
        createServiceContext(owner.organizationId),
        {
          importId: view.id,
          archive: archiveReader(buildArchive(recipient, spec).bytes),
          recipientPrivateKeyPem: recipient.privateKeyPem,
        },
        depsFor(store),
      );
      expect(result.warningCounts.TOMBSTONED_SKIPPED).toBe(1);
      expect(await rows(owner, (tx) => tx.select().from(artifacts))).toEqual([]);
      expect(await rows(owner, (tx) => tx.select().from(workArtifacts))).toEqual([]);
      expect(store.objects.has(objectKey(owner.organizationId, ids.keptFile))).toBe(false);
      const [tombstone] = await rows(owner, (tx) =>
        tx.select().from(tombstones).where(eq(tombstones.targetId, ids.keptFile)),
      );
      expect(tombstone).toBeDefined();
    });
  });

  describe('hostile relationships', () => {
    it('reports a dependency cycle and a team cycle rather than crashing', async () => {
      const owner = await makeOwner('owner');
      const { spec, ids } = sourceTenant('Cycle');
      const teamA = randomUUID();
      const teamB = randomUUID();
      const { result } = await imported(owner, {
        ...spec,
        pages: [
          ...spec.pages,
          {
            section: 'people',
            recordKind: 'teams',
            records: [
              {
                kind: 'team',
                id: teamA,
                parent_id: teamB,
                name: 'A',
                created_at: '2026-01-02T03:04:05.000Z',
              },
              {
                kind: 'team',
                id: teamB,
                parent_id: teamA,
                name: 'B',
                created_at: '2026-01-02T03:04:05.000Z',
              },
            ],
          },
          {
            section: 'relations',
            recordKind: 'work_dependencies',
            records: [
              // The other way round from the edge the tenant already has.
              {
                kind: 'work_dependency',
                prerequisite_id: ids.movingWork,
                dependent_id: ids.parentWork,
              },
            ],
          },
        ],
      });
      expect(result.status).toBe('completed_with_warnings');
      expect(result.warningCounts.RELATION_DANGLING).toBeGreaterThanOrEqual(2);
      const edges = await rows(owner, (tx) => tx.select().from(workDependencies));
      expect(edges).toHaveLength(1);
      const cycle = await rows(owner, (tx) =>
        tx
          .select({ id: teams.id, parentId: teams.parentId })
          .from(teams)
          .where(sql`${teams.id} in (${teamA}, ${teamB})`),
      );
      expect(cycle.filter(({ parentId }) => parentId !== null)).toHaveLength(1);
    });
  });

  describe('denied', () => {
    it('an admin and a member may not ask, look or link', async () => {
      const owner = await makeOwner('owner');
      const admin = await joinAs(owner, 'admin');
      const member = await joinAs(owner, 'member');
      const importId = await seedImportRow(db(), owner);
      for (const context of [admin, member]) {
        await expect(requestOrganizationImport(db(), context)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(getOrganizationImport(db(), context, importId)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(listImportedPeople(db(), context)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(
          linkImportedPerson(db(), context, {
            sourceMembershipId: randomUUID(),
            membershipId: context.membershipId,
          }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          runOrganizationImport(
            db(),
            context,
            {
              importId,
              archive: archiveReader(Buffer.alloc(0)),
              recipientPrivateKeyPem: recipient.privateKeyPem,
            },
            depsFor(new MemoryStore()),
          ),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    });

    it('a second import', async () => {
      const owner = await makeOwner('owner');
      await requestOrganizationImport(db(), owner);
      await expect(requestOrganizationImport(db(), owner)).rejects.toMatchObject({
        code: 'IMPORT_ALREADY_USED',
      });
    });

    it('one finished cannot run again', async () => {
      const owner = await makeOwner('owner');
      const { spec } = sourceTenant('Once');
      const { view, built } = await imported(owner, spec);
      await expect(
        runOrganizationImport(
          db(),
          createServiceContext(owner.organizationId),
          {
            importId: view.id,
            archive: archiveReader(built.bytes),
            recipientPrivateKeyPem: recipient.privateKeyPem,
          },
          depsFor(new MemoryStore()),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await expect(requestOrganizationImport(db(), owner)).rejects.toMatchObject({
        code: 'IMPORT_ALREADY_USED',
      });
    });

    it('a target with anything in it, when asked and again when run', async () => {
      const asked = await makeOwner('owner');
      await createWorkUnit(db(), asked, { title: 'Already here' });
      await expect(requestOrganizationImport(db(), asked)).rejects.toMatchObject({
        code: 'IMPORT_TARGET_NOT_EMPTY',
      });

      const withMember = await makeOwner('owner');
      await joinAs(withMember, 'member');
      await expect(requestOrganizationImport(db(), withMember)).rejects.toMatchObject({
        code: 'IMPORT_TARGET_NOT_EMPTY',
      });

      const late = await makeOwner('owner');
      const view = await requestOrganizationImport(db(), late);
      await createWorkUnit(db(), late, { title: 'Arrived in between' });
      const { spec } = sourceTenant('Late');
      const result = await runOrganizationImport(
        db(),
        createServiceContext(late.organizationId),
        {
          importId: view.id,
          archive: archiveReader(buildArchive(recipient, spec).bytes),
          recipientPrivateKeyPem: recipient.privateKeyPem,
        },
        depsFor(new MemoryStore()),
      );
      expect(result).toMatchObject({ status: 'failed', failureCode: 'TARGET_NOT_EMPTY' });
      expect(await rows(late, (tx) => tx.select().from(clients))).toEqual([]);
    });

    it("another tenant's import is not found, to read or to run", async () => {
      const owner = await makeOwner('owner');
      const other = await makeOwner('other');
      const importId = await seedImportRow(db(), other);
      await expect(getOrganizationImport(db(), owner, importId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        runOrganizationImport(
          db(),
          createServiceContext(owner.organizationId),
          {
            importId,
            archive: archiveReader(Buffer.alloc(0)),
            recipientPrivateKeyPem: recipient.privateKeyPem,
          },
          depsFor(new MemoryStore()),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const [row] = await rows(other, (tx) =>
        tx.select().from(organizationImports).where(eq(organizationImports.id, importId)),
      );
      expect(row?.status).toBe('requested');
    });
  });

  describe('a run after a failure', () => {
    it('retains completed steps and refuses to resend a file whose write outcome is unknown', async () => {
      const owner = await makeOwner('owner');
      const { spec } = sourceTenant('Retry');
      const view = await requestOrganizationImport(db(), owner);
      const built = buildArchive(recipient, spec);
      const store = new MemoryStore();
      const failing = await runOrganizationImport(
        db(),
        createServiceContext(owner.organizationId),
        {
          importId: view.id,
          archive: archiveReader(built.bytes),
          recipientPrivateKeyPem: recipient.privateKeyPem,
        },
        {
          ...depsFor(store),
          store: {
            ...store,
            exists: store.exists.bind(store),
            get: store.get.bind(store),
            delete: store.delete.bind(store),
            put: async () => {
              throw new Error('store down');
            },
          },
        },
      );
      expect(failing).toMatchObject({ status: 'failed', failureCode: 'STORE_UNAVAILABLE' });
      expect((await rows(owner, (tx) => tx.select().from(workUnits))).length).toBe(4);
      // Asking for a new one would be merging two archives.
      await expect(requestOrganizationImport(db(), owner)).rejects.toMatchObject({
        code: 'IMPORT_TARGET_NOT_EMPTY',
      });
      const resumed = await runOrganizationImport(
        db(),
        createServiceContext(owner.organizationId),
        {
          importId: view.id,
          archive: archiveReader(built.bytes),
          recipientPrivateKeyPem: recipient.privateKeyPem,
        },
        depsFor(store),
      );
      expect(resumed).toMatchObject({ status: 'failed', failureCode: 'RECORD_REFUSED' });
      expect((await rows(owner, (tx) => tx.select().from(workUnits))).length).toBe(4);
      expect(resumed.appliedCounts.work_unit).toBe(4);
      expect(await rows(owner, (tx) => tx.select().from(artifacts))).toEqual([]);
      expect(store.objects.size).toBe(0);
      expect(await listImportedArchiveFiles(db(), owner, { importId: view.id })).toEqual([
        expect.objectContaining({ state: 'unknown' }),
      ]);
    });
  });

  describe('linking a person', () => {
    it('moves their work and their place on work, on the record, and grants no role', async () => {
      const owner = await makeOwner('owner');
      const { spec, ids } = sourceTenant('Link');
      await imported(owner, spec);
      const member = await joinAs(owner, 'member');

      const linked = await linkImportedPerson(db(), owner, {
        sourceMembershipId: ids.grace,
        membershipId: member.membershipId,
      });
      expect(linked.targetMembershipId).toBe(member.membershipId);
      expect(linked.linkedAt).toBeInstanceOf(Date);

      const work = await rows(owner, (tx) => tx.select().from(workUnits));
      expect(work.find((unit) => unit.id === ids.movingWork)?.ownerMembershipId).toBe(
        member.membershipId,
      );
      // Ada's work stays with the fallback until she is linked herself.
      expect(work.find((unit) => unit.id === ids.parentWork)?.ownerMembershipId).toBe(
        owner.membershipId,
      );
      const assignments = await rows(owner, (tx) => tx.select().from(workAssignments));
      expect(assignments).toEqual([
        expect.objectContaining({
          workUnitId: ids.parentWork,
          membershipId: member.membershipId,
          responsibility: 'reviewer',
        }),
      ]);

      const after = await nativeSovereignContext(db(), member.userId, owner.organizationId);
      expect(after.role).toBe('member');

      const { rows: audits } = await su.query(
        `select action from governance.audit_events where organization_id = $1
          and action in ('work.owner_changed', 'imported_person.linked')`,
        [owner.organizationId],
      );
      expect(new Set(audits.map((row) => row.action))).toEqual(
        new Set(['work.owner_changed', 'imported_person.linked']),
      );
    });

    it('a source owner linked to a member stays a member', async () => {
      const owner = await makeOwner('owner');
      const { spec, ids } = sourceTenant('Role');
      await imported(owner, spec);
      const member = await joinAs(owner, 'member');
      await linkImportedPerson(db(), owner, {
        sourceMembershipId: ids.ada,
        membershipId: member.membershipId,
      });
      const after = await nativeSovereignContext(db(), member.userId, owner.organizationId);
      expect(after.role).toBe('member');
    });

    it('is refused for a member of another tenant, and for someone already linked', async () => {
      const owner = await makeOwner('owner');
      const other = await makeOwner('other');
      const { spec, ids } = sourceTenant('Refuse');
      await imported(owner, spec);
      await expect(
        linkImportedPerson(db(), owner, {
          sourceMembershipId: ids.grace,
          membershipId: other.membershipId,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

      const member = await joinAs(owner, 'member');
      const second = await joinAs(owner, 'member');
      await linkImportedPerson(db(), owner, {
        sourceMembershipId: ids.grace,
        membershipId: member.membershipId,
      });
      await expect(
        linkImportedPerson(db(), owner, {
          sourceMembershipId: ids.grace,
          membershipId: second.membershipId,
        }),
      ).rejects.toMatchObject({ code: 'IMPORTED_PERSON_ALREADY_LINKED' });
      await expect(
        linkImportedPerson(db(), other, {
          sourceMembershipId: ids.ada,
          membershipId: other.membershipId,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('leaves alone work someone has since moved by hand', async () => {
      const owner = await makeOwner('owner');
      const { spec, ids } = sourceTenant('Moved by hand');
      await imported(owner, spec);
      const member = await joinAs(owner, 'member');
      const third = await joinAs(owner, 'member');
      const current = await getWorkUnit(db(), owner, ids.movingWork);
      const { setOwner } = await import('@ensemus/application');
      await setOwner(db(), owner, {
        id: ids.movingWork,
        expectedVersion: current.version,
        ownerMembershipId: third.membershipId,
      });
      await linkImportedPerson(db(), owner, {
        sourceMembershipId: ids.grace,
        membershipId: member.membershipId,
      });
      const after = await getWorkUnit(db(), owner, ids.movingWork);
      expect(after.ownerMembershipId).toBe(third.membershipId);
    });
  });

  describe('history', () => {
    it('reads by the rule of its work, and cannot be reached otherwise', async () => {
      const owner = await makeOwner('owner');
      const { spec, ids } = sourceTenant('History');
      await imported(owner, spec);
      const records = await listImportedRecordsForWork(db(), owner, ids.pendingWork);
      expect(records.map((row) => row.recordType)).toContain('approval');

      const other = await makeOwner('other');
      await expect(listImportedRecordsForWork(db(), other, ids.pendingWork)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});
