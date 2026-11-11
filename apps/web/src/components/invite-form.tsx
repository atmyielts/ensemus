'use client';

import { useActionState, useState, useSyncExternalStore } from 'react';
import type { InviteFormState } from '@/lib/form-state';
import { inviteAction } from '@/server/work-actions';
import { SubmitButton } from './submit-button';
import { ErrorNotice } from './ui';

const INITIAL: InviteFormState = {};

const subscribe = () => () => {};
/** The copy button exists only where it can work: in a browser with a clipboard, never on the server. */
const clipboardReady = () => typeof navigator !== 'undefined' && Boolean(navigator.clipboard);

/** Copies the link. Without JavaScript the button is not there, and the field can be selected and copied. */
function CopyLink({ link }: { link: string }) {
  const ready = useSyncExternalStore(subscribe, clipboardReady, () => false);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  if (!ready) return null;
  return (
    <>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          navigator.clipboard.writeText(link).then(
            () => setCopied('yes'),
            () => setCopied('no'),
          );
        }}
      >
        Copy link
      </button>
      {/* Inside the notice, which is already announced as it changes. */}
      <span className="pending">
        {copied === 'yes'
          ? 'Copied'
          : copied === 'no'
            ? 'Could not copy. Select the link and copy it yourself.'
            : ''}
      </span>
    </>
  );
}

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
        <div className="notice good invite-link" role="status">
          <strong>Your invitation is ready</strong>
          <div className="invite-link-field">
            <label>
              Invitation link
              <input readOnly value={state.link} />
            </label>
            <CopyLink key={state.link} link={state.link} />
          </div>
          <p>
            Copy it now and send it to them privately: it is shown only this once. It works once,
            for the email address you invited, and expires in 7 days, or as soon as you lose the
            right to invite people. If their address has not been proven, you confirm them here
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
        <label className="field-short">
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
