import { idSchema } from '@ensemus/application';
import { releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import { releaseLegalHoldSchema } from '@ensemus/contracts/saas';
import { apiRoute, organizationParams, readIfMatch, readJson } from '@/server/api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  organizationParams.extend({ legalHoldId: idSchema }),
  async ({ request, database, context, params }) => {
    const body = await readJson(request, releaseLegalHoldSchema);
    await releaseLegalHold(database, context, {
      holdId: params.legalHoldId,
      reasonCode: body.reason_code,
      expectedVersion: readIfMatch(request),
    });
    return new Response(null, { status: 204 });
  },
  'account',
);
