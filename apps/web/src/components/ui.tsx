// Shared display pieces (UX-11). Copy follows the spec's employee-facing terms: "work", "approval"
// and plain status words, never internal names.
import Link from 'next/link';
import { messageFor } from '@/lib/messages';
import type { ReactNode } from 'react';
import { NavigationIcon } from './navigation-icon';
import type { NavigationIcon as NavigationIconName } from './navigation-model';

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
  paused: { label: 'Paused', tone: 'attention' },
  waiting_for_approval: { label: 'Waiting for approval', tone: 'attention' },
  waiting_for_child: { label: 'Waiting for a delegated task', tone: 'active' },
  preparing: { label: 'Preparing', tone: 'active' },
  budget_exhausted: { label: 'Spending limit reached', tone: 'bad' },
  policy_denied: { label: 'Stopped by a rule', tone: 'bad' },
  timed_out: { label: 'Time limit reached', tone: 'bad' },
  outcome_unverified: { label: 'Needs a result check', tone: 'attention' },
  unknown: { label: 'Delivery unknown', tone: 'unknown' },
  unknown_external_state: { label: 'Delivery unknown', tone: 'unknown' },
  draft: { label: 'Draft', tone: '' },
  active: { label: 'Active', tone: 'done' },
  probing: { label: 'Checking the connection', tone: 'active' },
  disabled: { label: 'Disabled', tone: '' },
  retired: { label: 'Retired', tone: '' },
  revoked: { label: 'Revoked', tone: '' },
};

/** How to name someone in a list of choices. Their address appears only if this viewer may see it. */
export function personLabel(person: { name: string; email: string | null }) {
  return person.email ? `${person.name} (${person.email})` : person.name;
}

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

/** The product's name, above the pages shown outside an organization. */
export function Wordmark() {
  return (
    <Link className="wordmark" href="/">
      Ensemus
    </Link>
  );
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

export function Empty({
  children,
  action,
  title,
}: {
  children: ReactNode;
  action?: ReactNode;
  title?: string;
}) {
  return (
    <div className="empty">
      {title && <strong className="empty-title">{title}</strong>}
      <p>{children}</p>
      {action}
    </div>
  );
}

/** A destination is one clear linked row, consistently used by settings and builder overviews. */
export function DestinationList({
  items,
  label,
}: {
  items: readonly {
    href: string;
    label: string;
    description: string;
    icon: NavigationIconName;
  }[];
  label: string;
}) {
  return (
    <ul className="destination-list" aria-label={label}>
      {items.map((item) => (
        <li key={item.href}>
          <Link href={item.href} className="destination-row">
            <span className="destination-icon">
              <NavigationIcon name={item.icon} />
            </span>
            <span className="destination-copy">
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </span>
            <span className="destination-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <p className="back">
      <Link href={href}>
        <span aria-hidden="true">← </span>
        {children}
      </Link>
    </p>
  );
}

/** Ordinary links keep full no-JavaScript behavior. All equivalent action variants share CSS. */
export function ActionLink({
  href,
  children,
  variant = 'primary',
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'quiet';
}) {
  return (
    <Link
      className={`button${variant === 'primary' ? '' : ` ${variant === 'quiet' ? 'ghost' : variant}`}`}
      href={href}
    >
      {children}
    </Link>
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
