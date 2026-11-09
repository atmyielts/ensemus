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
  work_blocked_by_prerequisite: 'A visible prerequisite is not complete',
  work_owner_disabled: 'The accountable owner is no longer active',
  approval_waiting_past_expiry_window: 'An approval is nearing its expiry',
  external_action_unknown: 'Delivery is not confirmed',
  external_action_failed: 'An external action failed',
  process_run_failed: 'A process run failed',
  agent_run_stopped: 'An assistant run stopped',
};
const parts: Record<PulsePartial, string> = {
  work: 'work',
  approvals: 'approvals',
  external_actions: 'external actions',
  agent_runs: 'assistant activity',
  process_runs: 'process activity',
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
    <p className="notice" role="status">
      This is a partial view of {partial.map((part) => parts[part]).join(', ')}. A source could not
      be read or reached this page’s review limit. Missing signals do not mean those areas are
      clear. <Link href={`/o/${organizationId}/work`}>Open Work to review individual records</Link>.
    </p>
  );
}

function evidenceHref(base: string, signal: PulseSignalView, item: PulseEvidence) {
  if (item.kind === 'approval') return `${base}/approvals/${item.id}`;
  if (item.kind === 'external_action') return `${base}/external-actions/${item.id}`;
  if (item.kind === 'process_run') return `${base}/pulse/signals/${encodeURIComponent(signal.key)}`;
  return `${base}/work/${signal.work.id}`;
}
const evidenceLabel: Record<PulseEvidence['kind'], string> = {
  work_unit: 'Work record',
  approval: 'Approval record',
  external_action: 'Action and receipt',
  process_run: 'Process outcome record',
  agent_run: 'Assistant run on Work',
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
  return (
    <article aria-labelledby={labelId} className="stack">
      <div className="row">
        <h3 id={labelId}>
          <Link href={`${base}/work/${signal.work.id}`}>{signal.work.title}</Link>
        </h3>
        <span className={`badge ${signal.severity === 'attention' ? 'attention' : ''}`}>
          {signal.severity === 'attention' ? 'Needs attention' : 'Watch'}
        </span>
      </div>
      <p>{pulseWords[signal.kind]}</p>
      <p className="muted">
        Source records are linked below.{' '}
        {signal.personalState === 'snoozed' &&
          `Snoozed until ${formatDateTime(signal.snoozedUntil!)}.`}
        {signal.personalState === 'dismissed' && 'Dismissed only for you.'}
      </p>
      <ul>
        {signal.evidence.map((item) => (
          <li key={`${item.kind}:${item.id}`}>
            <Link href={evidenceHref(base, signal, item)}>{evidenceLabel[item.kind]}</Link>
          </li>
        ))}
      </ul>
      {showControls && (
        <div className="row">
          {signal.personalState === 'open' ? (
            <>
              <form action={setPulseSignalStateAction}>
                {hidden(organizationId, signal)}
                <input type="hidden" name="state" value="dismissed" />
                <SubmitButton className="secondary" label={controlName('Dismiss for me', signal)}>
                  Dismiss for me
                </SubmitButton>
              </form>
              <form action={setPulseSignalStateAction} className="row">
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
            </>
          ) : (
            <form action={setPulseSignalStateAction}>
              {hidden(organizationId, signal)}
              <input type="hidden" name="state" value="open" />
              <SubmitButton className="secondary" label={controlName('Restore for me', signal)}>
                Restore for me
              </SubmitButton>
            </form>
          )}
        </div>
      )}
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
    <section className="stack" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <ul className="list">
        {signals.map((signal) => (
          <li key={signal.key}>
            <PulseSignalRow organizationId={organizationId} signal={signal} />
          </li>
        ))}
      </ul>
    </section>
  );
}
