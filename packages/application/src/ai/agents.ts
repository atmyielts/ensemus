// Owned by the agents slice (AGENT-01, AGENT-16). Publishing is an upload with `agent.publish`: the server
// checks the spec, lints its grants, requires a passing evaluation bound to this exact spec and policy,
// and then writes a row nobody can change (ADR-028 FD-19, threat SEC-007). "Signer" means the publishing
// membership plus the SHA-256. See docs/06-delivery/m4-slices.md.
import { createHash, randomUUID } from 'node:crypto';
import {
  agentSpecV1Schema,
  evaluationReportSchema,
  type AgentSpecV1,
  type AgentVersionView,
} from '@ensemus/contracts/ai';
import {
  actorOf,
  agentDefinitions,
  agentPublications,
  agentVersions,
  appendAudit,
  memberships,
  policyBundles,
  serviceIdentities,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { usdToMicros } from '@ensemus/domain/ai';
import { AGENT_VERSION_PUBLISHED } from '@ensemus/domain/ai-events';
import { canonicalJson } from '@ensemus/domain/approval';
import { can } from '@ensemus/domain/policy';
import {
  agentLimitsFromPolicyDocument,
  lintAgentSpec,
  NO_POLICY_AGENT_LIMITS,
  type OrgAgentLimits,
  type SpecLintCode,
} from '@ensemus/policy/agent-spec-lint';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { emit } from '../events';
import { idSchema } from '../ids';
import { assertInteractivePrivilege, withPrivilegeTx as withTenantTx } from '../product/privileged';

const UNIQUE_VIOLATION = '23505';
const AGGREGATE_AGENT_VERSION = 'agent_version';
/** More versions than anyone reads in one list. Newest first, so what is cut is the oldest. */
const MAX_LISTED_VERSIONS = 500;
const MAX_REPORTED_FIELDS = 20;

/** The policy version a report carries when the organization has no active policy document. */
export const DEFAULT_AGENT_POLICY_VERSION = 'default';

/** A spec that was refused, and which rules it broke. Codes and field names only, never its content. */
export class AgentSpecRefused extends AppError {
  constructor(
    readonly lintCodes: readonly SpecLintCode[],
    readonly fields: readonly string[] = [],
  ) {
    super('AGENT_SPEC_INVALID');
  }
}

const GATE_CODES: ReadonlySet<string> = new Set([
  'AGENT_SPEC_INVALID',
  'AGENT_EVALUATION_REQUIRED',
  'POLICY_DENIED',
]);

/**
 * Someone with the right to publish tried to get past the gate. Mistyped input usually leaves no record,
 * but this is the one way grants are set, so callers audit it through `auditRefusal`.
 */
export const isPublishGateRefusal = (error: unknown): error is AppError =>
  error instanceof AppError && GATE_CODES.has(error.code);

// A person, and not only a role. An agent's context carries its initiator's role (FD-3), so without this
// an agent acting for an owner would pass, and could widen its own grants by publishing a new version.
function requirePublisher(context: TenantContext) {
  if (context.actorType !== 'user' || !can(context.role, 'agent.publish')) {
    throw new AppError('FORBIDDEN');
  }
}

function requireRegistryReader(context: TenantContext) {
  const allowed = can(context.role, 'agent.publish') || can(context.role, 'agent.run');
  if (context.actorType !== 'user' || !allowed) throw new AppError('FORBIDDEN');
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** What a report binds to. An evaluation harness computes the same over the same parsed spec. */
export const agentSpecSha256 = (spec: unknown) => sha256(canonicalJson(spec));

export type PreparedPublication = {
  spec: AgentSpecV1;
  specSha256: string;
  reportSha256: string;
  maxCostMicros: number;
};

function parseSpec(raw: unknown): AgentSpecV1 {
  const parsed = agentSpecV1Schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Lint can say something more useful for what the schema refuses, such as skills in M4.
  const lint = lintAgentSpec(raw, NO_POLICY_AGENT_LIMITS);
  const lintCodes = lint.ok ? [] : lint.codes.filter((code) => code !== 'NOT_LINTED');
  // Field names come from our own schema. Values are never included.
  const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join('.')))]
    .filter(Boolean)
    .slice(0, MAX_REPORTED_FIELDS);
  throw new AgentSpecRefused(lintCodes, fields);
}

/**
 * The gate. A report only counts for the exact spec, suite and policy it was made against, so one that
 * passed for a narrower agent cannot be reused for a wider one, nor survive a change of policy.
 */
function checkEvaluation(
  raw: unknown,
  spec: AgentSpecV1,
  specSha256: string,
  policyVersions: readonly string[],
): string {
  const parsed = evaluationReportSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('AGENT_EVALUATION_REQUIRED');
  const report = parsed.data;
  const holds =
    report.passed &&
    report.spec_sha256 === specSha256 &&
    policyVersions.every((version) => version === report.policy_version) &&
    report.suite_ref === spec.evaluation.suite_ref &&
    report.pass_rate >= spec.evaluation.min_pass_rate;
  if (!holds) throw new AppError('AGENT_EVALUATION_REQUIRED');
  return sha256(canonicalJson(report));
}

/**
 * Every decision about a manifest, with no database, so each refusal can be tested on its own. The
 * policy version a caller names has to be the current one too, or a caller could present an old one
 * along with the old report that matches it.
 */
export function preparePublication(
  input: { spec: unknown; evaluationReport: unknown; policyVersion: string },
  limits: OrgAgentLimits,
  currentPolicyVersion: string,
): PreparedPublication {
  const spec = parseSpec(input.spec);
  const lint = lintAgentSpec(spec, limits);
  if (!lint.ok) throw new AgentSpecRefused(lint.codes);
  const specSha256 = agentSpecSha256(spec);
  const reportSha256 = checkEvaluation(input.evaluationReport, spec, specSha256, [
    input.policyVersion,
    currentPolicyVersion,
  ]);
  return {
    spec,
    specSha256,
    reportSha256,
    // Once, here. From now on a budget only ever sees this integer (FD-6).
    maxCostMicros: usdToMicros(spec.execution.max_cost_usd),
  };
}

/** At most one, by unique index. Bundles are never edited, so its version names exactly this document. */
async function readActiveBundle(tx: Tx, organizationId: string) {
  const [bundle] = await tx
    .select({ version: policyBundles.version, document: policyBundles.document })
    .from(policyBundles)
    .where(and(eq(policyBundles.organizationId, organizationId), eq(policyBundles.active, true)));
  return bundle;
}

const policyVersionOf = (bundle: { version: number } | undefined) =>
  bundle ? String(bundle.version) : DEFAULT_AGENT_POLICY_VERSION;

function limitsOf(bundle: { document: unknown } | undefined): OrgAgentLimits {
  if (!bundle) return NO_POLICY_AGENT_LIMITS;
  const limits = agentLimitsFromPolicyDocument(bundle.document);
  // A limit somebody wrote and nobody can read is not a limit that can be skipped.
  if (!limits) throw new AppError('POLICY_DENIED');
  return limits;
}

/** The policy version a report has to carry to be accepted now. */
export async function getAgentPolicyVersion(
  database: AppDatabase,
  context: TenantContext,
): Promise<string> {
  requireRegistryReader(context);
  return withTenantTx(database, context, async (tx) =>
    policyVersionOf(await readActiveBundle(tx, context.organizationId)),
  );
}

/**
 * The context was checked when the request began. The publisher is who signs this version for good, so
 * their right to is read again here, and held until commit, against a change of role at the same moment.
 */
async function assertStillPublisher(tx: Tx, context: TenantContext) {
  const [member] = await tx
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(eq(memberships.id, context.membershipId))
    .for('share');
  if (member?.status !== 'active' || !can(member.role, 'agent.publish')) {
    throw new AppError('FORBIDDEN');
  }
}

/** The definition for this manifest's `id`. A first publish also makes the identity it runs under. */
async function findOrCreateDefinition(tx: Tx, context: TenantContext, slug: string) {
  const organizationId = context.organizationId;
  const [existing] = await tx
    .select({ id: agentDefinitions.id })
    .from(agentDefinitions)
    .where(
      and(eq(agentDefinitions.organizationId, organizationId), eq(agentDefinitions.slug, slug)),
    );
  if (existing) return existing.id;
  const serviceIdentityId = randomUUID();
  const id = randomUUID();
  await tx.insert(serviceIdentities).values({
    organizationId,
    id: serviceIdentityId,
    ownerMembershipId: context.membershipId,
    purpose: `agent:${slug}`,
  });
  await tx.insert(agentDefinitions).values({
    organizationId,
    id,
    slug,
    name: slug,
    ownerMembershipId: context.membershipId,
    serviceIdentityId,
  });
  return id;
}

type VersionRow = typeof agentVersions.$inferSelect;

function versionView(row: VersionRow): AgentVersionView {
  return {
    id: row.id,
    definition_id: row.definitionId,
    version_number: row.versionNumber,
    spec_sha256: row.specSha256,
    evaluation_report_sha256: row.evaluationReportSha256,
    policy_version: row.policyVersion,
    published_by_membership_id: row.publishedByMembershipId,
    published_at: row.publishedAt.toISOString(),
  };
}

/**
 * Checks the spec, lints its grants, requires a report bound to its hash, then writes one immutable row.
 * Everything happens in one transaction, with nothing outside the database, so a refusal leaves no trace
 * of itself and the policy it was checked against is the policy it was published under.
 *
 * Runs already started keep the version they started on, because a run names its version and a version
 * cannot change. Only new runs get the new publication.
 */
export async function publishAgentVersion(
  database: AppDatabase,
  context: TenantContext,
  input: { spec: unknown; evaluationReport: unknown; policyVersion: string },
): Promise<AgentVersionView> {
  requirePublisher(context);
  const organizationId = context.organizationId;
  try {
    return await withTenantTx(database, context, async (tx) => {
      await assertStillPublisher(tx, context);
      await assertInteractivePrivilege(tx, context, 'agent.publish');
      const bundle = await readActiveBundle(tx, organizationId);
      const policyVersion = policyVersionOf(bundle);
      const prepared = preparePublication(input, limitsOf(bundle), policyVersion);
      const { spec } = prepared;

      const definitionId = await findOrCreateDefinition(tx, context, spec.id);
      const [newest] = await tx
        .select({ versionNumber: agentVersions.versionNumber })
        .from(agentVersions)
        .where(
          and(
            eq(agentVersions.organizationId, organizationId),
            eq(agentVersions.definitionId, definitionId),
          ),
        )
        .orderBy(desc(agentVersions.versionNumber))
        .limit(1);
      // A number is one exact spec, for good. Going backwards would also make the list misleading.
      if (newest && newest.versionNumber >= spec.version) throw new AppError('VERSION_CONFLICT');

      const id = randomUUID();
      const [row] = await tx
        .insert(agentVersions)
        .values({
          organizationId,
          id,
          definitionId,
          versionNumber: spec.version,
          spec,
          specSha256: prepared.specSha256,
          evaluationReportSha256: prepared.reportSha256,
          policyVersion,
          maxCostMicros: prepared.maxCostMicros,
          publishedByMembershipId: context.membershipId,
        })
        .returning();
      if (!row) throw new AppError('INVALID_STATE');

      await tx
        .update(agentPublications)
        .set({ activeUntil: sql`now()` })
        .where(
          and(
            eq(agentPublications.organizationId, organizationId),
            eq(agentPublications.definitionId, definitionId),
            isNull(agentPublications.activeUntil),
          ),
        );
      await tx.insert(agentPublications).values({
        organizationId,
        definitionId,
        versionId: id,
        activeFrom: sql`now()`,
      });

      await appendAudit(tx, {
        organizationId,
        ...actorOf(context),
        action: 'agent_version.published',
        targetRef: `agent_version:${id}`,
        decision: 'allow',
      });
      await emit(tx, context, {
        eventType: AGENT_VERSION_PUBLISHED,
        aggregateType: AGGREGATE_AGENT_VERSION,
        aggregateId: id,
        aggregateVersion: spec.version,
        classification: 'internal',
        payload: {
          definition_id: definitionId,
          version_number: spec.version,
          spec_sha256: prepared.specSha256,
        },
      });
      return versionView(row);
    });
  } catch (error) {
    // Two people publishing at once. The checks above cannot see each other's rows, and these unique
    // keys can: the slug, the version number, and one active publication per definition.
    if (pgCode(error) === UNIQUE_VIOLATION) throw new AppError('VERSION_CONFLICT');
    throw error;
  }
}

/** Read the actual publication ceilings, with fresh membership rather than a saved role. */
export async function getAgentPublicationPolicy(database: AppDatabase, context: TenantContext) {
  requireRegistryReader(context);
  return withTenantTx(database, context, async (tx) => {
    const [member] = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(
        and(
          eq(memberships.id, context.membershipId),
          eq(memberships.userId, context.userId),
          eq(memberships.status, 'active'),
        ),
      )
      .for('share');
    if (!member || !(can(member.role, 'agent.publish') || can(member.role, 'agent.run')))
      throw new AppError('FORBIDDEN');
    const bundle = await readActiveBundle(tx, context.organizationId);
    return { limits: limitsOf(bundle), policyVersion: policyVersionOf(bundle) };
  });
}

/** Repoint new runs to an immutable, previously evaluated version. A changed policy requires a new
 * evaluated publication; neither rollback nor a saved version restores obsolete permission. */
export async function pinAgentVersion(
  database: AppDatabase,
  context: TenantContext,
  rawId: string,
) {
  requirePublisher(context);
  const parsed = idSchema.safeParse(rawId);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  try {
    await withTenantTx(database, context, async (tx) => {
      await assertStillPublisher(tx, context);
      await assertInteractivePrivilege(tx, context, 'agent.publish');
      const [version] = await tx
        .select()
        .from(agentVersions)
        .where(eq(agentVersions.id, parsed.data));
      if (!version) throw new AppError('NOT_FOUND');
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
        ${`ensemus:agent-publication:${context.organizationId.toLowerCase()}:${version.definitionId.toLowerCase()}`},0))`);
      const [definition] = await tx
        .select({ identityId: agentDefinitions.serviceIdentityId })
        .from(agentDefinitions)
        .where(eq(agentDefinitions.id, version.definitionId));
      if (!definition) throw new AppError('NOT_FOUND');
      const [identity] = await tx
        .select({ status: serviceIdentities.status, expiresAt: serviceIdentities.expiresAt })
        .from(serviceIdentities)
        .where(eq(serviceIdentities.id, definition.identityId))
        .for('share');
      if (
        !identity ||
        identity.status !== 'active' ||
        (identity.expiresAt && identity.expiresAt <= new Date())
      )
        throw new AppError('INVALID_STATE');
      const bundle = await readActiveBundle(tx, context.organizationId);
      const spec = parseSpec(version.spec),
        lint = lintAgentSpec(spec, limitsOf(bundle));
      if (!lint.ok) throw new AgentSpecRefused(lint.codes);
      if (
        version.policyVersion !== policyVersionOf(bundle) ||
        agentSpecSha256(spec) !== version.specSha256 ||
        spec.version !== version.versionNumber ||
        !/^[a-f0-9]{64}$/.test(version.evaluationReportSha256)
      )
        throw new AppError('AGENT_EVALUATION_REQUIRED');
      const active = await tx
        .select()
        .from(agentPublications)
        .where(
          and(
            eq(agentPublications.definitionId, version.definitionId),
            sql`(${agentPublications.activeUntil} is null or ${agentPublications.activeUntil}>now())`,
          ),
        )
        .for('update');
      // A scheduled publication is a separate decision and cannot silently be replaced by a pin.
      if (active.some((publication) => publication.activeFrom > new Date()))
        throw new AppError('INVALID_STATE');
      if (active.length === 1 && active[0]!.versionId === version.id) return;
      await tx
        .update(agentPublications)
        .set({ activeUntil: sql`now()` })
        .where(
          and(
            eq(agentPublications.definitionId, version.definitionId),
            sql`(${agentPublications.activeUntil} is null or ${agentPublications.activeUntil}>now())`,
          ),
        );
      await tx.insert(agentPublications).values({
        organizationId: context.organizationId,
        definitionId: version.definitionId,
        versionId: version.id,
        activeFrom: sql`now()`,
      });
      await appendAudit(tx, {
        organizationId: context.organizationId,
        ...actorOf(context),
        action: 'agent_version.pinned',
        targetRef: `agent_version:${version.id}`,
        decision: 'allow',
      });
      await emit(tx, context, {
        eventType: 'agent_version.pinned',
        aggregateType: AGGREGATE_AGENT_VERSION,
        aggregateId: version.id,
        aggregateVersion: version.versionNumber,
        classification: 'internal',
        payload: {
          definition_id: version.definitionId,
          version_number: version.versionNumber,
          spec_sha256: version.specSha256,
        },
      });
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new AppError('VERSION_CONFLICT');
    throw error;
  }
}

export async function listAgentVersions(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly AgentVersionView[]> {
  requireRegistryReader(context);
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.organizationId, context.organizationId))
      .orderBy(desc(agentVersions.publishedAt), desc(agentVersions.id))
      .limit(MAX_LISTED_VERSIONS),
  );
  return rows.map(versionView);
}

/** The same answer for another tenant's ID and for one that does not exist, so none can be probed. */
export async function getAgentVersion(
  database: AppDatabase,
  context: TenantContext,
  versionId: string,
): Promise<AgentVersionView> {
  requireRegistryReader(context);
  const id = idSchema.safeParse(versionId);
  if (!id.success) throw new AppError('NOT_FOUND');
  const [row] = await withTenantTx(database, context, (tx) =>
    tx
      .select()
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.organizationId, context.organizationId),
          eq(agentVersions.id, id.data),
        ),
      ),
  );
  if (!row) throw new AppError('NOT_FOUND');
  return versionView(row);
}

export type AgentRegistryRow = {
  versionId: string;
  slug: string;
  name: string;
  versionNumber: number;
  specSha256: string;
  policyVersion: string;
  publishedAt: Date;
  /** Whether new runs get this version. A run already going keeps the one it started on. */
  active: boolean;
};

/** What the settings page lists: each version under its agent, with the one new runs get marked. */
export async function listAgentRegistry(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly AgentRegistryRow[]> {
  requireRegistryReader(context);
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({
        versionId: agentVersions.id,
        slug: agentDefinitions.slug,
        name: agentDefinitions.name,
        versionNumber: agentVersions.versionNumber,
        specSha256: agentVersions.specSha256,
        policyVersion: agentVersions.policyVersion,
        publishedAt: agentVersions.publishedAt,
        publicationId: agentPublications.id,
      })
      .from(agentVersions)
      .innerJoin(
        agentDefinitions,
        and(
          eq(agentDefinitions.organizationId, agentVersions.organizationId),
          eq(agentDefinitions.id, agentVersions.definitionId),
        ),
      )
      .leftJoin(
        agentPublications,
        and(
          eq(agentPublications.organizationId, agentVersions.organizationId),
          eq(agentPublications.versionId, agentVersions.id),
          isNull(agentPublications.activeUntil),
        ),
      )
      .where(eq(agentVersions.organizationId, context.organizationId))
      .orderBy(agentDefinitions.slug, desc(agentVersions.versionNumber))
      .limit(MAX_LISTED_VERSIONS),
  );
  return rows.map(({ publicationId, ...row }) => ({ ...row, active: publicationId !== null }));
}
