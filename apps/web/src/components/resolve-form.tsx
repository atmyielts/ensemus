import { resolveExternalActionAction } from '@/server/external-action-actions';
import { KeptTextarea } from './kept-field';
import { SubmitButton } from './submit-button';

/**
 * Says what happened to an action nobody can answer for. Works without JavaScript. It records what a
 * person found, and there is deliberately no way from here to send anything.
 */
export function ResolveForm({
  organizationId,
  externalActionId,
  version,
}: {
  organizationId: string;
  externalActionId: string;
  version: number;
}) {
  return (
    <form className="fields" action={resolveExternalActionAction}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="id" value={externalActionId} />
      <input type="hidden" name="version" value={version} />
      <fieldset className="group">
        <legend>What did you find?</legend>
        <label className="check">
          <input type="radio" name="resolution" value="confirmed_sent" required />
          It went: I found it
        </label>
        <label className="check">
          <input type="radio" name="resolution" value="confirmed_not_sent" required />
          It did not go: it is not there
        </label>
      </fieldset>
      <label>
        How do you know?
        <small>Required. People who can read this work can read it. It cannot be changed.</small>
        <KeptTextarea
          keep={`resolve-${externalActionId}`}
          name="reason"
          required
          maxLength={2000}
        />
      </label>
      <small>
        This records your word and sends nothing. If you say it did not go, sending it means asking
        again, and that needs a new approval.
      </small>
      <div>
        <SubmitButton>Record what I found</SubmitButton>
      </div>
    </form>
  );
}
