import { retryBusinessAction } from '@ensemus/application';
import { retryBusinessActionSchema } from '@ensemus/contracts/business-records';
import { apiRoute, readJson, externalActionParams } from '@/server/api';
import { businessProposalResponse } from '@/server/business-action-api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  externalActionParams,
  async ({ request, database, context, params }) => {
    const body = await readJson(request, retryBusinessActionSchema);
    return businessProposalResponse(request, database, context, body, (joined) =>
      retryBusinessAction(joined, context, {
        externalActionId: params.externalActionId,
        approverMembershipId: body.approver_membership_id,
      }),
    );
  },
);
