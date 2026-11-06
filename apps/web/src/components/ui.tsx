// Shared display pieces (UX-11). Copy follows the spec's employee-facing terms: "work", "approval"
// and plain status words, never internal names.
import { messageFor } from '@/lib/messages';
import type { ReactNode } from 'react';

const STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: 'Waiting to start', tone: '' },
  ready: { label: 'Ready', tone: 'active' },
  running: { label: 'In progress', tone: 'active' },
  blocked: { label: 'Blocked', tone: 'attention' },
  awaiting_approval: { label: 'Waiting for approval', tone: 'attention' },
  verifying: { label: 'Checking', tone: 'active' },
  completed: { label: 'Done', tone: 'done' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Stopped', tone: '' },
  closed: { label: 'Closed', tone: '' },
  outdated: { label: 'Out of date', tone: 'attention' },
  pending: { label: 'Waiting', tone: 'attention' },
  approved: { label: 'Approved', tone: 'done' },
  denied: { label: 'Denied', tone: 'bad' },
  expired: { label: 'Expired', tone: '' },
};

export function StatusBadge({ status }: { status: string }) {
  const known = STATUS[status] ?? { label: status, tone: '' };
  return <span className={`badge ${known.tone}`}>{known.label}</span>;
}

const CLASSIFICATION: Record<string, string> = {
  public: 'Public',
  internal: 'Internal',
  confidential: 'Confidential',
  restricted: 'Restricted',
};

export function ClassificationBadge({ value }: { value: string }) {
  const tone = value === 'restricted' || value === 'confidential' ? 'attention' : '';
  return <span className={`badge ${tone}`}>{CLASSIFICATION[value] ?? value}</span>;
}

export function PageHead({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}

/** Shows one known error. Unknown codes get a generic line, so URLs cannot inject text. */
export function ErrorNotice({ code }: { code?: string | undefined }) {
  if (!code) return null;
  return (
    <p className="notice error" role="alert">
      {messageFor(code)}
    </p>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p>{children}</p>
      {action}
    </div>
  );
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

export const formatDate = (value: Date) => dateFormat.format(value);
export const formatDateTime = (value: Date) => `${dateTimeFormat.format(value)} UTC`;

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export const toDateInput = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : '');
