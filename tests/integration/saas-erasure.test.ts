import { createTenantObjectErasure } from '@ensemus/application/saas/tenant-object-erasure';
import { createOffboardingAgentHaltPort } from '@ensemus/application/saas/offboarding-agent-port';
import { sealDelegatedErasureInTx } from '@ensemus/application/knowledge/delegated-erasure';
import { randomBytes, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import {
  artifacts,
  invoices,
  offboardings,
  openAppDatabase,
  sealedSecrets,
  ticketMessages,
  tickets,
  tombstones,
  withTenantTx,
  workUnits,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { createServiceContext } from '@ensemus/database/service';
import { eraseTenantRows, listErasableTables } from '@ensemus/database/eraser';
import {
  beginErasure,
  cancelOffboarding,
  finishErasure,
  getOffboarding,
  inspectErasure,
} from '@ensemus/application/saas/offboarding';
import { placeLegalHold, releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import {
  addTrustedSigner,
  createMeeting,
  createSkillPackage,
  createWorkUnit,
  getMeeting,
  getSkillPackage,
  importMeetingNotes,
  listTrustedSigners,
  purgeDueBlobs,
  recordMeetingConsent,
  revokeTrustedSigner,
  updateMeetingSettings,
  updateWorkUnit,
} from '@ensemus/application';
import { generateTestSigner } from '../helpers/skills';
import {
  clearDeploymentProfile,
  enableFederation,
  seedGrant,
  setDeploymentProfile,
} from '../helpers/federation';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRole, seedTaxTreatment } from '../helpers/saas';
import { urls } from '../helpers/stack';
import { lifecycleArtifact, lifecycleTenant, LifecycleMemoryStore } from './saas-lifecycle-fixture';
import { paymentFixture } from './saas-payment-fixture';
import { publishErasureLedger, readyToErase } from './saas-offboarding-fixture';

describe('restricted erasure independently verifies every tenant-content table', () => {
  const database = openAppDatabase(urls.app()),
    auth = new pg.Client({ connectionString: urls.auth() }),
    eraserClient = new pg.Client({ connectionString: urls.superuser() });
  let eraser: Parameters<typeof eraseTenantRows>[0];
  beforeAll(async () => {
    await auth.connect();
    await eraserClient.connect();
    await eraserClient.query('set session authorization ensemus_eraser');
    eraser = drizzle(eraserClient, { casing: 'snake_case' }) as unknown as Parameters<
      typeof eraseTenantRows
    >[0];
    await seedTaxTreatment();
  });
  /**
   * ops-erase's step before the restricted eraser runs: the native app service persists the current
   * material witness (0515, raw-qualified by 0516). erase_raw_source_inventories requires it
   * (lifecycle.raw_erasure_witness), and a missing seal is never read as an empty inventory.
   */
  const seal = async (ready: Awaited<ReturnType<typeof readyToErase>>) =>
    expect(
      await withTenantTx(database.db, ready.service, (tx) =>
        sealDelegatedErasureInTx(tx, ready.service, ready),
      ),
    ).toBe(true);
  afterAll(async () => {
    await eraserClient.query('reset session authorization');
    await eraserClient.end();
    await auth.end();
    await database.close();
  });
  it('registers tenant-local expansion records for restricted erasure without granting body reads', async () => {
    const tables = [
      'federation.org_settings',
      'integrations.business_record_actions',
      'integrations.business_records',
      'marketplace.installations',
      'meetings.consent_records',
      'meetings.derivation_runs',
      'meetings.import_requests',
      'meetings.meetings',
      'meetings.notes',
      'meetings.participants',
      'meetings.proposed_items',
      'meetings.provider_approvals',
      'meetings.settings',
      'meetings.summaries',
      'sandbox.runs',
      'skills.bundle_uploads',
      'skills.package_versions',
      'skills.packages',
      'skills.test_runs',
      'skills.trusted_signers',
      'tenancy.residency_requirements',
    ];
    await asRole('ensemus_eraser', async (client) => {
      const { rows } = await client.query(
        `select ref,
            has_table_privilege(current_user, ref, 'DELETE') as deletable,
            has_column_privilege(current_user, ref, 'organization_id', 'SELECT') as countable,
            has_any_column_privilege(current_user, ref, 'INSERT,UPDATE') as writable,
            exists (select 1 from pg_attribute a where a.attrelid=ref::regclass and a.attnum>0
              and not a.attisdropped and a.attname<>'organization_id'
              and has_column_privilege(current_user,ref::regclass,a.attnum,'SELECT')) as body_readable,
            exists (select 1 from pg_trigger where tgrelid=ref::regclass
              and tgname='lifecycle_erasure_birth_fence' and tgenabled='O') as birth_fenced,
            exists (select 1 from pg_policy where polrelid=ref::regclass
              and polname='auth_restore_0422_eraser' and not polpermissive) as restore_fenced,
            strpos(pg_get_functiondef('lifecycle.erasure_table_rows(text,uuid)'::regprocedure),
              quote_literal(ref))>0 as reportable
         from unnest($1::text[]) as refs(ref) order by ref collate "C"`,
        [tables],
      );
      expect(rows).toEqual(
        tables.map((ref) => ({
          ref,
          deletable: true,
          countable: true,
          writable: false,
          body_readable: false,
          birth_fenced: true,
          restore_fenced: true,
          reportable: true,
        })),
      );
    });
    await expect(
      asRole('ensemus_eraser', (client) =>
        client.query('delete from integrations.business_records where organization_id=$1', [
          randomUUID(),
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501', message: 'ERASURE_NOT_OPEN' });
    await expect(
      asRole('ensemus_eraser', (client) => client.query('select body from meetings.notes')),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asRole('ensemus_eraser', (client) =>
        client.query('select public_key from skills.trusted_signers'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await asRole('ensemus_eraser', async (client) => {
      const { rows } = await client.query(
        `select n.nspname||'.'||c.relname as ref,
           (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
             or has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE')) as reachable
         from pg_class c join pg_namespace n on c.relnamespace=n.oid
         where (n.nspname,c.relname)=('federation','outbound_items')
           or (n.nspname='marketplace' and c.relname<>'installations' and c.relkind in ('r','p'))
         order by (n.nspname||'.'||c.relname) collate "C"`,
      );
      expect(rows).toEqual([
        { ref: 'federation.outbound_items', reachable: false },
        { ref: 'marketplace.listing_object_reservations', reachable: false },
        { ref: 'marketplace.listings', reachable: false },
        { ref: 'marketplace.publishers', reachable: false },
        { ref: 'marketplace.security_reviews', reachable: false },
        { ref: 'marketplace.submissions', reachable: false },
      ]);
    });
  });

  it('erases catalog metadata through the restricted role and leaves the other tenant untouched', async () => {
    const owner = await lifecycleTenant(database.db, auth);
    const other = await lifecycleTenant(database.db, auth);
    const gate = { isEnabled: async () => true };
    const signer = generateTestSigner();
    const seed = async (tenant: typeof owner) => {
      await addTrustedSigner(database.db, tenant, gate, {
        displayName: 'Generated test publisher',
        publicKey: signer.publicKey,
      });
      return createSkillPackage(database.db, tenant, gate, {
        name: 'generated-catalog-erasure',
        displayName: 'Generated test package',
      });
    };
    await seed(owner);
    const revoked = await addTrustedSigner(database.db, owner, gate, {
      displayName: 'Generated revoked publisher',
      publicKey: generateTestSigner().publicKey,
    });
    await revokeTrustedSigner(database.db, owner, {
      signerId: revoked.id,
      expectedVersion: revoked.version,
    });
    const otherPackage = await seed(other);
    const ready = await readyToErase(database.db, owner);
    const counts = () =>
      withAccountTx(database.db, ready.service, async (tx) => {
        const result = await tx.execute<{ packages: string; signers: string }>(sql`
          select lifecycle.erasure_table_rows('skills.packages', ${ready.offboardingId}::uuid)::text packages,
                 lifecycle.erasure_table_rows('skills.trusted_signers', ${ready.offboardingId}::uuid)::text signers
        `);
        return result.rows[0];
      });

    expect(await counts()).toEqual({ packages: '1', signers: '2' });
    // Other protocols still prevent the operator from entering erasure. Exercise this module
    // through the native lifecycle gate that the full command uses after its inventory check.
    await withAccountTx(database.db, ready.service, (tx) =>
      tx
        .update(offboardings)
        .set({
          state: 'erasing',
          erasureStartedAt: new Date(),
          erasureStartedByRef: 'test-operator@example.invalid',
          version: sql`${offboardings.version}+1`,
          updatedAt: new Date(),
        })
        .where(eq(offboardings.id, ready.offboardingId)),
    );
    await eraserClient.query('begin');
    try {
      await eraserClient.query("select set_config('app.organization_id', $1, true)", [
        owner.organizationId,
      ]);
      await eraserClient.query("select set_config('app.actor_type', 'service', true)");
      for (const table of ['skills.packages', 'skills.trusted_signers']) {
        const result = await eraserClient.query(
          `delete from ${table} where organization_id in ($1,$2)`,
          [owner.organizationId, other.organizationId],
        );
        expect(result.rowCount).toBe(table === 'skills.packages' ? 1 : 2);
      }
      await eraserClient.query('commit');
    } catch (error) {
      await eraserClient.query('rollback');
      throw error;
    }
    expect(await counts()).toEqual({ packages: '0', signers: '0' });
    expect(await getSkillPackage(database.db, other, otherPackage.id)).toEqual(otherPackage);
    expect(await listTrustedSigners(database.db, other)).toHaveLength(1);
  });

  it('erases standalone federation settings and fences new settings after readiness', async () => {
    const owner = await lifecycleTenant(database.db, auth);
    const other = await lifecycleTenant(database.db, auth);
    const late = await lifecycleTenant(database.db, auth);
    const registerFederationSettings = (tenant: typeof owner) =>
      withAccountTx(database.db, tenant, (tx) =>
        tx.execute(sql`
          insert into federation.org_settings(organization_id, changed_by_membership_id)
          values (${tenant.organizationId}::uuid, ${tenant.membershipId}::uuid)
        `),
      );

    await withAccountTx(database.db, createServiceContext(late.organizationId), async (tx) => {
      await tx.execute(sql`select id from org.organizations
        where id=${late.organizationId}::uuid for no key update`);
      await expect(registerFederationSettings(late)).rejects.toMatchObject({
        cause: { code: '55P03' },
      });
    });
    const lateReady = await readyToErase(database.db, late);
    await expect(registerFederationSettings(late)).rejects.toMatchObject({
      cause: { code: 'EN850', message: 'TENANT_ERASURE_IN_PROGRESS' },
    });
    const webProof = await withAccountTx(database.db, late, (tx) =>
      tx.execute(
        sql`select lifecycle.deferred_erasure_clear(${lateReady.offboardingId}::uuid) as clear`,
      ),
    );
    expect(webProof.rows).toEqual([{ clear: false }]);

    await registerFederationSettings(owner);
    await registerFederationSettings(other);
    const ready = await readyToErase(database.db, owner);
    const operatorRef = 'test-operator@example.invalid';
    await beginErasure(database.db, ready.service, { ...ready, operatorRef });
    await seal(ready);
    const removed = await eraseTenantRows(eraser, owner.organizationId);
    expect(removed.find((table) => table.tableRef === 'federation.org_settings')).toEqual({
      tableRef: 'federation.org_settings',
      rowsRemoved: 1,
      rowsLeft: 0,
    });
    const otherSettings = await withTenantTx(database.db, other, (tx) =>
      tx.execute(
        sql`select enabled from federation.org_settings where organization_id=${other.organizationId}::uuid`,
      ),
    );
    expect(otherSettings.rows).toEqual([{ enabled: false }]);
  });

  it('blocks either party of a federation grant before erasing standalone settings', async () => {
    const sharing = await lifecycleTenant(database.db, auth);
    const receiving = await lifecycleTenant(database.db, auth);
    await setDeploymentProfile({ crossOrgEnabled: true });
    try {
      await enableFederation(database.db, sharing);
      await enableFederation(database.db, receiving);
      await seedGrant(database.db, sharing, receiving);
      for (const owner of [sharing, receiving]) {
        const ready = await readyToErase(database.db, owner);
        await expect(
          beginErasure(database.db, ready.service, {
            ...ready,
            operatorRef: 'test-operator@example.invalid',
          }),
        ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
        expect((await getOffboarding(database.db, owner))?.state).toBe('ready_for_erasure');
      }
    } finally {
      await clearDeploymentProfile();
    }
  });

  it('still refuses an unknown tenant table in the operator inventory', async () => {
    const observer = new pg.Client({ connectionString: urls.superuser() });
    await observer.connect();
    const schema = `generated_erasure_inventory_${randomUUID().replaceAll('-', '')}`;
    try {
      await observer.query(`create schema ${schema}`);
      try {
        await observer.query(`create table ${schema}.unknown_content(organization_id uuid)`);
        await expect(listErasableTables(eraser)).rejects.toThrow('ERASURE_GRANTS_INCOMPLETE');
      } finally {
        await observer.query(`drop table if exists ${schema}.unknown_content`);
        await observer.query(`drop schema ${schema}`);
      }
    } finally {
      await observer.end();
    }
  });

  it('classifies all tenant tables as retained, absence-proved, or physically erasable', async () => {
    const rows = await asRole('ensemus_eraser', (client) =>
      client.query<{
        table_ref: string;
        retained: boolean;
        requires_empty: boolean;
        deletable: boolean;
      }>(
        `select n.nspname||'.'||c.relname as table_ref,lifecycle.retained_table(n.nspname::text,c.relname::text) as retained,lifecycle.erasure_requires_empty(n.nspname::text,c.relname::text) as requires_empty,has_table_privilege(current_user,c.oid,'DELETE') as deletable from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attname='organization_id' and not a.attisdropped where c.relkind in ('r','p') and not c.relispartition and n.nspname not like 'pg_%' and n.nspname<>'information_schema'`,
      ),
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows)
      expect(row.deletable, `${row.table_ref} classification and role grants disagree`).toBe(
        !row.retained && !row.requires_empty,
      );
    expect(await listErasableTables(eraser)).toEqual(
      rows.rows
        .filter((row) => !row.retained && !row.requires_empty)
        .map((row) => row.table_ref)
        .sort(),
    );
  });

  it('erases a meeting and its consent history through the restricted role while preserving the other tenant', async () => {
    const owner = await lifecycleTenant(database.db, auth);
    const other = await lifecycleTenant(database.db, auth);
    const notice = 'generated-erasure-notice';
    const fixture = async (tenant: typeof owner) => {
      await updateMeetingSettings(database.db, tenant, {
        enabled: true,
        noticeRef: notice,
        expectedVersion: 1,
      });
      const meeting = await createMeeting(database.db, tenant, {
        title: 'Generated erasure meeting',
        occurredAt: new Date(),
      });
      await recordMeetingConsent(database.db, tenant, {
        meetingId: meeting.id,
        participantId: meeting.participants[0]!.id,
        decision: 'granted',
        noticeRef: notice,
      });
      await importMeetingNotes(database.db, tenant, {
        meetingId: meeting.id,
        text: 'Generated erasure notes',
      });
      return meeting.id;
    };
    await fixture(owner);
    const otherMeeting = await fixture(other);
    const ready = await readyToErase(database.db, owner);
    const tables = ['consent_records', 'notes', 'participants', 'meetings', 'settings'] as const;
    const counts = () =>
      withAccountTx(database.db, ready.service, async (tx) => {
        const result = await tx.execute<{ n: string }>(sql`
        select lifecycle.erasure_table_rows('meetings.'||name, ${ready.offboardingId}::uuid)::text n
        from unnest(array[${sql.join(
          tables.map((table) => sql`${table}::text`),
          sql`,`,
        )}]) with ordinality as names(name, idx)
        order by idx`);
        return result.rows.map(({ n }) => Number(n));
      });
    expect(await counts()).toEqual([1, 1, 1, 1, 1]);
    // Enter the native state machine to test this module's deletion. The complete operator
    // command separately requires coverage of every module before opening erasure.
    await withAccountTx(database.db, ready.service, (tx) =>
      tx
        .update(offboardings)
        .set({
          state: 'erasing',
          erasureStartedAt: new Date(),
          erasureStartedByRef: 'test-operator@example.invalid',
          version: sql`${offboardings.version}+1`,
          updatedAt: new Date(),
        })
        .where(eq(offboardings.id, ready.offboardingId)),
    );
    await eraserClient.query('begin');
    try {
      await eraserClient.query("select set_config('app.organization_id', $1, true)", [
        owner.organizationId,
      ]);
      await eraserClient.query("select set_config('app.actor_type', 'service', true)");
      for (const table of tables) {
        const removed = await eraserClient.query(
          `delete from meetings.${table} where organization_id in ($1,$2)`,
          [owner.organizationId, other.organizationId],
        );
        expect(removed.rowCount).toBe(1);
      }
      await eraserClient.query('commit');
    } catch (error) {
      await eraserClient.query('rollback');
      throw error;
    }
    expect(await counts()).toEqual([0, 0, 0, 0, 0]);
    expect((await getMeeting(database.db, other, otherMeeting)).currentNotes).not.toBeNull();
  });
  it('cannot erase with no open request or read content, and cannot silently report a hold-filtered zero', async () => {
    const owner = await lifecycleTenant(database.db, auth);
    await expect(eraseTenantRows(eraser, owner.organizationId)).rejects.toThrow('ERASURE_NOT_OPEN');
    await expect(
      asRole('ensemus_eraser', (client) => client.query('select title from work.work_units'), {
        organizationId: owner.organizationId,
      }),
    ).rejects.toMatchObject({ code: '42501' });
    const ready = await readyToErase(database.db, owner);
    await beginErasure(database.db, ready.service, {
      offboardingId: ready.offboardingId,
      operatorRef: 'test-operator@example.invalid',
    });
    const hold = await placeLegalHold(database.db, owner, {
      matterRef: randomUUID(),
      scopes: [{ type: 'organization', id: null }],
    });
    await expect(eraseTenantRows(eraser, owner.organizationId)).rejects.toThrow('ERASURE_NOT_OPEN');
    await releaseLegalHold(database.db, owner, {
      holdId: hold.holdId,
      reasonCode: 'TEST_CLOSED',
      expectedVersion: 1,
    });
  });
  it('requires ledger and blob receipts; a crash/rerun preserves honest counts, other tenants and financial records', async () => {
    const who = await paymentFixture(database.db, auth),
      other = await lifecycleTenant(database.db, auth),
      store = new LifecycleMemoryStore(),
      canary = `test-erasure-${randomUUID()}`,
      file = await lifecycleArtifact(database.db, who.owner, store),
      otherFile = await lifecycleArtifact(database.db, other, store);
    const [work] = await withTenantTx(database.db, who.owner, (tx) =>
      tx.select().from(workUnits).where(eq(workUnits.id, file.workUnitId)),
    );
    await updateWorkUnit(database.db, who.owner, work!.id, work!.version, { title: canary });
    await withTenantTx(database.db, who.owner, async (tx) => {
      const [ticket] = await tx
        .insert(tickets)
        .values({
          organizationId: who.owner.organizationId,
          subject: canary,
          category: 'other',
          openedByMembershipId: who.owner.membershipId,
        })
        .returning();
      await tx.insert(ticketMessages).values({
        organizationId: who.owner.organizationId,
        ticketId: ticket!.id,
        authorKind: 'customer',
        authorRef: who.owner.membershipId,
        body: canary,
      });
    });
    const ready = await readyToErase(database.db, who.owner);
    await beginErasure(database.db, ready.service, {
      offboardingId: ready.offboardingId,
      operatorRef: 'test-operator@example.invalid',
    });
    expect((await inspectErasure(database.db, ready.service, ready)).ledgerPending).toBeGreaterThan(
      0,
    );
    const before = (await getOffboarding(database.db, who.owner))!;
    await expect(
      cancelOffboarding(
        database.db,
        who.owner,
        { expectedVersion: before.version, reasonCode: 'TEST_TOO_LATE' },
        ready.ports.offboardingAgents,
      ),
    ).rejects.toMatchObject({ code: 'OFFBOARDING_NOT_CANCELLABLE' });
    await publishErasureLedger(database.db, ready.service, store);
    await purgeDueBlobs(database.db, store, ready.service, new Date(Date.now() + 1000), 100);
    await seal(ready);
    const first = await eraseTenantRows(eraser, who.owner.organizationId);
    expect(first.reduce((sum, table) => sum + table.rowsRemoved, 0)).toBeGreaterThan(0);
    // Simulate losing the process before finishErasure. Its pre-erase counts are already durable.
    const retry = await eraseTenantRows(eraser, who.owner.organizationId);
    expect(retry.every((table) => table.rowsRemoved === 0 && table.rowsLeft === 0)).toBe(true);
    const finished = await finishErasure(
      database.db,
      ready.service,
      { ...ready, tables: retry, blobsRemoved: 0, operatorRef: 'test-operator@example.invalid' },
      ready.ports.offboardingAgents,
      createTenantObjectErasure({ database: database.db, store }),
    );
    expect(finished.state).toBe('reported');
    // The deletion standing change ran while the intent was verified, so the offboarding-owned stop
    // was kept, not released, and 0508 still refuses a later halt once the intent is reported.
    const observer = new pg.Client({ connectionString: urls.superuser() });
    await observer.connect();
    try {
      expect(
        (
          await observer.query<{ engaged: boolean }>(
            'select k.released_at is null as engaged from lifecycle.offboarding_agent_stops s join governance.kill_switches k on k.organization_id=s.organization_id and k.id=s.switch_id where s.organization_id=$1 and s.offboarding_id=$2',
            [who.owner.organizationId, ready.offboardingId],
          )
        ).rows,
      ).toEqual([{ engaged: true }]);
    } finally {
      await observer.end();
    }
    await expect(
      withAccountTx(database.db, ready.service, (tx) =>
        createOffboardingAgentHaltPort().haltOffboardingAgents(
          tx,
          ready.service,
          ready.offboardingId,
        ),
      ),
    ).rejects.toMatchObject({
      cause: { code: 'EN850', message: 'OFFBOARDING_STOP_NOT_ALLOWED' },
    });
    expect(finished.report!.rowsRemoved).toBeGreaterThan(0);
    expect(finished.report!.leftOver).toEqual([]);
    expect(JSON.stringify(finished.report)).not.toContain(canary);
    expect(finished.report!.retained.map((item) => item.what)).toEqual(
      expect.arrayContaining([
        'invoices_and_payments',
        'audit_log',
        'account_identities',
        'backups_until_expiry',
      ]),
    );
    expect(
      await withAccountTx(database.db, ready.service, (tx) =>
        tx.select().from(invoices).where(eq(invoices.id, who.invoice.id)),
      ),
    ).toHaveLength(1);
    expect(
      await withAccountTx(database.db, ready.service, (tx) => tx.select().from(tombstones)),
    ).toHaveLength(1);
    expect(
      await withTenantTx(database.db, other, (tx) =>
        tx.select().from(artifacts).where(eq(artifacts.id, otherFile.artifactId)),
      ),
    ).toHaveLength(1);
    expect((await inspectErasure(database.db, ready.service, ready)).state).toBe('reported');
    await expect(
      import('@ensemus/database').then(({ resolveTenantContext }) =>
        resolveTenantContext(database.db, who.owner.userId, who.owner.organizationId),
      ),
    ).rejects.toThrow();
  });
  it('admits a migrator erasure tombstone only from inside prepare_erasure_artifacts (0534)', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      file = await lifecycleArtifact(database.db, owner, new LifecycleMemoryStore()),
      admin = new pg.Client({ connectionString: urls.superuser() }),
      probe = `public.test_erasure_tombstone_probe_${randomUUID().replaceAll('-', '')}`;
    await admin.connect();
    try {
      // Stands in for any other migrator-owned SECURITY DEFINER function a service actor can call.
      // It writes exactly the row prepare_erasure_artifacts writes, for a fresh target.
      await admin.query(
        `create function ${probe}(p_target uuid) returns void language sql security definer set search_path=pg_catalog as $$ insert into platform.tombstones(organization_id,target_type,target_id,reason_code) values(app.current_organization_id(),'artifact',p_target,'TENANT_ERASURE') $$`,
      );
      await admin.query(`alter function ${probe}(uuid) owner to ensemus_migrator`);
      await admin.query(`revoke all on function ${probe}(uuid) from public`);
      await admin.query(`grant execute on function ${probe}(uuid) to ensemus_app`);
      const ready = await readyToErase(database.db, owner);
      await beginErasure(database.db, ready.service, {
        offboardingId: ready.offboardingId,
        operatorRef: 'test-operator@example.invalid',
      });
      // The fixed function's own write still passes the scoped policy.
      expect(
        (
          await admin.query(
            "select reason_code from platform.tombstones where organization_id=$1 and target_type='artifact' and target_id=$2",
            [owner.organizationId, file.artifactId],
          )
        ).rows,
      ).toEqual([{ reason_code: 'TENANT_ERASURE' }]);
      // Same tenant, same service actor, same open erasure, but outside the fixed function's scope.
      const stray = randomUUID();
      await expect(
        withAccountTx(database.db, ready.service, (tx) =>
          tx.execute(sql`select ${sql.raw(probe)}(${stray}::uuid)`),
        ),
      ).rejects.toMatchObject({
        cause: {
          code: '42501',
          message: expect.stringMatching(/row-level security policy for table "tombstones"/),
        },
      });
      expect(
        (
          await admin.query(
            "select 1 from platform.tombstones where organization_id=$1 and target_type='artifact' and target_id=$2",
            [owner.organizationId, stray],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await admin.query(`drop function if exists ${probe}(uuid)`);
      await admin.end();
    }
  });
  it('refuses a forged erasure tombstone scope from app and agent sessions, and keeps the fixed path (0541)', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      file = await lifecycleArtifact(database.db, owner, new LifecycleMemoryStore()),
      admin = new pg.Client({ connectionString: urls.superuser() }),
      agent = new pg.Client({ connectionString: urls.agent() }),
      probe = `public.test_erasure_tombstone_forge_${randomUUID().replaceAll('-', '')}`,
      tombstoneOf = async (target: string) =>
        (
          await admin.query(
            "select reason_code from platform.tombstones where organization_id=$1 and target_type='artifact' and target_id=$2",
            [owner.organizationId, target],
          )
        ).rows;
    await admin.connect();
    await agent.connect();
    try {
      // Any other migrator-owned SECURITY DEFINER writer an app or agent session can reach.
      await admin.query(
        `create function ${probe}(p_target uuid) returns void language sql security definer set search_path=pg_catalog as $$ insert into platform.tombstones(organization_id,target_type,target_id,reason_code) values(app.current_organization_id(),'artifact',p_target,'TENANT_ERASURE') $$`,
      );
      await admin.query(`alter function ${probe}(uuid) owner to ensemus_migrator`);
      await admin.query(`revoke all on function ${probe}(uuid) from public`);
      await admin.query(`grant execute on function ${probe}(uuid) to ensemus_app, ensemus_agent`);
      const ready = await readyToErase(database.db, owner);
      await beginErasure(database.db, ready.service, {
        offboardingId: ready.offboardingId,
        operatorRef: 'test-operator@example.invalid',
      });
      // The legitimate path: prepare_erasure_artifacts mints its own grant and consumes it.
      expect(await tombstoneOf(file.artifactId)).toEqual([{ reason_code: 'TENANT_ERASURE' }]);
      expect(
        (
          await admin.query(
            'select count(*)::int as n from lifecycle.erasure_tombstone_grants where tenant_id=$1',
            [owner.organizationId],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      // The app service actor sets the 0534 scope GUC and a guessed token, as any session may.
      const appStray = randomUUID();
      await expect(
        withAccountTx(database.db, ready.service, async (tx) => {
          await tx.execute(
            sql`select set_config('lifecycle.erasure_tombstone_org',${owner.organizationId},true),set_config('lifecycle.erasure_tombstone_token',${'a'.repeat(64)},true)`,
          );
          return tx.execute(sql`select ${sql.raw(probe)}(${appStray}::uuid)`);
        }),
      ).rejects.toMatchObject({
        cause: {
          code: '42501',
          message: expect.stringMatching(/row-level security policy for table "tombstones"/),
        },
      });
      expect(await tombstoneOf(appStray)).toEqual([]);
      // The grant table itself is not reachable from the app login.
      await expect(
        withAccountTx(database.db, ready.service, (tx) =>
          tx.execute(sql`select count(*) from lifecycle.erasure_tombstone_grants`),
        ),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
      // An agent login with the same forged settings is refused as well.
      const agentStray = randomUUID();
      await agent.query('begin');
      try {
        await agent.query(
          "select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true),set_config('app.user_id','',true),set_config('app.membership_id','',true),set_config('app.agent_run_id','',true),set_config('lifecycle.erasure_tombstone_org',$1,true),set_config('lifecycle.erasure_tombstone_token',$2,true)",
          [owner.organizationId, 'b'.repeat(64)],
        );
        // The same 0541 guard as the app session above: erasure_artifact_tombstone_birth finds no
        // grant for the forged token (and no app login), so the row is refused by RLS, not by anything
        // earlier such as a missing schema or function privilege.
        await expect(agent.query(`select ${probe}($1::uuid)`, [agentStray])).rejects.toMatchObject({
          code: '42501',
          message: expect.stringMatching(/row-level security policy for table "tombstones"/),
        });
      } finally {
        await agent.query('rollback');
      }
      expect(await tombstoneOf(agentStray)).toEqual([]);
    } finally {
      await admin.query(`drop function if exists ${probe}(uuid)`);
      await agent.end();
      await admin.end();
    }
  });
  it('advances an erasing tenant’s export epoch, and leaves a removed epoch row missing (0522)', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      organizationId = owner.organizationId,
      observer = new pg.Client({ connectionString: urls.superuser() });
    await createWorkUnit(database.db, owner, { title: 'Generated epoch-tracked work' });
    await observer.connect();
    try {
      const epoch = async () =>
        (
          await observer.query<{ epoch: string }>(
            'select epoch::text from sovereign.export_epochs where organization_id=$1',
            [organizationId],
          )
        ).rows.map((row) => BigInt(row.epoch));
      const ready = await readyToErase(database.db, owner);
      await beginErasure(database.db, ready.service, {
        offboardingId: ready.offboardingId,
        operatorRef: 'test-operator@example.invalid',
      });
      await publishErasureLedger(database.db, ready.service, new LifecycleMemoryStore());
      await seal(ready);
      const [before] = await epoch();
      expect(before).toBeDefined();
      // The restricted eraser removes epoch-tracked rows in the erasing tenant. Before 0522 every such
      // AFTER DELETE advance was an INSERT ... ON CONFLICT, which the erasure birth fence refused.
      await eraserClient.query('begin');
      let removed: number;
      try {
        await eraserClient.query(
          "select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true),set_config('app.user_id','',true),set_config('app.membership_id','',true),set_config('app.agent_run_id','',true)",
          [organizationId],
        );
        const open = await eraserClient.query<{ open: boolean }>(
          'select lifecycle.lock_erasure_tenant() as open',
        );
        expect(open.rows[0]?.open).toBe(true);
        removed =
          (
            await eraserClient.query('delete from work.work_assignments where organization_id=$1', [
              organizationId,
            ])
          ).rowCount ?? 0;
        await eraserClient.query('commit');
      } catch (error) {
        await eraserClient.query('rollback');
        throw error;
      }
      expect(removed).toBeGreaterThan(0);
      expect(await epoch()).toEqual([before! + BigInt(removed)]);
      // The full erasure removes the epoch row itself (sovereign before work). Every later tracked
      // deletion then finds no row and must not create one for a tenant that is being erased.
      const first = await eraseTenantRows(eraser, organizationId);
      expect(first.find((row) => row.tableRef === 'sovereign.export_epochs')).toMatchObject({
        rowsRemoved: 1,
        rowsLeft: 0,
      });
      const work = first.find((row) => row.tableRef === 'work.work_units');
      expect(work?.rowsRemoved).toBeGreaterThan(0);
      expect(work?.rowsLeft).toBe(0);
      expect(await epoch()).toEqual([]);
      const retry = await eraseTenantRows(eraser, organizationId);
      expect(retry.every((row) => row.rowsRemoved === 0 && row.rowsLeft === 0)).toBe(true);
      expect(await epoch()).toEqual([]);
    } finally {
      await observer.end();
    }
  });
  it('keeps metadata tenant-scoped after membership deletion and refuses new bodies after erasure', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      other = await lifecycleTenant(database.db, auth),
      service = createServiceContext(owner.organizationId),
      store = new LifecycleMemoryStore();
    const insert = () =>
      withAccountTx(database.db, service, (tx) =>
        tx.insert(sealedSecrets).values({
          organizationId: owner.organizationId,
          id: randomUUID(),
          purpose: 'test.erasure',
          keyId: randomUUID(),
          wrappedKey: randomBytes(32),
          iv: randomBytes(12),
          ciphertext: randomBytes(32),
          authTag: randomBytes(16),
        }),
      );
    await insert();
    const metadata = (context: typeof service) =>
      withAccountTx(database.db, context, async (tx) => {
        await tx.execute(sql`select set_config('app.actor_type','service',true)`);
        return tx.execute(
          sql`select count(*)::int as n from secrets.sealed_secrets where organization_id=${owner.organizationId}::uuid`,
        );
      });
    expect((await metadata(service)).rows[0]?.n).toBe(1);
    expect((await metadata(createServiceContext(other.organizationId))).rows[0]?.n).toBe(0);
    expect((await metadata(owner)).rows[0]?.n).toBe(0);
    for (const column of ['id', 'ciphertext', 'wrapped_key', 'key_id'])
      await expect(
        withAccountTx(database.db, service, (tx) =>
          tx.execute(sql`select ${sql.identifier(column)} from secrets.sealed_secrets`),
        ),
      ).rejects.toThrow();
    const ready = await readyToErase(database.db, owner);
    await beginErasure(database.db, service, {
      ...ready,
      operatorRef: 'test-operator@example.invalid',
    });
    await seal(ready);
    const tables = await eraseTenantRows(eraser, owner.organizationId);
    await finishErasure(
      database.db,
      service,
      { ...ready, tables, blobsRemoved: 0, operatorRef: 'test-operator@example.invalid' },
      ready.ports.offboardingAgents,
      createTenantObjectErasure({ database: database.db, store }),
    );
    // A stale service context cannot resurrect content after the final count and closed tenant.
    await expect(insert()).rejects.toThrow();
    expect((await metadata(service)).rows[0]?.n).toBe(0);
    await expect(
      withAccountTx(database.db, service, (tx) =>
        tx.execute(sql`select ciphertext from secrets.sealed_secrets`),
      ),
    ).rejects.toThrow();
  });
});
