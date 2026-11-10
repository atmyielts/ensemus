// Where someone goes to confirm it is them, and comes back from. Any privileged form redirects here on
// MFA_REQUIRED, so one page holds the code entry (ADR-031 D8). Pure, so a page and an action can both use it.

const OWN_PATH = /^\/o\/[0-9a-f-]{36}(\/[A-Za-z0-9_-]+)*$/;

/**
 * The value comes back from a query string, so it is untrusted. Only a plain path inside this organization
 * passes: no other site, no dot segments, no query. Anything else goes to the organization's home.
 */
export function safeStepUpReturn(organizationId: string, value: unknown): string {
  const home = `/o/${organizationId}`;
  if (typeof value !== 'string' || !OWN_PATH.test(value)) return home;
  return value === home || value.startsWith(`${home}/`) ? value : home;
}

export function stepUpPath(organizationId: string, next: string): string {
  const back = safeStepUpReturn(organizationId, next);
  return `/o/${organizationId}/security/confirm?next=${encodeURIComponent(back)}`;
}

// Account recovery must never turn a paused account action into a core/import destination.
const ACCOUNT_PAGES = new Set([
  'billing',
  'credits',
  'invoices',
  'exports',
  'support',
  'leave',
  'retention',
  'legal-holds',
  'break-glass',
]);
const ACCOUNT_RECORD =
  /^(?:support\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|invoices\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/pay)?)$/;
export function safeAccountStepUpReturn(organizationId: string, value: unknown): string {
  const account = `/o/${organizationId}/account`;
  if (typeof value !== 'string') return account;
  if (value === account) return account;
  if (!value.startsWith(`${account}/`)) return account;
  const page = value.slice(account.length + 1);
  return ACCOUNT_PAGES.has(page) || ACCOUNT_RECORD.test(page) ? value : account;
}
export function accountStepUpPath(organizationId: string, next: string): string {
  return `/o/${organizationId}/account/confirm?next=${encodeURIComponent(safeAccountStepUpReturn(organizationId, next))}`;
}
export function accountEnrollmentPath(organizationId: string, next: string): string {
  return `/o/${organizationId}/account/two-factor?next=${encodeURIComponent(safeAccountStepUpReturn(organizationId, next))}`;
}
