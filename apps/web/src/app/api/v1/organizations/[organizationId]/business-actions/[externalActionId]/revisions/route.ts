import { reviseBusinessAction } from '@ensemus/application';
import { reviseBusinessActionSchema } from '@ensemus/contracts/business-records';
import { apiRoute, readJson, readIfMatch, externalActionParams } from '@/server/api';
import { businessProposalResponse } from '@/server/business-action-api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  externalActionParams,
  async ({ request, database, context, params }) => {
    const expectedVersion = readIfMatch(request);
    const body = await readJson(request, reviseBusinessActionSchema);
    return businessProposalResponse(
      request,
      database,
      context,
      body,
      (joined) =>
        reviseBusinessAction(joined, context, {
          externalActionId: params.externalActionId,
          expectedVersion,
          payload: body.payload,
          approverMembershipId: body.approver_membership_id,
        }),
      expectedVersion,
    );
  },
);
