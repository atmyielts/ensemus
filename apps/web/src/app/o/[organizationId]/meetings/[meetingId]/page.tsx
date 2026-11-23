import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { AppError, getMeeting, getMeetingSettings, listDirectory } from '@ensemus/application';
import {
  BackLink,
  ClassificationBadge,
  ErrorNotice,
  PageHead,
  formatDateTime,
} from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { SubmitButton } from '@/components/submit-button';
import { ConfirmForm } from '@/components/confirm-form';
import { requireTenant } from '@/server/tenant';
import { MeetingForm } from '../meeting-form';
import { consentAction, removeParticipantAction } from '../actions';
export const metadata = { title: 'Meeting | Ensemus' };
export default async function MeetingPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; meetingId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, meetingId } = await params,
    { actor, database, context } = await requireTenant(organizationId);
  let meeting;
  try {
    meeting = await getMeeting(database, context, meetingId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }
  const settings = await getMeetingSettings(database, context),
    organizer = meeting.organizerMembershipId === context.membershipId,
    readable = meeting.title !== null,
    open = meeting.status === 'open';
  const people =
    organizer && open && !meeting.currentNotes
      ? (await listDirectory(database, context))
          .filter(
            (p) =>
              p.status === 'active' &&
              !meeting.participants.some((x) => x.membershipId === p.membershipId),
          )
          .map((p) => ({ membershipId: p.membershipId, name: p.name }))
      : [];
  const shared = (participantId: string) => (
    <>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="meetingId" value={meetingId} />
      <input type="hidden" name="participantId" value={participantId} />
      <input type="hidden" name="noticeRef" value={settings.noticeRef ?? ''} />
    </>
  );
  return (
    <>
      <BackLink href={`/o/${organizationId}/meetings`}>Meetings</BackLink>
      <PageHead
        title={meeting.title ?? 'Private meeting'}
        description={formatDateTime(meeting.occurredAt)}
      />
      <ErrorNotice code={(await searchParams).error} />
      <div className="row">
        <ClassificationBadge value={meeting.classification} />
        <Badge variant="outline">
          {meeting.status === 'purged'
            ? 'Removed after withdrawal'
            : meeting.consent === 'complete'
              ? 'Everyone agreed'
              : meeting.consent === 'pending'
                ? 'Awaiting consent'
                : meeting.consent}
        </Badge>
      </div>
      {!readable ? (
        <p className="notice">
          You can see this meeting’s status. Its title, participants and notes are private to the
          people in the room.
        </p>
      ) : (
        <>
          {meeting.status === 'purged' && (
            <p className="notice">
              Consent was withdrawn. Notes and derived content have been removed. A provider may
              already have received an earlier copy; withdrawal cannot recall that.
            </p>
          )}
          <section className="group" aria-labelledby="participants-heading">
            <h2 id="participants-heading">Participants and consent</h2>
            <p className="muted">
              Notice reference: {settings.noticeRef ?? 'Not set'}. Your organization holds the
              notice. Agreement covers storing notes and processing by any separately approved
              providers, not general administrator access.
            </p>
            <ul className="list">
              {meeting.participants.map((p) => (
                <li key={p.id}>
                  <div className="row spread">
                    <strong>{p.displayName}</strong>
                    <Badge variant="outline">{p.decision ?? 'Not answered'}</Badge>
                  </div>
                  {p.basis === 'attested' && (
                    <p className="muted">Attested by the organizer for an outside participant.</p>
                  )}
                  {open &&
                    (p.membershipId === context.membershipId ||
                      (organizer && p.kind === 'external')) && (
                      <div className="row">
                        {settings.enabled && (
                          <form action={consentAction}>
                            {shared(p.id)}
                            <input type="hidden" name="decision" value="granted" />
                            <SubmitButton working="Recording">
                              {p.kind === 'external' ? 'Attest agreement' : 'I agree'}
                            </SubmitButton>
                          </form>
                        )}
                        {settings.enabled && !meeting.currentNotes && (
                          <form action={consentAction}>
                            {shared(p.id)}
                            <input type="hidden" name="decision" value="declined" />
                            <SubmitButton working="Recording">
                              {p.kind === 'external' ? 'Attest refusal' : 'Decline'}
                            </SubmitButton>
                          </form>
                        )}
                        <ConfirmForm
                          action={consentAction}
                          fields={
                            <>
                              {shared(p.id)}
                              <input type="hidden" name="decision" value="withdrawn" />
                            </>
                          }
                          summary={p.kind === 'external' ? 'Attest withdrawal' : 'Withdraw consent'}
                          summaryLabel={`Withdraw consent: ${p.displayName}`}
                          consequence="This permanently removes every version of the meeting’s notes and derived content. People and providers may already have read it. Work someone separately created stays."
                          confirmLabel="Withdraw and remove notes"
                          confirmFullLabel={`Withdraw and remove notes: ${p.displayName}`}
                        />
                      </div>
                    )}
                  {organizer &&
                    open &&
                    !meeting.currentNotes &&
                    p.decision === null &&
                    p.membershipId !== context.membershipId && (
                      <form action={removeParticipantAction}>
                        {shared(p.id)}
                        <input type="hidden" name="version" value={meeting.version} />
                        <SubmitButton working="Removing">Remove participant</SubmitButton>
                      </form>
                    )}
                </li>
              ))}
            </ul>
            {organizer && open && !meeting.currentNotes && (
              <MeetingForm
                summary="Add someone"
                key={actor.userId + '-participant'}
                kind="participant"
                organizationId={organizationId}
                meetingId={meetingId}
                version={meeting.version}
                people={people}
              />
            )}
          </section>
          <section className="group" aria-labelledby="notes-heading">
            <h2 id="notes-heading">Notes</h2>
            {meeting.currentNotes?.text ? (
              <>
                <p className="muted">
                  Version {meeting.currentNotes.version} ·{' '}
                  {formatDateTime(meeting.currentNotes.createdAt)}
                </p>
                <div className="whitespace-pre-wrap break-words">{meeting.currentNotes.text}</div>
              </>
            ) : (
              <p className="muted">{open ? 'No notes stored.' : 'Notes removed.'}</p>
            )}
            {organizer &&
              open &&
              settings.enabled &&
              (meeting.consent === 'complete' ? (
                <MeetingForm
                  summary={meeting.currentNotes ? 'Store a new version' : 'Add notes'}
                  key={actor.userId + '-notes'}
                  kind="notes"
                  initialText={meeting.currentNotes?.text ?? ''}
                  organizationId={organizationId}
                  meetingId={meetingId}
                  requestKey={randomUUID()}
                />
              ) : (
                <p className="muted">Everyone listed must agree before notes can be stored.</p>
              ))}
          </section>
        </>
      )}
    </>
  );
}
