import Link from 'next/link';
import type { PulsePartial, PulseSignalView } from '@ensemus/application/pulse';
import type { PulseEvidence, PulseSignalKind } from '@ensemus/domain/pulse';
import { SubmitButton } from '../submit-button';
import { formatDateTime } from '../ui';
import { labelInName } from '@/lib/label-in-name';
import { setPulseSignalStateAction } from '@/server/pulse-actions';

export const pulseWords: Record<PulseSignalKind, string> = {
  work_overdue: 'The due date has passed',
  work_due_soon: 'Due within two days',
  work_blocked_by_prerequisite: 'Waiting for other work that is not finished',
  work_owner_disabled: 'The person accountable for it is no longer active',
  approval_waiting_past_expiry_window: 'An approval runs out soon',
  external_action_unknown: 'Nobody knows yet whether an email was sent',
  external_action_failed: 'An email could not be sent',
  process_run_failed: 'An automation stopped before it finished',
  agent_run_stopped: 'An assistant stopped before it finished',
};
const parts: Record<PulsePartial, string> = {
  work: 'work',
  approvals: 'approvals',
  external_actions: 'emails sent outside',
  agent_runs: 'assistant activity',
  process_runs: 'automations',
};

export function PulsePartialNotice({
  partial,
  organizationId,
}: {
  partial: readonly PulsePartial[];
  organizationId: string;
}) {
  if (!partial.length) return null;
  return (
    <p className="notice warn" role="status">
      Pulse could not check all of the {partial.map((part) => parts[part]).join(', ')} this time, so
      some signals may be missing. A missing signal does not mean all is well there.{' '}
      <Link href={`/o/${organizationId}/work`}>Open Work to check individual records</Link>.
    </p>
  );
}

function evidenceHref(base: string, signal: PulseSignalView, item: PulseEvidence) {
  if (item.kind === 'approval') return `${base}/approvals/${item.id}`;
  if (item.kind === 'external_action') return `${base}/external-actions/${item.id}`;
  if (item.kind === 'process_run') return `${base}/pulse/signals/${encodeURIComponent(signal.key)}`;
  return `${base}/work/${signal.work.id}`;
}
/** What the one link on a row opens: the record the signal is first about. */
const openLabel: Record<PulseEvidence['kind'], string> = {
  work_unit: 'Open the work',
  approval: 'Open the approval',
  external_action: 'Open the email and its receipts',
  process_run: 'Open what was recorded',
  agent_run: 'Open the work',
};
const evidenceLabel: Record<PulseEvidence['kind'], string> = {
  work_unit: 'the work',
  approval: 'the approval',
  external_action: 'the email and its receipts',
  process_run: 'what was recorded',
  agent_run: 'the assistant run',
};

function hidden(organizationId: string, signal: PulseSignalView) {
  return (
    <>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="signalKey" value={signal.key} />
    </>
  );
}

/** Every row has the same three controls, so each name goes on to say which signal it is for. */
const controlName = (words: string, signal: Pick<PulseSignalView, 'kind' | 'work'>) =>
  labelInName(words, pulseWords[signal.kind], signal.work.title);

export function PulseSignalRow({
  organizationId,
  signal,
  showControls = true,
}: {
  organizationId: string;
  signal: PulseSignalView;
  showControls?: boolean;
}) {
  const base = `/o/${organizationId}`,
    labelId = `pulse-${signal.kind}-${signal.work.id}-${signal.key.split(':')[1]}`;
  const [first] = signal.evidence;
  // A process outcome opens this signal's own page, so on that page the row opens the work instead.
  const opens = !showControls && first.kind === 'process_run' ? 'work_unit' : first.kind;
  const href =
    opens === first.kind ? evidenceHref(base, signal, first) : `${base}/work/${signal.work.id}`;
  return (
    <article aria-labelledby={labelId} className="pulse-signal">
      <div className="pulse-signal-text">
        <div className="row">
          <h3 id={labelId}>
            <Link href={`${base}/work/${signal.work.id}`}>{signal.work.title}</Link>
          </h3>
          <span className={`badge ${signal.severity === 'attention' ? 'attention' : ''}`}>
            {signal.severity === 'attention' ? 'Needs attention' : 'Coming up'}
          </span>
        </div>
        <p className="muted">
          {pulseWords[signal.kind]}.
          {signal.personalState === 'snoozed' && (
            <> Snoozed until {formatDateTime(signal.snoozedUntil!)}.</>
          )}
          {signal.personalState === 'dismissed' && ' Dismissed only for you.'}
        </p>
        {/* Every other record this fact comes from stays one click away. */}
        {signal.evidence.length > 1 && (
          <p className="pulse-also">
            Also from:{' '}
            {signal.evidence.slice(1).map((item, index) => (
              <span key={`${item.kind}:${item.id}`}>
                {index > 0 && ', '}
                <Link href={evidenceHref(base, signal, item)}>{evidenceLabel[item.kind]}</Link>
              </span>
            ))}
          </p>
        )}
      </div>
      <Link
        className="pulse-open"
        href={href}
        aria-label={labelInName(openLabel[opens], signal.work.title)}
      >
        {openLabel[opens]}
        <span aria-hidden="true">&nbsp;→</span>
      </Link>
      {showControls &&
        (signal.personalState === 'open' ? (
          <details className="pulse-controls">
            <summary>Snooze or dismiss</summary>
            <div className="pulse-control-forms">
              <form action={setPulseSignalStateAction} className="inline-form">
                {hidden(organizationId, signal)}
                <input type="hidden" name="state" value="snoozed" />
                <label htmlFor={`${labelId}-days`}>Snooze for</label>
                <select id={`${labelId}-days`} name="days" defaultValue="1">
                  <option value="1">1 day</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                </select>
                <SubmitButton className="secondary" label={controlName('Snooze for me', signal)}>
                  Snooze for me
                </SubmitButton>
              </form>
              <form action={setPulseSignalStateAction}>
                {hidden(organizationId, signal)}
                <input type="hidden" name="state" value="dismissed" />
                <SubmitButton className="ghost" label={controlName('Dismiss for me', signal)}>
                  Dismiss for me
                </SubmitButton>
              </form>
              <small>Only you stop seeing it here. Everyone else still does.</small>
            </div>
          </details>
        ) : (
          <form action={setPulseSignalStateAction} className="pulse-restore">
            {hidden(organizationId, signal)}
            <input type="hidden" name="state" value="open" />
            <SubmitButton className="ghost" label={controlName('Restore for me', signal)}>
              Restore for me
            </SubmitButton>
          </form>
        ))}
    </article>
  );
}

export function PulseSignalGroup({
  organizationId,
  id,
  title,
  signals,
}: {
  organizationId: string;
  id: string;
  title: string;
  signals: readonly PulseSignalView[];
}) {
  if (!signals.length) return null;
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <ul className="list card pulse-list">
        {signals.map((signal) => (
          <li key={signal.key}>
            <PulseSignalRow organizationId={organizationId} signal={signal} />
          </li>
        ))}
      </ul>
    </section>
  );
}
