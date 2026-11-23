'use client';
import { useActionState, useState } from 'react';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorNotice } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { stepUpPath } from '@/lib/step-up';
import { saveMeetingAction } from './actions';
import type { MeetingFormKind, MeetingFormState } from './form-state';
export function MeetingForm({
  kind,
  organizationId,
  meetingId,
  version,
  requestKey,
  noticeRef,
  enabled,
  people = [],
  sources = [],
  initialText,
  summary,
  disclosureClassName,
}: {
  summary?: string;
  disclosureClassName?: string;
  initialText?: string;
  kind: MeetingFormKind;
  organizationId: string;
  meetingId?: string;
  version?: number;
  requestKey?: string;
  noticeRef?: string | null;
  enabled?: boolean;
  people?: readonly { membershipId: string; name: string }[];
  sources?: readonly { resourceId: string; title: string | null; connectionName: string }[];
}) {
  const [state, action, pending] = useActionState<MeetingFormState, FormData>(
    saveMeetingAction,
    {},
  );
  const [draft, setDraft] = useState<Record<string, string>>({});
  const values = state.values ?? {};
  const field = (name: string, fallback = '') => draft[name] ?? values[name] ?? fallback;
  const change = (name: string, value: string) =>
    setDraft((previous) => ({ ...values, ...previous, [name]: value }));
  const content = (
    <>
      <ErrorNotice code={state.code} />
      {state.code === 'VERSION_CONFLICT' && (
        <p>
          Your entries are kept.{' '}
          <a
            href={
              meetingId
                ? `/o/${organizationId}/meetings/${meetingId}`
                : `/o/${organizationId}/meetings`
            }
          >
            Reload the current meeting
          </a>{' '}
          before trying again.
        </p>
      )}
      {state.code === 'MFA_REQUIRED' && (
        <p>
          <Link href={stepUpPath(organizationId, `/o/${organizationId}/meetings`)}>
            Confirm your identity
          </Link>{' '}
          before changing these settings.
        </p>
      )}
      {state.saved && (
        <p className="notice good" role="status">
          {kind === 'notes'
            ? 'Notes stored.'
            : kind === 'participant'
              ? 'Participant added.'
              : 'Meeting settings saved.'}
        </p>
      )}
      <form className="fields" action={action}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="kind" value={kind} />
        {meetingId && <input type="hidden" name="meetingId" value={meetingId} />}
        {version !== undefined && <input type="hidden" name="version" value={version} />}
        {requestKey && <input type="hidden" name="requestKey" value={requestKey} />}
        {kind === 'settings' && (
          <>
            <Label>
              <input
                type="checkbox"
                name="enabled"
                value="yes"
                checked={field('enabled', enabled ? 'yes' : '') === 'yes'}
                onChange={(e) => change('enabled', e.target.checked ? 'yes' : '')}
                disabled={pending}
              />{' '}
              Allow new meetings
            </Label>
            <Label>
              Notice reference
              <small>
                Your organization holds the notice itself. Enter its document name or version;
                Ensemus supplies no legal terms.
              </small>
              <Input
                name="noticeRef"
                maxLength={200}
                value={field('noticeRef', noticeRef ?? '')}
                onChange={(e) => change('noticeRef', e.target.value)}
                disabled={pending}
              />
            </Label>
            <p className="muted">
              Switching this off stops new meetings and notes. Participants can still withdraw. Keep
              the notice reference available for them.
            </p>
          </>
        )}
        {kind === 'create' && (
          <>
            {sources.length > 0 && (
              <Label>
                Notes source
                <NativeSelect
                  name="resourceId"
                  value={field('resourceId')}
                  onChange={(e) => change('resourceId', e.target.value)}
                  disabled={pending}
                >
                  <option value="">Add notes manually</option>
                  {sources.map((source) => (
                    <option key={source.resourceId} value={source.resourceId}>
                      {source.title ?? 'Untitled note'} · {source.connectionName}
                    </option>
                  ))}
                </NativeSelect>
              </Label>
            )}
            <Label>
              Meeting title
              <Input
                name="title"
                required
                maxLength={300}
                value={field('title')}
                onChange={(e) => change('title', e.target.value)}
                disabled={pending}
              />
            </Label>
            <Label>
              Occurred at (UTC)
              <Input
                name="occurredAt"
                type="datetime-local"
                required
                value={field('occurredAt')}
                onChange={(e) => change('occurredAt', e.target.value)}
                disabled={pending}
              />
            </Label>
            <Label>
              Classification
              <select
                name="classification"
                value={field('classification', 'confidential')}
                onChange={(e) => change('classification', e.target.value)}
                disabled={pending}
              >
                <option value="public">Public</option>
                <option value="internal">Internal</option>
                <option value="confidential">Confidential</option>
                <option value="restricted">Restricted</option>
              </select>
            </Label>
            <p className="muted">
              The organizer is listed automatically. No notes are stored until everyone listed
              agrees.
            </p>
          </>
        )}
        {kind === 'participant' && (
          <>
            <Label>
              Participant type
              <select
                name="participantKind"
                value={field('participantKind', 'member')}
                disabled={pending}
                onChange={(e) => change('participantKind', e.target.value)}
              >
                <option value="member">Company member</option>
                <option value="external">Someone outside the company</option>
              </select>
            </Label>
            <Label>
              Company member
              <select
                name="membershipId"
                value={field('membershipId')}
                onChange={(e) => change('membershipId', e.target.value)}
                disabled={pending}
              >
                <option value="">Choose a person</option>
                {people.map((p) => (
                  <option key={p.membershipId} value={p.membershipId}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Label>
            <Label>
              Outside participant name
              <small>
                For someone outside the company, enter their name instead. The organizer records
                their answer as an attestation.
              </small>
              <Input
                name="label"
                maxLength={200}
                value={field('label')}
                onChange={(e) => change('label', e.target.value)}
                disabled={pending}
              />
            </Label>
          </>
        )}
        {kind === 'notes' && (
          <>
            <Label>
              Meeting notes
              <Textarea
                name="text"
                required
                rows={12}
                maxLength={524288}
                value={field('text', initialText ?? '')}
                onChange={(e) => change('text', e.target.value)}
                disabled={pending}
              />
            </Label>
            <p className="muted">
              Stored as a new version. Only the organizer and listed participants can read it. No
              model or outside provider is called.
            </p>
          </>
        )}
        <div>
          <SubmitButton working="Saving">
            {kind === 'settings'
              ? 'Save meeting settings'
              : kind === 'create'
                ? 'Create meeting'
                : kind === 'participant'
                  ? 'Add participant'
                  : 'Store notes'}
          </SubmitButton>
        </div>
      </form>
    </>
  );
  return summary ? (
    <details className={disclosureClassName} open={state.code || state.saved ? true : undefined}>
      <summary>{summary}</summary>
      {content}
    </details>
  ) : (
    content
  );
}
