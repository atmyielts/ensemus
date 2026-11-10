import { decideApproval } from '@ensemus/application';
import { z } from 'zod';
import { apiRoute, approvalParams, readJson } from '@/server/api';

export const dynamic = 'force-dynamic';

const body = z.strictObject({
  decision: z.enum(['approve', 'deny']),
  action_hash: z.string().min(32).max(128),
  reason: z.string().max(2000).optional(),
});

export const POST = apiRoute(approvalParams, async ({ request, context, database, params }) => {
  const { decision, action_hash: shownHash, reason } = await readJson(request, body);
  await decideApproval(database, context, {
    approvalId: params.approvalId,
    decision,
    shownHash,
    ...(reason !== undefined ? { reason } : {}),
  });
  return new Response(null, { status: 200 });
});
