'use client';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';

import { useActionState } from 'react';
import { TICKET_CATEGORIES } from '@ensemus/saas/support';
import { openTicketFormAction, replyTicketFormAction } from '@/server/support-actions';
import { AccountActionNotice } from '@/components/account-action-notice';
import { SubmitButton } from '@/components/submit-button';
export type SupportFormState = {
  values: { subject: string; category: string; body: string };
  version?: number | undefined;
  code?: string;
  sent?: boolean;
};
export function SupportMessageForm({
  organizationId,
  ticket,
}: {
  organizationId: string;
  ticket?: { id: string; version: number };
}) {
  const [state, action] = useActionState(
    ticket ? replyTicketFormAction : openTicketFormAction,
    { values: { subject: '', category: 'other', body: '' }, version: ticket?.version },
    `/o/${organizationId}/account/support${ticket ? `/${ticket.id}` : ''}`,
  );
  return (
    <form className="fields form-width" action={action}>
      <input type="hidden" name="organizationId" value={organizationId} />
      {ticket && (
        <>
          <input type="hidden" name="ticketId" value={ticket.id} />
          <input type="hidden" name="version" value={state.version ?? ticket.version} />
        </>
      )}
      <AccountActionNotice
        code={state.code}
        organizationId={organizationId}
        returnTo={`/o/${organizationId}/account/support${ticket ? `/${ticket.id}` : ''}`}
      />
      {state.sent && (
        <p className="notice good" role="status">
          Reply added.
        </p>
      )}
      {!ticket && (
        <>
          <Label>
            Subject
            <Input name="subject" required maxLength={200} defaultValue={state.values.subject} />
          </Label>
          <Label>
            Category
            <NativeSelect name="category" defaultValue={state.values.category}>
              {TICKET_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </NativeSelect>
          </Label>
        </>
      )}
      <Label>
        {ticket ? 'Your reply' : 'Message'}
        <Textarea
          name="body"
          required
          maxLength={20000}
          rows={6}
          defaultValue={state.values.body}
          aria-describedby="support-message-help"
        />
      </Label>
      <small id="support-message-help">
        Do not paste secrets, credentials or unnecessary personal information.
      </small>
      <div>
        <SubmitButton working={ticket ? 'Adding reply' : 'Opening ticket'}>
          {ticket ? 'Add reply' : 'Open support ticket'}
        </SubmitButton>
      </div>
    </form>
  );
}
