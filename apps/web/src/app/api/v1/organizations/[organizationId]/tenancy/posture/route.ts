import { apiRoute, organizationParams } from '@/server/api';
import { readDeploymentPosture } from '@/server/deployment-posture';

export const dynamic = 'force-dynamic';
export const GET = apiRoute(organizationParams, async ({ database, context }) => {
  const { profile, isolation, residency } = await readDeploymentPosture(database, context);
  return Response.json(
    {
      tier: profile.tier,
      home_region: residency.homeRegion,
      cross_org_enabled: profile.crossOrgEnabled,
      isolated: isolation.isolated,
      all_in_region: residency.allInRegion,
      aspects: isolation.aspects.map(({ aspect, state, code, checkedAt }) => ({
        aspect,
        state,
        code,
        checked_at: checkedAt?.toISOString() ?? null,
      })),
      surfaces: residency.surfaces.map(
        ({ surface, state, regions, evidenceRef, observedElsewhere }) => ({
          surface,
          state,
          regions,
          evidence_ref: evidenceRef,
          observed_elsewhere: observedElsewhere,
        }),
      ),
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
});
