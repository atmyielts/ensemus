import { getObjectMigration, retryObjectMigration } from '@ensemus/application/custom-objects';
import { apiRoute, readIfMatch } from '@/server/api';
import { objectMigrationParams, createObjectOnce } from '@/server/object-api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  objectMigrationParams,
  async ({ database, context, params, request }) => {
    const input = {
        typeId: params.typeId,
        migrationId: params.migrationId,
        expectedTypeVersion: readIfMatch(request),
      },
      migrationId = await createObjectOnce(
        database,
        context,
        request.headers.get('idempotency-key') ?? '',
        'object-migration-retry',
        input,
        (db) => retryObjectMigration(db, context, input),
        202,
      );
    await getObjectMigration(database, context, { typeId: params.typeId, migrationId });
    return Response.json({ migration_id: migrationId }, { status: 202 });
  },
);
