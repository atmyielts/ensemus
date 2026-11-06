// Owned by the policy-router slice (the pre-send scan, SEC-13, ADR-028 FD-14). An extra signal, never the
// only boundary. This stub reports a hit on every part, so nothing leaves until the real scan exists.
import type { ContentPart, ScanResult } from './types';

export function scanForSecrets(
  parts: readonly ContentPart[],
  _canaries: readonly string[] = [],
): ScanResult {
  return { hits: parts.map((part) => ({ partId: part.id, code: 'API_KEY_SHAPE' as const })) };
}
