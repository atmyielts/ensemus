import { getModelProfile, updateModelProfile } from '@ensemus/application/ai-model-profiles';
import { loadModelEgressSettings } from '@ensemus/config';
import { updateModelProfileSchema } from '@ensemus/contracts/ai';
import { apiRoute, readJson } from '@/server/api';
import { modelProfileParams } from '../params';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(modelProfileParams, async ({ context, database, params }) =>
  Response.json(await getModelProfile(database, context, params.modelProfileId)),
);

/** A changed endpoint voids its key and returns it to draft, whatever else the patch says. */
export const PATCH = apiRoute(
  modelProfileParams,
  async ({ request, context, database, params }) => {
    const patch = await readJson(request, updateModelProfileSchema);
    const { privateEndpoints } = loadModelEgressSettings();
    return Response.json(
      await updateModelProfile(
        database,
        context,
        { profileId: params.modelProfileId, patch },
        { privateEndpoints },
      ),
    );
  },
);
