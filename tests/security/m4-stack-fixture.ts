// Real M4 stack setup. Auth, publication, work creation and run start use HTTP; the active keyless
// private profile, budget and Cloud entitlement are explicit seeds, not activation or commercial onboarding.
import { randomUUID } from 'node:crypto';
import { addArtifact } from '@ensemus/application';
import { getAgentPolicyVersion } from '@ensemus/application/ai-agents';
import { FEATURE_AGENT_RUN, FEATURE_MODEL_CALL, type CommercialMode } from '@ensemus/commercial';
import { openAppDatabase, type AppDatabase, type TenantContext } from '@ensemus/database';
import { S3ObjectStore } from '@ensemus/storage';
import pg from 'pg';
import { expect } from 'vitest';
import { assuranceSpec } from '../../evaluations/agents/fixtures';
import { evaluateScripted } from '../../evaluations/agents/harness';
import { syntheticCases } from '../../evaluations/agents/fixtures';
import { fakeModelRequests, scriptFakeModel } from '../conformance/fake-model';
import { createOrganization, signUp } from '../helpers/forms';
import { enrollAuthenticator, nativeStackContext } from '../helpers/native-mfa';
import { api } from '../helpers/slice-2';
import {
  openAgentTestDatabase,
  seedActiveProfile,
  seedOrganizationBudget,
  seedRateCard,
} from '../helpers/ai/fixtures';
import { compose, secret, urls } from '../helpers/stack';

export const MODEL_CONTROL = `http://127.0.0.1:${process.env.ENSEMUS_TEST_MODEL_CONTROL_PORT ?? '58026'}`;
export const MODEL_ORIGIN = 'http://fake-model:8000/v1';

export async function startAiCanaryRun(
  canaries: {
    artifact: string;
    prompt: string;
    toolArgument: string;
    providerError: string;
  },
  mode: CommercialMode = 'byom',
  options: {
    /**
     * Runs after the tenant, its profile, rate card and budget exist and before the run starts, in the owner's
     * native session, for what a hosted deployment also needs first (a subscription, for one).
     */
    beforeStart?: (seeded: {
      organizationId: string;
      context: TenantContext;
      app: AppDatabase;
    }) => Promise<void>;
  } = {},
) {
  // A job opting into AI must fail if its service wiring is absent.
  expect(compose('ps', '-q', 'agent-worker').trim()).not.toBe('');
  const health = await fetch(`${MODEL_CONTROL}/__fake/stats`);
  expect(health.status).toBe(200);
  const su = new pg.Client({ connectionString: urls.superuser() });
  const app = openAppDatabase(urls.app());
  const agent = openAgentTestDatabase();
  const objects = new S3ObjectStore({
    endpoint: `http://127.0.0.1:${process.env.ENSEMUS_TEST_OBJECTS_PORT ?? '58333'}`,
    bucket: 'ensemus',
    accessKey: secret('objects_access_key'),
    secretKey: secret('objects_secret_key'),
  });
  await su.connect();
  const close = async () => {
    objects.close();
    await Promise.all([su.end(), app.close(), agent.close()]);
  };
  try {
    const owner = await signUp('M4 Canary Owner');
    const organizationId = await createOrganization(owner, `M4 Canary ${randomUUID()}`);
    await su.query('update org.organizations set commercial_mode = $1 where id = $2', [
      mode,
      organizationId,
    ]);
    // 0404: the probe request in the profile seed and the agent publication below are always-MFA
    // actions. The owner turns on an authenticator through the real security page, and the seeds write
    // in that same native session rather than through a context without one.
    await enrollAuthenticator(owner, organizationId);
    const context = await nativeStackContext(app.db, owner, organizationId);
    const model = `fake:canary-${randomUUID()}`;
    const profileId = await seedActiveProfile(app.db, agent.db, context, {
      modelId: model,
      endpointUrl: MODEL_ORIGIN,
      billingOwner: mode === 'cloud' ? 'ensemus' : 'customer',
      allowedClasses: ['public', 'internal', 'confidential', 'restricted'],
      limits: { maxInputTokens: 16000, maxOutputTokens: 1024 },
    });
    await seedRateCard(app.db, context, profileId);
    await seedOrganizationBudget(app.db, context, 10_000_000);
    if (mode === 'cloud') {
      // This explicit test grant stands in for the later entitlement issuer. Cloud receives no
      // default allowance. Private inference permits either billing owner under the actual policy;
      // this exercises Ensemus-owned billing with the same approved keyless endpoint, without a
      // hosted credential, cross-billing consent, new egress permission or a production plan.
      await su.query(
        `insert into platform.entitlements
           (organization_id, mode, version, period, features, capacities)
         values ($1, 'cloud', 1, $2, $3, '{}'::jsonb)`,
        [
          organizationId,
          new Date().toISOString().slice(0, 7),
          [FEATURE_AGENT_RUN, FEATURE_MODEL_CALL],
        ],
      );
    }
    await options.beforeStart?.({ organizationId, context, app: app.db });

    const spec = {
      ...assuranceSpec,
      instructions: `${assuranceSpec.instructions}\n${canaries.prompt}`,
    };
    const report = await evaluateScripted({
      spec,
      policyVersion: await getAgentPolicyVersion(app.db, context),
      cases: syntheticCases(),
    });
    expect(report.report.passed).toBe(true);
    const root = `/api/v1/organizations/${organizationId}`;
    const published = await api(owner, 'POST', `${root}/agent-versions`, {
      body: { spec, evaluation_report: report.report },
    });
    expect(published.status).toBe(201);
    const versionId = (published.json as { id: string }).id;
    const work = await api(owner, 'POST', `${root}/work-units`, {
      key: randomUUID(),
      body: {
        title: 'M4 canary source handling',
        objective: 'Create a synthetic draft.',
      },
    });
    expect(work.status).toBe(201);
    const workUnitId = (work.json as { id: string }).id;
    const artifact = await addArtifact(app.db, objects, context, {
      workUnitId,
      name: 'source.txt',
      mimeType: 'text/plain',
      body: Buffer.from(`Synthetic evidence. ${canaries.artifact}`),
    });
    await scriptFakeModel(MODEL_CONTROL, model, [
      {
        tool: {
          name: 'artifact_draft_create',
          args: {
            name: 'Synthetic draft',
            text: canaries.toolArgument,
            evidence: [{ source_type: 'artifact', source_id: artifact.id }],
          },
        },
      },
      {
        error: {
          status: 500,
          message: `Provider echoed a synthetic diagnostic: ${canaries.providerError}`,
        },
      },
    ]);
    const start = await api(owner, 'POST', `${root}/agent-runs`, {
      key: randomUUID(),
      body: { work_unit_id: workUnitId, agent_version_id: versionId },
    });
    expect(start.status).toBe(202);
    const runId = (start.json as { id: string }).id;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    return {
      owner,
      organizationId,
      workUnitId,
      runId,
      versionId,
      profileId,
      model,
      su,
      close,
      start,
      requests: () => fakeModelRequests(MODEL_CONTROL, model),
      draftBytes: (artifactId: string) => objects.get(`${organizationId}/artifacts/${artifactId}`),
      runPath: `${root}/agent-runs/${runId}`,
      stepsPath: `${root}/agent-runs/${runId}/steps`,
      timelinePath: `/o/${organizationId}/work/${workUnitId}/run?run=${runId}`,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
