import { getOffboarding, requestOffboarding } from '@ensemus/application/saas/offboarding';
import { requestOffboardingSchema } from '@ensemus/contracts/saas';
import { apiRoute, etag, organizationParams, readJson } from '@/server/api';
import { getOffboardingAgents } from '@/server/offboarding-bindings';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(
  organizationParams,
  async ({ database, context }) => {
    const row = await getOffboarding(database, context);
    return Response.json(
      {
        offboarding: row
          ? {
              id: row.id,
              state: row.state,
              export_offered_at: row.exportOfferedAt?.toISOString() ?? null,
              export_ref: row.exportRef,
              transition_ends_at: row.transitionEndsAt?.toISOString() ?? null,
              active_holds: row.activeHolds,
              unsettled_actions: row.unsettledActions,
              report: row.report,
              version: row.version,
            }
          : null,
      },
      row ? { headers: { etag: etag(row.version) } } : {},
    );
  },
  'account',
);
export const POST = apiRoute(
  organizationParams,
  async ({ request, database, context }) => {
    const body = await readJson(request, requestOffboardingSchema),
      result = await requestOffboarding(
        database,
        context,
        { confirmName: body.confirm_name },
        getOffboardingAgents(),
      );
    return Response.json({ offboarding_id: result.offboardingId }, { status: 202 });
  },
  'account',
);
