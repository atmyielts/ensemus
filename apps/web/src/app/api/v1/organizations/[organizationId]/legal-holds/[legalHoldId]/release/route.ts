import { releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import { releaseLegalHoldSchema } from '@ensemus/contracts/saas';
import { z } from 'zod';
import { apiRoute, organizationParams, readIfMatch, readJson } from '@/server/api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  organizationParams.extend({ legalHoldId: z.uuid() }),
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
