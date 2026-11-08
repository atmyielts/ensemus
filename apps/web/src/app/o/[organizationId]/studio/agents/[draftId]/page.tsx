import { randomUUID } from 'node:crypto';
import { AppError } from '@ensemus/application';
import { getAgentDraft, assessAgentDraft, getAgentDraftChoices } from '@ensemus/application/agent-drafts';
import { listSimulations } from '@ensemus/application/simulations';
import { listPublishReviews } from '@ensemus/application/publish-reviews';
import { applicableAgentScenarios, requiredAgentScenarioKey } from '@ensemus/domain/simulation';
import { usdTextFromMicros } from '@ensemus/domain/agent-draft';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import { ActionLink, BackLink, Empty, ErrorNotice, PageHead, StatusBadge, formatDateTime } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { requireStudio, studioRead } from '@/server/studio-pages';
import { webProductPorts } from '@/server/product-ports';
import { simulateAgentAction, requestStudioReviewAction } from '@/server/studio-actions';
import { studioRiskText, studioScenarioName, studioToolName } from '@/lib/studio-present';

export const metadata = { title: 'Assistant draft | Ensemus' };
const issueText = {
  REQUIRED: 'Complete the required answer.',
  UNKNOWN_TOOL: 'A selected tool is not supported by the current catalog.',
  TOOL_NEEDS_APPROVAL_MODE: 'An outside-action tool needs approval mode.',
  SECRET_TOOL_REFUSED: 'A tool that exposes secrets cannot be selected.',
  LIMIT_TOO_HIGH: 'A run limit exceeds the current policy.',
  NO_BUDGET: 'Choose an explicit permitted spending limit.',
  RESTRICTED_NOT_OFFERED: 'Restricted data is not offered to this assistant.',
};

export default async function AgentDraftPage({ params, searchParams }: {
  params: Promise<{ organizationId: string; draftId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, draftId } = await params;
  const { database, context } = await requireStudio(organizationId);
  const draft = await studioRead(getAgentDraft(database, context, draftId));
  const ports = webProductPorts(), base = `/o/${organizationId}/studio`;
  const [choices, runs, reviews] = await Promise.all([
    studioRead(getAgentDraftChoices(database, context, draft.ownerMembershipId, draft.answers.knowledgeSourceIds)),
    studioRead(listSimulations(database, context, { subject: { kind: 'agent_draft', draftId: draft.id } })),
    studioRead(listPublishReviews(database, context, { subjectKind: 'agent_draft', subjectId: draft.id })),
  ]);
  let assessment: Awaited<ReturnType<typeof assessAgentDraft>> | null = null;
  let unavailable = false;
  try {
    assessment = await assessAgentDraft(context, ports, draft.answers);
  } catch (error) {
    if (error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE') unavailable = true;
    else throw error;
  }
  const savedOwner = choices.people.find(person => person.id === draft.ownerMembershipId);
  const missingSources = draft.answers.knowledgeSourceIds.filter(id => !choices.sources.some(source => source.id === id));
  const requiredScenario = assessment?.spec ? requiredAgentScenarioKey(assessment.spec) : null;
  const scenarios = assessment?.spec ? applicableAgentScenarios(assessment.spec) : [];
  const ready = draft.status !== 'archived' && Boolean(draft.specSha256 && assessment?.spec && !assessment.issues.length && savedOwner && !missingSources.length);
  const qualifyingRuns = ready && requiredScenario ? runs.filter(run => run.subjectSha256 === draft.specSha256 && run.scenarioKey === requiredScenario && run.status === 'passed' && run.report?.outcome === 'passed' && run.report.subjectSha256 === draft.specSha256 && run.report.scenarioKey === requiredScenario) : [];
  const elevated = assessment?.riskLevel === 'elevated';
  const reviewers = choices.people.filter(person => canProduct(person.role, 'studio.review') && (!elevated || person.id !== context.membershipId));
  const openReview = reviews.find(review => review.status === 'pending' || review.status === 'approved');
  return <OneActionAtATime>
    <BackLink href={`${base}/agents`}>Assistant drafts</BackLink>
    <PageHead title={draft.name} description="A saved definition for a person to rehearse and review. Editing or publishing it does not start a run." />
    <ErrorNotice code={(await searchParams).error} />
    <section className="card fields" aria-labelledby="saved-assistant">
      <div className="row"><h2 id="saved-assistant">Saved answers</h2><StatusBadge status={draft.status} /></div>
      <p className="muted">Revision {draft.version} · Updated {formatDateTime(draft.updatedAt)}</p>
      <dl className="details">
        <div><dt>Responsible person</dt><dd>{savedOwner?.name ?? 'The previously selected person is no longer active'}</dd></div>
        <div><dt>Role and purpose</dt><dd>{draft.answers.role}</dd></div>
        <div><dt>Intended result</dt><dd>{draft.answers.intendedOutcome}</dd></div>
        <div><dt>Behavior</dt><dd>{draft.answers.autonomy === 'suggest_only' ? 'Suggestions for a person' : draft.answers.autonomy === 'draft_for_review' ? 'Drafts for a person to review' : 'Actions proposed for a person to approve'}</dd></div>
        <div><dt>Spending limit</dt><dd>{draft.answers.maxCostMicros === null ? 'Not set; this is not ready to run' : `USD ${usdTextFromMicros(draft.answers.maxCostMicros)} maximum per run. This is a limit, not a measured charge.`}</dd></div>
      </dl>
      <h3>Boundaries</h3>{draft.answers.boundaries.length ? <ul>{draft.answers.boundaries.map((boundary, index) => <li key={index}>{boundary}</li>)}</ul> : <p>No additional written boundaries.</p>}
      <h3>Selected permissions</h3><ul>{draft.answers.toolIds.map(id => <li key={id}>{studioToolName(id)}</li>)}</ul>
      <p className="notice">No model or provider has been qualified by saving this definition. Current access, model policy and budget still decide whether a later run can start.</p>
      <details><summary>Saved snapshot details</summary><dl className="details"><div><dt>Definition hash</dt><dd><code>{draft.specSha256 ?? 'No compiled snapshot'}</code></dd></div><div><dt>Draft identifier</dt><dd><code>{draft.id}</code></dd></div></dl></details>
    </section>
    <section className="card fields" aria-labelledby="assistant-assessment">
      <h2 id="assistant-assessment">Current boundary assessment</h2>
      {unavailable ? <Empty>The rule catalog or policy reader is not available here. This is not a passing assessment.</Empty> : assessment?.issues.length ? <ul>{assessment.issues.map((issue, index) => <li key={index}>{issueText[issue.code]} <small>Answer: {issue.path}</small></li>)}</ul> : <p>The saved answers satisfy the currently available builder rules. This checks configuration, not real model quality.</p>}
      {assessment?.risk.length ? <ul>{assessment.risk.map((risk, index) => <li key={index}>{studioRiskText(risk)}</li>)}</ul> : null}
      {elevated && <p className="notice">A different eligible person must decide this publication review.</p>}
      {ready && <p>The saved definition has a compiled snapshot and current available references for a rehearsal.</p>}
      {!draft.specSha256 && !unavailable && <p className="notice">This saved revision has no compiled snapshot. Correct the answers and save them under the current policy before requesting a rehearsal.</p>}
      {missingSources.length > 0 && <p className="notice">Some saved source selections are not currently available. Their private titles and classes are hidden. Explicitly remove the unavailable selections in the form or restore access before saving.</p>}
      {!savedOwner && <p className="notice">The responsible person must be active before this definition can move forward.{draft.agentDefinitionId ? ' A published assistant keeps its recorded responsible person; restore that membership or create a separate assistant.' : ' Choose an active responsible person when editing the saved answers.'}</p>}
    </section>
    <section className="card fields" aria-labelledby="assistant-rehearsal">
      <h2 id="assistant-rehearsal">Rehearse the rules</h2>
      <p>These fixed synthetic scenarios call no real model, send no email and make no outside changes. A passed scenario does not qualify a provider.</p>
      {ready && scenarios.length ? <form action={simulateAgentAction} className="fields">
        <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="draftId" value={draft.id} /><input type="hidden" name="requestKey" value={randomUUID()} />
        <label htmlFor="assistant-scenario">Scenario</label><select id="assistant-scenario" name="scenarioKey" defaultValue={requiredScenario ?? undefined}>{scenarios.map(scenario => <option key={scenario.key} value={scenario.key}>{studioScenarioName(scenario.key)}{scenario.key === requiredScenario ? ' — required for review' : ''}</option>)}</select>
        <div><SubmitButton working="Requesting the rehearsal">Run this rehearsal</SubmitButton></div>
      </form> : <p className="muted">Save a complete definition with current available references before requesting a rehearsal.</p>}
      {runs.length ? <ul className="list" aria-label="Recent rehearsals">{runs.slice(0, 10).map(run => <li key={run.id}><div><Link href={`${base}/simulations/${run.id}`}>{studioScenarioName(run.scenarioKey)}</Link><p className="muted">{formatDateTime(run.createdAt)} · {run.subjectSha256 === draft.specSha256 ? 'Matches the saved definition hash' : 'Earlier definition snapshot'}</p></div><StatusBadge status={run.status} /></li>)}</ul> : <Empty>No rehearsal has been requested for this draft.</Empty>}
      <Link href={`${base}/agents/${draft.id}`}>Refresh rehearsal status</Link>
    </section>
    <section className="card fields" aria-labelledby="assistant-review">
      <h2 id="assistant-review">Request a human review</h2>
      <p>A review freezes the saved name, responsible person and definition snapshot. It does not publish or start anything.</p>
      {openReview ? <p>A review is already open. <Link href={`${base}/reviews/${openReview.id}`}>Read or close that review</Link> before requesting another.</p> : qualifyingRuns.length && reviewers.length ? <form action={requestStudioReviewAction} className="fields">
        <input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="draftId" value={draft.id} /><input type="hidden" name="requestKey" value={randomUUID()} />
        <label htmlFor="assistant-passed-rehearsal">Passed rehearsal for the saved definition</label><select id="assistant-passed-rehearsal" name="simulationId" required>{qualifyingRuns.map(run => <option key={run.id} value={run.id}>{studioScenarioName(run.scenarioKey)} · {formatDateTime(run.createdAt)}</option>)}</select>
        <label htmlFor="assistant-reviewer">Named reviewer</label><select id="assistant-reviewer" name="reviewerMembershipId" required>{reviewers.map(person => <option key={person.id} value={person.id}>{person.name}{person.id === context.membershipId ? ' (you; standard-risk review only)' : ''}</option>)}</select>
        <p className="muted">The server checks the current snapshot, scenario and reviewer again. The named reviewer cannot be changed on an open review; cancel and request a new one to reassign it.</p>
        <div><SubmitButton working="Requesting review">Request review of this snapshot</SubmitButton></div>
      </form> : <p className="muted">{!qualifyingRuns.length ? 'A passed required scenario for the current saved definition is needed first.' : 'No other active owner or administrator can review this elevated-risk definition. Invite an eligible independent reviewer before continuing.'}</p>}
      {reviews.length > 0 && <ul className="list" aria-label="Recent publication reviews">{reviews.slice(0, 5).map(review => <li key={review.id}><Link href={`${base}/reviews/${review.id}`}>Review requested {formatDateTime(review.createdAt)}</Link><StatusBadge status={review.status} /></li>)}</ul>}
    </section>
    {draft.status !== 'archived' && !unavailable && <section className="card fields"><h2>Edit the saved answers</h2><p>Saving changes cancels open reviews and requires a rehearsal of the new snapshot. Published runs keep their pinned version. Unavailable saved sources and tools must be explicitly removed in the edit form.</p><div><ActionLink href={`${base}/agents/${draft.id}/edit`} variant="secondary">Edit this draft</ActionLink></div></section>}
  </OneActionAtATime>;
}
