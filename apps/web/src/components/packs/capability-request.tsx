// One thing a pack asks for, with what it reads and what it changes in plain words, as the product doc says
// extension review must. Decided by itself, with its own two forms, so there is nothing to accept in bulk.
import type { PackReview } from '@ensemus/application/packs';
import { decidePackCapabilityAction } from '@/server/pack-actions';
import { SubmitButton } from '../submit-button';
import { DecisionBadge, KIND_WORDS, toolSentence } from './words';

export function CapabilityRequest({
  organizationId,
  installationId,
  request,
  canDecide,
}: {
  organizationId: string;
  installationId: string;
  request: PackReview['requests'][number];
  canDecide: boolean;
}) {
  const hidden = (decision: 'accepted' | 'declined') => (
    <>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="installationId" value={installationId} />
      <input type="hidden" name="capabilityKey" value={request.key} />
      <input type="hidden" name="decision" value={decision} />
    </>
  );
  return (
    <li className="block">
      <div className="spread">
        <strong>{KIND_WORDS[request.kind] ?? 'A request'}</strong>
        <span className="row">
          {request.isNew && <span className="badge active">New in this version</span>}
          {request.risk === 'elevated' && <span className="badge attention">Needs extra care</span>}
          <DecisionBadge decision={request.decision} />
        </span>
      </div>
      <p className="gap-above-small">{request.why}</p>
      <dl className="details gap-above-small">
        <div>
          <dt>What it can read</dt>
          <dd>{request.dataAccess}</dd>
        </div>
        <div>
          <dt>What it can change</dt>
          <dd>{request.sideEffects}</dd>
        </div>
        {request.tool && (
          <div>
            <dt>In your organization</dt>
            <dd>{toolSentence(request.tool)}</dd>
          </div>
        )}
        <div>
          <dt>Left out if you decline</dt>
          <dd>{request.neededBy.join(', ')}</dd>
        </div>
      </dl>
      <details className="gap-above-small">
        <summary>Technical details</summary>
        <p className="gap-above-small">
          Exact name: <code>{request.subject}</code>
        </p>
      </details>
      {canDecide && (
        <div className="row gap-above">
          <form action={decidePackCapabilityAction}>
            {hidden('accepted')}
            <SubmitButton className="secondary" label={`Accept ${request.subject}`}>
              Accept
            </SubmitButton>
          </form>
          <form action={decidePackCapabilityAction}>
            {hidden('declined')}
            <SubmitButton className="ghost" label={`Decline ${request.subject}`}>
              Decline
            </SubmitButton>
          </form>
        </div>
      )}
    </li>
  );
}
