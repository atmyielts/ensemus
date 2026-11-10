/** A source URL is an explicit human navigation, never a server fetch. Reject executable schemes,
 * embedded credentials and control characters before rendering it, and suppress the referrer. */
export function safeKnowledgeSourceUrl(raw: string | null): string | null {
  if (
    !raw ||
    [...raw].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  )
    return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
export function knowledgeCostLabel(micros: number | null): string {
  return micros === null || !Number.isSafeInteger(micros) || micros < 0
    ? 'Not available'
    : `$${(micros / 1_000_000).toFixed(4)} estimated`;
}
