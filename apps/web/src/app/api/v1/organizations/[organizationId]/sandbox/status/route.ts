import { getSandboxStatus } from '@ensemus/application';
import { apiRoute, organizationParams } from '@/server/api';
import { sandboxStatusDto } from '@/server/sandbox-api';
import { getSandboxCeilings, getSkillFeatureGate } from '@/server/skill-runtime';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ database, context }) => {
  const view = await getSandboxStatus(database, context, {
    enabled: await getSkillFeatureGate().isEnabled(context, 'sandbox'),
    ceilings: getSandboxCeilings(),
  });
  return Response.json(sandboxStatusDto(view));
});
