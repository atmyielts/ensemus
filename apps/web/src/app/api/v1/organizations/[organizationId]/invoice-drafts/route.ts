import { proposeInvoiceDraft } from '@ensemus/application';
import { proposeInvoiceDraftSchema } from '@ensemus/contracts/business-records';
import { apiRoute, readJson, organizationParams } from '@/server/api';
import { businessProposalResponse } from '@/server/business-action-api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(organizationParams, async ({ request, database, context }) => {
  const body = await readJson(request, proposeInvoiceDraftSchema);
  return businessProposalResponse(request, database, context, body, (joined) =>
    proposeInvoiceDraft(joined, context, {
      workUnitId: body.work_unit_id,
      connectionId: body.connection_id,
      invoice: body.invoice,
      approverMembershipId: body.approver_membership_id,
    }),
  );
});
