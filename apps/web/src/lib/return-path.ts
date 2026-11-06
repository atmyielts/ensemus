// Where someone goes after signing in. The value arrives from a query string or a hidden field, so
// it is untrusted: only the exact shape of an invitation path passes. That rules out other sites
// ("//evil.example", "/\evil.example"), dot segments, encoded slashes and query strings.
const INVITATION_PATH = /^\/invite\/[A-Za-z0-9_-]{16,128}$/;

export function safeReturnPath(value: unknown): string | undefined {
  return typeof value === 'string' && INVITATION_PATH.test(value) ? value : undefined;
}

/** Adds a checked return path to a sign-in or sign-up link, keeping any query already there. */
export function withReturnPath(path: string, next: string | undefined): string {
  if (!next) return path;
  return `${path}${path.includes('?') ? '&' : '?'}next=${encodeURIComponent(next)}`;
}
