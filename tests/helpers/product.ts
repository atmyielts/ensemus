// Test seeds and doubles for M7, shared by every M7 slice (ADR-031). They go through real roles and the real
// triggers, so a seed can never reach a state the rules forbid. Generated values only: nothing here is a real
// address, credential or provider. Fakes live here, with the tests, and no shipped code can import them.
import { randomUUID } from 'node:crypto';
import { unavailablePorts, type ProductPorts } from '@ensemus/application/product-ports';
import { openAppDatabase, createOrganization, resolveTenantContext } from '@ensemus/database';
import type { TenantContext } from '@ensemus/database';
import { authSchema, recordSessionAssurance, openAuthDatabase } from '@ensemus/database/auth';
import { eq } from 'drizzle-orm';
import type { AgentDraftAnswers, ToolFacts } from '@ensemus/domain/agent-draft';
import pg from 'pg';
import { urls } from './stack';

export type TestPerson = { userId: string; context: TenantContext; sessionId: string };

const authClient = async () => {
  const client = new pg.Client({ connectionString: urls.auth() });
  await client.connect();
  return client;
};

/** A person, with a session row, because a recent-MFA check names a real session. */
export async function makePerson(label: string): Promise<{ userId: string; sessionId: string }> {
  const client = await authClient();
  try {
    const userId = randomUUID();
    const sessionId = randomUUID();
    await client.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      label,
      `${label}-${userId}@example.invalid`,
    ]);
    await client.query(
      `insert into identity.sessions (id, user_id, token, expires_at)
       values ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, userId, randomUUID()],
    );
    return { userId, sessionId };
  } finally {
    await client.end();
  }
}

/** Two tenants with the same name, each with an owner, an admin and a member. */
export async function makeTwoTenants(database: ReturnType<typeof openAppDatabase>['db']) {
  const tenant = async (suffix: string) => {
    const owner = await makePerson(`owner${suffix}`);
    const { organizationId } = await createOrganization(database, {
      userId: owner.userId,
      name: 'Same Name Ltd',
      commercialMode: 'byom',
    });
    const context = await resolveTenantContext(database, owner.userId, organizationId);
    const join = async (role: 'admin' | 'member'): Promise<TestPerson> => {
      const person = await makePerson(`${role}${suffix}`);
      const client = new pg.Client({ connectionString: urls.superuser() });
      await client.connect();
      try {
        await client.query(
          `insert into org.memberships (organization_id, user_id, role, status)
           values ($1, $2, $3, 'active')`,
          [organizationId, person.userId, role],
        );
      } finally {
        await client.end();
      }
      return {
        ...person,
        context: await resolveTenantContext(database, person.userId, organizationId),
      };
    };
    return {
      organizationId,
      owner: { ...owner, context } satisfies TestPerson,
      admin: await join('admin'),
      member: await join('member'),
    };
  };
  return { a: await tenant('a'), b: await tenant('b') };
}

/**
 * Says this session proved a second factor, as the auth role, which is the only role that can. A test that
 * wants the refusal simply does not call this, and `verifiedAt` lets one make the proof old.
 */
export async function proveSecondFactor(
  person: { userId: string; sessionId: string },
  verifiedAt: Date = new Date(),
) {
  const { db, close } = openAuthDatabase(urls.auth());
  try {
    await db
      .update(authSchema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(authSchema.user.id, person.userId));
    await recordSessionAssurance(
      db,
      { sessionId: person.sessionId, userId: person.userId, kind: 'mfa_totp' },
      verifiedAt,
    );
  } finally {
    await close();
  }
}

export const testTools: readonly ToolFacts[] = [
  { id: 'work.read', version: '1', class: 'read_only', requiresApproval: false },
  { id: 'artifact.read_text', version: '1', class: 'read_only', requiresApproval: false },
  { id: 'artifact.draft.create', version: '1', class: 'draft_only', requiresApproval: false },
  { id: 'email.send', version: '1', class: 'external_write', requiresApproval: true },
  { id: 'agent.delegate', version: '1', class: 'delegation', requiresApproval: false },
];

export function testAnswers(
  ownerMembershipId: string,
  overrides: Partial<AgentDraftAnswers> = {},
): AgentDraftAnswers {
  return {
    role: 'A test assistant that prepares short briefs.',
    intendedOutcome: 'A one page brief with citations.',
    boundaries: ['Only uses what it is given.'],
    knowledgeSourceIds: [],
    toolIds: ['work.read', 'artifact.draft.create'],
    triggerKind: 'manual',
    maxCostMicros: 1_000_000,
    maxTurns: 10,
    maxToolCalls: 10,
    maxTotalTokens: 100_000,
    qualityTier: 'balanced',
    timeoutSeconds: 180,
    autonomy: 'draft_for_review',
    memoryWrite: 'none',
    outputFormat: 'markdown_brief',
    dataClasses: ['internal'],
    ownerMembershipId,
    ...overrides,
  };
}

/**
 * Recording doubles for M4's and M5's ports. Each starts from the honest default and overrides what a test
 * needs, so anything a test did not think about still says it is unavailable.
 */
export function fakePorts(overrides: Partial<ProductPorts> = {}): ProductPorts & {
  published: unknown[];
  stopped: string[];
} {
  const published: unknown[] = [];
  const stopped: string[] = [];
  const base = unavailablePorts();
  return {
    ...base,
    toolCatalog: { list: async () => testTools },
    agentRegistry: {
      ...base.agentRegistry,
      orgLimits: async () => ({
        maxTurns: 50,
        maxToolCalls: 50,
        timeoutSeconds: 3600,
        policyVersion: 'test-policy',
      }),
      list: async () => [],
      publish: async (_context, input) => {
        published.push(input);
        return {
          definitionId: randomUUID(),
          versionId: randomUUID(),
          versionNumber: published.length,
          specSha256: input.evaluationReport.spec_sha256,
        };
      },
    },
    agentRuns: {
      ...base.agentRuns,
      requestStop: async (_context, runId) => {
        stopped.push(runId);
      },
    },
    published,
    stopped,
    ...overrides,
  };
}
