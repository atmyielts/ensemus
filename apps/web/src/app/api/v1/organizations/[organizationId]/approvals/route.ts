import { listMyPendingApprovals } from '@ensemus/application';
import { apiRoute, organizationParams } from '@/server/api';

export const dynamic = 'force-dynamic';

/** What is waiting on this caller, with the same access rules as the Approvals page. */
export const GET = apiRoute(organizationParams, async ({ context, database }) => {
  const pending = await listMyPendingApprovals(database, context);
  return Response.json({
    items: pending.map((approval) => ({
      id: approval.id,
      work_unit_id: approval.workUnitId,
      work_title: approval.workTitle,
      tool_name: approval.toolName,
      expires_at: approval.expiresAt.toISOString(),
    })),
  });
});
