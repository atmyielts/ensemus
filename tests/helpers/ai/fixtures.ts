// Two-tenant seeds for governed AI, shared by every M4 slice (ADR-028). They go through the real roles,
// constraints and triggers, so a seed can never reach a state the rules forbid. Generated test values
// only: no real provider, key or address. A slice that needs more adds its own helper in its own file.
import { createHash, randomUUID } from 'node:crypto';
import {
  agentDefinitions,
  agentRuns,
  agentVersions,
  budgets,
  createOrganization,
  modelProfiles,
  rateCards,
  resolveTenantContext,
  serviceIdentities,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { openAgentDatabase, withRunLookupTx } from '@ensemus/database/agent';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { urls } from '../stack';

export const openAgentTestDatabase = (max = 2) => openAgentDatabase(urls.agent(), { max });

/** A person with an account, through the auth role, as sign-up would do it. */
export async function makeTestUser(label: string): Promise<string> {
  const auth = new pg.Client({ connectionString: urls.auth() });
  await auth.connect();
  try {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      `${label}-${id}@example.invalid`,
    ]);
    return id;
  } finally {
    await auth.end();
  }
}

export type AiTenant = {
  organizationId: string;
  owner: TenantContext;
  /** A plain member, who has none of the AI capabilities. */
  member: TenantContext;
};

/** One tenant with an owner and a member. Call it twice, with the same `name`, for the two-tenant cases. */
export async function seedAiTenant(
  database: AppDatabase,
  input: { name?: string; commercialMode?: 'cloud' | 'byom' | 'sovereign' } = {},
): Promise<AiTenant> {
  const ownerId = await makeTestUser('ai-owner');
  const memberId = await makeTestUser('ai-member');
  const { organizationId } = await createOrganization(database, {
    userId: ownerId,
    name: input.name ?? 'Same Name Ltd',
    commercialMode: input.commercialMode ?? 'byom',
  });
  const owner = await resolveTenantContext(database, ownerId, organizationId);
  const superuser = new pg.Client({ connectionString: urls.superuser() });
  await superuser.connect();
  try {
    await superuser.query(
      `insert into org.memberships (organization_id, user_id, role, status)
       values ($1, $2, 'member', 'active')`,
      [organizationId, memberId],
    );
  } finally {
    await superuser.end();
  }
  const member = await resolveTenantContext(database, memberId, organizationId);
  return { organizationId, owner, member };
}

/** Spec text that passes the contract. `overrides` go over the top, for the refusal tests. */
export function testAgentSpec(overrides: Record<string, unknown> = {}) {
  return {
    api_version: 'ensemus.ai/v1',
    id: 'work-brief',
    version: 1,
    objective: 'Read the work and draft a short brief for its owner.',
    instructions: 'Use only what the work and its files say. Cite each claim.',
    model: {
      required_capabilities: ['text', 'tools'],
      quality_tier: 'balanced',
      fallback: 'disabled',
    },
    context: { allowed_scopes: ['work.read'], memory_write_policy: 'none' },
    tools: { allow: ['work.read', 'artifact.read_text', 'artifact.draft.create'], deny: [] },
    execution: {
      max_model_turns: 5,
      max_tool_calls: 5,
      max_total_tokens: 10_000,
      max_cost_usd: '1',
      timeout_seconds: 60,
      max_delegation_depth: 0,
    },
    output: { schema_ref: 'schemas/work-brief.schema.json', verification: ['schema_check'] },
    evaluation: { suite_ref: 'evaluations/agents/work-brief', min_pass_rate: 0.9 },
    ...overrides,
  };
}

export const sha256Of = (value: string) => createHash('sha256').update(value).digest('hex');

export type SeededAgentVersion = {
  definitionId: string;
  serviceIdentityId: string;
  versionId: string;
};

/** Writes a published version directly, for what comes after publishing. */
export async function seedAgentVersion(
  database: AppDatabase,
  context: TenantContext,
  spec: Record<string, unknown> = testAgentSpec(),
): Promise<SeededAgentVersion> {
  const definitionId = randomUUID();
  const serviceIdentityId = randomUUID();
  const versionId = randomUUID();
  const organizationId = context.organizationId;
  const body = JSON.stringify(spec);
  await withTenantTx(database, context, async (tx) => {
    await tx.insert(serviceIdentities).values({
      organizationId,
      id: serviceIdentityId,
      ownerMembershipId: context.membershipId,
      purpose: 'test agent',
    });
    await tx.insert(agentDefinitions).values({
      organizationId,
      id: definitionId,
      slug: `work-brief-${definitionId.slice(0, 8)}`,
      name: 'Work brief',
      ownerMembershipId: context.membershipId,
      serviceIdentityId,
    });
    await tx.insert(agentVersions).values({
      organizationId,
      id: versionId,
      definitionId,
      versionNumber: 1,
      spec,
      specSha256: sha256Of(body),
      evaluationReportSha256: sha256Of('report'),
      policyVersion: 'test',
      maxCostMicros: 1_000_000,
      publishedByMembershipId: context.membershipId,
    });
  });
  return { definitionId, serviceIdentityId, versionId };
}

export type SeedRunInput = {
  workUnitId: string;
  version: SeededAgentVersion;
  classification?: 'public' | 'internal' | 'confidential' | 'restricted';
  limits?: Partial<{
    maxModelTurns: number;
    maxToolCalls: number;
    maxTotalTokens: number;
    maxCostMicros: number;
    timeoutSeconds: number;
    maxDelegationDepth: number;
  }>;
  tools?: readonly string[];
};

/** A queued run, as web writes it. It is the context's own membership that initiates it. */
export async function seedQueuedRun(
  database: AppDatabase,
  context: TenantContext,
  input: SeedRunInput,
): Promise<string> {
  const id = randomUUID();
  await withTenantTx(database, context, (tx) =>
    tx.insert(agentRuns).values({
      organizationId: context.organizationId,
      id,
      workUnitId: input.workUnitId,
      agentVersionId: input.version.versionId,
      initiatorMembershipId: context.membershipId,
      serviceIdentityId: input.version.serviceIdentityId,
      effectiveClassification: input.classification ?? 'internal',
      maxModelTurns: input.limits?.maxModelTurns ?? 5,
      maxToolCalls: input.limits?.maxToolCalls ?? 5,
      maxTotalTokens: input.limits?.maxTotalTokens ?? 10_000,
      maxCostMicros: input.limits?.maxCostMicros ?? 1_000_000,
      timeoutSeconds: input.limits?.timeoutSeconds ?? 60,
      maxDelegationDepth: input.limits?.maxDelegationDepth ?? 0,
      delegatedScopes: { tools: input.tools ?? ['work.read'] },
    }),
  );
  return id;
}

/** A draft pointing at a loopback fake. Keyless, so it needs no sealed secret. */
export async function seedDraftProfile(
  database: AppDatabase,
  context: TenantContext,
  overrides: Partial<typeof modelProfiles.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  await withTenantTx(database, context, (tx) =>
    tx.insert(modelProfiles).values({
      organizationId: context.organizationId,
      id,
      providerKind: 'local_openai_compatible',
      modelId: 'scripted-test-model',
      alias: `test-${id.slice(0, 8)}`,
      endpointUrl: 'http://127.0.0.1:59999/v1',
      capabilities: ['text', 'tools', 'structured_output'],
      limits: { maxInputTokens: 4096, maxOutputTokens: 512 },
      allowedClasses: ['public', 'internal'],
      allowedPurposes: ['reason', 'compose'],
      retentionBasis: 'self_hosted',
      createdByMembershipId: context.membershipId,
      ...overrides,
    }),
  );
  return id;
}

/** Walks a draft to active through the real moves: web asks for a probe, the agent role records a pass. */
export async function seedActiveProfile(
  database: AppDatabase,
  agentDatabase: AppDatabase,
  context: TenantContext,
  overrides: Partial<typeof modelProfiles.$inferInsert> = {},
): Promise<string> {
  const id = await seedDraftProfile(database, context, overrides);
  await withTenantTx(database, context, (tx) =>
    tx.update(modelProfiles).set({ status: 'probing' }).where(eq(modelProfiles.id, id)),
  );
  await withRunLookupTx(agentDatabase, context.organizationId, (tx) =>
    tx
      .update(modelProfiles)
      .set({ status: 'active', qualifiedAt: new Date() })
      .where(eq(modelProfiles.id, id)),
  );
  return id;
}

/** A rate card made up for the test. It is a tenant's own figure: there are no prices in this codebase. */
export async function seedRateCard(
  database: AppDatabase,
  context: TenantContext,
  profileId: string,
  rates = { inputMicrosPerMtok: 1_000_000, outputMicrosPerMtok: 2_000_000 },
): Promise<string> {
  const id = randomUUID();
  await withTenantTx(database, context, (tx) =>
    tx.insert(rateCards).values({
      organizationId: context.organizationId,
      id,
      profileId,
      version: 1,
      ...rates,
      createdByMembershipId: context.membershipId,
    }),
  );
  return id;
}

export const thisPeriod = (now = new Date()) => now.toISOString().slice(0, 7);

export async function seedOrganizationBudget(
  database: AppDatabase,
  context: TenantContext,
  limitMicros: number,
): Promise<string> {
  const id = randomUUID();
  await withTenantTx(database, context, (tx) =>
    tx.insert(budgets).values({
      organizationId: context.organizationId,
      id,
      scope: 'organization',
      period: thisPeriod(),
      limitMicros,
      createdByMembershipId: context.membershipId,
    }),
  );
  return id;
}
