import { randomUUID } from 'node:crypto';
import {
  getWorkDetail,
  getWorkTitle,
  listActionConnections,
  listDirectory,
  listExternalActions,
  listProjects,
  listWorkUnits,
} from '@ensemus/application';
import { can, canReadWork, type Classification } from '@ensemus/domain/policy';
import {
  allowedTransitions,
  canChangeContent,
  canDeleteFile,
  isApprovalOnlyTransition,
  isOverdue,
  isTerminal,
  unmetCriteria,
  type CompletionCriterion,
  type WorkState,
} from '@ensemus/domain/work-unit';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConfirmForm } from '@/components/confirm-form';
import { EditWorkForm } from '@/components/edit-work-form';
import { FileField } from '@/components/file-field';
import { DraftScope, KeptTextarea } from '@/components/kept-field';
import { LiveStatus } from '@/components/live-status';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { NewEmailForm } from '@/components/new-email-form';
import { ReceiptStatusBadge } from '@/components/receipt-status';
import { SubmitButton } from '@/components/submit-button';
import {
  ActionLink,
  BackLink,
  ClassificationBadge,
  Empty,
  ErrorNotice,
  formatBytes,
  formatDate,
  formatDateTime,
  PageHead,
  personLabel,
  StatusBadge,
  toDateInput,
} from '@/components/ui';
import { doneWhenSentence, evidenceSummary, planNote, reopenDraftName } from '@/lib/work-view';
import { getRuntime } from '@/server/runtime';
import { orNotFound, requireTenant } from '@/server/tenant';
import {
  addDependencyAction,
  assignAction,
  deleteArtifactAction,
  removeDependencyAction,
  removeStoppedHiddenPrerequisitesAction,
  requestReviewAction,
  runPlanAction,
  setOwnerAction,
  transitionWorkAction,
  unassignAction,
  uploadArtifactAction,
} from '@/server/work-actions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The work's own title in the browser tab, for someone who can read it. Anyone else gets a 404. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ organizationId: string; workUnitId: string }>;
}): Promise<Metadata> {
  const { organizationId, workUnitId } = await params;
  if (!UUID.test(workUnitId)) return { title: 'Work | Ensemus' };
  const { context, database } = await requireTenant(organizationId);
  const title = await getWorkTitle(database, context, workUnitId).catch(() => null);
  return { title: title ? `${title} | Ensemus` : 'Work | Ensemus' };
}

const STATE_NOTE: Record<WorkState, string> = {
  queued: 'This has not started, and nothing runs until someone starts it.',
  ready: 'This is ready, and nothing runs until someone starts it.',
  running: 'This is in progress.',
  blocked: 'This is blocked until someone clears the way and marks it ready.',
  awaiting_approval: 'This is paused while someone reviews it.',
  verifying: 'This is being checked.',
  completed: 'This is done.',
  failed: 'This did not finish. It can be tried again.',
  cancelled: 'This was stopped and cannot be restarted.',
};

const EVIDENCE: Record<CompletionCriterion['kind'], string> = {
  artifact_exists: 'Someone attaches a file',
  reviewer_approved: 'A reviewer approves this version',
  external_receipt: 'The outside system confirms it happened',
};

const TRANSITION_LABEL: Partial<Record<WorkState, string>> = {
  ready: 'Mark ready',
  running: 'Start',
  blocked: 'Mark blocked',
  verifying: 'Send for checking',
  completed: 'Mark done',
  failed: 'Mark failed',
};

const PRIMARY_ORDER: readonly WorkState[] = ['completed', 'verifying', 'running', 'ready'];

const ROLE_ON_WORK: Record<string, string> = { contributor: 'Contributor', reviewer: 'Reviewer' };

// Each sentence states what the permission rules in @ensemus/domain/policy actually do.
const WHO_CAN_SEE: Record<string, string> = {
  public: 'Everyone in this organization. Nothing in it is secret.',
  internal: 'Everyone in this organization.',
  confidential: 'Only the people on this work, plus organization owners and admins.',
  restricted: 'Only the people on this work. Owners and admins cannot see it.',
};

export default async function WorkDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; workUnitId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, workUnitId } = await params;
  const { error } = await searchParams;
  const { actor, context, database } = await requireTenant(organizationId);
  if (!UUID.test(workUnitId)) notFound();
  const detail = await orNotFound(getWorkDetail(database, context, workUnitId));
  const {
    work,
    ownerName,
    prerequisites,
    dependents,
    people,
    files,
    reviews,
    history,
    canChange,
    canManage,
  } = detail;

  const status = work.status as WorkState;
  const finished = isTerminal(status);
  const canAddDependency = canChange && (status === 'queued' || status === 'blocked');
  const [members, projects, candidates, externalActions, actionConnections] = await Promise.all([
    listDirectory(database, context),
    work.projectId ? listProjects(database, context) : [],
    canAddDependency ? listWorkUnits(database, context) : null,
    listExternalActions(database, context, { workUnitId: work.id }),
    listActionConnections(database, context),
  ]);
  const connectorsEnabled = getRuntime().config.connectorsEnabled;
  const senders = actionConnections.filter((connection) => connection.fromAddress);

  const base = `/o/${organizationId}`;
  const today = new Date();
  const now = today.getTime();
  const project = projects.find((p) => p.id === work.projectId);
  const nameOf = new Map(members.map((member) => [member.membershipId, member.name]));
  const active = members.filter((member) => member.status === 'active');
  const assigned = new Set(people.map((person) => person.membershipId));
  const newOwners = active.filter((m) => m.membershipId !== work.ownerMembershipId);
  const newContributors = newOwners.filter((m) => !assigned.has(m.membershipId));
  // Someone cannot approve their own request, and an approver has to be able to see the work. This
  // uses the same rule the service applies when the review is requested.
  const approvers = active.filter(
    (member) =>
      member.membershipId !== context.membershipId &&
      canReadWork(
        {
          classification: work.classification as Classification,
          ownerMembershipId: work.ownerMembershipId,
          isAssigned: assigned.has(member.membershipId),
        },
        { membershipId: member.membershipId, role: member.role },
      ),
  );

  const linked = new Set(prerequisites.map((p) => p.id));
  const dependencyOptions = (candidates?.items ?? []).filter(
    // Stopped work can never finish, so depending on it would block this forever.
    (item) => item.id !== work.id && !linked.has(item.id) && item.status !== 'cancelled',
  );

  // The evidence the service worked out, the same way it does when someone marks the work done.
  const criteria = work.completionCriteria as CompletionCriterion[];
  const unmet = unmetCriteria(criteria, detail.evidence);

  // This list only holds prerequisites this person can see, so an empty result does not prove there
  // are none outstanding. The service makes the real check when someone marks the work ready.
  const waitingOn = prerequisites.filter((p) => p.status !== 'completed');
  // Counted by the service, which can see what this person cannot. Never named.
  const hidden = detail.hiddenPrerequisites;
  const isHeldUp = waitingOn.length > 0 || hidden.unfinished > 0;
  const isOwner = work.ownerMembershipId === context.membershipId;
  const noEvidenceAsked = criteria.length === 0;
  const hasPlan = Boolean(work.executionPlan);
  const planHolds = Boolean(work.runId);
  const runRequested = Boolean(work.runRequestedAt);
  const canRunPlan = canChange && hasPlan && status === 'ready' && !runRequested;
  const needsReview = criteria.some((criterion) => criterion.kind === 'reviewer_approved');
  const whoDoesIt = planNote(status, { hasPlan, planHolds, runRequested });

  const openReview = reviews.find(
    (review) => review.status === 'pending' && review.expiresAt.getTime() > now,
  );
  // Time ran out, and the periodic check has not got to it yet.
  const overdueHold = reviews.some(
    (review) =>
      review.status === 'pending' && review.holdsWork && review.expiresAt.getTime() <= now,
  );
  const iReview = openReview?.approverMembershipId === context.membershipId;
  const canAskForReview = canChange && !finished && !planHolds && !openReview;

  const transitions = allowedTransitions(status);
  const buttons = transitions.filter(
    (to) =>
      // Only a decision on the approval releases work that is waiting for one.
      !isApprovalOnlyTransition(status, to) &&
      to !== 'cancelled' &&
      !(to === 'completed' && unmet.length > 0) &&
      // With nothing to check, only the person who answers for the work can say it is done.
      !(to === 'completed' && noEvidenceAsked && !isOwner) &&
      !(to === 'ready' && isHeldUp),
  );
  const canStop = canManage && transitions.includes('cancelled');
  const needsReason = status === 'completed' || status === 'failed';
  const primary = canRunPlan ? undefined : PRIMARY_ORDER.find((to) => buttons.includes(to));
  const labelFor = (to: WorkState) => {
    if (to === 'running' && status === 'verifying') return 'Back to in progress';
    if (to === 'running' && canRunPlan) return 'Start by hand';
    if (to === 'completed' && noEvidenceAsked) return 'Confirm this is done';
    return TRANSITION_LABEL[to];
  };

  const ids = (
    <>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="id" value={work.id} />
    </>
  );
  const versioned = (
    <>
      {ids}
      <input type="hidden" name="version" value={work.version} />
    </>
  );

  // Where the "done when" checks stand, said once in the summary and in full under Checks and reviews.
  const doneWhen = doneWhenSentence(criteria);
  const doneWhenState = evidenceSummary(status, criteria, detail.evidence);

  // Done or failed work goes round again only with a reason, kept in its history.
  const reasonForm = (
    <form className="fields gap-above-small" action={transitionWorkAction}>
      {versioned}
      <input type="hidden" name="to" value="ready" />
      <label>
        {status === 'completed' ? 'Why does this need reopening?' : 'Why is it worth trying again?'}
        <KeptTextarea
          keep={reopenDraftName(status, history, work.version)}
          name="reason"
          required
          maxLength={2000}
        />
      </label>
      <small>
        This is kept in its history. Any earlier review stops counting, so it will need a new one.
      </small>
      <div>
        <SubmitButton className={status === 'completed' ? 'secondary' : undefined}>
          {status === 'completed' ? 'Reopen' : 'Try again'}
        </SubmitButton>
      </div>
    </form>
  );

  const summary = (
    <aside aria-labelledby="state-heading">
      <div className="card work-summary">
        <h2 id="state-heading" className="visually-hidden">
          Summary
        </h2>
        <dl>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={status} />
          </dd>
          <dt>Owner</dt>
          <dd>{ownerName ?? 'Unknown'}</dd>
          <dt>Due</dt>
          <dd>
            {work.dueAt ? formatDate(work.dueAt) : 'No due date'}
            {isOverdue(work.dueAt, today) && !finished && (
              <>
                {' '}
                <span className="badge attention">Overdue</span>
              </>
            )}
          </dd>
          <dt>Who can see this</dt>
          <dd>
            <ClassificationBadge value={work.classification} />
            <small className="work-summary-note">{WHO_CAN_SEE[work.classification]}</small>
          </dd>
          {project && (
            <>
              <dt>Project</dt>
              <dd>
                {project.clientName ? `${project.name} (${project.clientName})` : project.name}
              </dd>
            </>
          )}
          <dt>Done when</dt>
          <dd>
            {doneWhen}
            {criteria.length > 0 && status !== 'completed' && (
              <small className="work-summary-note">{doneWhenState.text}</small>
            )}
          </dd>
        </dl>

        {/* The person asked to review sees the way to their decision first. */}
        {iReview && openReview && (
          <div className="divided">
            <p>
              You are asked to review this. You have until {formatDateTime(openReview.expiresAt)}.
            </p>
            <ActionLink
              href={`${base}/approvals/${openReview.id}`}
              variant={
                canChange && ((primary && !needsReason) || canRunPlan) ? 'secondary' : 'primary'
              }
            >
              Review and decide
            </ActionLink>
          </div>
        )}

        {canChange && (
          <section className="divided" aria-labelledby="actions-heading">
            <h2 id="actions-heading">Next step</h2>
            {isHeldUp && transitions.includes('ready') && (
              <p className="notice warn">
                This cannot be marked ready until what it depends on is done.
              </p>
            )}
            {unmet.length > 0 && transitions.includes('completed') && (
              <p className="notice warn">
                This cannot be marked done until everything under Checks and reviews is in place.
              </p>
            )}
            {noEvidenceAsked && transitions.includes('completed') && (
              <p className="muted">
                {isOwner
                  ? 'Your word as owner is the only check on this work, and its history will say so.'
                  : `Only ${ownerName ?? 'its owner'}, as owner, can confirm this is done.`}
              </p>
            )}
            {canRunPlan && (
              <form className="fields" action={runPlanAction}>
                {ids}
                <p className="muted">
                  Running the plan adds a checklist file
                  {needsReview ? ', asks the person you choose for a review,' : ''} and sends the
                  work for checking. It does not do the work, and it does not mark it done.
                </p>
                {needsReview && approvers.length > 0 && (
                  <label>
                    Who should review it?
                    <small>Someone other than you. They have 3 days to decide.</small>
                    <select
                      name="reviewerMembershipId"
                      required
                      defaultValue={
                        work.ownerMembershipId !== context.membershipId
                          ? work.ownerMembershipId
                          : ''
                      }
                    >
                      <option value="" disabled>
                        Choose a person
                      </option>
                      {approvers.map((member) => (
                        <option key={member.membershipId} value={member.membershipId}>
                          {personLabel(member)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {needsReview && approvers.length === 0 ? (
                  <p className="notice warn flush">
                    This plan needs a review, and nobody else who can see this work can give one.
                    {canManage
                      ? ' Add someone to this work first.'
                      : ` Ask ${ownerName ?? 'its owner'} to add someone first.`}
                  </p>
                ) : (
                  <div>
                    <SubmitButton>Run the plan</SubmitButton>
                  </div>
                )}
              </form>
            )}
            {needsReason ? (
              buttons.includes('ready') &&
              (status === 'completed' ? (
                // Finished work needs nothing more, so going round again is offered, not urged.
                <details>
                  <summary>Reopen this work</summary>
                  {reasonForm}
                </details>
              ) : (
                reasonForm
              ))
            ) : buttons.length > 0 ? (
              <div className={canRunPlan ? 'row gap-above' : 'row'}>
                {/* The one next step leads; the other moves follow it, outlined. */}
                {[...buttons]
                  .sort((a, b) => Number(b === primary) - Number(a === primary))
                  .map((to) => (
                    <form key={to} action={transitionWorkAction}>
                      {versioned}
                      <input type="hidden" name="to" value={to} />
                      <SubmitButton className={to === primary ? undefined : 'secondary'}>
                        {labelFor(to)}
                      </SubmitButton>
                    </form>
                  ))}
              </div>
            ) : status === 'cancelled' ? (
              <p className="muted">
                Stopped work cannot be edited or restarted. Its files can still be deleted, people
                can still be taken off it, and it can be handed to a new owner.
              </p>
            ) : status === 'awaiting_approval' ? (
              <p className="muted">
                {iReview
                  ? 'Your decision lets this carry on, or stops it for good.'
                  : 'Only the reviewer’s decision lets this carry on.'}
              </p>
            ) : null}
          </section>
        )}

        {canManage && newOwners.length > 0 && (
          <details className="divided">
            <summary>Hand over to someone else</summary>
            <form className="fields gap-above" action={setOwnerAction}>
              {versioned}
              <label>
                Hand over to
                <small>They become its owner and answer for it from then on.</small>
                <select name="membershipId" required defaultValue="">
                  <option value="" disabled>
                    Choose a person
                  </option>
                  {newOwners.map((member) => (
                    <option key={member.membershipId} value={member.membershipId}>
                      {personLabel(member)}
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <SubmitButton className="secondary">Change owner</SubmitButton>
              </div>
            </form>
          </details>
        )}

        <p className="divided link-line">
          <Link href={`${base}/work/${work.id}/run`}>Assistant activity</Link>
          <small className="work-summary-note">
            What an assistant has done on this work{canChange ? ', or start one' : ''}.
          </small>
        </p>

        {canStop && (
          <div className="divided work-stop">
            <ConfirmForm
              action={transitionWorkAction}
              fields={
                <>
                  {versioned}
                  <input type="hidden" name="to" value="cancelled" />
                </>
              }
              summary="Stop this work"
              reasonLabel="Why is this being stopped?"
              consequence="Stop this work for good. It cannot be restarted, and any running plan and open review end too."
              confirmLabel="Stop this work"
            />
          </div>
        )}
      </div>
    </aside>
  );

  const story = (
    <div className="stack work-story">
      <section className="card" aria-labelledby="purpose-heading">
        <h2 id="purpose-heading">Purpose</h2>
        <p className="pre-wrap">{work.objective || 'No details were written.'}</p>
        {canChange && canChangeContent(status) && (
          <details>
            <summary>Edit the details</summary>
            {/* Stays mounted through live updates, so nothing typed is lost. */}
            <EditWorkForm
              organizationId={organizationId}
              workId={work.id}
              current={{
                version: work.version,
                title: work.title,
                objective: work.objective ?? '',
                dueAt: toDateInput(work.dueAt),
              }}
            />
          </details>
        )}
        {canChange && status === 'awaiting_approval' && (
          <p className="muted">
            The details cannot change while this is paused, because they are what is being reviewed.
          </p>
        )}
      </section>

      <div className="card">
        <section aria-labelledby="progress-heading">
          <h2 id="progress-heading">Progress</h2>
          <p>{STATE_NOTE[status]}</p>
          {status === 'awaiting_approval' &&
            (openReview ? (
              <p>
                {nameOf.get(openReview.approverMembershipId) ?? 'The reviewer'} has until{' '}
                {formatDateTime(openReview.expiresAt)} to decide. Approving lets it carry on. If
                they deny it, or nobody decides in time, it stops for good.
              </p>
            ) : (
              <p>
                {planHolds
                  ? 'The time for its review has run out, so it stops at the next periodic check, usually within 15 minutes.'
                  : overdueHold
                    ? `The time for its review has run out, so it stops at the next periodic check, usually within 15 minutes.${canAskForReview ? ' To keep it going, ask someone else under Checks and reviews before then.' : ''}`
                    : `The person asked to review it can no longer decide. It stays paused until someone decides.${canAskForReview ? ' Ask someone else under Checks and reviews.' : ''}`}
              </p>
            ))}
          {status === 'verifying' &&
            (noEvidenceAsked ? (
              <p>
                Nothing beyond the owner’s word was asked for, so {ownerName ?? 'its owner'}{' '}
                confirms when it is done.
              </p>
            ) : unmet.length === 0 ? (
              <p>Everything it needs is in place, so it can now be marked done.</p>
            ) : (
              <p>It can be marked done once everything under Checks and reviews is in place.</p>
            ))}
          {!finished && status !== 'awaiting_approval' && whoDoesIt && (
            <p className="muted">{whoDoesIt}</p>
          )}
          {runRequested && status === 'ready' && (
            <p className="notice">
              Someone asked the plan to run. The status changes here when it actually starts. If
              nothing has picked it up after a few minutes, Ensemus asks again at its periodic
              check, about every 15 minutes. Starting by hand instead cancels that request.
            </p>
          )}
        </section>

        <section className="divided" aria-labelledby="verification-heading">
          <h2 id="verification-heading">Checks and reviews</h2>
          {status === 'completed' && detail.evidence.artifactCount > 0 && (
            <p>This is done. Its results are under Files.</p>
          )}
          {criteria.length === 0 ? (
            <p className="muted">
              Owner confirms: no file or review was asked for, so its owner says when it is done.
            </p>
          ) : (
            <ul className="list">
              {criteria.map((criterion) => {
                const missing = unmet.some((u) => u.kind === criterion.kind);
                return (
                  <li key={criterion.kind}>
                    <span>{EVIDENCE[criterion.kind]}</span>
                    <span className={`badge ${missing ? 'attention' : 'done'}`}>
                      {missing ? 'Still needed' : 'In place'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {criteria.some((c) => c.kind === 'artifact_exists') &&
            files.length > 0 &&
            unmet.some((u) => u.kind === 'artifact_exists') && (
              <p className="muted gap-above">
                The checklist the plan added does not count: someone has to attach the result.
              </p>
            )}
          {unmet.some((u) => u.kind === 'external_receipt') && (
            <p className="muted gap-above">
              {actionConnections.length === 0
                ? 'This asks for a receipt from an outside system, and this organization has no active connection that can give one. It stays unmet until an organization owner or admin connects one again.'
                : 'This counts an email below once your mail server has accepted it, or once someone who answers for this work has looked and said it went. That second case rests on their word, and the email shows it.'}
            </p>
          )}
          <h3 className="gap-above-large">Reviews</h3>
          {reviews.length === 0 ? (
            <p className="muted">
              {finished
                ? 'Nobody was asked to review this.'
                : 'Nobody has been asked to review this yet.'}
            </p>
          ) : (
            <ul className="list">
              {reviews.map((review) => (
                <li key={review.id}>
                  <Link href={`${base}/approvals/${review.id}`}>
                    Review by {nameOf.get(review.approverMembershipId) ?? 'someone no longer here'}
                  </Link>
                  <span className="row">
                    {review.status === 'pending' && review.expiresAt.getTime() > now && (
                      <small>Until {formatDateTime(review.expiresAt)}</small>
                    )}
                    {/* A review past its time can no longer be decided, whatever its row says. */}
                    <StatusBadge
                      status={
                        review.status === 'pending' && review.expiresAt.getTime() <= now
                          ? 'expired'
                          : review.status === 'cancelled'
                            ? 'closed'
                            : review.outdated
                              ? 'outdated'
                              : review.status
                      }
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {reviews.some((review) => review.outdated) && (
            <p className="muted gap-above">
              An approval covers exactly what it was asked about. This work has changed since, or
              the approval has run out, so it needs a new review.
            </p>
          )}
          {openReview && !finished && (
            <p className="muted gap-above">
              One review at a time. A new one can be asked for once this one is decided.
            </p>
          )}
          {canAskForReview &&
            (approvers.length === 0 ? (
              <p className="muted gap-above">
                Nobody else who can see this work is able to review it.
              </p>
            ) : (
              <form className="inline-form gap-above" action={requestReviewAction}>
                {versioned}
                <label>
                  Ask for a review from
                  <select name="approverMembershipId" required defaultValue="">
                    <option value="" disabled>
                      Choose a person
                    </option>
                    {approvers.map((member) => (
                      <option key={member.membershipId} value={member.membershipId}>
                        {personLabel(member)}
                      </option>
                    ))}
                  </select>
                </label>
                <SubmitButton className="secondary">Request review</SubmitButton>
                <small>
                  They have 3 days to decide. The review covers this work as it stands now, so
                  changing it afterwards needs a new one.
                  {(status === 'running' || status === 'awaiting_approval') &&
                    ' This work stays paused until they do. If they deny it or the time runs out, it stops for good.'}
                </small>
              </form>
            ))}
        </section>
      </div>

      <section className="card" aria-labelledby="files-heading">
        <h2 id="files-heading">Files</h2>
        {files.length === 0 ? (
          <Empty>
            {canChange && canChangeContent(status)
              ? 'No files yet. Attach briefs, source material or the finished result below.'
              : 'No files yet.'}
          </Empty>
        ) : (
          <ul className="list">
            {files.map((file) => (
              <li key={file.id}>
                {/* A plain link: this is a file download from a route, not a page to navigate to. */}
                <a href={`${base}/work/${work.id}/files/${file.id}`}>{file.name}</a>
                <span className="row">
                  <small>
                    {formatBytes(file.sizeBytes)}, added {formatDate(file.createdAt)}
                  </small>
                  {canChange && canDeleteFile(status) && (
                    <ConfirmForm
                      action={deleteArtifactAction}
                      fields={
                        <>
                          {ids}
                          <input type="hidden" name="artifactId" value={file.id} />
                        </>
                      }
                      summary="Delete"
                      summaryLabel={`Delete ${file.name}`}
                      consequence={`Delete ${file.name} for good. It cannot be recovered.`}
                      confirmLabel="Delete permanently"
                    />
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {status === 'completed' && canChange && files.length > 0 && (
          <p className="muted gap-above">
            Files on finished work are its record. Reopen it to change them.
          </p>
        )}
        {canChange && canChangeContent(status) && (
          <form className="inline-form divided" action={uploadArtifactAction}>
            {ids}
            <input type="hidden" name="requestKey" value={randomUUID()} />
            <label>
              Attach a file
              <FileField
                name="file"
                hint="Up to 25 MB. Anyone who can see this work can see it. Deleting a file later is permanent."
              />
            </label>
            <SubmitButton className="secondary" working="Uploading">
              Upload
            </SubmitButton>
          </form>
        )}
      </section>

      <section className="card" aria-labelledby="external-heading">
        <h2 id="external-heading">Emails from this work</h2>
        {externalActions.items.length === 0 ? (
          <p className="muted">
            Nothing has been proposed from this work. An email from here goes out only after someone
            else approves it.
          </p>
        ) : (
          <ul className="list">
            {externalActions.items.map((action) => (
              <li key={action.id}>
                <Link href={`${base}/external-actions/${action.id}`}>
                  {action.subject ?? 'An action outside Ensemus'}
                </Link>
                <ReceiptStatusBadge status={action.status} statusReason={action.statusReason} />
              </li>
            ))}
          </ul>
        )}
        {externalActions.next && (
          <p className="muted gap-above">Showing only the 50 most recent.</p>
        )}
        {canChange &&
          !finished &&
          (!connectorsEnabled ? (
            <p className="muted gap-above">Sending email is not turned on here.</p>
          ) : work.classification === 'restricted' ? (
            <p className="muted gap-above">Restricted work cannot be emailed outside Ensemus.</p>
          ) : senders.length === 0 ? (
            <p className="muted gap-above">
              This organization has no connection that can send email.{' '}
              {can(context.role, 'connection.manage') ? (
                <Link href={`${base}/connections`}>Add one under Connections.</Link>
              ) : (
                'An organization owner or admin can add one.'
              )}
            </p>
          ) : approvers.length === 0 ? (
            <p className="muted gap-above">
              An email needs someone else to approve it, and nobody else who can see this work is
              able to.
            </p>
          ) : (
            <details className="gap-above">
              <summary>Propose an email</summary>
              <NewEmailForm
                organizationId={organizationId}
                target={{ kind: 'propose', workUnitId: work.id }}
                requestKey={randomUUID()}
                connections={senders.map((connection) => ({
                  id: connection.id,
                  label: `${connection.displayName} (sends as ${connection.fromAddress})`,
                }))}
                approvers={approvers.map((member) => ({
                  id: member.membershipId,
                  label: personLabel(member),
                }))}
                {...(senders.length === 1 && senders[0]
                  ? { defaults: { connectionId: senders[0].id } }
                  : {})}
              />
            </details>
          ))}
      </section>

      <div className="card">
        <section aria-labelledby="owner-heading">
          <h2 id="owner-heading">People</h2>
          <dl>
            <dt>Accountable owner</dt>
            <dd>{ownerName ?? 'Unknown'}</dd>
          </dl>
          <h3 className="gap-above-large">Also on this work</h3>
          {people.length === 0 ? (
            <p className="muted">Nobody else yet.</p>
          ) : (
            <ul className="list">
              {people.map((person) => (
                <li key={person.membershipId}>
                  <span>
                    {person.name}{' '}
                    <small>{ROLE_ON_WORK[person.responsibility] ?? person.responsibility}</small>
                  </span>
                  {(canManage || person.membershipId === context.membershipId) && (
                    <form action={unassignAction}>
                      {ids}
                      <input type="hidden" name="membershipId" value={person.membershipId} />
                      {person.membershipId === context.membershipId ? (
                        <SubmitButton className="secondary" label="Take yourself off this work">
                          Take yourself off
                        </SubmitButton>
                      ) : (
                        <SubmitButton
                          className="secondary"
                          label={`Remove ${person.name} from this work`}
                        >
                          Remove
                        </SubmitButton>
                      )}
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canChange && !canManage && (
            <p className="muted gap-above">
              You are on this work, so you can work on it and move it along. Changing the owner,
              adding or removing other people and stopping it are for {ownerName ?? 'its owner'} or
              an organization admin.
            </p>
          )}
          {canManage && !finished && newContributors.length > 0 && (
            <form className="inline-form gap-above" action={assignAction}>
              {ids}
              <label>
                Add someone
                <select name="membershipId" required defaultValue="">
                  <option value="" disabled>
                    Choose a person
                  </option>
                  {newContributors.map((member) => (
                    <option key={member.membershipId} value={member.membershipId}>
                      {personLabel(member)}
                    </option>
                  ))}
                </select>
              </label>
              <SubmitButton className="secondary">Add</SubmitButton>
            </form>
          )}
        </section>

        <section className="divided" aria-labelledby="dependencies-heading">
          <h2 id="dependencies-heading">Waits for</h2>
          {prerequisites.length === 0 ? (
            <p className="muted">{hidden.unfinished > 0 ? 'Nothing you can see.' : 'Nothing.'}</p>
          ) : (
            <ul className="list">
              {prerequisites.map((item) => (
                <li key={item.id}>
                  <Link href={`${base}/work/${item.id}`}>{item.title}</Link>
                  <span className="row">
                    <StatusBadge status={item.status} />
                    {canChange && !finished && (
                      <form action={removeDependencyAction}>
                        {ids}
                        <input type="hidden" name="prerequisiteId" value={item.id} />
                        <SubmitButton className="secondary" label={`Stop waiting on ${item.title}`}>
                          Stop waiting
                        </SubmitButton>
                      </form>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {hidden.unfinished > 0 && (
            <div className="notice warn flush gap-above">
              <p>
                {hidden.unfinished === 1
                  ? 'This is also waiting on one piece of work you do not have access to.'
                  : `This is also waiting on ${hidden.unfinished} pieces of work you do not have access to.`}{' '}
                Someone who can see it can tell you more.
              </p>
              {hidden.stopped > 0 && (
                <>
                  <p>
                    {hidden.stopped === 1
                      ? 'One of these was stopped, so it can never finish.'
                      : `${hidden.stopped} of these were stopped, so they can never finish.`}{' '}
                    {canChange &&
                      !finished &&
                      'You can stop waiting on what was stopped. This does not show you what it was, or change it.'}
                  </p>
                  {canChange && !finished && (
                    <form action={removeStoppedHiddenPrerequisitesAction}>
                      {ids}
                      <SubmitButton className="secondary">
                        Stop waiting on stopped work
                      </SubmitButton>
                    </form>
                  )}
                </>
              )}
            </div>
          )}
          {canAddDependency && dependencyOptions.length > 0 && (
            <form className="inline-form gap-above" action={addDependencyAction}>
              {ids}
              <label>
                Add work it waits for
                <select name="prerequisiteId" required defaultValue="">
                  <option value="" disabled>
                    Choose work
                  </option>
                  {dependencyOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </label>
              <SubmitButton className="secondary">Add dependency</SubmitButton>
              {candidates?.nextCursor && <small>Showing only your 50 most recent items.</small>}
            </form>
          )}
          {canChange && !finished && !canAddDependency && (
            <p className="muted gap-above">
              What it waits for can only change before it is ready, or while it is blocked.
            </p>
          )}
          {dependents.length > 0 && (
            <>
              <h3 className="gap-above-large">Waiting on this</h3>
              <ul className="list">
                {dependents.map((item) => (
                  <li key={item.id}>
                    <Link href={`${base}/work/${item.id}`}>{item.title}</Link>
                    <StatusBadge status={item.status} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="history-heading">
        <h2 id="history-heading">History</h2>
        {history.length === 0 ? (
          <p className="muted">The status has not changed since this was created.</p>
        ) : (
          <ul className="list">
            {history.map((entry) => (
              <li key={entry.id} className="block">
                <span className="row">
                  <StatusBadge status={entry.fromStatus} />
                  <span aria-hidden="true">to</span>
                  <span className="visually-hidden">changed to</span>
                  <StatusBadge status={entry.toStatus} />
                  <small>
                    {entry.actorName ?? 'Ensemus'}, {formatDateTime(entry.occurredAt)}
                  </small>
                </span>
                {entry.completionBasis === 'owner_confirmed' && (
                  <p className="gap-above-small">
                    Confirmed by {entry.actorName ?? 'its owner'} as owner. No file or review was
                    asked for.
                  </p>
                )}
                {entry.reason && <p className="gap-above-small">{entry.reason}</p>}
              </li>
            ))}
          </ul>
        )}
        <p className="muted gap-above">Last changed {formatDateTime(work.updatedAt)}.</p>
      </section>
    </div>
  );

  const page = (
    <DraftScope account={actor.userId}>
      <BackLink href={`${base}/work`}>Back to work</BackLink>
      <PageHead title={work.title} />
      <ErrorNotice code={error} />
      <LiveStatus
        url={`/api/v1/organizations/${organizationId}/work-units/${work.id}/events?include=evidence`}
        version={work.version}
        evidence={detail.evidenceStamp}
      />
      {/* The summary comes first, so on a phone the status and next step sit under the title. */}
      <div className="detail-layout work-detail">
        {summary}
        {story}
      </div>
    </DraftScope>
  );

  // The forms here answer to one version, so none may go while another is on its way.
  return <OneActionAtATime>{page}</OneActionAtATime>;
}
