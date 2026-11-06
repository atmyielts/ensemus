import { requestModelProbe } from '@ensemus/application/ai-model-profiles';
import { activateRequestSchema } from '@/app/o/[organizationId]/settings/models/model-form';
import { apiRoute, readJson } from '@/server/api';
import { modelProfileParams } from '../../params';

export const dynamic = 'force-dynamic';

/**
 * Asks for a probe. This route cannot make a profile active: the web tier has no key and no way out, and
 * the database lets only the agent role write a result. The 202 means the request was recorded.
 */
export const POST = apiRoute(modelProfileParams, async ({ request, context, database, params }) => {
  const body = await readJson(request, activateRequestSchema);
  await requestModelProbe(database, context, {
    profileId: params.modelProfileId,
    expectedVersion: body.expected_version,
  });
  return new Response(null, { status: 202 });
});
