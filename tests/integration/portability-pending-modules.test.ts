import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganization,
  openAppDatabase,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  beginExport,
  requestOrganizationImport,
  SOURCE_PORTABILITY_SECTIONS,
} from '@ensemus/application';
import { assertJoinedPortabilitySchema } from '../../packages/application/src/portability-extensions';
import { isExportEpochCurrent } from '../../packages/application/src/portability-epoch';
import { PENDING_PORTABILITY_TABLES } from '../../packages/application/src/portability-pending-modules';
import { sql } from 'drizzle-orm';
import { nativeSovereignContext, seedExportRow, testRecipient } from '../helpers/sovereign';
import { seedPackage, seedSigner } from '../helpers/skills';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { urls } from '../helpers/stack';
import {
  enableFederation,
  seedGrant,
  setDeploymentProfile,
  clearDeploymentProfile,
} from '../helpers/federation';

describe('frozen archives beside unfinished modules', () => {
  let app: ReturnType<typeof openAppDatabase>, worker: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client, su: pg.Client;
  const recipient = testRecipient();
  const deps = {
    sections: SOURCE_PORTABILITY_SECTIONS,
    sourceRelease: 'generated-test',
    retentionHours: 24,
  };
  async function owner() {
    const id = randomUUID();
    await auth.query(
      'insert into identity.users(id,name,email,email_verified) values($1,$2,$3,true)',
      [id, 'Generated owner', `${id}@example.invalid`],
    );
    const { organizationId } = await createOrganization(app.db, {
      userId: id,
      name: 'Generated company',
      commercialMode: 'sovereign',
    });
    return nativeSovereignContext(app.db, id, organizationId);
  }
  const service = (person: TenantContext) => createServiceContext(person.organizationId);
  async function probe(person: TenantContext) {
    return withTenantTx(worker.db, service(person), async (tx) => {
      const rows = await tx.execute(sql`select sovereign.pending_modules_empty() as empty`);
      return rows.rows[0]?.empty;
    });
  }
  const epoch = async (person: TenantContext) => {
    const { rows } = await su.query(
      'select epoch::text from sovereign.export_epochs where organization_id=$1',
      [person.organizationId],
    );
    return BigInt(rows[0].epoch);
  };
  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    worker = openAppDatabase(urls.worker());
    auth = new pg.Client({ connectionString: urls.auth() });
    su = new pg.Client({ connectionString: urls.superuser() });
    await auth.connect();
    await su.connect();
  });
  afterAll(async () => {
    await app?.close();
    await worker?.close();
    await auth?.end();
    await su?.end();
  });

  it('lets a genuinely empty company use the unchanged /3 archive', async () => {
    const person = await owner();
    expect(await probe(person)).toBe(true);
    const exportId = await seedExportRow(app.db, person, recipient);
    expect(await beginExport(worker.db, service(person), { exportId }, deps)).toMatchObject({
      state: 'continue',
    });
    const { rows } = await su.query(
      'select inventory_version from sovereign.organization_exports where id=$1',
      [exportId],
    );
    expect(rows[0].inventory_version).toBe('ensemus.m3-m7/3');
  });
  it('refuses a restricted skill even when the exporter cannot see its row, without blocking another company', async () => {
    const person = await owner(),
      other = await owner();
    const exportId = await seedExportRow(app.db, person, recipient);
    await seedPackage(app.db, person, { contentClassification: 'restricted' });
    // Narrow the caller's RLS for this generated fixture; never broaden production visibility.
    // The migrator's fixed probe must remain independent of a caller-visible zero-row result.
    await su.query(
      'create policy pending_fixture_hidden on skills.packages as restrictive for select to ensemus_app using(false)',
    );
    try {
      const visible = await withTenantTx(worker.db, service(person), (tx) =>
        tx.execute(sql`select id from skills.packages`),
      );
      expect(visible.rows).toEqual([]);
      expect(await probe(person)).toBe(false);
      expect(await probe(other)).toBe(true);
      expect(await beginExport(worker.db, service(person), { exportId }, deps)).toEqual({
        state: 'failed',
        code: 'RECORD_REFUSED',
      });
      expect(await beginExport(worker.db, service(person), { exportId }, deps)).toEqual({
        state: 'failed',
        code: 'RECORD_REFUSED',
      });
      const { rows } = await su.query(
        'select status,snapshot_at from sovereign.organization_exports where id=$1',
        [exportId],
      );
      expect(rows[0]).toEqual({ status: 'failed', snapshot_at: null });
    } finally {
      await su.query('drop policy pending_fixture_hidden on skills.packages');
    }
  });
  it('names an unsupported import target as not empty before making any import intent', async () => {
    const person = await owner(),
      other = await owner();
    await seedSigner(app.db, person);
    await expect(requestOrganizationImport(app.db, person)).rejects.toMatchObject({
      code: 'IMPORT_TARGET_NOT_EMPTY',
    });
    expect(
      (
        await su.query('select id from sovereign.organization_imports where organization_id=$1', [
          person.organizationId,
        ])
      ).rows,
    ).toEqual([]);
    expect(await requestOrganizationImport(app.db, other)).toMatchObject({ status: 'requested' });
  });
  it('supersedes a running legacy export on the first new-module write and leaves other tenants alone', async () => {
    const person = await owner(),
      other = await owner();
    const exportId = await seedExportRow(app.db, person, recipient);
    await beginExport(worker.db, service(person), { exportId }, deps);
    const before = await epoch(person),
      otherBefore = await epoch(other);
    await seedSigner(app.db, person);
    expect(await epoch(person)).toBe(before + 1n);
    expect(await epoch(other)).toBe(otherBefore);
    const { rows } = await su.query(
      `select e.export_epoch::text as pinned,r.epoch::text as current
      from sovereign.organization_exports e join sovereign.export_epochs r using(organization_id) where e.id=$1`,
      [exportId],
    );
    expect(rows[0].pinned).not.toBe(rows[0].current);
    expect(await probe(person)).toBe(false);
    expect(
      await withTenantTx(app.db, other, async (tx) => {
        await tx.execute(
          sql`select set_config('sovereign.pending_epoch_tenant',${person.organizationId},true)`,
        );
        return (await tx.execute(sql`select id from skills.trusted_signers`)).rows;
      }),
    ).toEqual([]);
    await expect(
      withTenantTx(app.db, other, async (tx) => {
        await tx.execute(
          sql`select set_config('sovereign.pending_epoch_tenant',${person.organizationId},true)`,
        );
        await tx.execute(sql`update sovereign.export_epochs set epoch=epoch+1`);
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    expect(await epoch(person)).toBe(before + 1n);
  });
  it('counts both federation parties and invalidates both epochs without exposing the shared snapshot', async () => {
    const sender = await owner(),
      receiver = await owner(),
      other = await owner();
    // This isolated generated database must have no deployment profile before the fixture installs one.
    expect((await su.query('select singleton from tenancy.deployment_profile')).rows).toEqual([]);
    await setDeploymentProfile({ crossOrgEnabled: true });
    try {
      await enableFederation(app.db, sender);
      const grant = await seedGrant(app.db, sender, receiver, { status: 'proposed' });
      const a = await epoch(sender),
        b = await epoch(receiver),
        c = await epoch(other);
      // A crossing has no organization_id. Its recipient must count even before accepting a grant.
      await inFixtureTenant(su, sender.organizationId, () =>
        su.query(
          `insert into federation.crossings
        (grant_id,sender_organization_id,receiver_organization_id,outcome,code)
        values($1,$2,$3,'refused','GENERATED_TEST')`,
          [grant.id, sender.organizationId, receiver.organizationId],
        ),
      );
      expect(await probe(sender)).toBe(false);
      expect(await probe(receiver)).toBe(false);
      expect(await probe(other)).toBe(true);
      expect(await epoch(sender)).toBe(a + 1n);
      expect(await epoch(receiver)).toBe(b + 1n);
      expect(await epoch(other)).toBe(c);
      expect(
        (
          await su.query(
            "select current_setting('sovereign.pending_epoch_tenant',true) as selector",
          )
        ).rows[0].selector ?? '',
      ).toBe('');
    } finally {
      await clearDeploymentProfile();
    }
  });
  it('refuses pre-existing module data even when an older archive has a matching epoch', async () => {
    const person = await owner();
    const exportId = await seedExportRow(app.db, person, recipient);
    await beginExport(worker.db, service(person), { exportId }, deps);
    const pinned = await epoch(person);
    await seedSigner(app.db, person);
    // Generated restore fixture: the data exists but its epoch predates the new module's hook.
    // Only this test tenant's counter is set back; the product has no such grant or reset path.
    await su.query('update sovereign.export_epochs set epoch=$2 where organization_id=$1', [
      person.organizationId,
      pinned.toString(),
    ]);
    expect(
      await withTenantTx(worker.db, service(person), (tx) =>
        isExportEpochCurrent(tx, service(person), exportId),
      ),
    ).toBe(false);
  });
  it('keeps unknown schemas refused and pending probes isolated from the erasure allowlist', async () => {
    const person = await owner();
    const table = `pending_test_${randomUUID().replaceAll('-', '')}`;
    await su.query(`create table public.${table}(id uuid)`);
    try {
      await expect(withTenantTx(app.db, person, assertJoinedPortabilitySchema)).rejects.toThrow();
    } finally {
      await su.query(`drop table public.${table}`);
    }
    const { rows } = await su.query(
      `select n.nspname||'.'||c.relname as name,c.relrowsecurity,c.relforcerowsecurity,
      exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='portable_pending_probe') as probe,
      exists(select 1 from pg_trigger t where t.tgrelid=c.oid and t.tgname='portable_pending_epoch' and t.tgenabled='O') as epoch
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname||'.'||c.relname=any($1::text[])`,
      [PENDING_PORTABILITY_TABLES],
    );
    expect(rows.map((row) => row.name).sort()).toEqual([...PENDING_PORTABILITY_TABLES].sort());
    for (const row of rows) {
      expect(row.relrowsecurity && row.relforcerowsecurity).toBe(true);
      const tenantData = !['tenancy.deployment_profile', 'tenancy.isolation_evidence'].includes(
        row.name,
      );
      expect(row.probe).toBe(tenantData);
      expect(row.epoch).toBe(tenantData);
    }
    expect(
      (await app.db.run((tx) => tx.execute(sql`select sovereign.pending_modules_empty() as empty`)))
        .rows[0]?.empty,
    ).toBe(false);
    const eraser = await su.query(
      "select name from unnest($1::text[]) name where has_table_privilege('ensemus_eraser',name,'DELETE')",
      [PENDING_PORTABILITY_TABLES],
    );
    // Erasure coverage and the frozen export format have independent admission rules.
    expect(eraser.rows.map((row) => row.name).sort()).toEqual([
      'federation.org_settings',
      'integrations.business_record_actions',
      'integrations.business_records',
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
    ]);
    for (const url of [urls.auth(), urls.dispatcher()]) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await expect(client.query('select sovereign.pending_modules_empty()')).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await client.end();
      }
    }
    const agent = new pg.Client({ connectionString: urls.agent() });
    await agent.connect();
    try {
      expect((await agent.query('select sovereign.pending_modules_empty() as empty')).rows).toEqual(
        [{ empty: false }],
      );
    } finally {
      await agent.end();
    }
  });
});
