import { randomUUID } from 'node:crypto';
import type { DerivationRunView, MeetingProcessingOption } from '@ensemus/application';
import { DERIVATION_PURPOSES, type MeetingStopCode } from '@ensemus/domain/meeting';
import { ResourceRefresh } from '@/components/resource-refresh';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice, formatDateTime } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { requestMeetingProcessing } from './processing-actions';

const purposeLabels: Record<DerivationRunView['purpose'], string> = {
  summarize: 'Summary',
  extract_items: 'Follow-up suggestions',
};

const statusLabels: Record<DerivationRunView['status'], string> = {
  requested: 'Queued',
  running: 'Processing',
  completed: 'Ready',
  failed: 'Failed',
  refused: 'Stopped',
  cancelled: 'Cancelled',
};

const reasonLabels: Partial<Record<MeetingStopCode, string>> = {
  MEETINGS_NOT_ENABLED: 'Meeting processing is turned off for this workspace.',
  CONSENT_INCOMPLETE: 'Everyone listed must agree before notes can be processed.',
  CONSENT_WITHDRAWN: 'Someone withdrew consent.',
  PROVIDER_NOT_APPROVED: 'This provider is no longer approved for the request.',
  PROVIDER_APPROVAL_EXPIRED: 'The provider approval expired.',
  CLASSIFICATION_NOT_ALLOWED: 'The approval does not cover the classification of these notes.',
  EGRESS_DENIED: 'Workspace policy blocked the model call.',
  MODEL_UNAVAILABLE: 'The model could not complete the request.',
  MODEL_OUTPUT_INVALID: 'The model returned a result Ensemus could not use.',
  MODEL_TIMEOUT: 'The model call timed out.',
  NOTES_NOT_CURRENT: 'A newer version of the notes replaced this request.',
  MEETING_PURGED: 'The meeting notes were removed.',
};

export function MeetingProcessing({
  organizationId,
  meetingId,
  notes,
  options,
  runs,
  submitted,
  error,
  unavailable,
}: {
  organizationId: string;
  meetingId: string;
  notes: { id: string; version: number };
  options: readonly MeetingProcessingOption[];
  runs: readonly DerivationRunView[];
  submitted: string | undefined;
  error: string | undefined;
  unavailable: string | null;
}) {
  const path = `/o/${organizationId}/meetings/${meetingId}`;
  const active = runs.some((run) => run.status === 'requested' || run.status === 'running');
  return (
    <section className="group" aria-labelledby="meeting-processing">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="meeting-processing">Meeting processing</h2>
        {active && (
          <form action={path + '#meeting-processing'} method="get">
            <Button variant="outline" type="submit" className="min-h-10 sm:min-h-8">
              Refresh status
            </Button>
          </form>
        )}
      </div>
      {options.length > 0 && (
        <form
          action={requestMeetingProcessing.bind(null, {
            organizationId,
            meetingId,
            notesId: notes.id,
          })}
          className="grid min-w-0 gap-3 sm:max-w-xl"
        >
          <input type="hidden" name="requestKey" value={randomUUID()} />
          <p
            id="meeting-processing-description"
            className="max-w-prose text-sm text-muted-foreground"
          >
            Send version {notes.version} of these notes to the approved model you choose.
          </p>
          <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="grid min-w-0 gap-2">
              <Label htmlFor="meeting-processing-choice">Result and provider</Label>
              <NativeSelect
                id="meeting-processing-choice"
                name="processingChoice"
                aria-describedby="meeting-processing-description"
                defaultValue=""
                required
              >
                <NativeSelectOption value="" disabled>
                  Choose a result and provider
                </NativeSelectOption>
                {DERIVATION_PURPOSES.map((purpose) => {
                  const group = options.filter((option) => option.purpose === purpose);
                  return (
                    group.length > 0 && (
                      <NativeSelectOptGroup key={purpose} label={purposeLabels[purpose]}>
                        {group.map((option) => (
                          <NativeSelectOption
                            key={option.approvalId}
                            value={`${purpose}:${option.approvalId}`}
                          >
                            {option.label} · {purposeLabels[purpose]}
                          </NativeSelectOption>
                        ))}
                      </NativeSelectOptGroup>
                    )
                  );
                })}
              </NativeSelect>
            </div>
            <SubmitButton className="min-h-10" working="Queueing request">
              Queue request
            </SubmitButton>
          </div>
        </form>
      )}
      <ErrorNotice code={error} />
      {unavailable && <p className="muted">{unavailable}</p>}
      {runs.some((run) => run.id === submitted) && (
        <p className="notice good" role="status">
          Request submitted.
        </p>
      )}
      {runs.length > 0 && (
        <ul className="list" role="list" aria-label="Recent processing requests" aria-live="polite">
          {runs.map((run) => {
            const reason = run.statusCode ? reasonLabels[run.statusCode] : undefined;
            return (
              <li
                key={run.id}
                className="grid min-w-0 gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <strong>{purposeLabels[run.purpose]}</strong>
                    <time
                      dateTime={run.createdAt.toISOString()}
                      className="text-xs text-muted-foreground"
                    >
                      {formatDateTime(run.createdAt)}
                    </time>
                  </div>
                  {reason && <p className="muted wrap-anywhere">{reason}</p>}
                </div>
                <Badge variant={run.status === 'failed' ? 'destructive' : 'outline'}>
                  {statusLabels[run.status]}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
      <ResourceRefresh active={active} announce={false} />
    </section>
  );
}
