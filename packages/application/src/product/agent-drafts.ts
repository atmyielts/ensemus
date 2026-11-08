// Owned by the studio slice (AGENT-08). See docs/06-delivery/m7-slices.md and ADR-031 D5, D6.
import { createHash } from 'node:crypto';
import {
  agentDraftAnswersSchema,
  createAgentDraftSchema,
  updateAgentDraftSchema,
} from '@ensemus/contracts/studio';
import {
  agentDefinitions,
  agentVersions,
  knowledgeSources,
  users,
  memberships,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { agentDrafts, publishReviews, packInstallations } from '@ensemus/database/product';
import {
  agentSpecId,
  assessDraft,
  bindAgentSpec,
  type AgentDraftAnswers,
  type DraftAssessment,
} from '@ensemus/domain/agent-draft';
import { canonicalJson } from '@ensemus/domain/approval';
import { canProduct } from '@ensemus/domain/product-policy';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { canonicalId } from '../ids';
import { auditAction } from '../work';
import type { ProductPorts } from './ports';
import { studioPerson, withStudioTx as withTenantTx } from './studio-authority';

type Ports = Pick<ProductPorts, 'toolCatalog' | 'agentRegistry'>;
type Row = typeof agentDrafts.$inferSelect;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const view = (row: Row): AgentDraftView => ({
  id: row.id,
  name: row.name,
  ownerMembershipId: row.ownerMembershipId,
  agentDefinitionId: row.agentDefinitionId,
  answers: row.answers as AgentDraftAnswers,
  specSha256: row.specSha256,
  status: row.status as AgentDraftView['status'],
  fromPackInstallationId: row.fromPackInstallationId,
  version: row.version,
  updatedAt: row.updatedAt,
});

async function load(tx: Tx, id: string, lock = false) {
  const query = tx
    .select()
    .from(agentDrafts)
    .where(eq(agentDrafts.id, canonicalId(id)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

/** These selections name actual company records. A management role is never a source read grant. */
async function selectedReferences(tx: Tx, answers: AgentDraftAnswers) {
  const [owner] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.id, answers.ownerMembershipId), eq(memberships.status, 'active')))
    .for('share');
  if (!owner) throw new AppError('NOT_FOUND');
  const ids = [...new Set(answers.knowledgeSourceIds.map(canonicalId))];
  if (ids.length) {
    const found = await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(
        and(
          inArray(knowledgeSources.id, ids),
          eq(knowledgeSources.state, 'active'),
          sql`${knowledgeSources.id} in(select knowledge.readable_source_ids(app.current_membership_id()))`,
        ),
      )
      .for('share');
    if (found.length !== ids.length) throw new AppError('NOT_FOUND');
  }
}

async function catalogs(context: TenantContext, ports: Ports) {
  const [tools, limits] = await Promise.all([
    ports.toolCatalog.list(context),
    ports.agentRegistry.orgLimits(context),
  ]);
  return { tools, limits };
}

async function compiled(
  tx: Tx,
  name: string,
  answers: AgentDraftAnswers,
  definitionId: string | null,
  catalog: Awaited<ReturnType<typeof catalogs>>,
) {
  let slug = agentSpecId(name, sha256);
  if (definitionId) {
    const [definition] = await tx
      .select({
        slug: agentDefinitions.slug,
        ownerMembershipId: agentDefinitions.ownerMembershipId,
      })
      .from(agentDefinitions)
      .where(eq(agentDefinitions.id, definitionId))
      .for('share');
    if (!definition) throw new AppError('NOT_FOUND');
    if (definition.ownerMembershipId !== answers.ownerMembershipId)
      throw new AppError('INVALID_INPUT');
    slug = definition.slug;
  }
  const [latest] = await tx
    .select({
      version: agentVersions.versionNumber,
      ownerMembershipId: agentDefinitions.ownerMembershipId,
    })
    .from(agentVersions)
    .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentVersions.definitionId))
    .where(eq(agentDefinitions.slug, slug))
    .orderBy(desc(agentVersions.versionNumber))
    .limit(1);
  if (latest && latest.ownerMembershipId !== answers.ownerMembershipId)
    throw new AppError('INVALID_INPUT');
  const assessment = bindAgentSpec(
    assessDraft(answers, catalog.tools, catalog.limits, sha256),
    answers,
    { name: slug, version: (latest?.version ?? 0) + 1 },
    sha256,
  );
  return {
    assessment,
    compiledSpec: assessment.spec,
    compiledSpecCanonical: assessment.spec ? canonicalJson(assessment.spec) : null,
    specSha256: assessment.specSha256,
    compilePolicyVersion: assessment.spec ? catalog.limits.policyVersion : null,
  };
}

async function cancelReviews(tx: Tx, context: TenantContext, id: string) {
  const rows = await tx
    .update(publishReviews)
    .set({ status: 'cancelled', version: sql`${publishReviews.version}+1`, updatedAt: new Date() })
    .where(
      and(
        eq(publishReviews.subjectKind, 'agent_draft'),
        eq(publishReviews.subjectId, id),
        inArray(publishReviews.status, ['pending', 'approved']),
      ),
    )
    .returning({ id: publishReviews.id });
  for (const row of rows)
    await auditAction(
      tx,
      context,
      'publish_review.cancelled',
      `publish_review:${row.id}`,
      'DRAFT_CHANGED',
    );
}

export type AgentDraftView = {
  id: string;
  name: string;
  ownerMembershipId: string;
  agentDefinitionId: string | null;
  answers: AgentDraftAnswers;
  specSha256: string | null;
  status: 'editing' | 'in_review' | 'published' | 'archived';
  fromPackInstallationId: string | null;
  version: number;
  updatedAt: Date;
};

/** Readable choices are filtered before the bound; a manager's source metadata is not a body grant. */
export async function getAgentDraftChoices(
  database: AppDatabase,
  context: TenantContext,
  selectedOwner?: string,
  selectedSourceIds: readonly string[] = [],
) {
  if (selectedSourceIds.length > 50) throw new AppError('INVALID_INPUT');
  const sourceIds = [...new Set(selectedSourceIds.map(canonicalId))];
  return withTenantTx(database, context, async (tx) => {
    await studioPerson(tx, context);
    const owner = selectedOwner ? canonicalId(selectedOwner) : context.membershipId;
    const people = await tx
      .select({ id: memberships.id, name: users.name, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.status, 'active'))
      .orderBy(
        sql`case when ${memberships.id}=${owner}::uuid then 0 else 1 end`,
        users.name,
        memberships.id,
      )
      .limit(200);
    const sources = await tx.execute<{
      id: string;
      title: string;
      classification: 'public' | 'internal' | 'confidential';
    }>(sql`
      select s.id,d.title,s.classification from knowledge.sources s
      join lateral(select doc.title from knowledge.documents doc where doc.organization_id=s.organization_id
        and doc.source_id=s.id and doc.state='searchable' and doc.superseded_at is null
        order by doc.version_no desc limit 1)d on true
      where s.organization_id=${context.organizationId}::uuid and s.state='active'
        and s.classification in ('public','internal','confidential')
        and s.id in(select knowledge.readable_source_ids(app.current_membership_id()))
      order by case when ${
        sourceIds.length
          ? sql`s.id in (${sql.join(
              sourceIds.map((id) => sql`${id}::uuid`),
              sql`,`,
            )})`
          : sql`false`
      }
        then 0 else 1 end,s.updated_at desc,s.id desc limit 200`);
    return { people, sources: sources.rows };
  });
}

/** Needs `studio.author`. A draft can act on nothing, so writing one takes no MFA. */
export async function createAgentDraft(
  database: AppDatabase,
  context: TenantContext,
  ports: Ports,
  input: { name: string; answers: AgentDraftAnswers; agentDefinitionId?: string },
): Promise<AgentDraftView> {
  const parsed = createAgentDraftSchema.safeParse({
    name: input.name,
    answers: input.answers,
    ...(input.agentDefinitionId ? { agent_definition_id: input.agentDefinitionId } : {}),
  });
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    const actor = await studioPerson(tx, context),
      answers = parsed.data.answers;
    const catalog = await catalogs(actor, ports);
    await selectedReferences(tx, answers);
    const binding = await compiled(
      tx,
      parsed.data.name,
      answers,
      parsed.data.agent_definition_id ? canonicalId(parsed.data.agent_definition_id) : null,
      catalog,
    );
    const [row] = await tx
      .insert(agentDrafts)
      .values({
        organizationId: actor.organizationId,
        name: parsed.data.name,
        ownerMembershipId: answers.ownerMembershipId,
        answers,
        agentDefinitionId: parsed.data.agent_definition_id
          ? canonicalId(parsed.data.agent_definition_id)
          : null,
        compiledSpec: binding.compiledSpec,
        compiledSpecCanonical: binding.compiledSpecCanonical,
        specSha256: binding.specSha256,
        compilePolicyVersion: binding.compilePolicyVersion,
        createdByMembershipId: actor.membershipId,
      })
      .returning();
    if (!row) throw new AppError('INVALID_STATE');
    await auditAction(tx, actor, 'agent_draft.created', `agent_draft:${row.id}`);
    return view(row);
  });
}

/** For a pack, in its transaction. Same checks, and the row records which installation made it. */
export async function createAgentDraftInTx(
  tx: Tx,
  context: TenantContext,
  input: { name: string; answers: AgentDraftAnswers; fromPackInstallationId: string },
): Promise<{ id: string }> {
  const actor = await studioPerson(tx, context),
    parsed = createAgentDraftSchema.safeParse({ name: input.name, answers: input.answers });
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const [installation] = await tx
    .select({ id: packInstallations.id })
    .from(packInstallations)
    .where(eq(packInstallations.id, canonicalId(input.fromPackInstallationId)))
    .for('share');
  if (!installation) throw new AppError('NOT_FOUND');
  await selectedReferences(tx, parsed.data.answers);
  // A pack has no catalog/policy compilation in this transaction and never supplies a passing hash.
  const [row] = await tx
    .insert(agentDrafts)
    .values({
      organizationId: actor.organizationId,
      name: parsed.data.name,
      ownerMembershipId: parsed.data.answers.ownerMembershipId,
      answers: parsed.data.answers,
      fromPackInstallationId: installation.id,
      createdByMembershipId: actor.membershipId,
    })
    .returning({ id: agentDrafts.id });
  if (!row) throw new AppError('INVALID_STATE');
  await auditAction(tx, actor, 'agent_draft.created', `agent_draft:${row.id}`, 'PACK_DRAFT');
  return row;
}

export async function listAgentDrafts(
  database: AppDatabase,
  context: TenantContext,
  input: { status?: AgentDraftView['status'] } = {},
): Promise<readonly AgentDraftView[]> {
  if (input.status && !['editing', 'in_review', 'published', 'archived'].includes(input.status))
    throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    await studioPerson(tx, context);
    return (
      await tx
        .select()
        .from(agentDrafts)
        .where(input.status ? eq(agentDrafts.status, input.status) : undefined)
        .orderBy(desc(agentDrafts.updatedAt), desc(agentDrafts.id))
        .limit(200)
    ).map(view);
  });
}

export async function getAgentDraft(
  database: AppDatabase,
  context: TenantContext,
  draftId: string,
): Promise<AgentDraftView> {
  return withTenantTx(database, context, async (tx) => {
    await studioPerson(tx, context);
    return view(await load(tx, draftId));
  });
}

/** Any change clears the hash's standing: earlier simulations and reviews bind the old hash and lapse. */
export async function updateAgentDraft(
  database: AppDatabase,
  context: TenantContext,
  ports: Ports,
  input: { draftId: string; expectedVersion: number; name?: string; answers?: AgentDraftAnswers },
): Promise<AgentDraftView> {
  const parsed = updateAgentDraftSchema.safeParse({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.answers !== undefined ? { answers: input.answers } : {}),
  });
  if (!parsed.success || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    const actor = await studioPerson(tx, context),
      row = await load(tx, input.draftId, true);
    if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (row.status === 'archived') throw new AppError('INVALID_STATE');
    const catalog = await catalogs(actor, ports);
    const answers = parsed.data.answers ?? (row.answers as AgentDraftAnswers),
      name = parsed.data.name ?? row.name;
    await selectedReferences(tx, answers);
    const binding = await compiled(tx, name, answers, row.agentDefinitionId, catalog);
    if (
      name === row.name &&
      canonicalJson(answers) === canonicalJson(row.answers) &&
      binding.specSha256 === row.specSha256 &&
      binding.compilePolicyVersion === row.compilePolicyVersion
    )
      return view(row);
    await cancelReviews(tx, actor, row.id);
    const [saved] = await tx
      .update(agentDrafts)
      .set({
        name,
        answers,
        ownerMembershipId: answers.ownerMembershipId,
        compiledSpec: binding.compiledSpec,
        compiledSpecCanonical: binding.compiledSpecCanonical,
        specSha256: binding.specSha256,
        compilePolicyVersion: binding.compilePolicyVersion,
        status: 'editing',
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(agentDrafts.id, row.id))
      .returning();
    if (!saved) throw new AppError('NOT_FOUND');
    await auditAction(tx, actor, 'agent_draft.updated', `agent_draft:${row.id}`);
    return view(saved);
  });
}

export async function archiveAgentDraft(
  database: AppDatabase,
  context: TenantContext,
  input: { draftId: string; expectedVersion: number },
): Promise<void> {
  return withTenantTx(database, context, async (tx) => {
    const actor = await studioPerson(tx, context),
      row = await load(tx, input.draftId, true);
    if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT');
    if (row.status === 'archived') return;
    await cancelReviews(tx, actor, row.id);
    await tx
      .update(agentDrafts)
      .set({ status: 'archived', version: row.version + 1, updatedAt: new Date() })
      .where(eq(agentDrafts.id, row.id));
    await auditAction(tx, actor, 'agent_draft.archived', `agent_draft:${row.id}`);
  });
}

/** The issues and the risk list for the page, without saving anything. */
export async function assessAgentDraft(
  context: TenantContext,
  ports: Ports,
  answers: AgentDraftAnswers,
): Promise<DraftAssessment> {
  if (context.actorType !== 'user' || !canProduct(context.role, 'studio.author'))
    throw new AppError('FORBIDDEN');
  const parsed = agentDraftAnswersSchema.safeParse(answers);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const catalog = await catalogs(context, ports);
  return assessDraft(parsed.data, catalog.tools, catalog.limits, sha256);
}
