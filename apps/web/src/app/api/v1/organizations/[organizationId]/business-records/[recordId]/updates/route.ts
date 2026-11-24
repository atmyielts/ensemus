import { proposeRecordUpdate } from '@ensemus/application';
import { proposeRecordUpdateSchema } from '@ensemus/contracts/business-records';
import { apiRoute, readJson } from '@/server/api';
import { businessProposalResponse } from '@/server/business-action-api';
import { businessRecordParams } from '@/server/business-record-api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  businessRecordParams,
  async ({ request, database, context, params }) => {
    const body = await readJson(request, proposeRecordUpdateSchema);
    return businessProposalResponse(request, database, context, body, (joined) =>
      proposeRecordUpdate(joined, context, {
        workUnitId: body.work_unit_id,
        recordId: params.recordId,
        expectedVersion: body.expected_version,
        changes: body.changes,
        approverMembershipId: body.approver_membership_id,
      }),
    );
  },
);
