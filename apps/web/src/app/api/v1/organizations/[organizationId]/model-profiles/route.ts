import { createModelProfile, listModelProfiles } from '@ensemus/application/ai-model-profiles';
import { loadModelEgressSettings } from '@ensemus/config';
import { createModelProfileSchema } from '@ensemus/contracts/ai';
import { apiRoute, organizationParams, readJson } from '@/server/api';

export const dynamic = 'force-dynamic';

/** Approved models, without a key or a reference to one. Needs one of the model capabilities. */
export const GET = apiRoute(organizationParams, async ({ context, database }) =>
  Response.json({ items: await listModelProfiles(database, context) }),
);

/** Registers a draft. It cannot be used until a probe passes. */
export const POST = apiRoute(organizationParams, async ({ request, context, database }) => {
  const input = await readJson(request, createModelProfileSchema);
  const { privateEndpoints } = loadModelEgressSettings();
  const profile = await createModelProfile(database, context, input, { privateEndpoints });
  return Response.json(profile, { status: 201 });
});
