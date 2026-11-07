'use client';

import { useActionState } from 'react';
import { requestExportAction, type RequestExportState } from '@/server/sovereign-actions';
import { SubmitButton } from './submit-button';
import { ErrorNotice } from './ui';

const INITIAL: RequestExportState = {};

/**
 * Asks for a public key, and only that. The field is never kept as a draft and never given back after a
 * refusal, because the wrong half of a key pair may be what someone pasted.
 */
export function ExportRequestForm({ organizationId }: { organizationId: string }) {
  const [state, action] = useActionState(requestExportAction, INITIAL);
  return (
    <>
      <ErrorNotice code={state.code} />
      {state.privateKeyRefused && (
        <p className="notice error" role="alert">
          That looks like a private key, so it was not used or kept. Paste the public key. The
          private key stays with you, and if it has been anywhere else, make a new pair.
        </p>
      )}
      {state.requested && (
        <p className="notice good" role="status">
          Your export has been asked for. It runs in the background, and this page shows how it
          stands. You will get a notification when it is ready.
        </p>
      )}
      <form className="fields" action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <label>
          Public key
          <input
            name="recipientPublicKey"
            className="mono"
            required
            maxLength={512}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="export-key-hint"
          />
        </label>
        <small id="export-key-hint">
          Make a key pair on your own machine with the recipient-key tool, and paste its public key
          here. The matching private key stays with you, and only that key can open the archive.
        </small>
        <div>
          <SubmitButton working="Asking for an export">Ask for an export</SubmitButton>
        </div>
      </form>
    </>
  );
}
