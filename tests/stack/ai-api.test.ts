// M4 public contracts, through the real proxy. Positive coverage is required for every activated
// operation here; a skipped job is not acceptance. Generated keys/prices go only to the private fake.
import { randomUUID } from 'node:crypto';
import { getAgentPolicyVersion } from '@ensemus/application/ai-agents';
import { openAppDatabase, type TenantContext } from '@ensemus/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assuranceSpec, syntheticCases } from '../../evaluations/agents/fixtures';
import { evaluateScripted } from '../../evaluations/agents/harness';
import { openAgentTestDatabase, seedActiveProfile, seedRateCard } from '../helpers/ai/fixtures';
import { createOrganization, signUp, type Person } from '../helpers/forms';
import { enrollAuthenticator, nativeStackContext } from '../helpers/native-mfa';
import { contractProblems, operationName, operations } from '../helpers/openapi';
import { api, type ApiResult } from '../helpers/slice-2';
import { urls } from '../helpers/stack';

const ours = (path: string) =>
  /\/(agent-runs|agent-versions|model-profiles|budgets|usage|entitlements)(\/|$)/.test(path);
const enabled = process.env.ENSEMUS_AI_ENABLED === 'true';
const period = new Date().toISOString().slice(0, 7);

describe.skipIf(!enabled)('governed AI public API', () => {
  const validated = new Set<string>();
  const app = openAppDatabase(urls.app());
  const agent = openAgentTestDatabase();
  let owner: Person;
  let outsider: Person;
  let root: string;
  let foreignRoot: string;
  let context: TenantContext;
  let profileId: string;
  let versionId: string;
  let runId: string;
  let workId: string;

  async function call(
    person: Person | undefined,
    method: string,
    path: string,
    expected: number,
    body?: unknown,
    key?: string,
  ): Promise<ApiResult> {
    // api validates every response, including refusals, against OpenAPI before returning it.
    const result = await api(person, method, path, {
      ...(body === undefined ? {} : { body }),
      ...(key ? { key } : {}),
    });
    expect(result.status, result.text).toBe(expected);
    if (result.status < 400) {
      const checked = contractProblems({
        method,
        path,
        status: result.status,
        headers: result.headers,
        text: result.text,
      });
      expect(checked.problems).toEqual([]);
      if (checked.operation && ours(path.split('?')[0]!)) validated.add(checked.operation);
    }
    return result;
  }

  beforeAll(async () => {
    owner = await signUp('AI API owner');
    outsider = await signUp('Other company owner');
    const organizationId = await createOrganization(owner, `AI API ${randomUUID()}`);
    const foreignId = await createOrganization(outsider, `AI API ${randomUUID()}`);
    root = `/api/v1/organizations/${organizationId}`;
    foreignRoot = `/api/v1/organizations/${foreignId}`;
    // 0404: a probe, a qualification and an agent publication are always-MFA actions. The owner turns
    // on an authenticator as a person does, and the seeds below write in that same native session.
    await enrollAuthenticator(owner, organizationId);
    context = await nativeStackContext(app.db, owner, organizationId);
  }, 60000);

  afterAll(async () => {
    await Promise.all([app.close(), agent.close()]);
  });

  it('registers, edits, seals and genuinely probes a private profile, with measured metadata only', async () => {
    const draft = await call(owner, 'POST', `${root}/model-profiles`, 201, {
      provider_kind: 'local_openai_compatible',
      model_id: 'fake:text',
      alias: 'z-probe',
      endpoint_url: 'http://fake-model:8000/v1',
      billing_owner: 'customer',
      region: null,
      capabilities: ['text', 'tools', 'structured_output'],
      limits: { max_input_tokens: 16000, max_output_tokens: 1024 },
      allowed_classes: ['public', 'internal'],
      allowed_purposes: ['reason', 'compose'],
      retention_basis: 'self_hosted',
      contract_ref: null,
      fallback_profile_ids: [],
    });
    profileId = (draft.json as { id: string }).id;
    await call(owner, 'GET', `${root}/model-profiles`, 200);
    const path = `${root}/model-profiles/${profileId}`;
    await call(owner, 'GET', path, 200);
    const changed = await call(owner, 'PATCH', path, 200, {
      expected_version: (draft.json as { version: number }).version,
      alias: 'z-private-probe',
    });
    const generatedKey = `synthetic-${randomUUID()}`;
    const keyed = await call(owner, 'PUT', `${path}/credential`, 200, {
      expected_version: (changed.json as { version: number }).version,
      key: generatedKey,
    });
    expect(keyed.text).not.toContain(generatedKey);
    expect(keyed.text).not.toContain('secret_ref');
    await call(owner, 'POST', `${path}/rate-cards`, 201, {
      input_micros_per_mtok: 1_000_000,
      output_micros_per_mtok: 2_000_000,
    });
    await call(owner, 'POST', `${path}/activation`, 202, {
      expected_version: (keyed.json as { version: number }).version,
    });
    await expect
      .poll(async () => (await call(owner, 'GET', path, 200)).json as { status: string }, {
        timeout: 90000,
        interval: 500,
      })
      .toMatchObject({ status: 'active' });
  });

  it('publishes, starts and stops bounded work, and exposes code-only progress and usage', async () => {
    await call(owner, 'POST', `${root}/budgets`, 201, {
      scope: 'organization',
      agent_version_id: null,
      period,
      limit_micros: 10_000_000,
    });
    await call(owner, 'GET', `${root}/usage?period=${period}`, 200);
    await call(owner, 'GET', `${root}/entitlements`, 200);
    const evaluation = await evaluateScripted({
      spec: assuranceSpec,
      policyVersion: await getAgentPolicyVersion(app.db, context),
      cases: syntheticCases(),
    });
    expect(evaluation.report.passed).toBe(true);
    const version = await call(owner, 'POST', `${root}/agent-versions`, 201, {
      spec: assuranceSpec,
      evaluation_report: evaluation.report,
    });
    versionId = (version.json as { id: string }).id;
    await call(owner, 'GET', `${root}/agent-versions`, 200);
    await call(owner, 'GET', `${root}/agent-versions/${versionId}`, 200);
    // This seed makes the control request independent of how fast a text model answers. It is a
    // generated, keyless, approved private test profile, not provider qualification evidence.
    const hanging = await seedActiveProfile(app.db, agent.db, context, {
      alias: 'a-control',
      modelId: 'fake:hang',
      endpointUrl: 'http://fake-model:8000/v1',
    });
    await seedRateCard(app.db, context, hanging);
    const work = await call(
      owner,
      'POST',
      `${root}/work-units`,
      201,
      {
        title: 'Stop an assistant',
        objective: 'Synthetic control acceptance',
      },
      randomUUID(),
    );
    workId = (work.json as { id: string }).id;
    const key = randomUUID();
    const start = await call(
      owner,
      'POST',
      `${root}/agent-runs`,
      202,
      {
        work_unit_id: workId.toUpperCase(),
        agent_version_id: versionId.toUpperCase(),
      },
      key,
    );
    runId = (start.json as { id: string }).id;
    const repeated = await call(
      owner,
      'POST',
      `${root}/agent-runs`,
      202,
      {
        work_unit_id: workId,
        agent_version_id: versionId,
      },
      key,
    );
    expect(repeated.json).toEqual(start.json);
    await call(owner, 'GET', `${root}/agent-runs?work_unit_id=${workId}`, 200);
    await call(owner, 'GET', `${root}/agent-runs/${runId}`, 200);
    await call(owner, 'GET', `${root}/agent-runs/${runId}/steps`, 200);
    await call(owner, 'POST', `${root}/agent-runs/${runId}/controls`, 202, { kind: 'stop' });
    await expect
      .poll(async () => (await call(owner, 'GET', `${root}/agent-runs/${runId}`, 200)).json, {
        timeout: 90000,
        interval: 500,
      })
      .toMatchObject({ status: 'cancelled' });
  });

  it('refuses cross-tenant identifiers and exposes no model or run content', async () => {
    await call(undefined, 'GET', `${root}/model-profiles`, 401);
    await call(outsider, 'GET', `${root}/model-profiles/${profileId}`, 404);
    await call(outsider, 'GET', `${foreignRoot}/model-profiles/${profileId}`, 404);
    await call(outsider, 'GET', `${foreignRoot}/agent-versions/${versionId}`, 404);
    await call(outsider, 'GET', `${foreignRoot}/agent-runs/${runId}`, 404);
    await call(outsider, 'GET', `${foreignRoot}/agent-runs?work_unit_id=${workId}`, 404);
    await call(outsider, 'POST', `${foreignRoot}/agent-runs/${runId}/controls`, 404, {
      kind: 'stop',
    });
  });

  it('queues one bounded capability qualification and reads its content-free evidence', async () => {
    // A separate keyless private draft, so the probed profile and the stopped run are untouched.
    const draft = await call(owner, 'POST', `${root}/model-profiles`, 201, {
      provider_kind: 'local_openai_compatible',
      model_id: 'fake:text',
      alias: 'z-qualification',
      endpoint_url: 'http://fake-model:8000/v1',
      billing_owner: 'customer',
      region: null,
      capabilities: ['text', 'structured_output'],
      limits: { max_input_tokens: 8192, max_output_tokens: 64 },
      allowed_classes: ['public'],
      allowed_purposes: ['embed'],
      retention_basis: 'self_hosted',
      contract_ref: null,
      fallback_profile_ids: [],
    });
    const { id, version } = draft.json as { id: string; version: number };
    const path = `${root}/model-profiles/${id}/qualifications`;
    const request = {
      expected_profile_version: version,
      purpose: 'embed',
      dimension: 3,
      vector_space_version: 'generated-stack-v1',
      request_key: randomUUID(),
      bounds: {
        max_calls: 1,
        max_input_tokens: 8192,
        max_output_tokens: 64,
        max_total_tokens: 50000,
        max_cost_micros: 10000,
        timeout_seconds: 240,
      },
    };
    const queued = await call(owner, 'POST', path, 202, request);
    const repeated = await call(owner, 'POST', path, 202, request);
    expect(repeated.json).toEqual(queued.json);
    const evidence = await call(owner, 'GET', path, 200);
    const { qualification_id } = queued.json as { qualification_id: string };
    expect((evidence.json as { items: { id: string }[] }).items.map((item) => item.id)).toContain(
      qualification_id,
    );
    // The outsider names this tenant's profile from their own tenant and learns nothing.
    await call(outsider, 'GET', `${foreignRoot}/model-profiles/${id}/qualifications`, 404);
  });

  it('validates a successful response from every activated M4 operation', () => {
    const expected = operations()
      .filter((op) => op.status === undefined && ours(op.path))
      .map(({ method, path }) => operationName(method, path))
      .sort();
    // 18 M4 operations plus 0216's two model-profile qualification operations (GET and POST
    // /model-profiles/{id}/qualifications), which the test above exercises.
    expect(expected).toHaveLength(20);
    expect([...validated].sort()).toEqual(expected);
  });
});
