import {
  cancelSandboxRun,
  getSandboxRun,
  getSandboxStatus,
  requestSandboxRun,
  requestHash,
  runIdempotent,
  uploadSkillBundle,
} from '@ensemus/application';
import { createSandboxWorkerControl } from '@ensemus/application/sandbox-worker-control';
import { openAppDatabase, sandboxRuns, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { SANDBOX_DEFAULT_CEILINGS } from '@ensemus/domain/sandbox';
import { createScriptedRunner } from '@ensemus/sandbox/testing';
import { buildTestBundle } from '@ensemus/skills/testing';
import {
  createSandboxRunActivities,
  createSandboxRunPlatformActivities,
} from '@ensemus/workflows/sandbox-run-activities';
import { createSkillVerificationActivities } from '@ensemus/workflows/skill-verification-activities';
import { Context } from '@temporalio/activity';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { seedPackage, seedSigner } from '../helpers/skills';
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
  async function fixture(output: Record<string, unknown>) {
    const owner = tenants.a.owner.context;
    const pkg = await seedPackage(app.db, owner);
    const { signer } = await seedSigner(app.db, owner);
    const built = buildTestBundle({
      key: signer,
      name: pkg.name,
      source: 'process.stdout.write(JSON.stringify({sample: true}));',
    });
    const store = new LifecycleMemoryStore();
    const objects = Object.assign(store, {
      async putSingleAttempt(key: string, body: Buffer) {
        await store.put(key, body);
        return { transport: 'written' } as const;
      },
    });
    const version = await uploadSkillBundle(app.db, objects, owner, enabled, {
      packageId: pkg.id,
      bytes: built.bytes,
    });
    const input = { organizationId: owner.organizationId, skillVersionId: version.id };
    const verifier = createSkillVerificationActivities({
      database: worker.db,
      store: objects,
      ceilings,
      reviewKeys: new Map(),
      sandboxGate: enabled,
    });
    const runner = createScriptedRunner({
      execute() {
        const stdout = Buffer.from(JSON.stringify(output));
        return {
          ending: 'exited',
          exitCode: 0,
          wallMs: 10,
          cpuMs: 2,
          peakMemoryKb: 64,
          stdout,
          stdoutBytes: stdout.length,
          stderrBytes: 0,
          runtime: { name: 'scripted', version: 'test' },
        };
      },
    });
    const activity = createSandboxRunActivities({
      control: await createSandboxWorkerControl(worker.db),
      gate: enabled,
      ceilings,
      store: objects,
      runner,
      maxConcurrentPerTenant: 1,
      probeMaxAgeMs: 30_000,
    });
    const step = await verifier.checkSkillBundle(input);
    expect(step.step).toBe('run_fixtures');
    if (step.step !== 'run_fixtures') throw new Error('TEST_FIXTURE_NOT_QUEUED');
    expect(await verifier.checkSkillBundle(input)).toEqual(step);
    const sandboxRunId = step.sandboxRunIds[0]!;
    const native = { organizationId: owner.organizationId, sandboxRunId };
    await expect(getSandboxRun(app.db, owner, sandboxRunId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const activityContext = vi.spyOn(Context, 'current').mockReturnValue({
      heartbeat() {},
      cancellationSignal: new AbortController().signal,
    } as Context);
    try {
      await expect(activity.executeSandboxRun(native)).resolves.toEqual({
        step: 'settled',
        outcome: 'succeeded',
      });
    } finally {
      activityContext.mockRestore();
    }
    expect(runner.jobs).toHaveLength(1);
    expect(runner.jobs[0]!.stdin.toString()).toBe('{"sample":true}');
    expect(runner.jobs[0]!.files.every(({ path }) => !path.startsWith('tests/'))).toBe(true);
    return { input, verifier };
  }

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    worker = openAppDatabase(urls.worker());
    tenants = await makeTwoTenants(app.db);
    await proveSecondFactor(tenants.a.owner);
    // A scripted runner tests the database and Activity boundary. Native OCI has its own suite.
    const { input, verifier } = await fixture({ sample: true });
    await expect(verifier.finishSkillVerification(input)).resolves.toBe('verified');
    await expect(verifier.finishSkillVerification(input)).resolves.toBe('verified');
    skillVersionId = input.skillVersionId;
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
      isolationEvidence: 'probe_passed',
      lastProbePassedAt: expect.any(Date),
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

  it('rejects a signed fixture that returns valid JSON with the wrong value', async () => {
    const { input, verifier } = await fixture({ sample: false });
    await expect(verifier.finishSkillVerification(input)).resolves.toBe('rejected');
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
