import { createHash, randomUUID } from 'node:crypto';
import { createSandboxWorkerControl } from '@ensemus/application/sandbox-worker-control';
import { openAppDatabase, skillVersions, withTenantTx } from '@ensemus/database';
import { SANDBOX_DEFAULT_CEILINGS } from '@ensemus/domain/sandbox';
import { skillBundleObjectKey } from '@ensemus/domain/skill';
import { passingProbeReport } from '@ensemus/sandbox/testing';
import { buildTestBundle } from '@ensemus/skills/testing';
import { createSkillVerificationActivities } from '@ensemus/workflows/skill-verification-activities';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { nativeStackContext } from '../helpers/native-mfa';
import { contractProblems } from '../helpers/openapi';
import { seedPackage, seedSigner } from '../helpers/skills';
import { urls } from '../helpers/stack';
import { LifecycleMemoryStore } from '../integration/saas-lifecycle-fixture';

const enabled = process.env.ENSEMUS_SANDBOX_ENABLED === 'true';
const ceilings = SANDBOX_DEFAULT_CEILINGS;
const unknownId = '00000000-0000-4000-8000-000000000001';

async function signedTrialVersion(owner: Person, organizationId: string) {
  const app = openAppDatabase(urls.app());
  const worker = openAppDatabase(urls.worker());
  try {
    const context = await nativeStackContext(app.db, owner, organizationId);
    const pkg = await seedPackage(app.db, context);
    const { signer } = await seedSigner(app.db, context);
    const signed = buildTestBundle({
      key: signer,
      name: pkg.name,
      source: 'process.stdout.write(JSON.stringify({sample:true}));',
    });
    const skillVersionId = randomUUID();
    const bundleObjectKey = skillBundleObjectKey(organizationId, skillVersionId);
    // The API does not execute code on this stack. Seed a generated receipt through native roles.
    // The dedicated Linux runner has a separate job exercising actual execution.
    await withTenantTx(app.db, context, (tx) =>
      tx.insert(skillVersions).values({
        organizationId,
        id: skillVersionId,
        packageId: pkg.id,
        bundleObjectKey,
        bundleSha256: createHash('sha256').update(signed.bytes).digest('hex'),
        sizeBytes: signed.bytes.length,
        uploadedByMembershipId: context.membershipId,
      }),
    );
    const store = new LifecycleMemoryStore();
    await store.put(bundleObjectKey, signed.bytes);
    const verifier = createSkillVerificationActivities({
      database: worker.db,
      store,
      ceilings,
      reviewKeys: new Map(),
      sandboxGate: { isEnabled: async () => true },
    });
    const input = { organizationId, skillVersionId };
    const step = await verifier.checkSkillBundle(input);
    if (step.step !== 'run_fixtures') throw new Error('STACK_SANDBOX_FIXTURE_NOT_QUEUED');
    const control = await createSandboxWorkerControl(worker.db);
    const probe = passingProbeReport();
    const runtime = { name: probe.runtime, version: probe.runtimeVersion };
    const sandboxRunId = step.sandboxRunIds[0]!;
    const attempt = await control.begin(organizationId, {
      sandboxRunId,
      enabled: true,
      ceilings,
      probe,
      runtime,
      probeMaxAgeMs: 30_000,
      maxConcurrentPerTenant: 1,
    });
    if (attempt.step !== 'start') throw new Error('STACK_SANDBOX_FIXTURE_NOT_STARTED');
    const stdout = Buffer.from('{"sample":true}');
    await expect(
      control.finish(organizationId, {
        sandboxRunId,
        attempt: attempt.job.attempt,
        result: {
          ending: 'exited',
          exitCode: 0,
          wallMs: 10,
          cpuMs: 2,
          peakMemoryKb: 64,
          stdout,
          stdoutBytes: stdout.length,
          stderrBytes: 0,
          runtime,
        },
        output: { ok: true, value: { sample: true } },
      }),
    ).resolves.toBe('succeeded');
    await expect(verifier.finishSkillVerification(input)).resolves.toBe('verified');
    return skillVersionId;
  } finally {
    await Promise.all([app.close(), worker.close()]);
  }
}

describe('Sandbox trial HTTP contract', () => {
  let owner: Person, member: Person, outsider: Person, organizationId: string;
  const path = (suffix: string) => `/api/v1/organizations/${organizationId}/${suffix}`;
  const requestPath = (id: string) => `skill-versions/${id}/sandbox-runs`;
  beforeAll(async () => {
    owner = await signUp('Generated Sandbox owner');
    organizationId = await createOrganization(owner, 'Generated Sandbox company');
    member = await join(owner, organizationId, 'Generated Sandbox member');
    outsider = await signUp('Generated Sandbox outsider');
  });

  async function call(
    person: Person | null,
    method: 'GET' | 'POST',
    suffix: string,
    { body, key, origin = BASE }: { body?: unknown; key?: string; origin?: string } = {},
  ) {
    const response = await fetch(`${BASE}${path(suffix)}`, {
      method,
      headers: {
        ...(person ? { cookie: person.jar.cookie } : {}),
        ...(method === 'POST' ? { origin } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    expect(
      contractProblems({
        method,
        path: path(suffix),
        status: response.status,
        headers: response.headers,
        text,
      }).problems,
    ).toEqual([]);
    expect(response.headers.get('cache-control')).toContain('no-store');
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  }

  it('returns current operator configuration without exposing it to other tenants or members', async () => {
    expect((await call(null, 'GET', 'sandbox/status')).status).toBe(401);
    expect((await call(outsider, 'GET', 'sandbox/status')).status).toBe(404);
    expect((await call(member, 'GET', 'sandbox/status')).status).toBe(403);
    expect((await call(owner, 'GET', 'sandbox/status')).body).toMatchObject({
      enabled,
      isolation_evidence: 'none',
      last_probe_passed_at: null,
      ceilings: { wall_ms: ceilings.wallMs, memory_mb: ceilings.memoryMb },
    });
    expect((await call(owner, 'GET', `sandbox-runs/${unknownId}`)).status).toBe(404);
    expect((await call(owner, 'POST', `sandbox-runs/${unknownId}/cancellation`)).status).toBe(404);
    const body = { classification: 'internal', input: { sample: true } };
    expect(
      (await call(member, 'POST', requestPath(unknownId), { body, key: randomUUID() })).status,
    ).toBe(403);
    expect(
      (
        await call(owner, 'POST', requestPath(unknownId), {
          body,
          key: randomUUID(),
          origin: 'https://outside.example.invalid',
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(owner, 'POST', requestPath(unknownId), { body, key: randomUUID() })).status,
    ).toBe(enabled ? 404 : 409);
  });

  it('queues, replays, reads and cancels a generated trial', async () => {
    if (!enabled) return;
    const version = await signedTrialVersion(owner, organizationId);
    const body = { classification: 'internal', input: { marker: 'generated-private-trial' } };
    const key = randomUUID();
    const requested = await call(owner, 'POST', requestPath(version), { key, body });
    expect(requested.status).toBe(202);
    expect(requested.body).toMatchObject({
      status: 'queued',
      output: null,
      isolation_evidence: 'none',
    });
    expect(requested.headers.get('etag')).toBe('"1"');
    expect((await call(owner, 'POST', requestPath(version), { key, body })).body).toEqual(
      requested.body,
    );
    expect(
      (await call(owner, 'POST', requestPath(version), { key, body: { ...body, input: {} } })).body
        .code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    const run = `sandbox-runs/${requested.body.id}`;
    const read = await call(owner, 'GET', run);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain('generated-private-trial');
    expect((await call(member, 'GET', run)).status).toBe(403);
    expect((await call(owner, 'POST', `${run}/cancellation`)).status).toBe(202);
    expect((await call(owner, 'POST', `${run}/cancellation`)).status).toBe(202);
    expect((await call(owner, 'GET', run)).body).toMatchObject({
      status: 'cancelled',
      outcome_code: 'CANCELLED_BY_REQUEST',
      output: null,
    });
  });
});
