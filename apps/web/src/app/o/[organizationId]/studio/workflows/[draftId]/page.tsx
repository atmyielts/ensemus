import { randomUUID } from 'node:crypto';
import { listDirectory } from '@ensemus/application';
import { getProcessDraft, loadProcessCatalog } from '@ensemus/application/process-specs';
import { listAgentRegistry } from '@ensemus/application/ai-agents';
import { listSimulations } from '@ensemus/application/simulations';
import { listPublishReviews } from '@ensemus/application/publish-reviews';
import { canProduct, canReadRecord } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import {
  ActionLink,
  BackLink,
  ClassificationBadge,
  ErrorNotice,
  PageHead,
  StatusBadge,
  formatDateTime,
} from '@/components/ui';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { SubmitButton } from '@/components/submit-button';
import { WorkflowIssues, WorkflowOverview } from '@/components/studio/workflow-overview';
import { WorkflowMap } from '@/components/studio/workflow-map';
import { layoutWorkflowGraph } from '@/lib/graph-layout';
import { workflowChoiceData, workflowNeedsIndependentReview } from '@/lib/process-studio-present';
import { rehearseWorkflowAction, reviewWorkflowAction } from '@/server/process-studio-actions';
import { requireStudio, studioRead } from '@/server/studio-pages';
import { webProductPorts } from '@/server/product-ports';
export const metadata = { title: 'Workflow definition | Ensemus' };
export default async function WorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; draftId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, draftId } = await params,
    { database, context } = await requireStudio(organizationId),
    ports = webProductPorts();
  const [draft, catalog, runs, reviews, people] = await Promise.all([
    studioRead(getProcessDraft(database, context, ports, draftId)),
    loadProcessCatalog(context, ports),
    studioRead(listSimulations(database, context, { subject: { kind: 'process_draft', draftId } })),
    studioRead(
      listPublishReviews(database, context, { subjectKind: 'process_draft', subjectId: draftId }),
    ),
    listDirectory(database, context),
  ]);
  const choices = workflowChoiceData(
      catalog,
      catalog.agents === null ? [] : await listAgentRegistry(database, context),
    ),
    base = `/o/${organizationId}/studio`,
    path = `${base}/workflows/${draft.id}`,
    owner = people.find((p) => p.membershipId === draft.ownerMembershipId);
  const unavailableReference = draft.graph.nodes.some(
    (node) =>
      (node.kind === 'agent_task' &&
        !choices.agents?.some((a) => a.id === node.agentDefinitionId)) ||
      (node.kind === 'external_action' && !choices.tools?.some((t) => t.id === node.toolId)),
  );
  const missingManager = draft.graph.nodes.some(
    (node) => node.kind === 'human_approval' && node.approverRole === 'starter_manager',
  );
  const ready = Boolean(
    draft.status !== 'archived' &&
    draft.specSha256 &&
    !draft.issues.length &&
    !unavailableReference &&
    !missingManager &&
    owner?.status === 'active',
  );
  const elevated = workflowNeedsIndependentReview(draft.graph, draft.classification);
  const reviewers = people.filter(
    (person) =>
      person.status === 'active' &&
      canProduct(person.role, 'studio.review') &&
      canReadRecord(draft, { membershipId: person.membershipId, role: person.role }) &&
      (!elevated || person.membershipId !== context.membershipId),
  );
  const passed = ready
    ? runs.filter(
        (run) =>
          run.status === 'passed' &&
          run.subjectSha256 === draft.specSha256 &&
          run.scenarioKey === 'standard.process' &&
          run.report?.outcome === 'passed' &&
          run.report.subjectSha256 === draft.specSha256 &&
          run.report.scenarioKey === 'standard.process',
      )
    : [];
  const openReview = reviews.find(
    (review) => review.status === 'pending' || review.status === 'approved',
  );
  return (
    <OneActionAtATime>
      <BackLink href={`${base}/workflows`}>Workflow drafts</BackLink>
      <PageHead
        title={draft.name}
        description="Check the steps, rehearse the workflow with made-up examples, then ask a colleague to review it. Nothing here starts real work."
      />
      <ErrorNotice code={(await searchParams).error} />
      <div className="detail-layout">
        <div className="stack">
          <section className="card" aria-labelledby="workflow-snapshot">
            <h2 id="workflow-snapshot">Steps</h2>
            <WorkflowIssues graph={draft.graph} issues={draft.issues} />
            {!draft.specSha256 && !draft.issues.length && (
              <p className="notice gap-above">
                Something it relies on has changed since it was saved. Save it again before you
                rehearse it.
              </p>
            )}
            {unavailableReference && (
              <p className="notice gap-above">
                An assistant or outside action in this workflow is no longer offered. It stays
                selected so you can see it; choose one that is available before moving on.
              </p>
            )}
            {missingManager && (
              <p className="notice gap-above">
                One approval asks for the manager of the person who starts the work. Ensemus does
                not know who manages whom, so choose a different way to find the approver.
              </p>
            )}
            {catalog.agents === null && (
              <p className="muted gap-above">
                The list of assistants cannot be read right now. Workflows with only people in them
                can still be prepared.
              </p>
            )}
            {catalog.tools === null && (
              <p className="muted gap-above">
                The list of outside actions cannot be read right now, so none counts as ready.
              </p>
            )}
            <div className="gap-above-large">
              <WorkflowOverview graph={draft.graph} choices={choices} />
            </div>
            <div className="divided">
              <WorkflowMap
                draft={draft}
                layout={layoutWorkflowGraph(draft.graph)}
                id="saved-workflow-map"
                editHref={`${path}/edit`}
                readOnly={draft.status === 'archived'}
                organizationId={organizationId}
              />
            </div>
          </section>

          <section className="card" aria-labelledby="workflow-rehearsal">
            <h2 id="workflow-rehearsal">Rehearse it</h2>
            <p className="muted">
              A rehearsal walks through the saved steps with made-up facts. No AI model is called,
              nothing is sent and nothing outside Ensemus changes. It does not check that real
              connections are set up.
            </p>
            {ready ? (
              <form action={rehearseWorkflowAction} className="gap-above">
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="draftId" value={draft.id} />
                <input type="hidden" name="requestKey" value={randomUUID()} />
                <SubmitButton working="Requesting the fixed rehearsal">
                  Run the workflow rehearsal
                </SubmitButton>
              </form>
            ) : (
              <p className="muted gap-above">
                Once the steps pass every check and the responsible person is active, you can
                rehearse it here.
              </p>
            )}
            {runs.length ? (
              <ul className="list gap-above" aria-label="Recent workflow rehearsals">
                {runs.slice(0, 10).map((run) => (
                  <li key={run.id}>
                    <span>
                      <Link href={`${base}/simulations/${run.id}`}>
                        Rehearsal · {formatDateTime(run.createdAt)}
                      </Link>
                      <br />
                      <small>
                        {run.subjectSha256 === draft.specSha256
                          ? 'This version'
                          : 'An earlier version'}
                      </small>
                    </span>
                    <StatusBadge status={run.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted gap-above">No rehearsals yet.</p>
            )}
            <p className="link-line gap-above">
              <Link href={path}>Refresh rehearsal status</Link>
            </p>
          </section>

          <section className="card" aria-labelledby="workflow-review">
            <h2 id="workflow-review">Ask for a review</h2>
            <p className="muted">
              The reviewer sees exactly this version. Approving and publishing are separate steps,
              and neither starts the workflow.
            </p>
            {elevated && (
              <p className="notice gap-above">
                Because of who can see it, or because it uses assistants or outside actions, someone
                other than you has to review it. They need to be able to read this draft.
              </p>
            )}
            {openReview ? (
              <p className="gap-above">
                A review is already open.{' '}
                <Link href={`${base}/reviews/${openReview.id}`}>Open that review</Link> to read or
                close it before asking again.
              </p>
            ) : passed.length && reviewers.length ? (
              <form action={reviewWorkflowAction} className="fields gap-above">
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="draftId" value={draft.id} />
                <input type="hidden" name="requestKey" value={randomUUID()} />
                <label htmlFor="workflow-passed-run">Passed rehearsal to show the reviewer</label>
                <select id="workflow-passed-run" name="simulationId" required>
                  {passed.map((run) => (
                    <option value={run.id} key={run.id}>
                      {formatDateTime(run.createdAt)} · Passed
                    </option>
                  ))}
                </select>
                <label htmlFor="workflow-named-reviewer">
                  <span id="workflow-named-reviewer-label">Named reviewer</span>
                  <small id="workflow-named-reviewer-help">
                    To change the reviewer later, cancel the review and ask again.
                  </small>
                  <select
                    id="workflow-named-reviewer"
                    name="reviewerMembershipId"
                    required
                    aria-labelledby="workflow-named-reviewer-label"
                    aria-describedby="workflow-named-reviewer-help"
                  >
                    {reviewers.map((person) => (
                      <option key={person.membershipId} value={person.membershipId}>
                        {person.name}
                        {person.membershipId === context.membershipId
                          ? ' (you, standard reviews only)'
                          : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <SubmitButton working="Requesting human review">
                    Request review of this workflow
                  </SubmitButton>
                </div>
              </form>
            ) : (
              <p className="muted gap-above">
                {!passed.length
                  ? 'Run a rehearsal of this version first. Once it passes, you can ask for a review.'
                  : 'Nobody else who can review it is able to read this draft yet. Keep it private until someone can.'}
              </p>
            )}
            {reviews.length > 0 && (
              <ul className="list gap-above" aria-label="Recent workflow reviews">
                {reviews.slice(0, 5).map((review) => (
                  <li key={review.id}>
                    <Link href={`${base}/reviews/${review.id}`}>
                      Review requested {formatDateTime(review.createdAt)}
                    </Link>
                    <StatusBadge status={review.status} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="card" aria-labelledby="workflow-summary">
          <div className="spread">
            <h2 id="workflow-summary">Summary</h2>
            <StatusBadge status={draft.status} />
          </div>
          <dl className="details gap-above-small">
            <div>
              <dt>Responsible person</dt>
              <dd>
                {owner?.name ?? 'No longer listed'}
                {owner && owner.status !== 'active' ? ' (no longer active)' : ''}
              </dd>
            </div>
            <div>
              <dt>Who can see this</dt>
              <dd>
                <ClassificationBadge value={draft.classification} />
              </dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{draft.version}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{formatDateTime(draft.updatedAt)}</dd>
            </div>
          </dl>
          {draft.status !== 'archived' && (
            <div className="divided">
              <ActionLink href={`${path}/edit`} variant="secondary">
                Edit workflow
              </ActionLink>
              <p className="muted gap-above-small">
                <small>
                  Saving changes closes open reviews. Published versions stay as they are.
                </small>
              </p>
            </div>
          )}
          <details className="divided">
            <summary>Technical details</summary>
            <dl className="details gap-above-small">
              <div>
                <dt>Definition fingerprint</dt>
                <dd>
                  <code>{draft.specSha256 ?? 'Not compiled'}</code>
                </dd>
              </div>
              <div>
                <dt>Responsible membership</dt>
                <dd>
                  <code>{draft.ownerMembershipId}</code>
                </dd>
              </div>
              <div>
                <dt>Draft identifier</dt>
                <dd>
                  <code>{draft.id}</code>
                </dd>
              </div>
            </dl>
          </details>
        </aside>
      </div>
    </OneActionAtATime>
  );
}
