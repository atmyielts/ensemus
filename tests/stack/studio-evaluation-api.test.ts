// Built-web publication with generated evaluator signatures. No model/provider quality claim.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentDraft } from '@ensemus/application/agent-drafts';
import { createRuntimeProductPorts } from '@ensemus/application/product-runtime';
import { requestSimulation, runSimulationStep } from '@ensemus/application/simulations';
import { requestPublishReview, decidePublishReview } from '@ensemus/application/publish-reviews';
import { getAgentPolicyVersion } from '@ensemus/application/ai-agents';
import { openAppDatabase, withTenantTx, agentVersions } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { STUDIO_SUITE_REF } from '@ensemus/domain/agent-draft';
import {
  reportV2,
  signedReport,
} from '../../packages/application/src/ai/evaluation-attestation.test-support';
import { BASE, createOrganization, signUp, read, type Person } from '../helpers/forms';
import { nativePersonContext, proveSecondFactor, testAnswers } from '../helpers/product';
import { stackEvaluationSigner } from '../helpers/ai/evaluation';
import { contractProblems } from '../helpers/openapi';
import { urls } from '../helpers/stack';

describe('independent Studio evaluation through the actual HTTP route', () => {
  let database: ReturnType<typeof openAppDatabase>, owner: Person, outsider: Person;
  let organization: string, reviewId: string, signed: ReturnType<typeof signedReport>;
  let context: Awaited<ReturnType<typeof nativePersonContext>>;
  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    owner = await signUp('Generated evaluated Studio owner');
    outsider = await signUp('Generated evaluated Studio outsider');
    organization = await createOrganization(owner, 'Generated evaluated Studio company');
    const session = (await (
      await fetch(`${BASE}/api/auth/get-session`, { headers: { cookie: owner.jar.cookie } })
    ).json()) as { user: { id: string }; session: { id: string } };
    const person = { userId: session.user.id, sessionId: session.session.id };
    await proveSecondFactor(person);
    context = await nativePersonContext(database.db, person, organization);
    const ports = createRuntimeProductPorts(database.db);
    const draft = await createAgentDraft(database.db, context, ports, {
      name: 'Generated independently evaluated draft',
      answers: testAnswers(context.membershipId),
    });
    const simulation = await requestSimulation(database.db, context, {
      subject: { kind: 'agent_draft', draftId: draft.id },
      scenarioKey: 'standard.draft_only',
    });
    await runSimulationStep(database.db, createServiceContext(organization), {
      simulationId: simulation.id,
    });
    const review = await requestPublishReview(database.db, context, {
      subjectKind: 'agent_draft',
      subjectId: draft.id,
      simulationRunId: simulation.id,
    });
    await decidePublishReview(
      database.db,
      context,
      { sessionId: person.sessionId },
      { reviewId: review.id, expectedVersion: 1, decision: 'approved' },
    );
    reviewId = review.id;
    signed = signedReport(
      reportV2(draft.specSha256!, await getAgentPolicyVersion(database.db, context), {
        suite_ref: STUDIO_SUITE_REF,
      }),
      stackEvaluationSigner(),
    );
  });
  afterAll(async () => {
    await database?.close();
  });
  async function publish(person: Person, body?: unknown, key = randomUUID()) {
    const path = `/api/v1/organizations/${organization}/studio/publish-reviews/${reviewId}/publication`;
    const response = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        cookie: person.jar.cookie,
        origin: BASE,
        'if-match': '"2"',
        'idempotency-key': key,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    expect(
      contractProblems({
        method: 'POST',
        path,
        status: response.status,
        headers: response.headers,
        text,
      }).problems,
    ).toEqual([]);
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  }
  it('renders the independent evidence field and refuses missing, malformed and changed reports', async () => {
    const page = await read(`/o/${organization}/studio/reviews/${reviewId}`, owner.jar);
    expect(page.status).toBe(200);
    expect(page.html).toContain('Signed evaluation report');
    expect((await publish(outsider, { evaluation_report: signed })).status).toBe(404);
    expect((await publish(owner)).body.code).toBe('AGENT_EVALUATION_REQUIRED');
    expect(
      (await publish(owner, { evaluation_report: { report_version: 1, passed: true } })).status,
    ).toBe(400);
    expect(
      (
        await publish(owner, {
          evaluation_report: {
            ...signed,
            report: { ...signed.report, spec_sha256: '0'.repeat(64) },
          },
        })
      ).body.code,
    ).toBe('AGENT_EVALUATION_UNVERIFIED');
    expect(
      await withTenantTx(database.db, context, (tx) => tx.select().from(agentVersions)),
    ).toEqual([]);
  });
  it('publishes the exact signed revision once and replays the same receipt', async () => {
    const key = randomUUID(),
      body = { evaluation_report: signed };
    const first = await publish(owner, body, key);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('published');
    expect(await publish(owner, body, key)).toEqual(first);
    const versions = await withTenantTx(database.db, context, (tx) =>
      tx.select().from(agentVersions),
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]?.specSha256).toBe(signed.report.spec_sha256);
    expect(first.body.published_ref).toBe(versions[0]?.id);
  });
});
