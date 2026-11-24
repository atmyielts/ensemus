import {
  cancelSandboxRun,
  getSandboxRun,
  getSandboxStatus,
  requestSandboxRun,
  requestHash,
  runIdempotent,
} from '@ensemus/application';
import { createSandboxWorkerControl } from '@ensemus/application/sandbox-worker-control';
import { openAppDatabase, sandboxRuns, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { SANDBOX_DEFAULT_CEILINGS } from '@ensemus/domain/sandbox';
import { createSandboxRunPlatformActivities } from '@ensemus/workflows/sandbox-run-activities';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTwoTenants } from '../helpers/product';
import { seedPackage, seedSigner, seedVersion } from '../helpers/skills';
import { urls } from '../helpers/stack';
import { LifecycleMemoryStore } from './saas-lifecycle-fixture';

const ceilings = SANDBOX_DEFAULT_CEILINGS;
const enabled = { isEnabled: async () => true };
const disabled = { isEnabled: async () => false };
const deps = { gate: enabled, agentGuard: null };

describe('sandbox request native authority', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let worker: ReturnType<typeof openAppDatabase>;
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;
  let skillVersionId: string;
  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    worker = openAppDatabase(urls.worker());
    tenants = await makeTwoTenants(app.db);
    const owner = tenants.a.owner.context;
    const pkg = await seedPackage(app.db, owner);
    const { signer } = await seedSigner(app.db, owner);
    // A DDL/dispatch fixture, not runtime evidence. Its bytes never leave PostgreSQL in these tests.
    const version = await seedVersion(app.db, owner, {
      packageId: pkg.id,
      packageName: pkg.name,
      signer,
      kind: 'sandbox',
      state: 'verified',
    });
    skillVersionId = version.id;
  });
  afterAll(async () => {
    await Promise.all([app?.close(), worker?.close()]);
  });

  const prepared = () => ({
    purpose: 'operator_test' as const,
    classification: 'internal' as const,
    input: { data: 'generated fixture' },
    ceilings,
    skillVersionId,
  });

  it('uses tenant and user boundaries for operator trials and never reports input', async () => {
    const owner = tenants.a.owner.context;
    const row = await requestSandboxRun(app.db, owner, deps, prepared());
    expect(row).toMatchObject({
      status: 'queued',
      isolationEvidence: 'none',
      network: 'none',
      output: null,
    });
    expect(row).not.toHaveProperty('input');
    await expect(getSandboxRun(app.db, owner, row.id)).resolves.toEqual(row);
    await expect(getSandboxRun(app.db, tenants.b.owner.context, row.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(getSandboxRun(app.db, tenants.a.admin.context, row.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(getSandboxRun(app.db, tenants.a.member.context, row.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(getSandboxStatus(app.db, owner, { enabled: false, ceilings })).resolves.toEqual({
      enabled: false,
      ceilings,
      isolationEvidence: 'none',
      lastProbePassedAt: null,
    });
    await cancelSandboxRun(app.db, owner, row.id);
    await cancelSandboxRun(app.db, owner, row.id);
    const stopped = await getSandboxRun(app.db, owner, row.id);
    expect(stopped).toMatchObject({
      status: 'cancelled',
      outcomeCode: 'CANCELLED_BY_REQUEST',
      version: 2,
    });
    const aggregate = await withTenantTx(
      worker.db,
      createServiceContext(owner.organizationId),
      (tx) =>
        tx.execute<{ event_type: string; payload: unknown }>(
          sql`select e.event_type,e.payload from platform.domain_events e
          join platform.outbox_events o on o.event_id=e.id and o.organization_id=e.organization_id
          where e.aggregate_id=${row.id}::uuid order by e.aggregate_version,e.event_type`,
        ),
    );
    expect(aggregate.rows.map(({ event_type }) => event_type)).toEqual([
      'sandbox_run.requested',
      'sandbox_run.cancel_requested',
      'sandbox_run.settled',
    ]);
    expect(JSON.stringify(aggregate.rows)).not.toContain('generated fixture');
  });

  it('refuses disabled, oversize and over-classified requests before any new run', async () => {
    const owner = tenants.a.owner.context;
    await expect(
      requestSandboxRun(app.db, owner, { gate: disabled, agentGuard: null }, prepared()),
    ).rejects.toMatchObject({ code: 'FEATURE_NOT_ENABLED' });
    await expect(
      requestSandboxRun(app.db, owner, deps, { ...prepared(), input: 'a'.repeat(1048576) }),
    ).rejects.toMatchObject({ code: 'SANDBOX_INPUT_TOO_LARGE' });
    await expect(
      requestSandboxRun(app.db, owner, deps, { ...prepared(), input: '\u0000' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      requestSandboxRun(app.db, owner, deps, { ...prepared(), classification: 'confidential' }),
    ).rejects.toMatchObject({ code: 'SANDBOX_CLASSIFICATION_NOT_ALLOWED' });
    await expect(
      requestSandboxRun(app.db, tenants.b.owner.context, deps, prepared()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('replays a repeated operator request against one run ID', async () => {
    const owner = tenants.a.owner.context;
    const request = {
      key: 'sandbox-test-idempotency-key',
      requestHash: requestHash(['sandbox', skillVersionId]),
    };
    const invoke = () =>
      runIdempotent(
        app.db,
        owner,
        request,
        (db) => requestSandboxRun(db, owner, deps, prepared()),
        (row) => ({ status: 202, body: { id: row.id } }),
      );
    const first = await invoke();
    expect(first.kind).toBe('fresh');
    expect(await invoke()).toEqual({ ...first, kind: 'replayed' });
  });

  it('refuses a web login attempting to claim or forge an execution receipt', async () => {
    const owner = tenants.a.owner.context;
    const row = await requestSandboxRun(app.db, owner, deps, prepared());
    await expect(createSandboxWorkerControl(app.db)).rejects.toMatchObject({
      code: 'WORKER_LOGIN_ROLE_MISMATCH',
    });
    await expect(
      withTenantTx(app.db, owner, (tx) =>
        tx
          .update(sandboxRuns)
          .set({
            status: 'running',
            attempts: 1,
            isolationProbePassedAt: new Date(),
            version: 2,
          })
          .where(eq(sandboxRuns.id, row.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(getSandboxRun(app.db, owner, row.id)).resolves.toMatchObject({
      status: 'queued',
      isolationEvidence: 'none',
    });
  });

  it('settles unavailable when the dedicated worker never ran and omits false receipts', async () => {
    const owner = tenants.a.owner.context;
    const row = await requestSandboxRun(app.db, owner, deps, prepared());
    const activities = createSandboxRunPlatformActivities({
      database: worker.db,
      store: new LifecycleMemoryStore(),
      ceilings,
      reviewKeys: new Map(),
    });
    const ids = { organizationId: owner.organizationId, sandboxRunId: row.id };
    await expect(activities.abandonSandboxRun(ids)).resolves.toBe('runner_unavailable');
    await expect(activities.abandonSandboxRun(ids)).resolves.toBe('runner_unavailable');
    await expect(activities.readSandboxRunOutcome(ids)).resolves.toBe('runner_unavailable');
    await expect(getSandboxRun(app.db, owner, row.id)).resolves.toMatchObject({
      status: 'runner_unavailable',
      outcomeCode: 'RUNNER_NOT_CONFIGURED',
      isolationEvidence: 'none',
      output: null,
    });
    await expect(cancelSandboxRun(app.db, owner, row.id)).rejects.toMatchObject({
      code: 'SANDBOX_RUN_NOT_CANCELLABLE',
    });
  });

  it('cannot admit an attempt without a fresh passing report', async () => {
    const owner = tenants.a.owner.context;
    const row = await requestSandboxRun(app.db, owner, deps, prepared());
    const control = await createSandboxWorkerControl(worker.db);
    await expect(
      control.begin(owner.organizationId, {
        sandboxRunId: row.id,
        probe: null,
        runtime: null,
        enabled: true,
        ceilings,
        maxConcurrentPerTenant: 2,
        probeMaxAgeMs: 30000,
      }),
    ).resolves.toEqual({ step: 'settled', status: 'denied' });
    await expect(getSandboxRun(app.db, owner, row.id)).resolves.toMatchObject({
      status: 'denied',
      outcomeCode: 'ISOLATION_NOT_PROVED',
      isolationEvidence: 'none',
    });
  });
});
