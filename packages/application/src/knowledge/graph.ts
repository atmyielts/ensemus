// The relational graph is read live. Visibility filters both ends before recursion, ranking or limits,
// so a hidden node cannot become a path, a label, a count or a truncation signal.
import {
  appendAudit,
  knowledgeEdges,
  knowledgeSources,
  memberships,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  edgeAllowed,
  GRAPH_MAX_DEPTH,
  GRAPH_MAX_NODES,
  GRAPH_NODE_TYPES,
  type GraphNode,
  type GraphNodeType,
} from '@ensemus/domain/knowledge';
import { can } from '@ensemus/domain/policy';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { AppError, pgCode } from '../errors';
import { idSchema } from '../ids';

export type GraphEdgeView = {
  from: GraphNode;
  relation: string;
  to: GraphNode;
  origin: 'record' | 'person' | 'fact';
};
export type GraphTraversal = {
  nodes: readonly (GraphNode & { depth: number; label: string })[];
  edges: readonly GraphEdgeView[];
  truncated: boolean;
};
const MAX_EDGES = 1000;
function identifier(value: string) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}
function node(value: GraphNode): GraphNode {
  if (!value || !GRAPH_NODE_TYPES.includes(value.type)) throw new AppError('INVALID_INPUT');
  return { type: value.type, id: identifier(value.id) };
}
async function person(tx: Tx, context: TenantContext, write = false) {
  if (context.actorType === 'service' || (write && context.actorType !== 'user'))
    throw new AppError('FORBIDDEN');
  const [member] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.id, context.membershipId), eq(memberships.status, 'active')))
    .for('share');
  if (!member || (write && !can(member.role, 'knowledge.manage'))) throw new AppError('FORBIDDEN');
  return member;
}
async function visible(tx: Tx, value: GraphNode) {
  if (value.type === 'knowledge_source')
    await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, value.id))
      .for('share');
  const result = await tx.execute<{ allowed: boolean }>(
    sql`select knowledge.can_read_fact_subject(${`${value.type}:${value.id}`}) as allowed`,
  );
  if (!result.rows[0]?.allowed) throw new AppError('NOT_FOUND');
}

export async function linkNodes(
  database: AppDatabase,
  context: TenantContext,
  input: { from: GraphNode; relation: string; to: GraphNode },
): Promise<{ edgeId: string }> {
  const from = node(input.from),
    to = node(input.to);
  if (typeof input.relation !== 'string' || !edgeAllowed(from.type, input.relation, to.type))
    throw new AppError('INVALID_INPUT');
  try {
    return await withTenantTx(database, context, async (tx) => {
      await person(tx, context, true);
      // Deterministic source lock order matches source close/review and avoids two-source link deadlocks.
      for (const endpoint of [from, to].sort((a, b) => a.id.localeCompare(b.id)))
        await visible(tx, endpoint);
      const [created] = await tx
        .insert(knowledgeEdges)
        .values({
          organizationId: context.organizationId,
          fromType: from.type,
          fromId: from.id,
          toType: to.type,
          toId: to.id,
          relation: input.relation,
          origin: 'person',
          createdByMembershipId: context.membershipId,
        })
        .onConflictDoNothing()
        .returning({ id: knowledgeEdges.id });
      if (!created) {
        const [existing] = await tx
          .select({ id: knowledgeEdges.id })
          .from(knowledgeEdges)
          .where(
            and(
              eq(knowledgeEdges.fromType, from.type),
              eq(knowledgeEdges.fromId, from.id),
              eq(knowledgeEdges.toType, to.type),
              eq(knowledgeEdges.toId, to.id),
              eq(knowledgeEdges.relation, input.relation),
            ),
          );
        if (!existing) throw new AppError('VERSION_CONFLICT');
        return { edgeId: existing.id };
      }
      await appendAudit(tx, {
        organizationId: context.organizationId,
        actorType: 'user',
        actorId: context.membershipId,
        action: 'knowledge.nodes_linked',
        targetRef: `knowledge_edge:${created.id}`,
        decision: 'allow',
      });
      return { edgeId: created.id };
    });
  } catch (error) {
    if (pgCode(error) === 'EN112') throw new AppError('NOT_FOUND');
    throw error;
  }
}
export async function unlinkEdge(
  database: AppDatabase,
  context: TenantContext,
  input: { edgeId: string },
): Promise<void> {
  const edgeId = identifier(input.edgeId);
  await withTenantTx(database, context, async (tx) => {
    await person(tx, context, true);
    const [edge] = await tx
      .select()
      .from(knowledgeEdges)
      .where(eq(knowledgeEdges.id, edgeId))
      .for('update');
    if (!edge) throw new AppError('NOT_FOUND');
    if (edge.origin !== 'person') throw new AppError('INVALID_STATE');
    await tx.delete(knowledgeEdges).where(eq(knowledgeEdges.id, edgeId));
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'knowledge.edge_unlinked',
      targetRef: `knowledge_edge:${edgeId}`,
      decision: 'allow',
    });
  });
}

/** Traversal treats structure as adjacent in both directions; returned edges keep their actual direction. */
export async function traverseGraph(
  database: AppDatabase,
  context: TenantContext,
  input: {
    from: GraphNode;
    relations?: readonly string[];
    nodeTypes?: readonly GraphNodeType[];
    depth?: number;
    limit?: number;
  },
): Promise<GraphTraversal> {
  const from = node(input.from),
    depth = input.depth ?? GRAPH_MAX_DEPTH,
    limit = input.limit ?? GRAPH_MAX_NODES;
  const relations = input.relations === undefined ? null : [...new Set(input.relations)];
  const types =
    input.nodeTypes === undefined ? [...GRAPH_NODE_TYPES] : [...new Set(input.nodeTypes)];
  if (
    !Number.isInteger(depth) ||
    depth < 1 ||
    depth > GRAPH_MAX_DEPTH ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > GRAPH_MAX_NODES ||
    (relations &&
      (relations.length > 20 ||
        relations.some(
          (value) => typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value),
        ))) ||
    types.length > GRAPH_NODE_TYPES.length ||
    types.some((value) => !GRAPH_NODE_TYPES.includes(value))
  )
    throw new AppError('INVALID_INPUT');
  const includeRelation =
    relations === null
      ? sql`true`
      : relations.length
        ? sql`g.relation in (${sql.join(
            relations.map((value) => sql`${value}`),
            sql`, `,
          )})`
        : sql`false`;
  const includeType = (type: SQL) =>
    types.length
      ? sql`${type} in (${sql.join(
          types.map((value) => sql`${value}`),
          sql`, `,
        )})`
      : sql`false`;
  // Bound recursive work as well as returned nodes. UNION removes repeated paths at each depth; a
  // conservative exploration cap may report truncation sooner than a complete breadth-first expansion.
  const exploration = (depth + 1) * (limit + 1);
  return withTenantTx(database, context, async (tx) => {
    await person(tx, context);
    const result = await tx.execute<GraphTraversal & { rootExists: boolean }>(sql`
      with recursive visible(type,id,label) as not materialized (
        select 'client'::text,c.id,c.display_name from work.clients c where c.organization_id=${context.organizationId}::uuid and knowledge.can_read_fact_subject('client:'||c.id::text)
        union all select 'project',p.id,p.name from work.projects p where p.organization_id=${context.organizationId}::uuid and knowledge.can_read_fact_subject('project:'||p.id::text)
        union all select 'work_unit',w.id,w.title from work.work_units w where w.organization_id=${context.organizationId}::uuid and knowledge.can_read_work(w.id,app.current_membership_id())
        union all select 'membership',m.id,u.name from org.memberships m join identity.users u on u.id=m.user_id where m.organization_id=${context.organizationId}::uuid
        union all select 'team',t.id,t.name from org.teams t where t.organization_id=${context.organizationId}::uuid
        union all select 'knowledge_source',s.id,coalesce(d.title,'Document') from knowledge.sources s left join lateral(select doc.title from knowledge.documents doc where doc.organization_id=s.organization_id and doc.source_id=s.id order by doc.version_no desc limit 1)d on true where s.organization_id=${context.organizationId}::uuid and s.state='active' and s.id in(select knowledge.readable_source_ids(app.current_membership_id()))
      ), links as not materialized (
        select g.* from knowledge.graph_links g join visible f on f.type=g.from_type and f.id=g.from_id join visible t on t.type=g.to_type and t.id=g.to_id
        where g.organization_id=${context.organizationId}::uuid and ${includeRelation}
          and (g.origin<>'fact' or exists(select 1 from knowledge.edges e join knowledge.facts f on f.organization_id=e.organization_id and f.id=e.fact_id where e.organization_id=g.organization_id and e.from_type=g.from_type and e.from_id=g.from_id and e.to_type=g.to_type and e.to_id=g.to_id and e.relation=g.relation and e.origin='fact' and f.trust_state='verified' and (f.valid_from is null or f.valid_from<=now()) and (f.valid_until is null or f.valid_until>now())))
      ), walk(type,id,depth) as (
        select v.type,v.id,0 from visible v where v.type=${from.type} and v.id=${from.id}::uuid
        union
        select n.type,n.id,w.depth+1 from walk w join lateral(
          select case when g.from_type=w.type and g.from_id=w.id then g.to_type else g.from_type end as type,
                 case when g.from_type=w.type and g.from_id=w.id then g.to_id else g.from_id end as id
          from links g where ((g.from_type=w.type and g.from_id=w.id) or (g.to_type=w.type and g.to_id=w.id))
            and ${includeType(sql`case when g.from_type=w.type and g.from_id=w.id then g.to_type else g.from_type end`)}
          order by type,id limit ${limit + 1}
        ) n on true where w.depth<${depth}
      ), explored as materialized(select * from walk limit ${exploration + 1}),
      candidates as materialized(select type,id,min(depth) as depth from explored group by type,id),
      selected as materialized(select * from candidates order by depth,type,id limit ${limit}),
      selected_edges as materialized(select distinct g.from_type,g.from_id,g.relation,g.to_type,g.to_id,g.origin from links g join selected f on f.type=g.from_type and f.id=g.from_id join selected t on t.type=g.to_type and t.id=g.to_id order by g.from_type,g.from_id,g.relation,g.to_type,g.to_id,g.origin limit ${MAX_EDGES + 1})
      select exists(select 1 from visible v where v.type=${from.type} and v.id=${from.id}::uuid) as "rootExists",
        coalesce((select jsonb_agg(jsonb_build_object('type',s.type,'id',s.id,'depth',s.depth,'label',v.label) order by s.depth,s.type,s.id) from selected s join visible v on v.type=s.type and v.id=s.id),'[]'::jsonb) as nodes,
        coalesce((select jsonb_agg(jsonb_build_object('from',jsonb_build_object('type',e.from_type,'id',e.from_id),'relation',e.relation,'to',jsonb_build_object('type',e.to_type,'id',e.to_id),'origin',e.origin) order by e.from_type,e.from_id,e.relation,e.to_type,e.to_id,e.origin) from (select * from selected_edges order by from_type,from_id,relation,to_type,to_id,origin limit ${MAX_EDGES})e),'[]'::jsonb) as edges,
        ((select count(*) from explored)>${exploration} or (select count(*) from candidates)>${limit} or (select count(*) from selected_edges)>${MAX_EDGES}
          or exists(select 1 from selected s join links g on (g.from_type=s.type and g.from_id=s.id) or (g.to_type=s.type and g.to_id=s.id)
            where ${includeType(sql`case when g.from_type=s.type and g.from_id=s.id then g.to_type else g.from_type end`)}
              and not exists(select 1 from selected n where n.type=case when g.from_type=s.type and g.from_id=s.id then g.to_type else g.from_type end and n.id=case when g.from_type=s.type and g.from_id=s.id then g.to_id else g.from_id end))) as truncated
    `);
    const row = result.rows[0];
    if (!row?.rootExists) throw new AppError('NOT_FOUND');
    return { nodes: row.nodes, edges: row.edges, truncated: row.truncated };
  });
}
