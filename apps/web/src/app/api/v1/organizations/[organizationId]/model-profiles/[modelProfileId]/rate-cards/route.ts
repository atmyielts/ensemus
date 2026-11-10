import { addRateCard } from '@ensemus/application/ai-model-profiles';
import { createRateCardSchema } from '@ensemus/contracts/ai';
import { apiRoute, readJson } from '@/server/api';
import { modelProfileParams } from '../../params';

export const dynamic = 'force-dynamic';

/** A tenant's own estimate of what a model costs. Immutable, and the newest applies from now on. */
export const POST = apiRoute(modelProfileParams, async ({ request, context, database, params }) => {
  const body = await readJson(request, createRateCardSchema);
  await addRateCard(database, context, {
    profileId: params.modelProfileId,
    inputMicrosPerMtok: body.input_micros_per_mtok,
    outputMicrosPerMtok: body.output_micros_per_mtok,
  });
  return new Response(null, { status: 201 });
});
