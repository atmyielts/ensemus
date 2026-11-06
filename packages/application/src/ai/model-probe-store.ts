// Owned by the model-profiles slice (MODEL-01). The probe's side of a profile, in agent-worker (ADR-028
// FD-23). It has no person behind it: it reads through `withRunLookupTx` and writes as the agent role,
// which is the only role that can mark a profile active. Worker-only, so the web tier cannot import it.
import { randomUUID } from 'node:crypto';
import {
  appendAudit,
  domainEvents,
  modelEvaluations,
  modelProfiles,
  outboxEvents,
  type AppDatabase,
  type Tx,
} from '@ensemus/database';
import { withRunLookupTx } from '@ensemus/database/agent';
import { AGGREGATE_MODEL_PROFILE, MODEL_PROFILE_ACTIVATED } from '@ensemus/domain/ai-events';
import { and, eq } from 'drizzle-orm';
import { toRoutableProfile } from './model-profiles';
import type { RoutableProfile } from './ports';

/** What the `suite` column says for a row this store writes. */
export const PROBE_SUITE = 'probe';

/** Answers null if the profile is not `probing`. */
export async function loadProfileForProbe(
  database: AppDatabase,
  input: { organizationId: string; profileId: string },
): Promise<RoutableProfile | null> {
  return withRunLookupTx(database, input.organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(modelProfiles)
      .where(
        and(
          eq(modelProfiles.organizationId, input.organizationId),
          eq(modelProfiles.id, input.profileId),
          eq(modelProfiles.status, 'probing'),
        ),
      );
    return row ? toRoutableProfile(row) : null;
  });
}

/** The columns a result sets. Only a pass ever carries a date, and the trigger refuses active without one. */
export function probeResultColumns(passed: boolean, now: Date) {
  return passed
    ? { status: 'active' as const, qualifiedAt: now, updatedAt: now }
    : { status: 'probe_failed' as const, qualifiedAt: null, updatedAt: now };
}

/** A fact for projections. `emit` needs a context, and a probe has no person to build one from. */
async function recordActivated(
  tx: Tx,
  input: { organizationId: string; profileId: string; profileVersion: number },
) {
  const id = randomUUID();
  await tx.insert(domainEvents).values({
    organizationId: input.organizationId,
    id,
    eventType: MODEL_PROFILE_ACTIVATED,
    aggregateType: AGGREGATE_MODEL_PROFILE,
    aggregateId: input.profileId,
    aggregateVersion: input.profileVersion,
    actorType: 'system',
    actorId: null,
    classification: 'internal',
    payload: {},
    correlationId: id,
    causationId: null,
  });
  await tx.insert(outboxEvents).values({ organizationId: input.organizationId, eventId: id });
}

/**
 * Writes the result, and only if the profile is still at the version that was tested and still waiting
 * for this. The update is the check, so nothing can change between looking and writing, and a profile
 * someone changed during the test keeps what they did. Its evaluation row and audit row go with it.
 */
export async function recordProbeResult(
  database: AppDatabase,
  input: { organizationId: string; profileId: string; profileVersion: number; passed: boolean },
): Promise<void> {
  await withRunLookupTx(database, input.organizationId, async (tx) => {
    const [written] = await tx
      .update(modelProfiles)
      .set(probeResultColumns(input.passed, new Date()))
      .where(
        and(
          eq(modelProfiles.organizationId, input.organizationId),
          eq(modelProfiles.id, input.profileId),
          eq(modelProfiles.version, input.profileVersion),
          eq(modelProfiles.status, 'probing'),
        ),
      )
      .returning({ askedBy: modelProfiles.probeRequestedByMembershipId });
    if (!written) return;

    await tx.insert(modelEvaluations).values({
      organizationId: input.organizationId,
      profileId: input.profileId,
      profileVersion: input.profileVersion,
      suite: PROBE_SUITE,
      passed: input.passed,
    });
    await appendAudit(tx, {
      organizationId: input.organizationId,
      actorType: 'system',
      ...(written.askedBy ? { actorId: written.askedBy } : {}),
      action: input.passed ? 'model_profile.probe_passed' : 'model_profile.probe_failed',
      targetRef: `model_profile:${input.profileId}`,
      decision: input.passed ? 'allow' : 'deny',
    });
    if (input.passed) await recordActivated(tx, input);
  });
}
