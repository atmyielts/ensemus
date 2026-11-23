import { randomUUID } from 'node:crypto';
import type { getMeetingSourceImportPanel } from '@ensemus/application';
import type { MeetingStopCode } from '@ensemus/domain/meeting';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { SubmitButton } from '@/components/submit-button';
import { formatDateTime } from '@/components/ui';
import { requestConnectedNotesAction } from '../actions';

const REASONS: Partial<Record<MeetingStopCode, string>> = {
  CONNECTOR_UNAVAILABLE: 'The connection could not read the notes.',
  SOURCE_NOT_FOUND: 'The notes are no longer available to you at the source.',
  SOURCE_TOO_LARGE: 'The source notes exceed the 512 KiB limit.',
  PROVIDER_NOT_APPROVED: 'This connection no longer has approval to import the notes.',
  PROVIDER_APPROVAL_EXPIRED: 'The approval for this connection expired.',
  CLASSIFICATION_NOT_ALLOWED: 'The source classification prevents this import.',
  CONSENT_INCOMPLETE: 'Everyone must agree before the notes can be read.',
  CONSENT_WITHDRAWN: 'Someone withdrew their agreement.',
  CONNECTION_NOT_ACTIVE: 'The connection is inactive.',
  MEETINGS_NOT_ENABLED: 'Meeting notes imports are switched off.',
};

export function ConnectedNotes({
  organizationId,
  meetingId,
  panel,
  canRequest,
  hasNotes,
}: {
  organizationId: string;
  meetingId: string;
  panel: Awaited<ReturnType<typeof getMeetingSourceImportPanel>>;
  canRequest: boolean;
  hasNotes: boolean;
}) {
  const path = `/o/${organizationId}/meetings/${meetingId}`;
  const { last, approvals, sourceName } = panel;
  return (
    <div className="grid min-w-0 gap-3 border-t border-border pt-3">
      {sourceName && (
        <p className="m-0 wrap-anywhere text-sm text-muted-foreground">Source · {sourceName}</p>
      )}
      {last?.status === 'requested' && (
        <div className="row">
          <p className="m-0 text-sm" role="status">
            Import queued
          </p>
          <form method="get" action={path + '#notes-heading'}>
            <SubmitButton className="secondary">Refresh import status</SubmitButton>
          </form>
        </div>
      )}
      {last?.status === 'completed' && (
        <p className="m-0 text-sm" role="status">
          Notes imported
        </p>
      )}
      {(last?.status === 'failed' || last?.status === 'refused') && (
        <p className="m-0 text-sm" role="status">
          {(last.statusCode && REASONS[last.statusCode]) ||
            'The import ended before notes were stored.'}
        </p>
      )}
      {canRequest && last?.status !== 'requested' && (!sourceName || approvals.length === 0) && (
        <p className="m-0 text-sm text-muted-foreground">
          {sourceName
            ? 'An administrator must approve this connection before you can import notes.'
            : 'The connected source is unavailable or you no longer have access.'}
        </p>
      )}
      {canRequest && last?.status !== 'requested' && approvals.length > 0 && (
        <form action={requestConnectedNotesAction} className="grid min-w-0 max-w-md gap-3">
          <input type="hidden" name="organizationId" value={organizationId} />
          <input type="hidden" name="meetingId" value={meetingId} />
          <input type="hidden" name="requestKey" value={randomUUID()} />
          <Label>
            Source approval
            <NativeSelect name="providerApprovalId" required>
              {approvals.map((approval) => (
                <option key={approval.id} value={approval.id}>
                  Valid through {formatDateTime(approval.expiresAt)}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <div>
            <SubmitButton working="Queuing import">
              {hasNotes ? 'Import new version' : 'Import notes'}
            </SubmitButton>
          </div>
        </form>
      )}
    </div>
  );
}
