import { getObjectMigration } from '@ensemus/application/custom-objects';
import { apiRoute } from '@/server/api';
import { objectMigrationParams } from '@/server/object-api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(objectMigrationParams, async ({ database, context, params }) => {
  const m = await getObjectMigration(database, context, {
    typeId: params.typeId,
    migrationId: params.migrationId,
  });
  return Response.json({
    id: m.id,
    type_id: m.typeId,
    from_version_number: m.fromVersionNumber,
    to_version_number: m.toVersionNumber,
    status: m.status,
    migrated_count: m.migratedCount,
    failed_count: m.failedCount,
    error_code: m.errorCode,
  });
});
