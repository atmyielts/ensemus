import { getMemberCapabilities, setMemberCapabilities } from '@ensemus/application/suite-settings';
import { apiRoute, assertManagesConnections, organizationParams, readJson } from '@/server/api';
import { memberConnectionCapabilitiesSchema } from '@/server/personal-connections';

export const dynamic = 'force-dynamic';

// Anyone in the organization may read what members may connect.
export const GET = apiRoute(organizationParams, async ({ context, database }) =>
  Response.json({ capabilities: [...(await getMemberCapabilities(database, context))] }),
);

export const PUT = apiRoute(organizationParams, async ({ request, context, database }) => {
  assertManagesConnections(context);
  const body = await readJson(request, memberConnectionCapabilitiesSchema);
  const capabilities = await setMemberCapabilities(database, context, body.capabilities);
  return Response.json({ capabilities: [...capabilities] });
});
