'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice } from '@/components/ui';
import {
  createWebhookEndpointFormAction,
  type WebhookFormState,
} from '@/server/external-action-actions';

const INITIAL: WebhookFormState = {};

/**
 * Makes a callback address, and shows it and its secret here and nowhere else. They live in this render's
 * memory: leave the page or reload it, and they are gone, so they have to be copied now.
 */
export function WebhookForm({
  organizationId,
  connectionId,
  connectionName,
}: {
  organizationId: string;
  connectionId: string;
  connectionName: string;
}) {
  const [state, action] = useActionState(createWebhookEndpointFormAction, INITIAL);
  return (
    <>
      <ErrorNotice code={state.code} />
      {state.created && (
        <div className="notice good" role="status">
          <label>
            Callback address
            <input readOnly value={state.created.url} />
          </label>
          <label className="gap-above">
            Signing secret
            <input readOnly value={state.created.signingSecret} />
          </label>
          <p className="gap-above">
            These are shown once, so copy them now and keep them private. Only a hash of the address
            and a sealed copy of the secret are kept, so nobody can show you them again. If they are
            lost, make a new address.
          </p>
          <p>
            Sign each request with {state.created.scheme}. An unsigned or wrongly signed request is
            answered the same as a good one, and shows up under Recent callbacks, so look there when
            setting this up.
          </p>
        </div>
      )}
      <form action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="connectionId" value={connectionId} />
        <SubmitButton className="quiet" label={`Make a callback address for ${connectionName}`}>
          Make a callback address
        </SubmitButton>
      </form>
    </>
  );
}
