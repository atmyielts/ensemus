'use client';

import { useActionState } from 'react';
import type { InviteFormState } from '@/lib/form-state';
import { inviteAction } from '@/server/work-actions';
import { SubmitButton } from './submit-button';
import { ErrorNotice } from './ui';

const INITIAL: InviteFormState = {};

/**
 * Creates an invitation, and shows its link here and nowhere else. The link lives in this render's
 * memory: leave the page or reload it, and it is gone, so it has to be copied now.
 */
export function InviteForm({ organizationId }: { organizationId: string }) {
  const [state, action] = useActionState(inviteAction, INITIAL);
  return (
    <>
      <ErrorNotice code={state.code} />
      {state.link && (
        <div className="notice good" role="status">
          <label>
            Invitation link
            <input readOnly value={state.link} />
          </label>
          <p style={{ margin: '0.5rem 0 0' }}>
            This link is shown once, so copy it now and send it privately. It works once, for the
            email address you invited. It expires in 7 days, or as soon as you lose the right to
            invite people. If that person&apos;s address has not been proven, you confirm them here
            before they can join.
          </p>
        </div>
      )}
      <form className="fields" action={action} style={{ marginTop: '0.75rem' }}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <label>
          Email address
          <input
            name="email"
            type="email"
            required
            autoComplete="off"
            defaultValue={state.values?.email ?? ''}
          />
        </label>
        <label>
          Access
          <select name="role" defaultValue={state.values?.role ?? 'member'}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <div>
          <SubmitButton>Create invitation</SubmitButton>
        </div>
      </form>
    </>
  );
}
