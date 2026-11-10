// Generated conformance fixtures through the actual app/agent roles and durable model-job path.
// Native sessions are verified by auth and second-factor proof is written only by its role. Provider
// output is synthetic; this fixture is not live-provider or production identity acceptance evidence.
// In a running stack the stack's own agent worker runs the qualification job against the test-only fake
// model (tests/fixtures/fake-model), and this helper only waits for it.
import { randomUUID } from 'node:crypto';
import { createModelProfile, addRateCard } from '@ensemus/application/ai-model-profiles';
import { setBudget } from '@ensemus/application/ai-budget';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { bindKnowledgeModelReceipts } from '@ensemus/application/ai-knowledge-result-consumer';
import { runKnowledgeModelJob } from '@ensemus/application/ai-knowledge-model-jobs';
import { requestModelQualification } from '@ensemus/application/knowledge/model-jobs';
import { AppError, busyFromDatabase, TENANT_BUSY_RETRY_AFTER_SECONDS } from '@ensemus/application';
import { startSubscription } from '@ensemus/application/saas/subscriptions';
import { createEntitlements, FEATURE_AGENT_RUN, FEATURE_MODEL_CALL } from '@ensemus/commercial';
import { createKnowledgeModelGateway, createEmbeddingAdapter } from '@ensemus/intelligence';
import { ScriptedModelAdapter } from '@ensemus/intelligence/testing';
import { openAgentDatabase } from '@ensemus/database/agent';
import {
  modelJobs,
  modelOperationQualifications,
  organizations,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { eq } from 'drizzle-orm';
import type { KnowledgeModelPurpose } from '@ensemus/domain/knowledge-models';
import type { ModelRoute } from '@ensemus/knowledge/ports';
import { deterministicVector } from '@ensemus/knowledge/testing';
import { urls } from './stack';
import pg from 'pg';
import { nativePersonContext, proveSecondFactor } from './product';
import { seedPlan } from './saas';

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

/** At most this many sends of one fixture write, TENANT_BUSY_RETRY_AFTER_SECONDS apart: 20 seconds. */
const BUSY_ATTEMPTS = 20;

/**
 * Whether a fixture write was refused as TENANT_BUSY and only that, exactly as the product decides it:
 * an AppError TENANT_BUSY, as the application throws it, or a database error that busyFromDatabase
 * (errors.ts) translates to TENANT_BUSY for the API and the forms, which is lock_not_available (55P03)
 * anywhere in its cause chain within PG_CAUSE_DEPTH links, however many wrappers sit above Drizzle's.
 * Every other refusal, VERSION_CONFLICT and SUBSCRIPTION_EXISTS among them, is not busy.
 */
const tenantBusy = (error: unknown) =>
  (error instanceof AppError && error.code === 'TENANT_BUSY') || busyFromDatabase(error) !== null;

/**
 * Sends one fixture write again, a bounded number of times, while it is refused as TENANT_BUSY and only
 * then. The erasure birth fence (lifecycle.refuse_erasing_birth, 0515 and 0533) takes the tenant's
 * organization row FOR SHARE NOWAIT on every insert it guards, so such a write is refused at once while
 * a background job in the same tenant holds that row FOR NO KEY UPDATE, as a source purge does
 * (0514-0516; CI run 42692158422: the qualification insert, right after a revocation). That refusal is
 * TENANT_BUSY (errors.ts; recognised here by tenantBusy, through the product's own busyFromDatabase),
 * which the API documents as retryable after Retry-After: the write's transaction rolled back, so the
 * same write is sent again after the same wait. Any other refusal,
 * VERSION_CONFLICT among them, and a write still busy after the last attempt, fails the fixture at once;
 * the fence itself is unchanged.
 */
async function whileBusy<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (!tenantBusy(error) || attempt >= BUSY_ATTEMPTS) throw error;
      await new Promise((done) => setTimeout(done, TENANT_BUSY_RETRY_AFTER_SECONDS * 1000));
    }
  }
}

/**
 * ADR-032: a hosted BYOM tenant is entitled to model calls only by a current subscription on a
 * deployment with billing enabled; the mode alone grants nothing. Start one the way an owner does
 * (`startSubscription`) on a generated BYOM plan, once. Sovereign and Cloud tenants are left as
 * they are.
 */
async function entitleHostedByom(database: AppDatabase, owner: TenantContext) {
  const [org] = await withTenantTx(database, owner, (tx) =>
    tx
      .select({ mode: organizations.commercialMode })
      .from(organizations)
      .where(eq(organizations.id, owner.organizationId)),
  );
  if (org?.mode !== 'byom') return;
  const plan = await seedPlan({ mode: 'byom', features: [FEATURE_MODEL_CALL, FEATURE_AGENT_RUN] });
  try {
    await whileBusy(() =>
      startSubscription(database, owner, { planVersionId: plan.planVersionId }),
    );
  } catch (error) {
    if (!(error instanceof AppError && error.code === 'SUBSCRIPTION_EXISTS')) throw error;
  }
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
/** Time the stack's own agent worker has to finish a qualification the outbox woke it for. */
const STACK_QUALIFICATION_WAIT_MS = 90_000;

/**
 * Waits for the stack's own agent worker to end a qualification job, as the outbox dispatcher wakes it
 * for every requested job, and requires that it completed and passed. Nothing here runs or settles the
 * job: in a running stack the worker is its one runner (knowledgeModelJobWorkflow, a single attempt).
 */
async function awaitStackQualification(
  database: AppDatabase,
  owner: TenantContext,
  request: { jobId: string; qualificationId: string },
) {
  const deadline = Date.now() + STACK_QUALIFICATION_WAIT_MS;
  for (;;) {
    const [job] = await withTenantTx(database, owner, (tx) =>
      tx
        .select({ state: modelJobs.state, code: modelJobs.refusalCode })
        .from(modelJobs)
        .where(eq(modelJobs.id, request.jobId)),
    );
    if (!job) throw new Error('TEST_QUALIFICATION_JOB_MISSING');
    if (job.state === 'refused' || job.state === 'fenced')
      throw new Error(`TEST_QUALIFICATION_REFUSED:${job.code ?? job.state}`);
    if (job.state === 'completed') break;
    if (Date.now() > deadline) throw new Error(`TEST_QUALIFICATION_TIMEOUT:${job.state}`);
    await new Promise((done) => setTimeout(done, 250));
  }
  const [qualification] = await withTenantTx(database, owner, (tx) =>
    tx
      .select({ state: modelOperationQualifications.state })
      .from(modelOperationQualifications)
      .where(eq(modelOperationQualifications.id, request.qualificationId)),
  );
  if (qualification?.state !== 'passed')
    throw new Error(`TEST_QUALIFICATION_NOT_PASSED:${qualification?.state ?? 'missing'}`);
}

export async function seedQualifiedKnowledgeRoute(
  database: AppDatabase,
  owner: TenantContext,
  input: {
    purpose?: KnowledgeModelPurpose;
    dimension?: number;
    vectorSpaceVersion?: string;
    modelId?: string;
    /** A private endpoint the stack's own workers may reach, such as the in-subnet fake model. */
    endpointUrl?: string;
    /**
     * Who runs the qualification job. 'here' (the default) runs the durable job in this process with a
     * synthetic provider, for a suite with no live model worker. 'stack' leaves it to the running stack's
     * own agent worker, which the outbox dispatcher wakes for the job exactly as in production, against
     * `endpointUrl`. A second runner here would race that worker for the same job, and either runner's
     * refusal fences the job for both, so a stack suite never runs it here.
     */
    runner?: 'here' | 'stack';
  } = {},
): Promise<ModelRoute> {
  if (input.runner === 'stack' && !input.endpointUrl)
    throw new Error('TEST_STACK_QUALIFICATION_NEEDS_REACHABLE_ENDPOINT');
  const endpoint = input.endpointUrl ?? GENERATED_MODEL_ENDPOINT;
  const purpose = input.purpose ?? 'embed',
    dimension = purpose === 'embed' ? (input.dimension ?? 4) : null;
  owner = await nativeModelContext(database, owner);
  const context = owner;
  // Every write below is built once, so a write refused as busy is sent again unchanged (whileBusy).
  const definition: Parameters<typeof createModelProfile>[2] = {
    provider_kind: 'local_openai_compatible',
    model_id: input.modelId ?? `generated-${randomUUID()}`,
    alias: `Generated ${randomUUID()}`,
    endpoint_url: endpoint,
    billing_owner: 'customer',
    region: null,
    capabilities: ['text', 'structured_output'],
    limits: { max_input_tokens: 64000, max_output_tokens: 256 },
    allowed_classes: ['public', 'internal', 'confidential', 'restricted'],
    allowed_purposes: [purpose],
    retention_basis: 'self_hosted',
    contract_ref: null,
    fallback_profile_ids: [],
  };
  const profile = await whileBusy(() =>
    createModelProfile(database, context, definition, { privateEndpoints: [endpoint] }),
  );
  await whileBusy(() =>
    addRateCard(database, context, {
      profileId: profile.id,
      inputMicrosPerMtok: 11,
      outputMicrosPerMtok: 17,
    }),
  );
  await entitleHostedByom(database, context);
  const budget: Parameters<typeof setBudget>[2] = {
    scope: 'organization',
    agent_version_id: null,
    period: new Date().toISOString().slice(0, 7),
    limit_micros: 1000000,
  };
  await whileBusy(() => setBudget(database, context, budget));
  // One request key for every attempt: a qualification request is idempotent on it.
  const qualification = {
    profileId: profile.id,
    expectedProfileVersion: profile.version,
    purpose,
    dimension,
    vectorSpaceVersion: purpose === 'embed' ? (input.vectorSpaceVersion ?? 'generated-v1') : null,
    requestKey: randomUUID(),
    bounds: GENERATED_MODEL_BOUNDS,
  };
  const request = await whileBusy(() =>
    requestModelQualification(database, context, qualification),
  );
  const route: ModelRoute = {
    modelProfileRef: profile.id,
    modelProfileVersion: profile.version,
    qualificationId: request.qualificationId,
    modelId: profile.model_id,
    providerKind: 'local_openai_compatible',
    destinationHost: new URL(endpoint).hostname,
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
  if (input.runner === 'stack') {
    await awaitStackQualification(database, owner, request);
    return route;
  }
  const agent = openAgentDatabase(urls.agent(), { max: 2 });
  try {
    const calls = createKnowledgeCallStore(agent.db);
    const gateway = createKnowledgeModelGateway({
      store: calls,
      // A hosted deployment, as the worker binds it from its SaaS config. Sovereign still answers by
      // its licence, and Cloud model calls stay closed (no prepaid hold is bound yet).
      entitlements: createEntitlements(agent.db, { billingEnabled: true }),
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
      privateEndpoints: [endpoint],
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
    return route;
  } finally {
    await agent.close();
  }
}
