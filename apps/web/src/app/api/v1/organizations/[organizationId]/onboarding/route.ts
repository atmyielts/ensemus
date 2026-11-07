import { getOnboarding } from '@ensemus/application/onboarding';
import { apiRoute, organizationParams } from '@/server/api';
import { onboardingDto } from '@/server/experience-api';
import { webProductPorts } from '@/server/product-ports';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(organizationParams, async ({ database, context }) =>
  Response.json(onboardingDto(await getOnboarding(database, context, webProductPorts()))),
);
