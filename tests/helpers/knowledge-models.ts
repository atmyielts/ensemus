// Generated conformance fixtures through the actual app/agent roles and durable model-job path.
// Native sessions are verified by auth and second-factor proof is written only by its role. Provider
// output is synthetic; this fixture is not live-provider or production identity acceptance evidence.
import { randomUUID } from 'node:crypto';
import { createModelProfile, addRateCard } from '@ensemus/application/ai-model-profiles';
import { setBudget } from '@ensemus/application/ai-budget';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { bindKnowledgeModelReceipts } from '@ensemus/application/ai-knowledge-result-consumer';
import { runKnowledgeModelJob } from '@ensemus/application/ai-knowledge-model-jobs';
import { requestModelQualification } from '@ensemus/application/knowledge/model-jobs';
import { createEntitlements } from '@ensemus/commercial';
import { createKnowledgeModelGateway, createEmbeddingAdapter } from '@ensemus/intelligence';
import { ScriptedModelAdapter } from '@ensemus/intelligence/testing';
import { openAgentDatabase } from '@ensemus/database/agent';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { KnowledgeModelPurpose } from '@ensemus/domain/knowledge-models';
import type { ModelRoute } from '@ensemus/knowledge/ports';
import { deterministicVector } from '@ensemus/knowledge/testing';
import { urls } from './stack';
import pg from 'pg';
import { nativePersonContext, proveSecondFactor } from './product';

/** Generated native login + auth-role second-factor proof for the existing fixture's actual owner. */
export async function nativeModelContext(database: AppDatabase, owner: TenantContext) {
  const auth = new pg.Client({ connectionString: urls.auth() }),
    sessionId = randomUUID();
  await auth.connect();
  try {
    await auth.query(
      "insert into identity.sessions(id,user_id,token,expires_at) values($1,$2,$3,now()+interval '1 hour')",
      [sessionId, owner.userId, randomUUID()],
    );
  } finally {
    await auth.end();
  }
  const person = { userId: owner.userId, sessionId };
  await proveSecondFactor(person);
  return nativePersonContext(database, person, owner.organizationId);
}

export const GENERATED_MODEL_ENDPOINT = 'http://generated-model.internal:8080/v1';
export const GENERATED_MODEL_BOUNDS = {
  maxCalls: 1,
  maxInputTokens: 64000,
  maxOutputTokens: 64,
  maxTotalTokens: 64064,
  maxCostMicros: 10000,
  timeoutSeconds: 240,
};
export async function seedQualifiedKnowledgeRoute(
  database: AppDatabase,
  owner: TenantContext,
  input: {
    purpose?: KnowledgeModelPurpose;
    dimension?: number;
    vectorSpaceVersion?: string;
    modelId?: string;
  } = {},
): Promise<ModelRoute> {
  const purpose = input.purpose ?? 'embed',
    dimension = purpose === 'embed' ? (input.dimension ?? 4) : null;
  owner = await nativeModelContext(database, owner);
  const profile = await createModelProfile(
    database,
    owner,
    {
      provider_kind: 'local_openai_compatible',
      model_id: input.modelId ?? `generated-${randomUUID()}`,
      alias: `Generated ${randomUUID()}`,
      endpoint_url: GENERATED_MODEL_ENDPOINT,
      billing_owner: 'customer',
      region: null,
      capabilities: ['text', 'structured_output'],
      limits: { max_input_tokens: 64000, max_output_tokens: 256 },
      allowed_classes: ['public', 'internal', 'confidential', 'restricted'],
      allowed_purposes: [purpose],
      retention_basis: 'self_hosted',
      contract_ref: null,
      fallback_profile_ids: [],
    },
    { privateEndpoints: [GENERATED_MODEL_ENDPOINT] },
  );
  await addRateCard(database, owner, {
    profileId: profile.id,
    inputMicrosPerMtok: 11,
    outputMicrosPerMtok: 17,
  });
  await setBudget(database, owner, {
    scope: 'organization',
    agent_version_id: null,
    period: new Date().toISOString().slice(0, 7),
    limit_micros: 1000000,
  });
  const request = await requestModelQualification(database, owner, {
    profileId: profile.id,
    expectedProfileVersion: profile.version,
    purpose,
    dimension,
    vectorSpaceVersion: purpose === 'embed' ? (input.vectorSpaceVersion ?? 'generated-v1') : null,
    requestKey: randomUUID(),
    bounds: GENERATED_MODEL_BOUNDS,
  });
  const agent = openAgentDatabase(urls.agent(), { max: 2 });
  try {
    const calls = createKnowledgeCallStore(agent.db);
    const gateway = createKnowledgeModelGateway({
      store: calls,
      entitlements: createEntitlements(agent.db),
      credentials: {
        withKey: async () => {
          throw new Error('TEST_UNEXPECTED_KEY');
        },
      },
      guard: {
        fetchFor: () => async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { input: string[] };
          return new Response(
            JSON.stringify({
              data: body.input.map((text, index) => ({
                index,
                embedding: deterministicVector(text, dimension!),
              })),
              usage: { prompt_tokens: 13 },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        },
      },
      embeddings: createEmbeddingAdapter(),
      adapter: new ScriptedModelAdapter([
        {
          kind: 'final',
          text: purpose === 'rerank' ? '{"order":[1,0]}' : 'ready',
          usage: { inputTokens: 7, outputTokens: 5 },
        },
      ]),
      privateEndpoints: [GENERATED_MODEL_ENDPOINT],
      canaries: async () => [],
      bundle: async () => null,
    });
    const forPrincipal = (principal: Parameters<typeof gateway>[0]) =>
      bindKnowledgeModelReceipts(principal, gateway(principal));
    const outcome = await runKnowledgeModelJob(
      { database: agent.db, calls, forPrincipal },
      {
        organizationId: owner.organizationId,
        jobId: request.jobId,
        signal: AbortSignal.timeout(10000),
      },
    );
    if (outcome.state !== 'completed')
      throw new Error(`TEST_QUALIFICATION_REFUSED:${outcome.code}`);
    // The qualification job is terminal, so use the exact qualified immutable profile metadata as a
    // test route. Ordinary test doubles still exercise live space qualification/identity SQL guards.
    return {
      modelProfileRef: profile.id,
      modelProfileVersion: profile.version,
      qualificationId: request.qualificationId,
      modelId: profile.model_id,
      providerKind: 'local_openai_compatible',
      destinationHost: new URL(GENERATED_MODEL_ENDPOINT).hostname,
      policyVersion: 'generated-policy',
      purpose,
      classification: 'internal',
      ...(dimension
        ? {
            embedding: {
              dimension,
              vectorSpaceVersion: input.vectorSpaceVersion ?? 'generated-v1',
            },
          }
        : {}),
    };
  } finally {
    await agent.close();
  }
}
