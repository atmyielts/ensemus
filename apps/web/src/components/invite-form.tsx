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
          <p className="gap-above">
            This link is shown once, so copy it now and send it privately. It works once, for the
            email address you invited. It expires in 7 days, or as soon as you lose the right to
            invite people. If that person&apos;s address has not been proven, you confirm them here
            before they can join.
          </p>
        </div>
      )}
      <form className="inline-form" action={action}>
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
        <label style={{ flex: '0 1 9rem' }}>
          Access
          {/* The key brings a refused choice back: React only reads defaultValue on a new select. */}
          <select
            key={state.values?.role}
            name="role"
            defaultValue={state.values?.role ?? 'member'}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <SubmitButton>Create invitation</SubmitButton>
      </form>
    </>
  );
}
