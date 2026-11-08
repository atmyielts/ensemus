import { listAvailablePlans } from '@ensemus/application/saas/catalog';
import { apiRoute, organizationParams } from '@/server/api';

export const dynamic = 'force-dynamic';
export const GET = apiRoute(
  organizationParams,
  async ({ database, context }) => {
    const plans = await listAvailablePlans(database, context);
    return Response.json({
      items: plans.map((p) => ({
        plan_version_id: p.planVersionId,
        plan_code: p.planCode,
        display_name: p.displayName,
        currency: p.currency,
        billing_interval: p.billingInterval,
        payment_terms_days: p.paymentTermsDays,
        platform_fee_micros: p.platformFeeMicros.toString(),
        included_microcredits: p.includedMicrocredits?.toString() ?? null,
        overage_policy: p.overagePolicy,
        features: p.features,
        max_active_members: p.maxActiveMembers,
      })),
    });
  },
  'account',
);
