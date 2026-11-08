import { saveBillingAccount } from '@ensemus/application/saas/subscriptions';
import { saveBillingAccountSchema } from '@ensemus/contracts/saas';
import { apiRoute, etag, organizationParams, readIfMatch, readJson } from '@/server/api';

export const dynamic = 'force-dynamic';
export const PUT = apiRoute(
  organizationParams,
  async ({ request, database, context }) => {
    const body = await readJson(request, saveBillingAccountSchema);
    const result = await saveBillingAccount(database, context, {
      billingName: body.billing_name,
      billingEmail: body.billing_email,
      countryCode: body.country_code,
      regionCode: body.region_code,
      postalCode: body.postal_code,
      taxId: body.tax_id,
      expectedVersion: request.headers.has('if-match') ? readIfMatch(request) : null,
    });
    return Response.json(result, { headers: { ETag: etag(result.version) } });
  },
  'account',
);
