import { getApproval } from '@ensemus/application';
import { apiRoute, approvalParams } from '@/server/api';

export const dynamic = 'force-dynamic';

/**
 * One approval and the exact action it binds. A decision has to quote this action_hash, so this is
 * how an API client sees what it is deciding. It is hidden from anyone who cannot read the work.
 */
export const GET = apiRoute(approvalParams, async ({ context, database, params }) => {
  const { approval, work } = await getApproval(database, context, params.approvalId);
  return Response.json({
    id: approval.id,
    work_unit_id: work.id,
    status: approval.status,
    tool_name: approval.toolName,
    action: approval.action,
    action_hash: approval.actionHash,
    expires_at: approval.expiresAt.toISOString(),
    decided_at: approval.decidedAt?.toISOString() ?? null,
  });
});
