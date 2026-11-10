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

export const metadata = { title: 'Review a frozen definition | Ensemus' };
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
        title={snapshot.name ?? 'Frozen definition review'}
        description="Read the exact requested snapshot. Your decision never substitutes a later edit."
      />
      <ErrorNotice code={(await searchParams).error} />
      <section className="card fields" aria-labelledby="review-identity">
        <div className="row">
          <h2 id="review-identity">Requested snapshot</h2>
          <StatusBadge status={review.status} />
        </div>
        <dl className="details">
          <div>
            <dt>Definition</dt>
            <dd>{snapshot.name ?? 'No historical display name was recorded'}</dd>
          </div>
          <div>
            <dt>Responsible person</dt>
            <dd>
              {owner?.name ?? 'The historical responsible person is no longer listed'}
              {owner && owner.status !== 'active' ? ' (currently inactive)' : ''}
            </dd>
          </div>
          <div>
            <dt>Rehearsed source revision</dt>
            <dd>{snapshot.sourceVersion}</dd>
          </div>
          <div>
            <dt>Requested by</dt>
            <dd>{requester?.name ?? 'The requesting person is no longer listed'}</dd>
          </div>
          <div>
            <dt>Requested</dt>
            <dd>{formatDateTime(review.createdAt)}</dd>
          </div>
          <div>
            <dt>Named reviewer</dt>
            <dd>
              {review.reviewerMembershipId
                ? namedReviewer
                  ? namedReviewer.name +
                    (namedReviewer.status === 'active' ? '' : ' (currently inactive)')
                  : 'The named reviewer is no longer listed'
                : review.riskLevel === 'elevated'
                  ? 'Any eligible person other than the requester'
                  : 'Any eligible organization reviewer'}
            </dd>
          </div>
        </dl>
        <p className="notice">
          This review contains a frozen definition and a synthetic rehearsal. It does not show real
          model quality, provider qualification, a real delivery or a completed business outcome.
        </p>
        {review.riskSummary.length > 0 && (
          <ul>
            {review.riskSummary.map((risk, index) => (
              <li key={index}>{studioRiskText(risk)}</li>
            ))}
          </ul>
        )}
        {review.riskLevel === 'elevated' && (
          <p className="notice">
            The person who requested this elevated-risk review cannot decide it. A named reviewer,
            if selected, must be the person deciding.
          </p>
        )}
        {!current && (
          <p className="notice">
            Current draft readiness is unavailable or invalid. This verified frozen snapshot remains
            readable as history; approval and publication are unavailable until the current draft
            can be checked.
          </p>
        )}
        {current && !currentMatches && (
          <p className="notice">
            The current draft no longer matches this frozen name, owner or definition hash, is
            archived or has compilation issues. The snapshot remains readable as history. It cannot
            be approved or published as the current draft.
          </p>
        )}
        {owner?.status !== 'active' && (
          <p className="notice">
            The frozen responsible person is not currently active. Resolve responsibility on the
            draft before moving it forward.
          </p>
        )}
        <p>
          <Link href={subjectPath}>
            {review.subjectKind === 'agent_draft'
              ? 'Read the current draft'
              : 'Read the current workflow draft'}
          </Link>{' '}
          ·{' '}
          <Link href={`${base}/simulations/${review.simulationRunId}`}>
            Read the bound rehearsal
          </Link>
        </p>
      </section>
      <section className="card fields" aria-labelledby="frozen-definition">
        <h2 id="frozen-definition">Frozen definition</h2>
        <SpecSummary snapshot={snapshot} sourceNames={sourceNames} />
      </section>
      {review.decisionReason && (
        <section className="card fields">
          <h2>Recorded decision reason</h2>
          <p>{review.decisionReason}</p>
        </section>
      )}
      {review.status === 'pending' && (
        <section className="card fields" aria-labelledby="decide-review">
          <h2 id="decide-review">Decide this review</h2>
          {canDecide ? (
            <>
              <p>
                A decision applies only to the frozen snapshot above. Approval does not publish it.
                Current account security and authority are checked again on submit.
              </p>
              <form action={decideStudioReviewAction} className="fields">
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="reviewId" value={review.id} />
                <input type="hidden" name="version" value={review.version} />
                <input type="hidden" name="decision" value="approved" />
                <input type="hidden" name="requestKey" value={randomUUID()} />
                <label htmlFor="review-approval-reason">Approval reason (optional)</label>
                <textarea id="review-approval-reason" name="reason" maxLength={2000} rows={3} />
                <label className="check">
                  <input type="checkbox" required />I reviewed the frozen purpose, permissions,
                  responsible person and limits.
                </label>
                <div>
                  <SubmitButton working="Recording approval">Approve this snapshot</SubmitButton>
                </div>
              </form>
              <form action={decideStudioReviewAction} className="fields">
                <input type="hidden" name="organizationId" value={organizationId} />
                <input type="hidden" name="reviewId" value={review.id} />
                <input type="hidden" name="version" value={review.version} />
                <input type="hidden" name="decision" value="rejected" />
                <input type="hidden" name="requestKey" value={randomUUID()} />
                <label htmlFor="review-rejection-reason">
                  What needs to change? (required to reject)
                </label>
                <textarea
                  id="review-rejection-reason"
                  name="reason"
                  required
                  minLength={1}
                  maxLength={2000}
                  rows={3}
                />
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
                ? 'You requested this elevated-risk review. A different eligible person must decide it.'
                : !namedEligible
                  ? 'Only the named reviewer may decide this review.'
                  : !currentMatches
                    ? 'Request a review of the current draft after a new rehearsal.'
                    : 'A current eligible reviewer and active responsible person are required.'}
            </p>
          )}
        </section>
      )}
      {review.status === 'approved' && (
        <section className="card fields" aria-labelledby="publish-review">
          <h2 id="publish-review">Publish the approved definition</h2>
          <p>
            Publishing makes this approved version available for future authorized runs under the
            current policy. It does not start a run or perform an outside action.
          </p>
          {canPublish ? (
            <form action={publishStudioReviewAction} className="fields">
              <input type="hidden" name="organizationId" value={organizationId} />
              <input type="hidden" name="reviewId" value={review.id} />
              <input type="hidden" name="version" value={review.version} />
              <input type="hidden" name="requestKey" value={randomUUID()} />
              <label className="check">
                <input type="checkbox" required />
                Publish only this reviewed snapshot, with its recorded responsible person and
                permissions.
              </label>
              <div>
                <SubmitButton working="Publishing the approved snapshot">
                  Publish approved snapshot
                </SubmitButton>
              </div>
            </form>
          ) : (
            <p className="muted">
              The current draft must match the review, its responsible person must be active and
              your current role must permit publication. Refresh after resolving those conditions.
            </p>
          )}
        </section>
      )}
      {review.status === 'published' && (
        <p className="notice">
          This review has a publication receipt. It does not certify a live model or start an
          execution. Existing runs keep their pinned version.
        </p>
      )}
      {canCancel && (
        <section className="card fields" aria-labelledby="cancel-review">
          <h2 id="cancel-review">Close without publishing</h2>
          <p>
            Cancel this review when it is no longer wanted or a different named reviewer is needed.
            This grants no new authority and starts no work.
          </p>
          <form action={cancelStudioReviewAction}>
            <input type="hidden" name="organizationId" value={organizationId} />
            <input type="hidden" name="reviewId" value={review.id} />
            <input type="hidden" name="version" value={review.version} />
            <SubmitButton className="secondary" working="Closing the review">
              Cancel this review
            </SubmitButton>
          </form>
        </section>
      )}
      <p>
        <Link href={`${base}/reviews/${review.id}`}>Refresh the current review status</Link>
      </p>
      <details>
        <summary>Snapshot and receipt details</summary>
        <p>
          People’s names are read from the current company directory. The frozen responsible
          membership identity below remains pinned.
        </p>
        <dl className="details">
          <div>
            <dt>Frozen definition hash</dt>
            <dd>
              <code>{review.subjectSha256}</code>
            </dd>
          </div>
          <div>
            <dt>Frozen responsible membership</dt>
            <dd>
              <code>{snapshot.ownerMembershipId}</code>
            </dd>
          </div>
          <div>
            <dt>Review receipt version</dt>
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
    </OneActionAtATime>
  );
}
