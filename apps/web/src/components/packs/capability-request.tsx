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
      <div className="row">
        <strong>{KIND_WORDS[request.kind] ?? 'A request'}</strong>
        <code>{request.subject}</code>
        <DecisionBadge decision={request.decision} />
        {request.risk === 'elevated' && <span className="badge attention">Needs extra care</span>}
        {request.isNew && <span className="badge active">New in this version</span>}
      </div>
      <p>{request.why}</p>
      <dl className="facts">
        <dt>What it can read</dt>
        <dd>{request.dataAccess}</dd>
        <dt>What it can change</dt>
        <dd>{request.sideEffects}</dd>
        {request.tool && (
          <>
            <dt>On this deployment</dt>
            <dd>{toolSentence(request.tool)}</dd>
          </>
        )}
        <dt>Left out if you decline</dt>
        <dd>{request.neededBy.join(', ')}</dd>
      </dl>
      {canDecide && (
        <div className="row gap-above">
          <form action={decidePackCapabilityAction}>
            {hidden('accepted')}
            <SubmitButton className="quiet" label={`Accept ${request.subject}`}>
              Accept
            </SubmitButton>
          </form>
          <form action={decidePackCapabilityAction}>
            {hidden('declined')}
            <SubmitButton className="quiet" label={`Decline ${request.subject}`}>
              Decline
            </SubmitButton>
          </form>
        </div>
      )}
    </li>
  );
}
