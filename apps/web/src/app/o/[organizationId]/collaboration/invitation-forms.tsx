'use client';

import { useActionState } from 'react';
import { ErrorNotice, formatDateTime } from '@/components/ui';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { SubmitButton } from '@/components/submit-button';
import { ConfirmForm } from '@/components/confirm-form';
import type { GrantTerms } from '@ensemus/domain/federation';
import {
  previewAction,
  proposeAction,
  updateCollaboration,
  type InvitationState,
  type ProposalState,
} from './actions';

const kinds = { work_summary: 'Work summary', artifact: 'File', status_update: 'Status update' };
export function GrantScope({ terms }: { terms: GrantTerms }) {
  return (
    <dl className="grid gap-2 text-sm">
      <div>
        <dt className="text-muted-foreground">Purpose</dt>
        <dd>{terms.purpose === 'delegated_work' ? 'Delegated work' : 'Document review'}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Highest classification</dt>
        <dd className="capitalize">{terms.max_classification}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Sharing side may send</dt>
        <dd>{terms.forward_kinds.map((kind) => kinds[kind]).join(', ')}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Receiving side may send</dt>
        <dd>{terms.return_kinds.map((kind) => kinds[kind]).join(', ')}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Grant expires</dt>
        <dd>{formatDateTime(new Date(terms.expires_at))}</dd>
      </div>
      {terms.note && (
        <div className="min-w-0">
          <dt className="text-muted-foreground">Note</dt>
          <dd className="wrap-anywhere">{terms.note}</dd>
        </div>
      )}
    </dl>
  );
}

export function InvitationForms({
  org,
  requestKey,
  acceptanceKey,
}: {
  org: string;
  requestKey: string;
  acceptanceKey: string;
}) {
  const [offer, propose] = useActionState<ProposalState, FormData>(proposeAction, {});
  const [invitation, preview] = useActionState<InvitationState, FormData>(previewAction, {});
  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-2">
      <Card asChild>
        <section className="card min-w-0" aria-labelledby="propose-grant">
          <h2 id="propose-grant">Create invitation</h2>
          <ErrorNotice code={offer.error} />
          {offer.token ? (
            <div className="grid min-w-0 gap-2" role="status">
              <Label htmlFor="new-invitation">Invitation token</Label>
              <Input
                id="new-invitation"
                value={offer.token}
                readOnly
                autoComplete="off"
                className="font-mono"
              />
              <p className="m-0 text-sm text-muted-foreground">
                Copy this token now and give it directly to the other organization. You can retrieve
                it only from this screen.
              </p>
            </div>
          ) : (
            <form action={propose} className="grid min-w-0 gap-3">
              <input type="hidden" name="organizationId" value={org} />
              <input type="hidden" name="requestKey" value={requestKey} />
              <Label>
                Purpose
                <NativeSelect name="purpose">
                  <option value="delegated_work">Delegated work</option>
                  <option value="document_review">Document review</option>
                </NativeSelect>
              </Label>
              <Label>
                Highest classification
                <NativeSelect name="classification" defaultValue="internal">
                  <option value="public">Public</option>
                  <option value="internal">Internal</option>
                  <option value="confidential">Confidential</option>
                </NativeSelect>
              </Label>
              <div className="grid gap-3 sm:grid-cols-2">
                <Label>
                  Grant days
                  <Input
                    name="grantDays"
                    type="number"
                    min={1}
                    max={365}
                    defaultValue={30}
                    required
                  />
                </Label>
                <Label>
                  Invitation days
                  <Input
                    name="invitationDays"
                    type="number"
                    min={1}
                    max={14}
                    defaultValue={7}
                    required
                  />
                </Label>
              </div>
              <Label>
                Note (optional)
                <Textarea name="note" maxLength={2000} />
              </Label>
              <div>
                <SubmitButton working="Creating invitation">Create invitation</SubmitButton>
              </div>
            </form>
          )}
        </section>
      </Card>
      <Card asChild>
        <section className="card min-w-0" aria-labelledby="redeem-grant">
          <h2 id="redeem-grant">Review invitation</h2>
          <ErrorNotice code={invitation.error} />
          <form action={preview} className="grid min-w-0 gap-3">
            <input type="hidden" name="organizationId" value={org} />
            <Label>
              Token from the other organization
              <Input
                name="invitation"
                type="password"
                minLength={16}
                maxLength={256}
                autoComplete="off"
                required
              />
            </Label>
            <div>
              <SubmitButton className="secondary" working="Opening invitation">
                Review invitation
              </SubmitButton>
            </div>
          </form>
          {invitation.preview && (
            <div className="mt-4 grid min-w-0 gap-3">
              <div className="grid min-w-0 gap-1">
                <h3 className="m-0 wrap-anywhere">{invitation.preview.sharing_display_name}</h3>
                <p className="m-0 text-sm text-muted-foreground">
                  Compare this fingerprint with the other organization.
                </p>
                <code className="wrap-anywhere text-sm">
                  {invitation.preview.sharing_fingerprint}
                </code>
              </div>
              <GrantScope terms={invitation.preview.terms} />
              <p className="m-0 text-sm text-muted-foreground">
                Invitation expires{' '}
                {formatDateTime(new Date(invitation.preview.invitation_expires_at))}
              </p>
              <ConfirmForm
                action={updateCollaboration.bind(null, org)}
                fields={
                  <>
                    <input type="hidden" name="requestKey" value={acceptanceKey} />
                    <input type="hidden" name="operation" value="accept" />
                    <input type="hidden" name="invitation" value={invitation.token} />
                    <input type="hidden" name="termsHash" value={invitation.preview.terms_hash} />
                  </>
                }
                summary="Accept invitation"
                confirmLabel="Accept invitation"
                consequence="I have reviewed this scope. The sharing owner must still confirm the recipient."
              />
            </div>
          )}
        </section>
      </Card>
    </div>
  );
}
