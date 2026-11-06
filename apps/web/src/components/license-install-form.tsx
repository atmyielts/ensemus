'use client';

import { useActionState } from 'react';
import {
  installSignedDocumentAction,
  type InstallDocumentState,
} from '@/server/sovereign-actions';
import { SubmitButton } from './submit-button';
import { ErrorNotice } from './ui';

const INITIAL: InstallDocumentState = {};

const DOCUMENT_LABEL = {
  license: 'license',
  maintenance: 'maintenance statement',
  advisory: 'advisory',
  support_policy: 'support policy',
} as const;

/** Takes a signed file, uploaded or pasted. What it says is checked by the server, and only a signature counts. */
export function LicenseInstallForm({ organizationId }: { organizationId: string }) {
  const [state, action] = useActionState(installSignedDocumentAction, INITIAL);
  const { installed } = state;
  return (
    <>
      <ErrorNotice code={state.code} />
      {installed && (
        <p className="notice good" role="status">
          {installed.created
            ? `The ${DOCUMENT_LABEL[installed.type]} was checked and installed.`
            : `This ${DOCUMENT_LABEL[installed.type]} was already installed, so nothing changed.`}
          {installed.testKey && ' It was signed with a generated test key.'}
        </p>
      )}
      <form className="fields" action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <label>
          Signed file
          <input name="file" type="file" accept=".json,.dsse,application/json" />
        </label>
        <label>
          Or paste what the file holds
          <textarea name="envelope" className="mono" autoComplete="off" spellCheck={false} />
        </label>
        <div>
          <SubmitButton working="Checking the file">Check and install</SubmitButton>
        </div>
      </form>
    </>
  );
}
