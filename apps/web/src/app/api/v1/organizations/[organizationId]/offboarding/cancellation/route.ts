import { cancelOffboarding } from '@ensemus/application/saas/offboarding';
import { cancelOffboardingSchema } from '@ensemus/contracts/saas';
import { apiRoute, organizationParams, readIfMatch, readJson } from '@/server/api';
import { getOffboardingAgents } from '@/server/offboarding-bindings';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  organizationParams,
  async ({ request, database, context }) => {
    const body = await readJson(request, cancelOffboardingSchema);
    await cancelOffboarding(
      database,
      context,
      { reasonCode: body.reason_code, expectedVersion: readIfMatch(request) },
      getOffboardingAgents(),
    );
    return new Response(null, { status: 204 });
  },
  'account',
);
