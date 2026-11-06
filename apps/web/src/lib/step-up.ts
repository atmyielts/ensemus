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
