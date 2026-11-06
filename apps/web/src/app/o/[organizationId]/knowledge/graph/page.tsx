import { AppError, listDirectory, listTeams, listWorkUnits } from '@ensemus/application';
import { listSources } from '@ensemus/application/knowledge/sources';
import { traverseGraph, type GraphTraversal } from '@ensemus/application/knowledge/graph';
import { GRAPH_NODE_TYPES, type GraphNodeType } from '@ensemus/domain/knowledge';
import Link from 'next/link';
import { PageHead, Empty, ErrorNotice } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Related company records | Ensemus' };
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
  return (
    <>
      <PageHead
        title="Related records"
        description="Follow visible relationships. Hidden records are never used as paths between the records shown."
      />
      <ErrorNotice code={error} />
      <form method="get" className="card fields">
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
        <div className="row">
          <SubmitButton>Show related records</SubmitButton>
        </div>
      </form>
      {result && (
        <>
          {result.truncated && (
            <p className="notice">
              Only the first part of this visible graph is shown. Start from a closer record to
              narrow it.
            </p>
          )}
          {result.nodes.length < 2 ? (
            <Empty>No other visible records are related to this one.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <caption>Related records, up to three steps away</caption>
                <thead>
                  <tr>
                    <th scope="col">Record</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Steps away</th>
                  </tr>
                </thead>
                <tbody>
                  {result.nodes.map((n) => (
                    <tr key={`${n.type}:${n.id}`}>
                      <td>
                        <Link href={`?from=${n.type}:${n.id}`}>{n.label}</Link>
                      </td>
                      <td>
                        {
                          {
                            client: 'Client',
                            project: 'Project',
                            membership: 'Person',
                            team: 'Team',
                            work_unit: 'Work',
                            knowledge_source: 'Source',
                          }[n.type]
                        }
                      </td>
                      <td>{n.depth}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details>
            <summary>Relationship details</summary>
            <ul>
              {result.edges.map((e, i) => (
                <li key={i}>
                  {result.nodes.find((n) => n.type === e.from.type && n.id === e.from.id)?.label ??
                    'Record'}{' '}
                  · {e.relation.replaceAll('_', ' ')} ·{' '}
                  {result.nodes.find((n) => n.type === e.to.type && n.id === e.to.id)?.label ??
                    'Record'}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </>
  );
}
