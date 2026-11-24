import {
  listResidencyRequirements,
  setResidencyRequirement,
  type ResidencyRequirementView,
} from '@ensemus/application';
import { setResidencyRequirementSchema } from '@ensemus/contracts/tenancy';
import { apiRoute, organizationParams, readJson } from '@/server/api';

const response = (rows: readonly ResidencyRequirementView[]) =>
  Response.json(
    {
      items: rows.map(({ scope, region, version, updatedAt }) => ({
        scope,
        region,
        version,
        updated_at: updatedAt.toISOString(),
      })),
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );

export const GET = apiRoute(organizationParams, async ({ database, context }) =>
  response(await listResidencyRequirements(database, context)),
);

export const PUT = apiRoute(organizationParams, async ({ database, context, request }) => {
  const body = await readJson(request, setResidencyRequirementSchema);
  return response(
    await setResidencyRequirement(database, context, {
      scope: body.scope,
      region: body.region,
      expectedVersion: body.expected_version,
    }),
  );
});
