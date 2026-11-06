'use client';

import { useActionState } from 'react';
import {
  proposeEmailFormAction,
  reviseEmailFormAction,
  type EmailDraft,
  type EmailFormState,
} from '@/server/external-action-actions';
import { SubmitButton } from './submit-button';
import { ErrorNotice } from './ui';

const INITIAL: EmailFormState = {};

const FIELD_HELP: Partial<Record<keyof EmailDraft, string>> = {
  connectionId: 'Choose which mail server this goes through.',
  approverMembershipId: 'Choose who approves this.',
  to: 'Check these addresses. Each one needs to be a whole email address.',
  cc: 'Check these addresses. Each one needs to be a whole email address.',
  bcc: 'Check these addresses. Each one needs to be a whole email address.',
  replyTo: 'That is not a whole email address.',
  subject: 'Write a subject of up to 200 characters, on one line.',
  textBody: 'Write the message.',
};

/**
 * Proposes an email, or changes one that has not been tried yet. A refused form comes back with what was
 * typed, with or without JavaScript. The sender is not a field: it comes from the connection, on the
 * server. Nothing leaves until the person chosen here approves exactly this.
 */
export function NewEmailForm({
  organizationId,
  target,
  connections,
  approvers,
  defaults,
  requestKey,
}: {
  organizationId: string;
  target:
    | { kind: 'propose'; workUnitId: string }
    | { kind: 'revise'; externalActionId: string; version: number };
  connections: ReadonlyArray<{ id: string; label: string }>;
  approvers: ReadonlyArray<{ id: string; label: string }>;
  defaults?: Partial<EmailDraft>;
  requestKey: string;
}) {
  const [state, action] = useActionState(
    target.kind === 'propose' ? proposeEmailFormAction : reviseEmailFormAction,
    INITIAL,
  );
  const value = (name: keyof EmailDraft) => state.values?.[name] ?? defaults?.[name] ?? '';
  const invalid = (name: keyof EmailDraft) => state.field === name;
  const help = (name: keyof EmailDraft) =>
    invalid(name) ? <small className="field-error">{FIELD_HELP[name]}</small> : null;

  return (
    <>
      <ErrorNotice code={state.code} />
      <form className="fields" action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="requestKey" value={requestKey} />
        {target.kind === 'propose' ? (
          <>
            <input type="hidden" name="workUnitId" value={target.workUnitId} />
            <label>
              Send through
              {help('connectionId')}
              {/* The key brings a refused choice back: React only reads defaultValue on a new select. */}
              <select
                key={`connection-${value('connectionId')}`}
                name="connectionId"
                required
                defaultValue={value('connectionId')}
                aria-invalid={invalid('connectionId')}
              >
                <option value="" disabled>
                  Choose a connection
                </option>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <input type="hidden" name="id" value={target.externalActionId} />
            <input type="hidden" name="version" value={target.version} />
          </>
        )}
        <label>
          To
          <small>One or more addresses, separated by commas.</small>
          {help('to')}
          <textarea
            name="to"
            required
            rows={2}
            defaultValue={value('to')}
            aria-invalid={invalid('to')}
          />
        </label>
        <label>
          Copy to
          <small>Optional.</small>
          {help('cc')}
          <input name="cc" defaultValue={value('cc')} aria-invalid={invalid('cc')} />
        </label>
        <label>
          Blind copy to
          <small>Optional. The other recipients do not see these, and your approver does.</small>
          {help('bcc')}
          <input name="bcc" defaultValue={value('bcc')} aria-invalid={invalid('bcc')} />
        </label>
        <label>
          Replies go to
          <small>Optional.</small>
          {help('replyTo')}
          <input
            name="replyTo"
            type="email"
            defaultValue={value('replyTo')}
            aria-invalid={invalid('replyTo')}
          />
        </label>
        <label>
          Subject
          {help('subject')}
          <input
            name="subject"
            required
            maxLength={200}
            autoComplete="off"
            defaultValue={value('subject')}
            aria-invalid={invalid('subject')}
          />
        </label>
        <label>
          Message
          <small>Plain text. It is sent exactly as written.</small>
          {help('textBody')}
          <textarea
            name="textBody"
            required
            rows={8}
            maxLength={200000}
            defaultValue={value('textBody')}
            aria-invalid={invalid('textBody')}
          />
        </label>
        <label>
          Who approves it?
          <small>Someone other than you, who can see this work. They see exactly this.</small>
          {help('approverMembershipId')}
          <select
            key={`approver-${value('approverMembershipId')}`}
            name="approverMembershipId"
            required
            defaultValue={value('approverMembershipId')}
            aria-invalid={invalid('approverMembershipId')}
          >
            <option value="" disabled>
              Choose a person
            </option>
            {approvers.map((approver) => (
              <option key={approver.id} value={approver.id}>
                {approver.label}
              </option>
            ))}
          </select>
        </label>
        <small>
          {target.kind === 'propose'
            ? 'Nothing is sent until they approve. Once it goes it cannot be taken back.'
            : 'This closes the current version and its approval, even if it was already approved, and asks for a new one.'}
        </small>
        <div>
          <SubmitButton>
            {target.kind === 'propose' ? 'Ask for approval' : 'Replace it and ask again'}
          </SubmitButton>
        </div>
      </form>
    </>
  );
}
