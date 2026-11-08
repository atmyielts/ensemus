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
  Empty,
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
        description="The saved work, connections, approvals and evidence requirements. Nothing starts from this page without a separate authorized request."
        actions={
          draft.status !== 'archived' ? (
            <ActionLink href={`${path}/edit`} variant="secondary">
              Edit workflow
            </ActionLink>
          ) : undefined
        }
      />
      <ErrorNotice code={(await searchParams).error} />
      <section className="card fields" aria-labelledby="workflow-snapshot">
        <div className="row">
          <h2 id="workflow-snapshot">Saved definition</h2>
          <StatusBadge status={draft.status} />
        </div>
        <dl className="details">
          <div>
            <dt>Responsible person</dt>
            <dd>
              {owner?.name ?? 'The recorded responsible person is no longer listed'}
              {owner && owner.status !== 'active' ? ' (currently inactive)' : ''}
            </dd>
          </div>
          <div>
            <dt>Sensitivity</dt>
            <dd>
              <ClassificationBadge value={draft.classification} />
            </dd>
          </div>
          <div>
            <dt>Source revision</dt>
            <dd>{draft.version}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatDateTime(draft.updatedAt)}</dd>
          </div>
        </dl>
        <WorkflowIssues graph={draft.graph} issues={draft.issues} />
        {!draft.specSha256 && !draft.issues.length && (
          <p className="notice">
            The current catalog no longer matches the stored hash. Save the definition under the
            current catalog before requesting another rehearsal.
          </p>
        )}
        {unavailableReference && (
          <p className="notice">
            A saved assistant or outside action is not currently offered. Its selection is
            preserved. Correct the reference or restore an actual active publication before moving
            forward.
          </p>
        )}
        {missingManager && (
          <p className="notice">
            This definition asks for an initiating person’s manager. No manager relationship is
            recorded in this product, so that approval cannot be resolved here. Choose a supported
            approval route.
          </p>
        )}
        {catalog.agents === null && (
          <p className="muted">
            The assistant catalog is unavailable. Human-only workflows can still be prepared.
          </p>
        )}
        {catalog.tools === null && (
          <p className="muted">
            The outside-action catalog is unavailable. No outside-action readiness is assumed.
          </p>
        )}
        <WorkflowMap
          draft={draft}
          layout={layoutWorkflowGraph(draft.graph)}
          id="saved-workflow-map"
          editHref={`${path}/edit`}
          readOnly={draft.status === 'archived'}
          organizationId={organizationId}
        />
        <details>
          <summary>Point requirements and saved choices</summary>
          <WorkflowOverview graph={draft.graph} choices={choices} />
        </details>
        <details>
          <summary>Snapshot identity</summary>
          <dl className="details">
            <div>
              <dt>Definition hash</dt>
              <dd>
                <code>{draft.specSha256 ?? 'No current compiled snapshot'}</code>
              </dd>
            </div>
            <div>
              <dt>Responsible membership</dt>
              <dd>
                <code>{draft.ownerMembershipId}</code>
              </dd>
            </div>
            <div>
              <dt>Draft identity</dt>
              <dd>
                <code>{draft.id}</code>
              </dd>
            </div>
          </dl>
        </details>
      </section>
      <section className="card fields" aria-labelledby="workflow-rehearsal">
        <h2 id="workflow-rehearsal">Rehearse the saved definition</h2>
        <p>
          The standard workflow scenario walks the actual compiled steps using fixed synthetic
          facts. It calls no model, sends nothing and performs no outside action. It does not
          qualify a real provider or prove that live connections are configured.
        </p>
        {ready ? (
          <form action={rehearseWorkflowAction}>
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="draftId" value={draft.id} />
            <input type="hidden" name="requestKey" value={randomUUID()} />
            <SubmitButton working="Requesting the fixed rehearsal">
              Run the workflow rehearsal
            </SubmitButton>
          </form>
        ) : (
          <p className="muted">
            Resolve the current compilation, reference and responsible-person issues before using
            the publication rehearsal flow.
          </p>
        )}
        {runs.length ? (
          <ul className="list" aria-label="Recent workflow rehearsals">
            {runs.slice(0, 10).map((run) => (
              <li key={run.id}>
                <div>
                  <Link href={`${base}/simulations/${run.id}`}>
                    Workflow rehearsal · {formatDateTime(run.createdAt)}
                  </Link>
                  <p className="muted">
                    {run.subjectSha256 === draft.specSha256
                      ? 'Matches the saved definition hash'
                      : 'Earlier definition snapshot'}
                  </p>
                </div>
                <StatusBadge status={run.status} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No rehearsal has been requested for this workflow.</Empty>
        )}
        <Link href={path}>Refresh rehearsal status</Link>
      </section>
      <section className="card fields" aria-labelledby="workflow-review">
        <h2 id="workflow-review">Request human review</h2>
        <p>
          A review freezes this name, responsible person, revision and definition hash. Approval and
          publication remain separate decisions; neither starts a workflow run.
        </p>
        {elevated && (
          <p className="notice">
            This definition needs an independent reviewer because of its sensitivity, assistant use
            or outside actions. That person must already be permitted to read the draft.
          </p>
        )}
        {openReview ? (
          <p>
            A review is already open.{' '}
            <Link href={`${base}/reviews/${openReview.id}`}>Read or close that review</Link> before
            requesting another.
          </p>
        ) : passed.length && reviewers.length ? (
          <form action={reviewWorkflowAction} className="fields">
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="draftId" value={draft.id} />
            <input type="hidden" name="requestKey" value={randomUUID()} />
            <label htmlFor="workflow-passed-run">
              Passed standard rehearsal for the saved hash
            </label>
            <select id="workflow-passed-run" name="simulationId" required>
              {passed.map((run) => (
                <option value={run.id} key={run.id}>
                  {formatDateTime(run.createdAt)} · Fixed standard scenario passed
                </option>
              ))}
            </select>
            <label htmlFor="workflow-named-reviewer">Named reviewer</label>
            <select id="workflow-named-reviewer" name="reviewerMembershipId" required>
              {reviewers.map((person) => (
                <option key={person.membershipId} value={person.membershipId}>
                  {person.name}
                  {person.membershipId === context.membershipId
                    ? ' (you; standard-risk review only)'
                    : ''}
                </option>
              ))}
            </select>
            <p className="muted">
              The exact source, rehearsal and current reviewer authority are checked again on
              submit. A named reviewer is fixed for that review; cancel it to request a different
              reviewer.
            </p>
            <div>
              <SubmitButton working="Requesting human review">
                Request review of this workflow
              </SubmitButton>
            </div>
          </form>
        ) : (
          <p className="muted">
            {!passed.length
              ? 'A passed standard rehearsal of the current saved definition is needed first.'
              : 'There is no eligible independent reader under this draft’s current access rules. Keep it private until an approved review-access path is available.'}
          </p>
        )}
        {reviews.length > 0 && (
          <ul className="list" aria-label="Recent workflow reviews">
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
    </OneActionAtATime>
  );
}
