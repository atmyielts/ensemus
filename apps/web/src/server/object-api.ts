import { AppError, idSchema, runIdempotent, requestHash } from '@ensemus/application';
import { canonicalJson } from '@ensemus/domain/approval';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { ObjectTypeView, ObjectRecordView } from '@ensemus/application/custom-objects';
import { organizationParams } from './api';
export const objectTypeParams = organizationParams.extend({ typeId: idSchema });
export const objectRecordParams = organizationParams.extend({ recordId: idSchema });
export const objectRelationParams = objectRecordParams.extend({ relationId: idSchema });
export const objectMigrationParams = objectTypeParams.extend({ migrationId: idSchema });
export const objectTypeDto = (t: ObjectTypeView) => ({
  id: t.id,
  slug: t.slug,
  display_name: t.displayName,
  classification: t.classification,
  current_version_number: t.currentVersionNumber,
  fields: t.fields,
  relations: t.relations,
  state: t.state,
  version: t.version,
});
export const objectRecordDto = (r: ObjectRecordView) => ({
  id: r.id,
  type_id: r.typeId,
  type_version_number: r.typeVersionNumber,
  display_name: r.displayName,
  attributes: r.attributes,
  classification: r.classification,
  owner_membership_id: r.ownerMembershipId,
  can_change: r.canChange,
  version: r.version,
  updated_at: r.updatedAt.toISOString(),
});
/** Save only identity, then callers reread through current ACL. Cached content never outruns revocation. */
export async function createObjectOnce(
  database: AppDatabase,
  context: TenantContext,
  key: string,
  operation: string,
  input: unknown,
  perform: (db: AppDatabase) => Promise<{ id: string }>,
  status = 201,
) {
  const once = () =>
    runIdempotent(
      database,
      context,
      { key, requestHash: requestHash([operation, canonicalJson(input)]) },
      perform,
      (row) => ({ status, body: { id: row.id } }),
    );
  let outcome;
  try {
    outcome = await once();
  } catch (error) {
    // Type slugs are unique. A concurrent winner can commit its key before this loser reaches the
    // kernel's key INSERT. One fresh lookup replays that winner; another key's slug still conflicts.
    if (
      !['object-type', 'object-migration-retry'].includes(operation) ||
      !(error instanceof AppError) ||
      error.code !== 'VERSION_CONFLICT'
    )
      throw error;
    outcome = await once();
  }
  if (outcome.kind === 'conflict') throw new AppError('IDEMPOTENCY_KEY_REUSED');
  const parsed = idSchema.safeParse(
    typeof outcome.body === 'object' && outcome.body !== null && 'id' in outcome.body
      ? outcome.body.id
      : null,
  );
  if (!parsed.success) throw new AppError('INVALID_STATE');
  return parsed.data;
}
