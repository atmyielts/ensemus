import { changePlan, startSubscriptionOnce } from '@ensemus/application/saas/subscriptions';
import { AppError } from '@ensemus/application';
import { loadSaasConfig } from '@ensemus/config';
import { changePlanSchema, startSubscriptionSchema } from '@ensemus/contracts/saas';
import {
  apiRoute,
  idempotencyKeyReused,
  organizationParams,
  readIfMatch,
  readJson,
} from '@/server/api';

export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  organizationParams,
  async ({ request, database, context }) => {
    if (!loadSaasConfig().billingEnabled) throw new AppError('BILLING_NOT_ENABLED');
    const body = await readJson(request, startSubscriptionSchema);
    const result = await startSubscriptionOnce(database, context, {
      planVersionId: body.plan_version_id,
      requestKey: request.headers.get('idempotency-key') ?? '',
    });
    if (result.kind === 'conflict') throw idempotencyKeyReused();
    return Response.json({ subscription_id: result.subscriptionId }, { status: 201 });
  },
  'account',
);
export const PATCH = apiRoute(
  organizationParams,
  async ({ request, database, context }) => {
    if (!loadSaasConfig().billingEnabled) throw new AppError('BILLING_NOT_ENABLED');
    const body = await readJson(request, changePlanSchema);
    return Response.json(
      await changePlan(database, context, {
        toPlanVersionId: body.plan_version_id,
        expectedVersion: readIfMatch(request),
      }),
    );
  },
  'account',
);
