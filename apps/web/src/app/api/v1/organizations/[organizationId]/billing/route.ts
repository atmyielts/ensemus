import { getBillingOverview } from '@ensemus/application/saas/subscriptions';
import { loadSaasConfig } from '@ensemus/config';
import { apiRoute, organizationParams } from '@/server/api';

export const dynamic = 'force-dynamic';
export const GET = apiRoute(
  organizationParams,
  async ({ database, context }) => {
    const value = await getBillingOverview(database, context, loadSaasConfig());
    const a = value.account;
    const s = value.subscription;
    return Response.json({
      lifecycle: value.lifecycle,
      billing_enabled: value.billingEnabled,
      account: a
        ? {
            billing_name: a.billingName,
            billing_email: a.billingEmail,
            country_code: a.countryCode,
            region_code: a.regionCode,
            postal_code: a.postalCode,
            tax_id: a.taxId,
            version: a.version,
          }
        : null,
      subscription: s
        ? {
            id: s.id,
            plan_version_id: s.planVersionId,
            status: s.status,
            current_period_start: s.currentPeriodStart.toISOString(),
            current_period_end: s.currentPeriodEnd.toISOString(),
            cancel_at_period_end: s.cancelAtPeriodEnd,
            version: s.version,
          }
        : null,
    });
  },
  'account',
);
