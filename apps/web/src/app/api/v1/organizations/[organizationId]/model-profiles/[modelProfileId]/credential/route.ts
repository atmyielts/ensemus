import { captureModelKey } from '@/app/o/[organizationId]/settings/models/capture';
import { modelCredentialRequestSchema } from '@/app/o/[organizationId]/settings/models/model-form';
import { apiRoute, readJson } from '@/server/api';
import { modelProfileParams } from '../../params';

export const dynamic = 'force-dynamic';

/** Takes a key once and seals it. The answer shows only that one is on file, and it can never be read. */
export const PUT = apiRoute(modelProfileParams, async ({ request, context, database, params }) => {
  const body = await readJson(request, modelCredentialRequestSchema);
  return Response.json(
    await captureModelKey(database, context, {
      profileId: params.modelProfileId,
      expectedVersion: body.expected_version,
      key: body.key,
    }),
  );
});
