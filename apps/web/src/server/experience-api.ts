import { AppError, idSchema, runIdempotent, requestHash } from '@ensemus/application';
import {
  composeOutcome,
  getOutcomeDraft,
  type OutcomeDraftView,
} from '@ensemus/application/outcomes';
import type { CompanyOnboardingView } from '@ensemus/application/onboarding';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { canonicalJson } from '@ensemus/domain/approval';
import { organizationParams } from './api';
export const outcomeParams = organizationParams.extend({ outcomeDraftId: idSchema });
export const outcomeDto = (d: OutcomeDraftView) => ({
  id: d.id,
  objective: d.objective,
  preview: d.preview,
  preview_sha256: d.previewSha256,
  status: d.status,
  work_unit_id: d.workUnitId,
  version: d.version,
  updated_at: d.updatedAt.toISOString(),
});
export const onboardingDto = (v: CompanyOnboardingView) => ({
  steps: v.steps,
  finished: v.finished,
  next: v.next,
  completion_recorded: v.completionRecorded,
  latest_simulation: v.latestSimulation,
});
/** Cache identity only, then reauthorize every replay through the private draft reader. */
export async function composeOnce(
  database: AppDatabase,
  context: TenantContext,
  key: string,
  input: { objective: string; today: string },
) {
  const result = await runIdempotent(
    database,
    context,
    { key, requestHash: requestHash(['outcome-compose', canonicalJson(input)]) },
    (db) => composeOutcome(db, context, input),
    (d) => ({ status: 201, body: { id: d.id } }),
  );
  if (result.kind === 'conflict') throw new AppError('IDEMPOTENCY_KEY_REUSED');
  const id = idSchema.safeParse(
    typeof result.body === 'object' && result.body !== null && 'id' in result.body
      ? result.body.id
      : null,
  );
  if (!id.success) throw new AppError('INVALID_STATE');
  return getOutcomeDraft(database, context, id.data);
}
