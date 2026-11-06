import { decidePackCapability } from '@ensemus/application/packs';
import { decidePackCapabilitySchema } from '@ensemus/contracts/packs';
import { apiRoute, readJson } from '@/server/api';
import { installationParams, installationResponse } from '../../dto';

export const dynamic = 'force-dynamic';

// One capability, by name, each time. The contract has no shape for deciding several at once.
export const POST = apiRoute(installationParams, async ({ request, context, database, params }) => {
  const body = await readJson(request, decidePackCapabilitySchema);
  return installationResponse(
    await decidePackCapability(database, context, {
      installationId: params.installationId,
      capabilityKey: body.capability_key,
      decision: body.decision,
    }),
  );
});
