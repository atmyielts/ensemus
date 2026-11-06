// Owned by the model-profiles slice (MODEL-01). The probe's side of a profile, in agent-worker (ADR-028
// FD-23). It has no person behind it: it reads through `withRunLookupTx` and writes as the agent role,
// which is the only role that can mark a profile active. Worker-only, so the web tier cannot import it.
import type { AppDatabase } from '@ensemus/database';
import type { RoutableProfile } from './ports';

/** Answers null if the profile is not `probing`. */
export function loadProfileForProbe(
  _database: AppDatabase,
  _input: { organizationId: string; profileId: string },
): Promise<RoutableProfile | null> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Writes the result, and only if the profile is still at the version that was tested. */
export function recordProbeResult(
  _database: AppDatabase,
  _input: { organizationId: string; profileId: string; profileVersion: number; passed: boolean },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}
