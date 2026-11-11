import { randomUUID } from 'node:crypto';
import { AppError, listDirectory } from '@ensemus/application';
import { getPublishReview, getPublishReviewSnapshot } from '@ensemus/application/publish-reviews';
import { getAgentDraft, getAgentDraftChoices } from '@ensemus/application/agent-drafts';
import { getProcessDraft } from '@ensemus/application/process-specs';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import { BackLink, ErrorNotice, PageHead, StatusBadge, formatDateTime } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { OneActionAtATime } from '@/components/one-action-at-a-time';
import { SpecSummary } from '@/components/studio/spec-summary';
import { requireStudio, studioRead } from '@/server/studio-pages';
import { webProductPorts } from '@/server/product-ports';
import {
  decideStudioReviewAction,
  publishStudioReviewAction,
  cancelStudioReviewAction,
} from '@/server/studio-actions';
import { studioRiskText } from '@/lib/studio-present';

export const metadata = { title: 'Publication review | Ensemus' };
export default async function PublishReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; reviewId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, reviewId } = await params;
  const { database, context } = await requireStudio(organizationId);
  const review = await studioRead(getPublishReview(database, context, reviewId));
  const snapshot = await studioRead(getPublishReviewSnapshot(database, context, review.id));
  const directory = await listDirectory(database, context);
  let current:
    Awaited<ReturnType<typeof getAgentDraft>> | Awaited<ReturnType<typeof getProcessDraft>> | null =
    null;
  try {
    current =
      review.subjectKind === 'agent_draft'
        ? await studioRead(getAgentDraft(database, context, review.subjectId))
        : await studioRead(getProcessDraft(database, context, webProductPorts(), review.subjectId));
  } catch (error) {
    if (
      !(error instanceof AppError) ||
      !['CAPABILITY_UNAVAILABLE', 'GRAPH_INVALID', 'DRAFT_INVALID'].includes(error.code)
    )
      throw error;
  }
  const base = `/o/${organizationId}/studio`;
  const currentMatches = Boolean(
    current &&
    current.status !== 'archived' &&
    (!('issues' in current) || !current.issues.length) &&
    current.specSha256 === review.subjectSha256 &&
    current.name === snapshot.name &&
    current.ownerMembershipId === snapshot.ownerMembershipId,
  );
  const owner = directory.find((person) => person.membershipId === snapshot.ownerMembershipId);
  const requester = directory.find(
    (person) => person.membershipId === review.requestedByMembershipId,
  );
  const namedReviewer = directory.find(
    (person) => person.membershipId === review.reviewerMembershipId,
  );
  const independent =
    review.riskLevel !== 'elevated' || review.requestedByMembershipId !== context.membershipId;
  const namedEligible =
    !review.reviewerMembershipId || review.reviewerMembershipId === context.membershipId;
  const canDecide =
    review.status === 'pending' &&
    currentMatches &&
    owner?.status === 'active' &&
    canProduct(context.role, 'studio.review') &&
    independent &&
    namedEligible;
  const canPublish =
    review.status === 'approved' &&
    currentMatches &&
    owner?.status === 'active' &&
    canProduct(context.role, 'studio.publish');
  const canCancel =
    (review.status === 'pending' || review.status === 'approved') &&
    canProduct(context.role, 'studio.author');
  const sourceNames: Record<string, string> = {};
  if (snapshot.kind === 'agent_draft') {
    const ids = snapshot.spec.context.allowed_scopes.flatMap((scope) => {
      const match = /^knowledge\.([0-9a-f-]{36})\.read$/i.exec(scope);
      return match?.[1] ? [match[1].toLowerCase()] : [];
    });
    if (ids.length) {
      const choices = await studioRead(
        getAgentDraftChoices(database, context, snapshot.ownerMembershipId, ids),
      );
      for (const source of choices.sources) sourceNames[source.id] = source.title;
    }
  }
  const subjectPath =
    review.subjectKind === 'agent_draft'
      ? `${base}/agents/${review.subjectId}`
      : `${base}/workflows/${review.subjectId}`;
  return (
    <OneActionAtATime>
      <BackLink href={`${base}/reviews`}>Publication reviews</BackLink>
      <PageHead
        title={snapshot.name ?? 'Review'}
        description="Read exactly what was built, then decide. Your decision applies only to this version, never to a later edit."
      />
      <ErrorNotice code={(await searchParams).error} />
      <div className="detail-layout">
        <div className="stack">
          {(review.riskLevel === 'elevated' ||
            !current ||
            (current && !currentMatches) ||
            owner?.status !== 'active') && (
            <div>
              {review.riskLevel === 'elevated' && (
                <p className="notice">
                  The person who asked for this review cannot decide it. If a reviewer was named,
                  only they can.
                </p>
              )}
              {!current && (
                <p className="notice warn">
                  The current draft cannot be checked right now. You can still read this version,
                  but it cannot be approved or published until the draft can be checked.
                </p>
              )}
              {current && !currentMatches && (
                <p className="notice warn">
                  The draft has changed since this review was requested, or it was archived or has
                  problems. You can still read this version, but it cannot be approved or published.
                </p>
              )}
              {owner?.status !== 'active' && (
                <p className="notice warn">
                  The responsible person is no longer active. Sort out who is responsible on the
                  draft before this can move forward.
                </p>
              )}
            </div>
          )}

          <section className="card" aria-labelledby="frozen-definition">
            <h2 id="frozen-definition">Frozen definition</h2>
            <p className="muted">
              This is the exact version that was rehearsed and sent for review. Later edits to the
              draft do not change it.
            </p>
            <div className="gap-above">
              <SpecSummary snapshot={snapshot} sourceNames={sourceNames} />
            </div>
            {review.riskSummary.length > 0 && (
              <>
                <h3 className="gap-above-large">Worth knowing</h3>
                <ul>
                  {review.riskSummary.map((risk, index) => (
                    <li key={index}>{studioRiskText(risk)}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="muted divided">
              <small>
                The rehearsal used made-up examples. It does not show how well a real AI model will
                do, that anything was delivered, or that the work got done.
              </small>
            </p>
          </section>

          {review.decisionReason && (
            <section className="card" aria-labelledby="decision-reason">
              <h2 id="decision-reason">Reason given</h2>
              <p>{review.decisionReason}</p>
            </section>
          )}

          {review.status === 'pending' && (
            <section className="card" aria-labelledby="decide-review">
              <h2 id="decide-review">Your decision</h2>
              {canDecide ? (
                <>
                  <p className="muted">
                    Approving does not publish it. Your access is checked again when you submit.
                  </p>
                  <form action={decideStudioReviewAction} className="fields gap-above">
                    <input type="hidden" name="organizationId" value={organizationId} />
                    <input type="hidden" name="reviewId" value={review.id} />
                    <input type="hidden" name="version" value={review.version} />
                    <input type="hidden" name="decision" value="approved" />
                    <input type="hidden" name="requestKey" value={randomUUID()} />
                    <label htmlFor="review-approval-reason">
                      <span id="review-approval-reason-label">Note for the requester</span>
                      <small id="review-approval-reason-help">Optional.</small>
                      <textarea
                        id="review-approval-reason"
                        aria-labelledby="review-approval-reason-label"
                        aria-describedby="review-approval-reason-help"
                        name="reason"
                        maxLength={2000}
                        rows={3}
                      />
                    </label>
                    <label className="check">
                      <input type="checkbox" required />I read what it is for, what it may do, who
                      is responsible and its limits.
                    </label>
                    <div>
                      <SubmitButton working="Recording approval">
                        Approve this snapshot
                      </SubmitButton>
                    </div>
                  </form>
                  <form action={decideStudioReviewAction} className="fields divided">
                    <input type="hidden" name="organizationId" value={organizationId} />
                    <input type="hidden" name="reviewId" value={review.id} />
                    <input type="hidden" name="version" value={review.version} />
                    <input type="hidden" name="decision" value="rejected" />
                    <input type="hidden" name="requestKey" value={randomUUID()} />
                    <label htmlFor="review-rejection-reason">
                      <span id="review-rejection-reason-label">What needs to change?</span>
                      <small id="review-rejection-reason-help">Needed if you send it back.</small>
                      <textarea
                        id="review-rejection-reason"
                        aria-labelledby="review-rejection-reason-label"
                        aria-describedby="review-rejection-reason-help"
                        name="reason"
                        required
                        minLength={1}
                        maxLength={2000}
                        rows={3}
                      />
                    </label>
                    <div>
                      <SubmitButton className="secondary" working="Recording rejection">
                        Reject and return for changes
                      </SubmitButton>
                    </div>
                  </form>
                </>
              ) : (
                <p className="muted">
                  {!independent
                    ? 'You asked for this review, so someone else has to decide it.'
                    : !namedEligible
                      ? 'Only the named reviewer can decide this review.'
                      : !currentMatches
                        ? 'The draft has changed. Rehearse the current draft and ask for a new review.'
                        : 'It needs a reviewer who can decide it and an active responsible person.'}
                </p>
              )}
            </section>
          )}

          {review.status === 'approved' && (
            <section className="card" aria-labelledby="publish-review">
              <h2 id="publish-review">Publish it</h2>
              <p className="muted">
                Publishing makes this approved version available to your team. It does not start
                anything or act outside Ensemus.
              </p>
              {canPublish ? (
                <form action={publishStudioReviewAction} className="fields gap-above">
                  <input type="hidden" name="organizationId" value={organizationId} />
                  <input type="hidden" name="reviewId" value={review.id} />
                  <input type="hidden" name="version" value={review.version} />
                  <input type="hidden" name="requestKey" value={randomUUID()} />
                  <label className="check">
                    <input type="checkbox" required />
                    Publish only this reviewed version, with its responsible person and what it may
                    do.
                  </label>
                  <div>
                    <SubmitButton working="Publishing the approved snapshot">
                      Publish approved snapshot
                    </SubmitButton>
                  </div>
                </form>
              ) : (
                <p className="muted gap-above">
                  To publish, the draft has to match this review, its responsible person has to be
                  active and you need permission to publish. Refresh once that is sorted out.
                </p>
              )}
            </section>
          )}

          {review.status === 'published' && (
            <p className="notice good">
              Published. Work already under way keeps the version it started with.
            </p>
          )}
        </div>

        <aside className="card" aria-labelledby="review-identity">
          <div className="spread">
            <h2 id="review-identity">Summary</h2>
            <StatusBadge status={review.status} />
          </div>
          <dl className="details gap-above-small">
            <div>
              <dt>{review.subjectKind === 'agent_draft' ? 'Assistant' : 'Workflow'}</dt>
              <dd>{snapshot.name ?? 'No name was recorded'}</dd>
            </div>
            <div>
              <dt>Responsible person</dt>
              <dd>
                {owner?.name ?? 'No longer listed'}
                {owner && owner.status !== 'active' ? ' (no longer active)' : ''}
              </dd>
            </div>
            <div>
              <dt>Requested by</dt>
              <dd>{requester?.name ?? 'No longer listed'}</dd>
            </div>
            <div>
              <dt>Requested</dt>
              <dd>{formatDateTime(review.createdAt)}</dd>
            </div>
            <div>
              <dt>Reviewer</dt>
              <dd>
                {review.reviewerMembershipId
                  ? namedReviewer
                    ? namedReviewer.name +
                      (namedReviewer.status === 'active' ? '' : ' (no longer active)')
                    : 'No longer listed'
                  : review.riskLevel === 'elevated'
                    ? 'Anyone who can review, except the requester'
                    : 'Anyone who can review'}
              </dd>
            </div>
            <div>
              <dt>Rehearsed draft version</dt>
              <dd>{snapshot.sourceVersion}</dd>
            </div>
          </dl>
          <ul className="studio-links divided">
            <li className="link-line">
              <Link href={subjectPath}>Read the current draft</Link>
            </li>
            <li className="link-line">
              <Link href={`${base}/simulations/${review.simulationRunId}`}>
                Read the rehearsal report
              </Link>
            </li>
            <li className="link-line">
              <Link href={`${base}/reviews/${review.id}`}>Refresh this review</Link>
            </li>
          </ul>
          {canCancel && (
            <div className="divided">
              <p className="muted">
                <small>
                  Close it if it is no longer wanted, or to choose a different reviewer.
                </small>
              </p>
              <form action={cancelStudioReviewAction} className="gap-above-small">
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="reviewId" value={review.id} />
                <input type="hidden" name="version" value={review.version} />
                <SubmitButton className="secondary" working="Closing the review">
                  Cancel this review
                </SubmitButton>
              </form>
            </div>
          )}
          <details className="divided">
            <summary>Technical details</summary>
            <p className="muted gap-above-small">
              <small>
                Names come from today’s company directory. The membership below stays as it was
                recorded.
              </small>
            </p>
            <dl className="details gap-above-small">
              <div>
                <dt>Definition fingerprint</dt>
                <dd>
                  <code>{review.subjectSha256}</code>
                </dd>
              </div>
              <div>
                <dt>Responsible membership</dt>
                <dd>
                  <code>{snapshot.ownerMembershipId}</code>
                </dd>
              </div>
              <div>
                <dt>Review record version</dt>
                <dd>{review.version}</dd>
              </div>
              <div>
                <dt>Review identifier</dt>
                <dd>
                  <code>{review.id}</code>
                </dd>
              </div>
              {review.publishedRef && (
                <div>
                  <dt>Published version reference</dt>
                  <dd>
                    <code>{review.publishedRef}</code>
                  </dd>
                </div>
              )}
            </dl>
          </details>
        </aside>
      </div>
    </OneActionAtATime>
  );
}
