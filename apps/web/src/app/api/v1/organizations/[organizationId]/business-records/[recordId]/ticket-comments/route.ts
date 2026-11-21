import { proposeTicketComment } from '@ensemus/application';
import { proposeTicketCommentSchema } from '@ensemus/contracts/business-records';
import { apiRoute, readJson } from '@/server/api';
import { businessProposalResponse } from '@/server/business-action-api';
import { businessRecordParams } from '@/server/business-record-api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  businessRecordParams,
  async ({ request, database, context, params }) => {
    const body = await readJson(request, proposeTicketCommentSchema);
    return businessProposalResponse(request, database, context, body, (joined) =>
      proposeTicketComment(joined, context, {
        workUnitId: body.work_unit_id,
        recordId: params.recordId,
        body: body.body,
        approverMembershipId: body.approver_membership_id,
      }),
    );
  },
);
