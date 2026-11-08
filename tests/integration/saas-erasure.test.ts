import { createTenantObjectErasure } from '@ensemus/application/saas/tenant-object-erasure';
import { randomBytes, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import {
  artifacts,
  invoices,
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
import { purgeDueBlobs, updateWorkUnit } from '@ensemus/application';
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
  afterAll(async () => {
    await eraserClient.query('reset session authorization');
    await eraserClient.end();
    await auth.end();
    await database.close();
  });
  it('classifies every tenant table as explicitly retained or actually reachable by the eraser role', async () => {
    const rows = await asRole('ensemus_eraser', (client) =>
      client.query<{ table_ref: string; retained: boolean; deletable: boolean }>(
        `select n.nspname||'.'||c.relname as table_ref,lifecycle.retained_table(n.nspname::text,c.relname::text) as retained,has_table_privilege(current_user,c.oid,'DELETE') as deletable from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attname='organization_id' and not a.attisdropped where c.relkind in ('r','p') and not c.relispartition and n.nspname not like 'pg_%' and n.nspname<>'information_schema'`,
      ),
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows)
      expect(row.deletable, `${row.table_ref} classification and role grants disagree`).toBe(
        !row.retained,
      );
    expect(await listErasableTables(eraser)).toEqual(
      rows.rows
        .filter((row) => !row.retained)
        .map((row) => row.table_ref)
        .sort(),
    );
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
      createTenantObjectErasure({database:database.db,store}),
    );
    expect(finished.state).toBe('reported');
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
  it('keeps metadata tenant-scoped after membership deletion and refuses new bodies after erasure', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      other = await lifecycleTenant(database.db, auth),
      service = createServiceContext(owner.organizationId),store=new LifecycleMemoryStore();
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
    const tables = await eraseTenantRows(eraser, owner.organizationId);
    await finishErasure(
      database.db,
      service,
      { ...ready, tables, blobsRemoved: 0, operatorRef: 'test-operator@example.invalid' },
      ready.ports.offboardingAgents,
      createTenantObjectErasure({database:database.db,store}),
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
