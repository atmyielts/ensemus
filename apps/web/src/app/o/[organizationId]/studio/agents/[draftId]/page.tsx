import { randomUUID } from 'node:crypto';
import { AppError } from '@ensemus/application';
import {
  getAgentDraft,
  assessAgentDraft,
  getAgentDraftChoices,
} from '@ensemus/application/agent-drafts';
import { listSimulations } from '@ensemus/application/simulations';
import { listPublishReviews } from '@ensemus/application/publish-reviews';
import { applicableAgentScenarios, requiredAgentScenarioKey } from '@ensemus/domain/simulation';
import { usdTextFromMicros } from '@ensemus/domain/agent-draft';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import {
  ActionLink,
  BackLink,
  ErrorNotice,
  PageHead,
  StatusBadge,
  formatDateTime,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { requireStudio, studioRead } from '@/server/studio-pages';
import { webProductPorts } from '@/server/product-ports';
import { simulateAgentAction, requestStudioReviewAction } from '@/server/studio-actions';
import { studioRiskText, studioScenarioName } from '@/lib/studio-present';
import { toolName } from '@/components/studio/tool-words';

export const metadata = { title: 'Assistant draft | Ensemus' };
const issueText = {
  REQUIRED: 'An answer that is needed is still empty.',
  UNKNOWN_TOOL: 'One of its abilities is no longer offered.',
  TOOL_NEEDS_APPROVAL_MODE:
    'An ability that changes things outside Ensemus needs “Propose actions for approval”.',
  SECRET_TOOL_REFUSED: 'An ability that could reveal passwords or keys cannot be chosen.',
  LIMIT_TOO_HIGH: 'A limit is higher than your organization allows.',
  NO_BUDGET: 'Choose how much it may spend per run.',
  RESTRICTED_NOT_OFFERED: 'Restricted material is not offered to this assistant.',
};

export default async function AgentDraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; draftId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, draftId } = await params;
  const { database, context } = await requireStudio(organizationId);
  const draft = await studioRead(getAgentDraft(database, context, draftId));
  const ports = webProductPorts(),
    base = `/o/${organizationId}/studio`;
  const [choices, runs, reviews] = await Promise.all([
    studioRead(
      getAgentDraftChoices(
        database,
        context,
        draft.ownerMembershipId,
        draft.answers.knowledgeSourceIds,
      ),
    ),
    studioRead(
      listSimulations(database, context, { subject: { kind: 'agent_draft', draftId: draft.id } }),
    ),
    studioRead(
      listPublishReviews(database, context, { subjectKind: 'agent_draft', subjectId: draft.id }),
    ),
  ]);
  let assessment: Awaited<ReturnType<typeof assessAgentDraft>> | null = null;
  let unavailable = false;
  try {
    assessment = await assessAgentDraft(context, ports, draft.answers);
  } catch (error) {
    if (error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE') unavailable = true;
    else throw error;
  }
  const savedOwner = choices.people.find((person) => person.id === draft.ownerMembershipId);
  const missingSources = draft.answers.knowledgeSourceIds.filter(
    (id) => !choices.sources.some((source) => source.id === id),
  );
  const requiredScenario = assessment?.spec ? requiredAgentScenarioKey(assessment.spec) : null;
  const scenarios = assessment?.spec ? applicableAgentScenarios(assessment.spec) : [];
  const ready =
    draft.status !== 'archived' &&
    Boolean(
      draft.specSha256 &&
      assessment?.spec &&
      !assessment.issues.length &&
      savedOwner &&
      !missingSources.length,
    );
  const qualifyingRuns =
    ready && requiredScenario
      ? runs.filter(
          (run) =>
            run.subjectSha256 === draft.specSha256 &&
            run.scenarioKey === requiredScenario &&
            run.status === 'passed' &&
            run.report?.outcome === 'passed' &&
            run.report.subjectSha256 === draft.specSha256 &&
            run.report.scenarioKey === requiredScenario,
        )
      : [];
  const elevated = assessment?.riskLevel === 'elevated';
  const reviewers = choices.people.filter(
    (person) =>
      canProduct(person.role, 'studio.review') && (!elevated || person.id !== context.membershipId),
  );
  const openReview = reviews.find(
    (review) => review.status === 'pending' || review.status === 'approved',
  );
  const editable = draft.status !== 'archived' && !unavailable;
  return (
    <OneActionAtATime>
      <BackLink href={`${base}/agents`}>Assistant drafts</BackLink>
      <PageHead
        title={draft.name}
        description="Check what you described, rehearse it with made-up examples, then ask a colleague to review it. Nothing here starts the assistant."
      />
      <ErrorNotice code={(await searchParams).error} />
      <div className="detail-layout">
        <div className="stack">
          <section className="card" aria-labelledby="saved-assistant">
            <h2 id="saved-assistant">What it does</h2>
            <dl className="details">
              <div>
                <dt>What it helps with</dt>
                <dd>{draft.answers.role}</dd>
              </div>
              <div>
                <dt>A good result contains</dt>
                <dd>{draft.answers.intendedOutcome}</dd>
              </div>
              <div>
                <dt>How it works</dt>
                <dd>
                  {draft.answers.autonomy === 'suggest_only'
                    ? 'Makes suggestions for a person'
                    : draft.answers.autonomy === 'draft_for_review'
                      ? 'Prepares drafts for a person to review'
                      : 'Proposes actions for a person to approve'}
                </dd>
              </div>
            </dl>
            <h3 className="gap-above-large">What it must avoid</h3>
            {draft.answers.boundaries.length ? (
              <ul>
                {draft.answers.boundaries.map((boundary, index) => (
                  <li key={index}>{boundary}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">No extra rules written down.</p>
            )}
            <h3 className="gap-above">What it may do</h3>
            {draft.answers.toolIds.length ? (
              <ul>
                {draft.answers.toolIds.map((id) => (
                  <li key={id}>{toolName(id)}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">Read and answer only.</p>
            )}
            <details className="gap-above">
              <summary>Technical details</summary>
              <dl className="details gap-above-small">
                <div>
                  <dt>Definition fingerprint</dt>
                  <dd>
                    <code>{draft.specSha256 ?? 'Not compiled yet'}</code>
                  </dd>
                </div>
                <div>
                  <dt>Draft identifier</dt>
                  <dd>
                    <code>{draft.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>Abilities</dt>
                  <dd>
                    {draft.answers.toolIds.length ? (
                      <code>{draft.answers.toolIds.join(', ')}</code>
                    ) : (
                      'None'
                    )}
                  </dd>
                </div>
              </dl>
            </details>
          </section>

          <section className="card" aria-labelledby="assistant-assessment">
            <h2 id="assistant-assessment">Checks</h2>
            {unavailable ? (
              <p className="notice warn">
                The checks cannot run here right now, so this draft has not passed them. Try again
                later.
              </p>
            ) : assessment?.issues.length ? (
              <>
                <p>Fix these in the draft before you rehearse it:</p>
                <ul>
                  {assessment.issues.map((issue, index) => (
                    <li key={index}>
                      {issueText[issue.code]} <small>({issue.path})</small>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>
                Your answers follow the builder’s rules. This checks the set-up, not how well the AI
                model will do.
              </p>
            )}
            {assessment?.risk.length ? (
              <>
                <h3 className="gap-above">Worth knowing</h3>
                <ul>
                  {assessment.risk.map((risk, index) => (
                    <li key={index}>{studioRiskText(risk)}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {elevated && (
              <p className="notice gap-above">
                Because of what it may do, someone other than you has to review it.
              </p>
            )}
            {!draft.specSha256 && !unavailable && (
              <p className="notice gap-above">
                This version could not be prepared for a rehearsal. Correct the answers and save
                them again.
              </p>
            )}
            {missingSources.length > 0 && (
              <p className="notice gap-above">
                Some Knowledge sources it was given are no longer available to you, so their names
                are hidden. Untick them in the draft, or ask for access again, before saving.
              </p>
            )}
            {!savedOwner && (
              <p className="notice gap-above">
                The responsible person is no longer active.
                {draft.agentDefinitionId
                  ? ' A published assistant keeps its responsible person: restore their membership or create a separate assistant.'
                  : ' Choose someone active when you edit the draft.'}
              </p>
            )}
          </section>

          <section className="card" aria-labelledby="assistant-rehearsal">
            <h2 id="assistant-rehearsal">Rehearse it</h2>
            <p className="muted">
              A rehearsal plays a made-up example against your rules. No AI model is called, no
              email is sent and nothing outside Ensemus changes.
            </p>
            {ready && scenarios.length ? (
              <form action={simulateAgentAction} className="inline-form gap-above">
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="draftId" value={draft.id} />
                <input type="hidden" name="requestKey" value={randomUUID()} />
                <label htmlFor="assistant-scenario">
                  Example to play
                  <select
                    id="assistant-scenario"
                    name="scenarioKey"
                    defaultValue={requiredScenario ?? undefined}
                  >
                    {scenarios.map((scenario) => (
                      <option key={scenario.key} value={scenario.key}>
                        {studioScenarioName(scenario.key)}
                        {scenario.key === requiredScenario ? ' (needed for review)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <SubmitButton working="Requesting the rehearsal">Run this rehearsal</SubmitButton>
              </form>
            ) : (
              <p className="muted">Once the checks above pass, you can rehearse it here.</p>
            )}
            {runs.length ? (
              <ul className="list gap-above" aria-label="Recent rehearsals">
                {runs.slice(0, 10).map((run) => (
                  <li key={run.id}>
                    <span>
                      <Link href={`${base}/simulations/${run.id}`}>
                        {studioScenarioName(run.scenarioKey)}
                      </Link>
                      <br />
                      <small>
                        {formatDateTime(run.createdAt)} ·{' '}
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
              <Link href={`${base}/agents/${draft.id}`}>Refresh rehearsal status</Link>
            </p>
          </section>

          <section className="card" aria-labelledby="assistant-review">
            <h2 id="assistant-review">Ask for a review</h2>
            <p className="muted">
              The reviewer sees exactly this version. Approving it does not publish or start
              anything.
            </p>
            {openReview ? (
              <p className="gap-above">
                A review is already open.{' '}
                <Link href={`${base}/reviews/${openReview.id}`}>Open that review</Link> to read or
                close it before asking again.
              </p>
            ) : qualifyingRuns.length && reviewers.length ? (
              <form action={requestStudioReviewAction} className="fields gap-above">
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="draftId" value={draft.id} />
                <input type="hidden" name="requestKey" value={randomUUID()} />
                <label htmlFor="assistant-passed-rehearsal">
                  Passed rehearsal to show the reviewer
                </label>
                <select id="assistant-passed-rehearsal" name="simulationId" required>
                  {qualifyingRuns.map((run) => (
                    <option key={run.id} value={run.id}>
                      {studioScenarioName(run.scenarioKey)} · {formatDateTime(run.createdAt)}
                    </option>
                  ))}
                </select>
                <label htmlFor="assistant-reviewer">
                  <span id="assistant-reviewer-label">Named reviewer</span>
                  <small id="assistant-reviewer-help">
                    To change the reviewer later, cancel the review and ask again.
                  </small>
                  <select
                    id="assistant-reviewer"
                    name="reviewerMembershipId"
                    required
                    aria-labelledby="assistant-reviewer-label"
                    aria-describedby="assistant-reviewer-help"
                  >
                    {reviewers.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                        {person.id === context.membershipId ? ' (you, standard reviews only)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <SubmitButton working="Requesting review">
                    Request review of this snapshot
                  </SubmitButton>
                </div>
              </form>
            ) : (
              <p className="muted gap-above">
                {!qualifyingRuns.length
                  ? 'Run the rehearsal marked “needed for review” on this version first.'
                  : 'Nobody else can review it yet. Invite another owner or administrator to review assistants like this one.'}
              </p>
            )}
            {reviews.length > 0 && (
              <ul className="list gap-above" aria-label="Recent publication reviews">
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

        <aside className="card" aria-labelledby="assistant-summary">
          <div className="spread">
            <h2 id="assistant-summary">Summary</h2>
            <StatusBadge status={draft.status} />
          </div>
          <dl className="details gap-above-small">
            <div>
              <dt>Responsible person</dt>
              <dd>{savedOwner?.name ?? 'No longer active'}</dd>
            </div>
            <div>
              <dt>Most it may spend per run</dt>
              <dd>
                {draft.answers.maxCostMicros === null
                  ? 'Not set yet'
                  : `USD ${usdTextFromMicros(draft.answers.maxCostMicros)}`}
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
          {editable && (
            <div className="divided">
              <ActionLink href={`${base}/agents/${draft.id}/edit`} variant="secondary">
                Edit this draft
              </ActionLink>
              <p className="muted gap-above-small">
                <small>
                  Saving changes closes open reviews and needs a new rehearsal. Published versions
                  stay as they are.
                </small>
              </p>
            </div>
          )}
          <p className="muted divided">
            <small>
              The spending limit is a ceiling, not a charge. Your organization’s model and budget
              settings still decide whether a run can start.
            </small>
          </p>
        </aside>
      </div>
    </OneActionAtATime>
  );
}
