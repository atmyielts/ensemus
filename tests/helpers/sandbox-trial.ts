import { createHash, randomUUID } from 'node:crypto';
import { createSandboxWorkerControl } from '@ensemus/application/sandbox-worker-control';
import { openAppDatabase, skillVersions, withTenantTx } from '@ensemus/database';
import { SANDBOX_DEFAULT_CEILINGS } from '@ensemus/domain/sandbox';
import { skillBundleObjectKey } from '@ensemus/domain/skill';
import { passingProbeReport } from '@ensemus/sandbox/testing';
import { buildTestBundle } from '@ensemus/skills/testing';
import { createSkillVerificationActivities } from '@ensemus/workflows/skill-verification-activities';
import type { Person } from './forms';
import { nativeStackContext } from './native-mfa';
import { seedPackage, seedSigner } from './skills';
import { urls } from './stack';
import { LifecycleMemoryStore } from '../integration/saas-lifecycle-fixture';

const ceilings = SANDBOX_DEFAULT_CEILINGS;

export async function signedTrialVersion(owner: Person, organizationId: string) {
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
    const outcome = await control.finish(organizationId, {
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
    });
    if (outcome !== 'succeeded') throw new Error('STACK_SANDBOX_FIXTURE_DID_NOT_SUCCEED');
    if ((await verifier.finishSkillVerification(input)) !== 'verified')
      throw new Error('STACK_SANDBOX_VERSION_NOT_VERIFIED');
    return skillVersionId;
  } finally {
    await Promise.all([app.close(), worker.close()]);
  }
}
