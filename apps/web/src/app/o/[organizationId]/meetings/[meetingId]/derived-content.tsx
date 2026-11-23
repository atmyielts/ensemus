import { randomUUID } from 'node:crypto';
import type { MeetingSummaryTextView, ProposedItemView } from '@ensemus/application';
import { ConfirmForm } from '@/components/confirm-form';
import { SubmitButton } from '@/components/submit-button';
import { formatDateTime } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { decideMeetingProposal } from './proposal-actions';
import { ProposalWorkForm } from './proposal-work-form';

const labels: Record<ProposedItemView['status'], string> = {
  proposed: 'Suggested',
  accepted: 'Accepted',
  rejected: 'Dismissed',
  withdrawn: 'Removed',
};

export function MeetingDerivedContent({
  organizationId,
  meetingId,
  currentMember,
  summaries,
  proposals,
  people,
  notice,
  mayDecide,
}: {
  organizationId: string;
  meetingId: string;
  currentMember: string;
  summaries: readonly MeetingSummaryTextView[];
  proposals: readonly ProposedItemView[];
  people: readonly { id: string; name: string }[];
  notice?: string;
  mayDecide: boolean;
}) {
  return (
    <>
      {summaries.length > 0 && (
        <section className="stack" aria-labelledby="meeting-summaries">
          <h2 id="meeting-summaries">Summaries</h2>
          <ul className="list">
            {summaries.map((summary) => (
              <li key={summary.id} className="block">
                <div className="row">
                  <Badge variant="outline">Model-generated</Badge>
                  <small>{formatDateTime(summary.createdAt)}</small>
                </div>
                <p className="whitespace-pre-wrap wrap-anywhere">
                  {summary.text ?? 'Summary removed.'}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {proposals.length > 0 && (
        <section className="stack" aria-labelledby="meeting-suggestions">
          <h2 id="meeting-suggestions">Suggested work and decisions</h2>
          {(notice === 'accepted' || notice === 'rejected') && (
            <p className="notice good" role="status">
              {notice === 'accepted' ? 'Decision recorded.' : 'Suggestion dismissed.'}
            </p>
          )}
          <ul className="list">
            {proposals.map((item) => {
              const target = { organizationId, meetingId, itemId: item.id, version: item.version };
              const active = mayDecide && item.status === 'proposed' && item.title !== null;
              const suggestedOwner = item.suggestedOwnerMembershipId;
              const owner = people.some((person) => person.id === suggestedOwner)
                ? suggestedOwner!
                : currentMember;
              return (
                <li key={item.id} className="block">
                  <div className="row">
                    <strong className="wrap-anywhere">{item.title ?? 'Suggestion removed'}</strong>
                    <Badge variant="outline">{item.kind === 'work' ? 'Work' : 'Decision'}</Badge>
                    <Badge variant="outline">{labels[item.status]}</Badge>
                  </div>
                  {item.detail && (
                    <p className="whitespace-pre-wrap wrap-anywhere">{item.detail}</p>
                  )}
                  {item.workUnitId && <p className="muted">Work created</p>}
                  {active && (
                    <>
                      {item.kind === 'work' && people.length > 0 && (
                        <ProposalWorkForm
                          target={target}
                          requestKey={randomUUID()}
                          people={people}
                          initial={{
                            title: item.title ?? '',
                            objective: item.detail ?? '',
                            owner,
                            due: item.suggestedDueOn ? item.suggestedDueOn + 'T00:00' : '',
                          }}
                        />
                      )}
                      {item.kind === 'decision' && (
                        <form action={decideMeetingProposal.bind(null, target, 'accept')}>
                          <SubmitButton className="secondary" working="Recording">
                            Record decision
                          </SubmitButton>
                        </form>
                      )}
                      <ConfirmForm
                        action={decideMeetingProposal.bind(null, target, 'reject')}
                        fields={null}
                        summary="Dismiss"
                        summaryLabel={'Dismiss ' + item.title}
                        consequence="Dismiss this suggestion from the list of items to review."
                        confirmLabel="Dismiss suggestion"
                      />
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
