import { AppError, listDirectory, listTeams, listWorkUnits } from '@ensemus/application';
import { listSources } from '@ensemus/application/knowledge/sources';
import { traverseGraph, type GraphTraversal } from '@ensemus/application/knowledge/graph';
import { GRAPH_NODE_TYPES, type GraphNodeType } from '@ensemus/domain/knowledge';
import Link from 'next/link';
import { PageHead, Empty, ErrorNotice } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Related company records | Ensemus' };
const KIND: Record<string, string> = {
  client: 'Client',
  project: 'Project',
  membership: 'Person',
  team: 'Team',
  work_unit: 'Work',
  knowledge_source: 'Source',
};
export default async function GraphPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { organizationId } = await params,
    { context, database } = await requireTenant(organizationId),
    query = await searchParams,
    [sources, work, people, teams] = await Promise.all([
      listSources(database, context, {}),
      listWorkUnits(database, context),
      listDirectory(database, context),
      listTeams(database, context),
    ]);
  let result: GraphTraversal | undefined, error: string | undefined;
  if (query.from) {
    const [type, id] = query.from.split(':');
    if (!id || !GRAPH_NODE_TYPES.includes(type as GraphNodeType)) error = 'INVALID_INPUT';
    else
      result = await traverseGraph(database, context, {
        from: { type: type as GraphNodeType, id },
      }).catch((failure: unknown) => {
        if (!(failure instanceof AppError)) throw failure;
        error = failure.code;
        return undefined;
      });
  }
  const choices = [
    ...sources.items
      .filter((s) => s.canRead && s.state === 'active')
      .map((s) => ({ id: `knowledge_source:${s.id}`, label: `Source: ${s.title}` })),
    ...work.items.map((w) => ({ id: `work_unit:${w.id}`, label: `Work: ${w.title}` })),
    ...people
      .filter((p) => p.status === 'active')
      .map((p) => ({ id: `membership:${p.membershipId}`, label: `Person: ${p.name}` })),
    ...teams.map((t) => ({ id: `team:${t.id}`, label: `Team: ${t.name}` })),
  ];
  const label = (type: string, id: string) =>
    result?.nodes.find((n) => n.type === type && n.id === id)?.label ?? 'Record';
  return (
    <>
      <PageHead
        title="Related records"
        description="Pick a document, piece of work, person or team to see what it is connected to. You only ever see records you are allowed to see."
      />
      <ErrorNotice code={error} />
      <form method="get" className="card inline-form graph-form">
        <label>
          Start from
          <select name="from" required defaultValue={query.from ?? ''}>
            <option value="">Choose a record</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <SubmitButton>Show related records</SubmitButton>
      </form>
      {result && (
        <>
          {result.truncated && (
            <p className="notice">
              There are more connections than fit here, so only the closest ones are shown. Start
              from a nearer record to see the rest.
            </p>
          )}
          {result.nodes.length < 2 ? (
            <Empty title="Nothing connected yet">
              No other records you can see are connected to this one.
            </Empty>
          ) : (
            <section className="card" aria-labelledby="related-heading">
              <div className="section-heading">
                <h2 id="related-heading">Connected records</h2>
                <p>Up to three steps away. Choose one to start from it instead.</p>
              </div>
              <ul className="list">
                {result.nodes.map((n) => (
                  <li key={`${n.type}:${n.id}`}>
                    <div>
                      <Link href={`?from=${n.type}:${n.id}`}>{n.label}</Link>
                      <br />
                      <small>
                        {n.depth === 0
                          ? 'Where you started'
                          : `${n.depth} ${n.depth === 1 ? 'step' : 'steps'} away`}
                      </small>
                    </div>
                    <span className="badge tag">{KIND[n.type] ?? 'Record'}</span>
                  </li>
                ))}
              </ul>
              <details className="gap-above">
                <summary>How they are connected</summary>
                <ul>
                  {result.edges.map((e, i) => (
                    <li key={i}>
                      {label(e.from.type, e.from.id)} · {e.relation.replaceAll('_', ' ')} ·{' '}
                      {label(e.to.type, e.to.id)}
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          )}
        </>
      )}
    </>
  );
}
