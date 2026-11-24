import { listMeetingProviderApprovals } from '@ensemus/application';
import { approveProviderSchema } from '@ensemus/contracts/meetings';
import { apiRoute, organizationParams, readJson } from '@/server/api';
import { approveMeetingProviderOnce, meetingProviderApprovalDto } from '@/server/meeting-api';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ database, context }) => {
  const approvals = await listMeetingProviderApprovals(database, context);
  return Response.json({ items: approvals.map(meetingProviderApprovalDto) });
});

export const POST = apiRoute(organizationParams, async ({ database, context, request }) => {
  const body = await readJson(request, approveProviderSchema);
  const row = await approveMeetingProviderOnce(
    database,
    context,
    request.headers.get('idempotency-key') ?? '',
    body,
  );
  return Response.json(meetingProviderApprovalDto(row), { status: 201 });
});
