import {
  AppError,
  listSubmissions,
  requestHash,
  runIdempotent,
  submitToMarketplace,
} from '@ensemus/application';
import { submitToMarketplaceSchema } from '@ensemus/contracts/skills';
import { can } from '@ensemus/domain/policy';
import { apiRoute, etag, idempotencyKeyReused, organizationParams, readJson } from '@/server/api';
import { requireMarketplace, submissionDto } from '@/server/marketplace-api';

export const dynamic = 'force-dynamic';

export const GET = apiRoute(organizationParams, async ({ context, database }) => {
  await requireMarketplace(context);
  return Response.json({ items: (await listSubmissions(database, context)).map(submissionDto) });
});

export const POST = apiRoute(organizationParams, async ({ context, database, request }) => {
  if (context.actorType !== 'user' || !can(context.role, 'marketplace.publish'))
    throw new AppError('FORBIDDEN');
  const body = await readJson(request, submitToMarketplaceSchema);
  const gate = await requireMarketplace(context);
  const result = await runIdempotent(
    database,
    context,
    {
      key: request.headers.get('idempotency-key') ?? '',
      requestHash: requestHash(['POST', 'marketplace/submissions', body.skill_version_id]),
    },
    (joined) =>
      submitToMarketplace(joined, context, gate, {
        skillVersionId: body.skill_version_id,
        confirmShareWithOtherOrganizations: body.confirm_share_with_other_organizations,
      }),
    (row) => ({ status: 201, body: submissionDto(row) }),
  );
  if (result.kind === 'conflict') throw idempotencyKeyReused();
  const row = result.body as ReturnType<typeof submissionDto>;
  return Response.json(row, { status: result.status, headers: { ETag: etag(row.version) } });
});
