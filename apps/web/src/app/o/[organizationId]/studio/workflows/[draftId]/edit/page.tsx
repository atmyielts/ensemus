import { randomUUID } from 'node:crypto';
import { getProcessDraft, loadProcessCatalog } from '@ensemus/application/process-specs';
import { listAgentRegistry } from '@ensemus/application/ai-agents';
import Link from 'next/link';
import { BackLink, Empty, ErrorNotice, PageHead } from '@/components/ui';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { SubmitButton } from '@/components/submit-button';
import { WorkflowDetailsForm, WorkflowPointForm } from '@/components/studio/workflow-forms';
import { WorkflowMap, WorkflowMapChecks } from '@/components/studio/workflow-map';
import { WorkflowEditorState } from '@/components/studio/workflow-editor-state';
import { DraftScope } from '@/components/kept-field';
import { layoutWorkflowGraph, workflowPointAnchor } from '@/lib/graph-layout';
import styles from '@/components/studio/workflow-map.module.css';
import { workflowChoiceData, workflowPointLabel } from '@/lib/process-studio-present';
import { workflowPointId } from '@/lib/process-studio-input';
import { removeWorkflowPointAction } from '@/server/process-studio-actions';
import { requireStudio, studioRead } from '@/server/studio-pages';
import { webProductPorts } from '@/server/product-ports';
export const metadata = { title: 'Edit workflow | Ensemus' };
export default async function EditWorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; draftId: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { organizationId, draftId } = await params,
    { actor, database, context } = await requireStudio(organizationId),
    ports = webProductPorts(),
    [draft, catalog] = await Promise.all([
      studioRead(getProcessDraft(database, context, ports, draftId)),
      loadProcessCatalog(context, ports),
    ]);
  const choices = workflowChoiceData(
      catalog,
      catalog.agents === null ? [] : await listAgentRegistry(database, context),
    ),
    base = `/o/${organizationId}/studio/workflows/${draft.id}`,
    query = await searchParams,
    key = randomUUID(),
    picture = layoutWorkflowGraph(draft.graph);
  const points = draft.graph.nodes.filter(
    (node, index, nodes) => nodes.findIndex((other) => other.id === node.id) === index,
  );
  return (
    <DraftScope account={actor.userId}>
      <WorkflowEditorState draft={draft} layout={picture}>
        <OneActionAtATime>
          <BackLink href={base}>{draft.name}</BackLink>
          <PageHead
            title="Edit workflow"
            description="Save one section at a time. If someone changes this workflow, review their latest changes before saving."
          />
          <ErrorNotice code={query.error} />
          {query.saved === '1' && (
            <p role="status" className="notice">
              The change was saved. Check the current compilation result before requesting a
              rehearsal.
            </p>
          )}
          {query.saved === 'connection-removed' && (
            <p role="status" className="notice">
              The connection removal was recorded.
            </p>
          )}
          {draft.status === 'archived' ? (
            <Empty>This draft is archived. Its saved definition is read-only.</Empty>
          ) : (
            <>
              <WorkflowMapChecks />
              <WorkflowMap
                draft={draft}
                layout={picture}
                id="edit-workflow-map"
                editHref={`${base}/edit`}
                editing
                organizationId={organizationId}
                repairKey={randomUUID()}
              />

              <section aria-labelledby="workflow-details">
                <h2 id="workflow-details">Definition details</h2>
                <WorkflowDetailsForm
                  organizationId={organizationId}
                  draft={draft}
                  requestKey={randomUUID()}
                />
              </section>
              <section className="card fields" aria-labelledby="add-workflow-point">
                <h2 id="add-workflow-point">Add a point</h2>
                <p>
                  Use a clear name for what should happen. Save existing edits first; this form
                  inserts into the saved definition. The checked connections say exactly where it
                  goes.
                </p>
                {draft.graph.nodes.length < 64 ? (
                  <WorkflowPointForm
                    organizationId={organizationId}
                    draftId={draft.id}
                    version={draft.version}
                    graph={draft.graph}
                    newNodeId={workflowPointId(key)}
                    requestKey={key}
                    choices={choices}
                  />
                ) : (
                  <Empty>
                    The definition already has 64 points. Explicitly remove a point before adding
                    another.
                  </Empty>
                )}
              </section>
              <section aria-labelledby="edit-workflow-points">
                <h2 id="edit-workflow-points">Saved points</h2>
                <p className="muted">
                  Connections determine execution order. Forks continue along every selected path;
                  joins wait for every earlier point. An outside action must have approval on every
                  incoming path. There is no hidden conditional routing.
                </p>
                {points.length ? (
                  points.map((node) => {
                    const count = draft.graph.nodes.filter((n) => n.id === node.id).length;
                    return (
                      <details className="card" key={node.id}>
                        <summary
                          className={styles.editTarget}
                          id={workflowPointAnchor(
                            draft.graph.nodes.findIndex((point) => point.id === node.id),
                          )}
                        >
                          {workflowPointLabel(draft.graph, node.id)}
                        </summary>
                        {count === 1 ? (
                          <WorkflowPointForm
                            organizationId={organizationId}
                            draftId={draft.id}
                            version={draft.version}
                            graph={draft.graph}
                            node={node}
                            requestKey={randomUUID()}
                            choices={choices}
                          />
                        ) : (
                          <p className="notice">
                            {count} points share this saved identity. They cannot be edited as one
                            point. Explicitly remove this duplicated group and add the intended
                            points again.
                          </p>
                        )}
                        <section className="fields">
                          <h3>
                            {count === 1 ? 'Remove this point' : 'Remove the duplicated group'}
                          </h3>
                          <p>
                            Removal deletes{' '}
                            {count === 1
                              ? 'this point'
                              : 'every point with this duplicated identity'}{' '}
                            and its incoming and outgoing connections. It does not silently
                            reconnect the remaining points. Correct any resulting compilation
                            issues.
                          </p>
                          <form action={removeWorkflowPointAction} className="fields">
                            <input type="hidden" name="organizationId" value={organizationId} />
                            <input type="hidden" name="draftId" value={draft.id} />
                            <input type="hidden" name="version" value={draft.version} />
                            <input type="hidden" name="nodeId" value={node.id} />
                            <input type="hidden" name="requestKey" value={randomUUID()} />
                            <label className="check">
                              <input type="checkbox" name="confirmed" value="yes" required />
                              Remove{' '}
                              {count === 1
                                ? 'this point'
                                : 'all duplicated points with this identity'}{' '}
                              and their connections.
                            </label>
                            <div>
                              <SubmitButton
                                className="secondary"
                                working="Removing the selected point"
                              >
                                {count === 1 ? 'Remove this point' : 'Remove duplicated group'}
                              </SubmitButton>
                            </div>
                          </form>
                        </section>
                        <details>
                          <summary>Technical point identity</summary>
                          <code>{node.id}</code>
                        </details>
                      </details>
                    );
                  })
                ) : (
                  <Empty>
                    No points remain. Add a Start point, at least one execution step and a Finish
                    point, then connect them.
                  </Empty>
                )}
              </section>
              <Link href={base}>Review the saved workflow</Link>
            </>
          )}
        </OneActionAtATime>
      </WorkflowEditorState>
    </DraftScope>
  );
}
