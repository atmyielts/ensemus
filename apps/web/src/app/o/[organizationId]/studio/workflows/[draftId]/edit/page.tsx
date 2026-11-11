import { randomUUID } from 'node:crypto';
import { getProcessDraft, loadProcessCatalog } from '@ensemus/application/process-specs';
import { listAgentRegistry } from '@ensemus/application/ai-agents';
import { ActionLink, BackLink, Empty, ErrorNotice, PageHead } from '@/components/ui';
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
            description="Change one part at a time and save it. If someone else saves a change meanwhile, you will be asked to look at theirs first."
            actions={
              <ActionLink href={base} variant="secondary">
                Review the saved workflow
              </ActionLink>
            }
          />
          <ErrorNotice code={query.error} />
          {query.saved === '1' && (
            <p role="status" className="notice good">
              The change was saved. Check the list below before you rehearse it.
            </p>
          )}
          {query.saved === 'connection-removed' && (
            <p role="status" className="notice good">
              The connection removal was recorded.
            </p>
          )}
          {draft.status === 'archived' ? (
            <Empty
              title="This draft is archived"
              action={
                <ActionLink href={base} variant="secondary">
                  Read the saved workflow
                </ActionLink>
              }
            >
              An archived workflow can be read but not changed.
            </Empty>
          ) : (
            <div className="stack">
              <WorkflowMapChecks />

              <section aria-labelledby="workflow-details">
                <div className="section-intro">
                  <h2 id="workflow-details">Name and who can see it</h2>
                </div>
                <WorkflowDetailsForm
                  organizationId={organizationId}
                  draft={draft}
                  requestKey={randomUUID()}
                />
              </section>

              <section aria-labelledby="edit-workflow-points">
                <div className="section-intro">
                  <h2 id="edit-workflow-points">Steps</h2>
                  <p>
                    Open a step to change it. Each step waits for every step linked before it; when
                    a step links to several after it, they all carry on at the same time.
                  </p>
                </div>
                {points.length ? (
                  <div className="stack">
                    {points.map((node) => {
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
                          <div className="gap-above">
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
                                {count} points share the same saved identity, so they cannot be
                                edited one by one. Remove this group and add the points you meant
                                again.
                              </p>
                            )}
                          </div>
                          <section className="divided fields">
                            <h3>
                              {count === 1 ? 'Remove this point' : 'Remove the duplicated group'}
                            </h3>
                            <p className="muted">
                              This removes{' '}
                              {count === 1
                                ? 'the point'
                                : 'every point with this duplicated identity'}{' '}
                              and its links. The points around it are not joined up again for you,
                              so check the list afterwards.
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
                                  className="danger"
                                  working="Removing the selected point"
                                >
                                  {count === 1 ? 'Remove this point' : 'Remove duplicated group'}
                                </SubmitButton>
                              </div>
                            </form>
                          </section>
                          <details className="gap-above">
                            <summary>Technical details</summary>
                            <code>{node.id}</code>
                          </details>
                        </details>
                      );
                    })}
                  </div>
                ) : (
                  <Empty title="No steps yet">
                    Add a Start point, at least one step and a Finish point below, then link them in
                    order.
                  </Empty>
                )}
              </section>

              <section className="card fields" aria-labelledby="add-workflow-point">
                <h2 id="add-workflow-point">Add a point</h2>
                <p className="muted">
                  Give it a clear name for what should happen. Save any open changes above first:
                  this adds to the saved workflow, in the place the ticked links describe.
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
                  <p className="notice">
                    A workflow can have up to 64 points. Remove one before adding another.
                  </p>
                )}
              </section>

              <div className="card">
                <WorkflowMap
                  draft={draft}
                  layout={picture}
                  id="edit-workflow-map"
                  editHref={`${base}/edit`}
                  editing
                  organizationId={organizationId}
                  repairKey={randomUUID()}
                />
              </div>
            </div>
          )}
        </OneActionAtATime>
      </WorkflowEditorState>
    </DraftScope>
  );
}
