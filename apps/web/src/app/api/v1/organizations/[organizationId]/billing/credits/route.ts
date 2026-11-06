import { getCreditSummary } from '@ensemus/application/saas/credits';
import { apiRoute, organizationParams } from '@/server/api';

export const dynamic = 'force-dynamic';
export const GET = apiRoute(
  organizationParams,
  async ({ database, context }) => {
    const value = await getCreditSummary(database, context);
    return Response.json({
      balance_microcredits: value.balanceMicrocredits?.toString() ?? null,
      included_microcredits: value.includedMicrocredits?.toString() ?? null,
      overage_policy: value.overagePolicy,
      recent: value.recent.map((row) => ({
        kind: row.kind,
        amount_microcredits: row.amountMicrocredits.toString(),
        occurred_at: row.occurredAt.toISOString(),
      })),
    });
  },
  'account',
);
